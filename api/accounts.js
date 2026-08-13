// GET /api/accounts
// Live balances across every linked institution.

import { plaid, authorize, listItems } from '../lib/plaid.js';

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

    return res.status(200).json({ accounts, errors, as_of: new Date().toISOString() });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
