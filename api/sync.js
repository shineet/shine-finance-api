// POST /api/sync
// Pulls transaction changes from Plaid into Supabase.
//
// /transactions/sync is a delta feed: each call returns only what changed
// since the cursor. So the durable copy lives in Supabase and this endpoint
// keeps it current -- /api/transactions then always serves full history,
// regardless of how recently a sync ran.

import { plaid, authorize, listItems, saveCursor } from '../lib/plaid.js';

const CATEGORY_LABELS = {
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  TRANSPORTATION: 'Transport',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  ENTERTAINMENT: 'Entertainment',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  LOAN_PAYMENTS: 'Loan Payments',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  INCOME: 'Income',
  BANK_FEES: 'Fees',
  HOME_IMPROVEMENT: 'Home',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Non-profit',
};

function toRow(txn, institution) {
  const primary = txn.personal_finance_category?.primary || null;
  return {
    transaction_id: txn.transaction_id,
    account_id: txn.account_id,
    institution,
    date: txn.date,
    name: txn.merchant_name || txn.name,
    raw_name: txn.name,
    // Plaid signs outflows positive; flip so money leaving is negative.
    amount: txn.amount == null ? null : -txn.amount,
    currency: txn.iso_currency_code || 'USD',
    pending: !!txn.pending,
    category: primary,
    category_label: primary ? CATEGORY_LABELS[primary] || primary : null,
    channel: txn.payment_channel || null,
    updated_at: new Date().toISOString(),
  };
}

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

async function upsert(rows) {
  if (!rows.length) return;
  // Chunked so a large first sync doesn't exceed request limits.
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/plaid_transactions`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`upsert failed: ${await res.text()}`);
  }
}

async function remove(ids) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 200) {
    const list = ids.slice(i, i + 200).map(encodeURIComponent).join(',');
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions?transaction_id=in.(${list})`,
      { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } }
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    const items = await listItems();
    const errors = [];
    let addedCount = 0;
    let removedCount = 0;

    // Sequential across items: keeps Supabase writes predictable and avoids
    // hammering Plaid when several institutions each paginate.
    for (const item of items) {
      const institution = item.institution_name || item.item_id;
      try {
        let cursor = item.cursor || undefined;
        let hasMore = true;
        const upserts = [];
        const deletes = [];

        while (hasMore) {
          const out = await plaid('/transactions/sync', {
            access_token: item.access_token,
            cursor,
            count: 500,
            // Recurring detection wants at least 180 days; ask for two years
            // so income and bill patterns are visible from the first sync.
            days_requested: 730,
          });
          for (const t of out.added || []) upserts.push(toRow(t, institution));
          for (const t of out.modified || []) upserts.push(toRow(t, institution));
          for (const r of out.removed || []) deletes.push(r.transaction_id);
          cursor = out.next_cursor;
          hasMore = out.has_more;
        }

        // Persist rows before the cursor: if the write fails, the next run
        // replays the same window rather than skipping past it.
        await upsert(upserts);
        await remove(deletes);
        if (cursor) await saveCursor(item.item_id, cursor);

        addedCount += upserts.length;
        removedCount += deletes.length;
      } catch (err) {
        errors.push({ institution, error: err.message, code: err.plaidCode });
      }
    }

    return res.status(200).json({
      synced: addedCount,
      removed: removedCount,
      errors,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
