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

  // A full rebuild: ask Plaid to re-pull each Item, then replay its entire
  // history from the beginning instead of from the saved cursor.
  //
  // Safe to run at any time. Upserts merge on transaction_id, so replaying a
  // window that is already stored rewrites the same rows rather than doubling
  // them. That is what makes this usable as a repair rather than a gamble.
  //
  // It exists because a delta feed cannot heal a hole. When an Item's login
  // expires, Plaid stops collecting for it, and repairing the connection
  // resumes from the repair date -- it does not go back and fill the outage.
  // The cursor then carries on quite happily from the far side of a gap that
  // nothing will ever mention again.
  const full = req.query.full === '1';

  try {
    const items = await listItems();
    const errors = [];
    let addedCount = 0;
    let removedCount = 0;

    if (full) {
      console.log(`[sync] FULL rebuild requested for ${items.length} item(s)`);
      for (const item of items) {
        const institution = item.institution_name || item.item_id;
        try {
          // Ask the bank for anything it has not handed over yet. Rate-limited
          // by Plaid and allowed to fail: the replay below is the part that
          // matters, and a refused refresh must not stop it.
          await plaid('/transactions/refresh', { access_token: item.access_token });
          console.log(`[sync] ${institution}: refresh requested`);
        } catch (err) {
          console.log(`[sync] ${institution}: refresh declined (${err.message})`);
        }
      }
    }

    // Sequential across items: keeps Supabase writes predictable and avoids
    // hammering Plaid when several institutions each paginate.
    for (const item of items) {
      const institution = item.institution_name || item.item_id;
      try {
        let cursor = full ? undefined : (item.cursor || undefined);
        let hasMore = true;
        let pages = 0;
        const upserts = [];
        const deletes = [];
        // Logged because the alternative was guessing. This endpoint answers
        // 200 with a per-institution errors array -- one bank refusing must not
        // stop the others -- and for a month nothing anywhere read that array.
        // The store simply stopped receiving new transactions and every screen
        // reported zero as though zero were the answer.
        console.log(
          `[sync] ${institution}: starting, cursor=${cursor ? 'yes' : 'none'}` +
          (full ? ' (full rebuild)' : '')
        );

        while (hasMore) {
          const out = await plaid('/transactions/sync', {
            access_token: item.access_token,
            cursor,
            count: 500,
            // NO days_requested here. Plaid rejects it on this endpoint --
            // "the following fields are not recognized by this endpoint" --
            // and rejects the whole call, so every sync for every institution
            // failed from the moment it was added. It belongs on
            // /link/token/create, where it sets how much history a NEW Item
            // starts with; /transactions/sync is a delta feed and has no
            // window to ask for. The window is a property of the Item.
          });
          for (const t of out.added || []) upserts.push(toRow(t, institution));
          for (const t of out.modified || []) upserts.push(toRow(t, institution));
          for (const r of out.removed || []) deletes.push(r.transaction_id);
          cursor = out.next_cursor;
          hasMore = out.has_more;
          pages += 1;
          // A cursor that never advances is the failure that looks like
          // success: every call returns nothing, forever, and says nothing.
          if (pages > 50) {
            throw new Error('stopped after 50 pages -- cursor may not be advancing');
          }
        }

        // Persist rows before the cursor: if the write fails, the next run
        // replays the same window rather than skipping past it.
        await upsert(upserts);
        await remove(deletes);
        if (cursor) await saveCursor(item.item_id, cursor);

        addedCount += upserts.length;
        removedCount += deletes.length;
        console.log(
          `[sync] ${institution}: ${upserts.length} upserted, ${deletes.length} removed, ` +
          `${pages} page(s), cursor ${cursor ? 'saved' : 'MISSING'}`
        );
      } catch (err) {
        // Loudly. A caught error that is only returned in a body nobody reads
        // is indistinguishable from no error at all.
        console.error(`[sync] ${institution} FAILED: ${err.message}`, err.plaidCode || '');
        errors.push({ institution, error: err.message, code: err.plaidCode });
      }
    }

    console.log(
      `[sync] done: ${items.length} item(s), ${addedCount} upserted, ` +
      `${removedCount} removed, ${errors.length} failed`
    );

    // What the store actually HOLDS, per institution. Counts and dates only --
    // no descriptions, no amounts.
    //
    // Worth its own queries because "the sync succeeded" and "the data is
    // there" are different claims, and only the second one matters. A bank
    // whose newest row is weeks old, or whose oldest row starts after the
    // history should, is invisible from the app: a missing transaction has no
    // row to be missing from.
    try {
      const names = [...new Set(items.map((i) => i.institution_name || i.item_id))];
      for (const name of names) {
        const base =
          `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions` +
          `?select=date&institution=eq.${encodeURIComponent(name)}`;
        const [newest, oldest, counted] = await Promise.all([
          fetch(`${base}&order=date.desc&limit=1`, { headers: sbHeaders() }).then((r) => r.json()),
          fetch(`${base}&order=date.asc&limit=1`, { headers: sbHeaders() }).then((r) => r.json()),
          fetch(`${base}&limit=1`, {
            headers: { ...sbHeaders(), Prefer: 'count=exact', Range: '0-0' },
          }).then((r) => r.headers.get('content-range')),
        ]);
        const total = (counted || '').split('/')[1] || '?';
        console.log(
          `[store] ${name}: ${total} row(s), ` +
          `${oldest?.[0]?.date || 'none'} -> ${newest?.[0]?.date || 'none'}`
        );
      }
    } catch (e) {
      console.error(`[store] could not summarise: ${e.message}`);
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
