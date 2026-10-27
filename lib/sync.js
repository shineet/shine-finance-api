// Pulling one Item's transaction changes from Plaid into Supabase.
//
// Shared by /api/sync (the app's refresh) and /api/plaid-webhook (Plaid saying
// new data is waiting), so both keep the same store and the same cursor, and
// whichever runs first is the one that announces a deposit.

import { plaid, saveCursor } from './plaid.js';

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

export function toRow(txn, institution) {
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

export const sbHeaders = () => ({
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

/// Syncs one Item. Returns what changed, plus the raw transactions Plaid
/// ADDED, which is what the deposit notice looks at.
///
/// `full` replays the Item's whole history from no cursor (the repair path).
export async function syncItem(item, { full = false } = {}) {
  const institution = item.institution_name || item.item_id;
  const startedWithCursor = !!item.cursor && !full;
  let cursor = full ? undefined : (item.cursor || undefined);
  let hasMore = true;
  let pages = 0;
  const upserts = [];
  const deletes = [];
  const added = [];
  // Logged because the alternative was guessing. A sync that answers 200 with
  // a per-institution error is otherwise invisible.
  console.log(
    `[sync] ${institution}: starting, cursor=${cursor ? 'yes' : 'none'}` +
    (full ? ' (full rebuild)' : '')
  );

  while (hasMore) {
    const out = await plaid('/transactions/sync', {
      access_token: item.access_token,
      cursor,
      count: 500,
      // NO days_requested here. Plaid rejects it on this endpoint and fails the
      // whole call; it belongs on /link/token/create.
    });
    for (const t of out.added || []) { upserts.push(toRow(t, institution)); added.push(t); }
    for (const t of out.modified || []) upserts.push(toRow(t, institution));
    for (const r of out.removed || []) deletes.push(r.transaction_id);
    cursor = out.next_cursor;
    hasMore = out.has_more;
    pages += 1;
    // A cursor that never advances is the failure that looks like success.
    if (pages > 50) {
      throw new Error('stopped after 50 pages -- cursor may not be advancing');
    }
  }

  // Persist rows before the cursor: if the write fails, the next run replays
  // the same window rather than skipping past it.
  await upsert(upserts);
  await remove(deletes);
  if (cursor) await saveCursor(item.item_id, cursor);

  console.log(
    `[sync] ${institution}: ${upserts.length} upserted, ${deletes.length} removed, ` +
    `${pages} page(s), cursor ${cursor ? 'saved' : 'MISSING'}`
  );
  // `fresh` is false for a first sync or a rebuild: everything Plaid hands
  // over then is history, and announcing it would be a flood of old deposits.
  return { institution, upserts, deletes, added, fresh: startedWithCursor };
}
