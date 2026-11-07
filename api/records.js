// GET /api/history       and   GET /api/transactions
//
// Two read-only views of what the store holds, in one function. Vercel's Hobby
// plan allows 12 functions and every one was taken; /api/account needed a slot,
// so these two share this file. vercel.json rewrites both old paths here with
// ?kind=, so the app's URLs did not change.

import { authorize } from '../lib/plaid.js';
import { sbHeaders, rest, forUser } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.query.kind === 'history') return history(req, res);
  if (req.query.kind === 'transactions') return transactions(req, res);
  return res.status(404).json({ error: 'Not found' });
}

// ── /api/history ────────────────────────────────────────────────────────────
// GET /api/history?days=90
// Balance history per account, plus the closest earlier snapshot to compare
// today against. This is what turns "you owe X" into "you owe X, up Y since
// last month" -- the difference between a report and a sense of progress.


async function history(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  const days = Math.min(parseInt(req.query.days, 10) || 90, 730);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  try {
    const url =
      rest(`balance_snapshots?select=account_id,as_of,institution,name,type,subtype,current,available&${forUser(user)}`) +
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

// ── /api/transactions ───────────────────────────────────────────────────────
// GET /api/transactions?days=90&limit=500&q=term1,term2
// Serves stored transactions, newest first. Reads Supabase rather than Plaid,
// so this stays fast and works even if an institution is temporarily down.
// /api/sync is what refreshes the store.
// Optional `q` is a comma-separated list of terms; only transactions whose name
// contains any term are returned (used by the "Transfers to People" view to pull
// just the transfers over a long window, uncapped by the general row limit).


async function transactions(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

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
      rest(`plaid_transactions?select=transaction_id,account_id,institution,date,name,amount,currency,pending,category,category_label,channel&${forUser(user)}`) +
      `&date=gte.${sinceStr}${nameFilter}&order=date.desc&limit=${limit}`;

    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const transactions = await r.json();

    return res.status(200).json({ transactions, count: transactions.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
