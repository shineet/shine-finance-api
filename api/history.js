// GET /api/history?days=90
// Balance history per account, plus the closest earlier snapshot to compare
// today against. This is what turns "you owe X" into "you owe X, up Y since
// last month" -- the difference between a report and a sense of progress.

import { authorize } from '../lib/plaid.js';

const sbHeaders = () => ({
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  const days = Math.min(parseInt(req.query.days, 10) || 90, 730);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  try {
    const url =
      `${process.env.SUPABASE_URL}/rest/v1/balance_snapshots` +
      `?select=account_id,as_of,institution,name,type,subtype,current,available` +
      `&as_of=gte.${sinceStr}&order=as_of.asc&limit=5000`;

    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();

    // Roll up to a daily total split by asset vs debt, so the app can chart
    // net worth over time without recomputing per account.
    const byDate = new Map();
    for (const row of rows) {
      const day = row.as_of;
      if (!byDate.has(day)) byDate.set(day, { as_of: day, assets: 0, debts: 0 });
      const bucket = byDate.get(day);
      const value = Number(row.current) || 0;
      if (row.type === 'credit' || row.subtype === 'credit card') {
        bucket.debts += value;
      } else if (row.type === 'depository') {
        bucket.assets += value;
      }
    }

    const totals = [...byDate.values()]
      .sort((a, b) => (a.as_of < b.as_of ? -1 : 1))
      .map((d) => ({ ...d, net: d.assets - d.debts }));

    return res.status(200).json({
      snapshots: rows,
      totals,
      // How many distinct days we actually hold. The app says "collecting
      // history" rather than drawing a misleading one-point trend.
      days_recorded: totals.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
