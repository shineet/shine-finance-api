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
              available: acct.balances?.available ?? null,
              current: acct.balances?.current ?? null,
              limit: acct.balances?.limit ?? null,
              currency: acct.balances?.iso_currency_code || 'USD',
            });
          }
        } catch (err) {
          errors.push({
            institution: item.institution_name || item.item_id,
            error: err.message,
            code: err.plaidCode,
          });
        }
      })
    );

    await snapshot(accounts);

    return res.status(200).json({ accounts, errors, as_of: new Date().toISOString() });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
