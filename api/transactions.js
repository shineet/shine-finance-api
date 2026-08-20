// GET /api/transactions?days=90&limit=500&q=term1,term2
// Serves stored transactions, newest first. Reads Supabase rather than Plaid,
// so this stays fast and works even if an institution is temporarily down.
// /api/sync is what refreshes the store.
// Optional `q` is a comma-separated list of terms; only transactions whose name
// contains any term are returned (used by the "Transfers to People" view to pull
// just the transfers over a long window, uncapped by the general row limit).

import { authorize } from '../lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  const days = Math.min(parseInt(req.query.days, 10) || 90, 730);
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Optional name filter: comma-separated terms, matched case-insensitively.
  const q = (req.query.q || '').trim();
  const terms = q ? q.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12) : [];
  let nameFilter = '';
  if (terms.length) {
    const ors = terms.map((t) => `name.ilike.*${encodeURIComponent(t)}*`).join(',');
    nameFilter = `&or=(${ors})`;
  }

  try {
    const url =
      `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions` +
      `?select=transaction_id,account_id,institution,date,name,amount,currency,pending,category,category_label,channel` +
      `&date=gte.${sinceStr}${nameFilter}&order=date.desc&limit=${limit}`;

    const r = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!r.ok) throw new Error(await r.text());
    const transactions = await r.json();

    return res.status(200).json({ transactions, count: transactions.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
