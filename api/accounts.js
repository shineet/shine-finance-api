// GET /api/accounts
// Live balances across every linked institution.

import { plaid, authorize, listItems } from '../lib/plaid.js';

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

// Plaid only ever reports "now", so progress over time has to be recorded as
// it happens -- there is no way to backfill a balance for a past date. Every
// accounts read snapshots today's figures, overwriting the same day's row.
async function snapshot(accounts) {
  if (!accounts.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const rows = accounts.map((a) => ({
    account_id: a.account_id,
    as_of: today,
    institution: a.institution,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    current: a.current,
    available: a.available,
    limit: a.limit,
  }));
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/balance_snapshots`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    // Never fail a balance read because history couldn't be written.
    console.error('snapshot failed:', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    const items = await listItems();
    const accounts = [];
    const errors = [];

    // One institution being down (expired login, bank outage) shouldn't blank
    // out the whole dashboard -- collect what works, report what doesn't.
    await Promise.all(
      items.map(async (item) => {
        try {
          const out = await plaid('/accounts/balance/get', { access_token: item.access_token });
          for (const acct of out.accounts || []) {
            accounts.push({
              account_id: acct.account_id,
              name: acct.name,
              official_name: acct.official_name,
              mask: acct.mask,
              type: acct.type,
              subtype: acct.subtype,
              institution: item.institution_name || out.item?.institution_id || null,
              // Which connection this came from, so the app can offer to
              // repair or remove ONE bank instead of all of them.
              item_id: item.item_id,
              available: acct.balances?.available ?? null,
              current: acct.balances?.current ?? null,
              limit: acct.balances?.limit ?? null,
              currency: acct.balances?.iso_currency_code || 'USD',
            });
          }
        } catch (err) {
          // LOGGED, not only collected. The list is returned to the app and
          // shown as "not refreshing", which says that something is wrong and
          // never what. Chase failed for days and the only way to learn the
          // actual Plaid code was to add this line after the fact.
          console.error('Institution failed:', item.institution_name || item.item_id,
                        err.plaidCode || '(no code)', err.message);
          errors.push({
            institution: item.institution_name || item.item_id,
            item_id: item.item_id,
            error: err.message,
            code: err.plaidCode,
          });
        }
      })
    );

    await snapshot(accounts);

    // Accounts that used to exist and no longer do.
    //
    // Re-linking a bank issues NEW Plaid account ids for the same real
    // accounts, so every transaction recorded before the re-link is filed under
    // an id that now resolves to nothing. Anything that works by asking "is
    // this a cash account?" answers no, and the whole of that account's history
    // silently stops counting -- present in the transactions list, absent from
    // every total. That is how a payroll deposit in July can be visible on one
    // screen and missing from income on another.
    //
    // The balance snapshots know what those accounts were, because they were
    // written while the accounts were still live. Returning them lets the app
    // classify old transactions instead of discarding them. They carry no
    // balance: they are for identification only, and must never be added to a
    // total of what exists now.
    let retired = [];
    try {
      const rows = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/balance_snapshots` +
        `?select=account_id,name,institution,type,subtype,as_of&order=as_of.desc&limit=1000`,
        { headers: sbHeaders() }
      ).then((r) => r.json());
      const live = new Set(accounts.map((a) => a.account_id));
      const seen = new Set();
      for (const row of rows || []) {
        if (live.has(row.account_id) || seen.has(row.account_id)) continue;
        seen.add(row.account_id);
        retired.push({
          account_id: row.account_id,
          name: row.name,
          institution: row.institution,
          type: row.type,
          subtype: row.subtype,
          last_seen: row.as_of,
        });
      }
      if (retired.length) {
        console.log(
          `[accounts] ${retired.length} retired account(s): ` +
          retired.map((r) => `${r.institution}/${r.type} last seen ${r.last_seen}`).join(', ')
        );
      }
    } catch (err) {
      console.error('retired lookup failed:', err.message);
    }

    return res.status(200).json({ accounts, retired, errors, as_of: new Date().toISOString() });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
