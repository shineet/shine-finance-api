// GET /api/investments
// What is inside each investment account: holdings, what was paid for them,
// the securities they are, and this year's retirement contributions.
//
// Fetched live from Plaid rather than stored: holdings change every trading
// day, and a stale copy would show gains that are no longer there.
//
// An Item linked before investments were requested answers
// ADDITIONAL_CONSENT_REQUIRED until its owner approves the extra product in
// Link (POST /api/link-token with item_id and add: ['investments']). That is
// reported per Item, so the app can offer the button on the right bank.

import { plaid, authorize, listItems } from '../lib/plaid.js';

// Codes that mean "this bank has nothing here", not "something broke".
const NOTHING_HERE = new Set(['NO_INVESTMENT_ACCOUNTS', 'NO_INVESTMENT_AUTH_ACCOUNTS', 'NO_ACCOUNTS']);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  try {
    const items = await listItems(user);
    const accounts = [];
    const holdings = [];
    const securities = new Map();
    const contributions = [];
    const errors = [];

    const today = new Date().toISOString().slice(0, 10);
    // Two years back: enough to see this year's contributions and when each
    // holding was last bought, which decides short- or long-term.
    const start = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);

    await Promise.all(
      items.map(async (item) => {
        const institution = item.institution_name || item.item_id;
        try {
          const out = await plaid('/investments/holdings/get', { access_token: item.access_token });
          for (const a of out.accounts || []) {
            if (a.type !== 'investment') continue;
            accounts.push({
              account_id: a.account_id,
              item_id: item.item_id,
              institution,
              name: a.official_name || a.name,
              mask: a.mask ?? null,
              subtype: a.subtype ?? null,
              value: a.balances?.current ?? null,
            });
          }
          for (const h of out.holdings || []) {
            holdings.push({
              account_id: h.account_id,
              security_id: h.security_id,
              quantity: h.quantity ?? null,
              price: h.institution_price ?? null,
              value: h.institution_value ?? null,
              cost_basis: h.cost_basis ?? null,
            });
          }
          for (const s of out.securities || []) {
            securities.set(s.security_id, {
              security_id: s.security_id,
              name: s.name ?? null,
              ticker: s.ticker_symbol ?? null,
              type: s.type ?? null,
              subtype: s.subtype ?? null,
              is_cash: !!s.is_cash_equivalent,
            });
          }

          // Contributions and buys. A failure here must not hide the holdings.
          try {
            let offset = 0;
            for (let page = 0; page < 10; page++) {
              const t = await plaid('/investments/transactions/get', {
                access_token: item.access_token,
                start_date: start,
                end_date: today,
                options: { count: 500, offset },
              });
              for (const x of t.investment_transactions || []) {
                contributions.push({
                  account_id: x.account_id,
                  security_id: x.security_id ?? null,
                  date: x.date,
                  type: x.type,
                  subtype: x.subtype,
                  amount: x.amount,
                  quantity: x.quantity ?? null,
                  name: x.name ?? null,
                });
              }
              offset += (t.investment_transactions || []).length;
              if (offset >= (t.total_investment_transactions || 0)) break;
            }
          } catch (err) {
            errors.push({ item_id: item.item_id, institution, code: err.plaidCode, error: err.message, part: 'transactions' });
          }
        } catch (err) {
          if (NOTHING_HERE.has(err.plaidCode)) return;
          errors.push({ item_id: item.item_id, institution, code: err.plaidCode, error: err.message });
        }
      })
    );

    console.log(`investments: ${accounts.length} accounts, ${holdings.length} holdings, `
      + `${contributions.length} transactions, errors: ${errors.map((e) => e.code).join(', ') || 'none'}`);
    return res.status(200).json({
      accounts,
      holdings,
      securities: [...securities.values()],
      transactions: contributions,
      errors,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
