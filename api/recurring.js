// GET /api/recurring
// Recurring income and bills, used to work out what's genuinely spare.
//
// Plaid's Recurring Transactions is an add-on to the Transactions API and may
// not be enabled on every plan, so this falls back to deriving streams from
// the transactions already stored in Supabase. The response says which method
// produced the answer, since the fallback is rougher and the UI should say so.

import { plaid, authorize, listItems } from '../lib/plaid.js';
import { sbHeaders, rest, forUser } from '../lib/db.js';
import { detect, explain } from '../lib/subscriptions.js';
import { identify } from '../lib/merchants.js';
import { allRows } from '../lib/detected.js';
import { detectIncome } from '../lib/income.js';
import { accountBook } from '../lib/accounts.js';



function shapeStream(s, direction) {
  return {
    id: s.stream_id,
    account_id: s.account_id,
    description: s.merchant_name || s.description,
    direction,
    average_amount: Math.abs(s.average_amount?.amount ?? 0),
    last_amount: Math.abs(s.last_amount?.amount ?? 0),
    frequency: s.frequency || null,
    last_date: s.last_date || null,
    predicted_next_date: s.predicted_next_date || null,
    is_active: s.is_active ?? true,
    status: s.status || null,
    category: s.personal_finance_category?.primary || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  try {
    const items = await listItems(user);
    const inflows = [];
    const outflows = [];
    const errors = [];
    let source = 'plaid';

    await Promise.all(
      items.map(async (item) => {
        const institution = item.institution_name || item.item_id;
        try {
          const out = await plaid('/transactions/recurring/get', {
            access_token: item.access_token,
          });
          for (const s of out.inflow_streams || []) inflows.push(shapeStream(s, 'inflow'));
          for (const s of out.outflow_streams || []) outflows.push(shapeStream(s, 'outflow'));
        } catch (err) {
          errors.push({ institution, error: err.message, code: err.plaidCode });
        }
      })
    );

    // Why the banks' own detection said nothing, so the app can say it.
    const plaidSaid = errors.length
      ? { ok: false, reason: errors[0].code || errors[0].error || 'error', institutions: errors.map((e) => e.institution) }
      : { ok: inflows.length + outflows.length > 0, reason: inflows.length + outflows.length ? null : 'NO_STREAMS' };

    // Subscriptions and bills from the transactions themselves: two years, so a
    // yearly one has been seen twice. Each comes with every charge behind it.
    let subscriptions = [];
    let subscriptionsError = null;
    try {
      const rows = await allRows(user, 'transaction_id,account_id,institution,date,name,amount,category,pending', 760);
      subscriptions = identify(detect(rows));
      try { for (const e of explain(rows, subscriptions)) console.log('[subs-explain]', JSON.stringify(e)); } catch {}
      // Nothing came back from Plaid at all: what was found here is the
      // planner's bills, and income is inferred from the same rows.
      // Paydays: when the banks found none, read them from deposits into
      // checking and savings (one employer's changing IDs, same-day splits and
      // twice-a-month pay all handled; card credits never count).
      if (!inflows.length) {
        const book = await accountBook(user).catch(() => new Map());
        const cash = new Set([...book.values()].filter((a) => a.type === 'depository').map((a) => a.id));
        const year = rows.filter((r) => Date.now() - new Date(r.date).getTime() <= 365 * 86400000);
        for (const s of detectIncome(year, cash)) {
          const { payer, is_payroll, paydays_seen, ...stream } = s;
          inflows.push(stream);
        }
        if (inflows.length && source === 'plaid' && !outflows.length) source = 'inferred';
      }
      if (!outflows.length) {
        source = 'inferred';
        for (const s of subscriptions) {
          if (!s.is_active || s.kind === 'topup') continue;
          const { charges, kind, first_date, price_change, institution, known_as, about, ...stream } = s;
          outflows.push({ ...stream, id: s.id });
        }
      }
    } catch (err) {
      subscriptionsError = err.message;
    }

    const sortByAmount = (a, b) => b.average_amount - a.average_amount;
    return res.status(200).json({
      source,
      inflows: inflows.sort(sortByAmount),
      outflows: outflows.sort(sortByAmount),
      errors,
      detection: { plaid: plaidSaid, subscriptions: subscriptionsError },
      subscriptions,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
