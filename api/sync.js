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
        // Which DAYS have nothing.
        //
        // The monthly counts came back healthy -- Chase had 273 rows in August
        // -- while a specific deposit on 21 August was still missing. A month
        // that looks normal can still be missing one day, and one day is what a
        // fortnightly salary lives on. So: the recent window, day by day, with
        // the empty ones named.
        try {
          const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
          const recent = await fetch(
            `${base}&date=gte.${since}&order=date.desc&limit=1000`,
            { headers: sbHeaders() }
          ).then((r) => r.json());
          const days = new Set((recent || []).map((r) => String(r.date || '')));
          const empty = [];
          for (let i = 0; i < 45; i += 1) {
            const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            if (!days.has(d)) empty.push(d.slice(5));
          }
          console.log(
            `[gap] ${name}: ${days.size} day(s) with activity since ${since}; ` +
            `nothing on ${empty.join(' ') || 'every day covered'}`
          );
        } catch (e) {
          console.error(`[gap] ${name}: ${e.message}`);
        }

        // Every date this institution holds, counted per month.
        //
        // A first and last date cannot show a hole, and a hole in the middle is
        // exactly what a broken-then-repaired connection leaves behind: Plaid
        // stops collecting during the outage and resumes at the repair, so the
        // range still looks complete from both ends. A month with a suspiciously
        // small count, between two normal ones, is the whole diagnosis.
        const rows = await fetch(`${base}&order=date.desc&limit=5000`, {
          headers: sbHeaders(),
        }).then((r) => r.json());
        const perMonth = {};
        for (const row of rows || []) {
          const key = String(row.date || '').slice(0, 7);
          if (key) perMonth[key] = (perMonth[key] || 0) + 1;
        }
        const shape = Object.keys(perMonth).sort().map((m) => `${m}:${perMonth[m]}`).join(' ');
        console.log(
          `[store] ${name}: ${(rows || []).length} row(s)  ${shape || 'none'}`
        );
      }
    } catch (e) {
      console.error(`[store] could not summarise: ${e.message}`);
    }

    // The last question worth asking about the missing 21 August deposit.
    //
    // 21 August is not an empty day: both banks recorded transactions on it.
    // So either the store holds that deposit and the app is not showing it, or
    // Plaid never recorded it and no amount of replaying will conjure it. Those
    // need completely different answers and cannot be told apart from outside.
    //
    // Dates and institutions only. No amounts.
    try {
      const probe = String(req.query.probe || 'infosys').slice(0, 40);
      const url =
        `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions` +
        `?select=date,institution,account_id,name&name=ilike.*${encodeURIComponent(probe)}*` +
        `&date=gte.2026-07-01&order=date.desc&limit=60`;
      const hits = await fetch(url, { headers: sbHeaders() }).then((r) => r.json());
      console.log(`[probe] "${probe}" since 2026-07-01: ${(hits || []).length} row(s)`);
      for (const h of hits || []) {
        console.log(
          `[probe]   ${h.date}  ${h.institution}  acct=${String(h.account_id).slice(-6)}  ` +
          `${String(h.name).slice(0, 48)}`
        );
      }
    } catch (e) {
      console.error(`[probe] failed: ${e.message}`);
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
