// GET  /api/prefs          -> { key: value, ... }
// PUT  /api/prefs { key, value }
//
// Settings the user types in -- manual card rates, the cash cushion, expected
// income, scheduled payments. These belong to the person, not the device, so
// they live here rather than in each device's local storage.

import { authorize } from '../lib/plaid.js';

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

export default async function handler(req, res) {
  if (!authorize(req, res)) return;

  try {
    if (req.method === 'GET') {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/user_prefs?select=key,value`,
        { headers: sbHeaders() }
      );
      if (!r.ok) throw new Error(await r.text());
      const rows = await r.json();
      const out = {};
      for (const row of rows) out[row.key] = row.value;
      return res.status(200).json(out);
    }

    if (req.method === 'PUT') {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });

      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/user_prefs`, {
        method: 'POST',
        headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          key,
          value: value ?? null,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ saved: key });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
