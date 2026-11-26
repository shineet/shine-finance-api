// Reading every transaction for the subscription finder, shared by the app's
// screen (api/recurring.js) and Aura (api/ask.js), so both say the same thing.
import { sbHeaders, rest, forUser } from './db.js';
import { detect } from './subscriptions.js';
import { identify } from './merchants.js';

export // Supabase hands back at most 1,000 rows a request: the old fallback read the
// OLDEST 1,000 of the year and so saw nothing after July. Read every page.
async function allRows(user, select, sinceDays, extra = '') {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  const out = [];
  for (let page = 0; page < 40; page++) {
    const url = rest(`plaid_transactions?select=${select}&${forUser(user)}`) +
      `&date=gte.${since.toISOString().slice(0, 10)}${extra}&order=date.desc,transaction_id.asc&limit=1000&offset=${page * 1000}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`transactions: ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.reverse();
}

/// Every subscription and bill found in the last two years of transactions.
export async function loadDetected(user) {
  return identify(detect(await allRows(user, 'transaction_id,account_id,institution,date,name,amount,category,pending', 760)));
}
