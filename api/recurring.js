// GET /api/recurring
// Recurring income and bills, used to work out what's genuinely spare.
//
// Plaid's Recurring Transactions is an add-on to the Transactions API and may
// not be enabled on every plan, so this falls back to deriving streams from
// the transactions already stored in Supabase. The response says which method
// produced the answer, since the fallback is rougher and the UI should say so.

import { plaid, authorize, listItems } from '../lib/plaid.js';

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

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

// ── Fallback: infer streams from stored transactions ────────────────────────
// Groups by merchant name and looks for a steady cadence. Deliberately
// conservative: it only reports a stream after three sightings, because two
// coincidental charges are not a pattern.
function inferStreams(rows) {
  const byName = new Map();
  for (const row of rows) {
    const key = (row.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }

  const streams = [];
  for (const [, group] of byName) {
    if (group.length < 3) continue;
    group.sort((a, b) => (a.date < b.date ? -1 : 1));

    const gaps = [];
    for (let i = 1; i < group.length; i++) {
      const days = (new Date(group[i].date) - new Date(group[i - 1].date)) / 86400000;
      gaps.push(days);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Reject irregular spacing: a genuine bill lands on a rhythm.
    const spread = Math.max(...gaps) - Math.min(...gaps);
    if (spread > Math.max(avgGap * 0.6, 6)) continue;

    let frequency = null;
    if (avgGap <= 9) frequency = 'WEEKLY';
    else if (avgGap <= 18) frequency = 'BIWEEKLY';
    else if (avgGap <= 45) frequency = 'MONTHLY';
    else if (avgGap <= 120) frequency = 'QUARTERLY';
    else frequency = 'ANNUALLY';

    const amounts = group.map((g) => Math.abs(Number(g.amount) || 0));
    const average = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const last = group[group.length - 1];
    const next = new Date(last.date);
    next.setDate(next.getDate() + Math.round(avgGap));

    streams.push({
      id: `inferred:${last.account_id}:${(last.name || '').slice(0, 40)}`,
      account_id: last.account_id,
      description: last.name,
      direction: Number(last.amount) > 0 ? 'inflow' : 'outflow',
      average_amount: average,
      last_amount: Math.abs(Number(last.amount) || 0),
      frequency,
      last_date: last.date,
      predicted_next_date: next.toISOString().slice(0, 10),
      is_active: true,
      status: 'INFERRED',
      category: last.category || null,
    });
  }
  return streams;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    const items = await listItems();
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

    // Nothing came back from Plaid at all -- fall back to inference rather
    // than leaving the planner with no income or bills to work from.
    if (!inflows.length && !outflows.length) {
      source = 'inferred';
      const since = new Date();
      since.setDate(since.getDate() - 365);
      const url =
        `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions` +
        `?select=account_id,date,name,amount,category&date=gte.${since.toISOString().slice(0, 10)}` +
        `&order=date.asc&limit=2000`;
      const r = await fetch(url, { headers: sbHeaders() });
      if (r.ok) {
        const rows = await r.json();
        for (const s of inferStreams(rows)) {
          (s.direction === 'inflow' ? inflows : outflows).push(s);
        }
      }
    }

    const sortByAmount = (a, b) => b.average_amount - a.average_amount;
    return res.status(200).json({
      source,
      inflows: inflows.sort(sortByAmount),
      outflows: outflows.sort(sortByAmount),
      errors,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
