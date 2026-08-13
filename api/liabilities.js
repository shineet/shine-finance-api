// GET /api/liabilities
// Credit-account terms: APR, minimum payment, due date, statement balance.
// These are what turn a balance into a payoff projection.

import { plaid, authorize, listItems } from '../lib/plaid.js';

// A card can carry several APRs (purchase, cash advance, balance transfer).
// Payoff maths should use the one that applies to the carried balance, so
// prefer the purchase APR and fall back to the highest quoted.
function primaryApr(aprs = []) {
  const purchase = aprs.find((a) => a.apr_type === 'purchase_apr');
  if (purchase?.apr_percentage != null) return purchase.apr_percentage;
  const values = aprs.map((a) => a.apr_percentage).filter((v) => v != null);
  return values.length ? Math.max(...values) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    const items = await listItems();
    const credit = [];
    const errors = [];

    await Promise.all(
      items.map(async (item) => {
        const institution = item.institution_name || item.item_id;
        try {
          const out = await plaid('/liabilities/get', { access_token: item.access_token });
          for (const card of out.liabilities?.credit || []) {
            credit.push({
              account_id: card.account_id,
              institution,
              apr: primaryApr(card.aprs),
              aprs: (card.aprs || []).map((a) => ({
                type: a.apr_type,
                percentage: a.apr_percentage,
                balance_subject_to_apr: a.balance_subject_to_apr ?? null,
              })),
              minimum_payment: card.minimum_payment_amount ?? null,
              last_payment_amount: card.last_payment_amount ?? null,
              last_payment_date: card.last_payment_date ?? null,
              next_payment_due_date: card.next_payment_due_date ?? null,
              last_statement_balance: card.last_statement_balance ?? null,
              last_statement_issue_date: card.last_statement_issue_date ?? null,
              is_overdue: card.is_overdue ?? null,
            });
          }
        } catch (err) {
          // An institution that doesn't support liabilities shouldn't break
          // the others -- report it and carry on.
          errors.push({ institution, error: err.message, code: err.plaidCode });
        }
      })
    );

    return res.status(200).json({ credit, errors, as_of: new Date().toISOString() });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
