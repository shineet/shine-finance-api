// "Charge worth a look" notices: a fresh charge far above what that person
// usually pays the merchant, a large first-ever charge, or the same charge
// twice. Strict on purpose, since a notice that cries wolf gets muted, and with
// no amounts in the text, same as the deposit notices: it lands on a lock
// screen. The app has the figure and the same checks, so the tap shows why.

import { pushAll } from './push.js';
import { sbHeaders, rest, forUser } from './db.js';

const CAP = 3;                 // most charges named in one run
const MIN_SPIKE = 100;         // dollars: smaller surprises are not worth a buzz
const MIN_FIRST = 500;         // dollars: a first-ever charge must be big
const MIN_DUP = 40;

// Money that moves rather than gets spent never counts.
const NOT_SPENDING = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);

export const keyOf = (name) =>
  String(name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const dayMs = 86400000;
const t = (d) => new Date(`${d}T12:00:00Z`).getTime();

/// Pure: should this charge trigger a notice? `priors` are that person's EARLIER
/// outflows to the same merchant (amounts positive), `others` any same-merchant
/// rows other than this one (for the duplicate check). Returns a reason or null.
export function judge(charge, priors, others, { deepHistory }) {
  const amount = Math.abs(charge.amount);
  if (priors.length >= 4) {
    const med = median(priors.map((p) => Math.abs(p.amount)));
    if (med > 0 && amount >= Math.max(med * 3, med + 75) && amount >= MIN_SPIKE) return 'spike';
  } else if (priors.length === 0 && deepHistory && amount >= MIN_FIRST) {
    return 'first';
  }
  if (amount >= MIN_DUP) {
    const twin = others.find((o) =>
      Math.abs(Math.abs(o.amount) - amount) < 0.005 &&
      o.account_id === charge.account_id &&
      Math.abs(t(o.date) - t(charge.date)) <= 2 * dayMs);
    if (twin) return 'duplicate';
  }
  return null;
}

async function optedOut(userId) {
  try {
    const r = await fetch(rest(`user_prefs?select=value&key=eq.chargeAlerts&${forUser(userId)}&limit=1`),
      { headers: sbHeaders() });
    if (!r.ok) return false;
    const row = (await r.json())[0];
    return row?.value === false;
  } catch { return false; }
}

async function history(userId, run) {
  const since = new Date(Date.now() - 740 * dayMs).toISOString().slice(0, 10);
  const r = await fetch(
    rest(`plaid_transactions?select=transaction_id,account_id,date,amount,name&${forUser(userId)}`) +
    `&amount=lt.0&name=ilike.*${encodeURIComponent(run)}*&date=gte.${since}&order=date.desc&limit=300`,
    { headers: sbHeaders() });
  return r.ok ? r.json() : [];
}

async function earliestDate(userId) {
  const r = await fetch(
    rest(`plaid_transactions?select=date&${forUser(userId)}&order=date.asc&limit=1`),
    { headers: sbHeaders() });
  const row = r.ok ? (await r.json())[0] : null;
  return row?.date || null;
}

/// Looks at one Item's fresh sync and notices the few charges worth a look.
/// Quiet for a first sync or a rebuild, which hand over history, not news.
export async function announceUnusualCharges(item, result) {
  if (!result.fresh || !result.added.length) return 0;
  if (await optedOut(item.user_id)) return 0;

  const cutoff = new Date(Date.now() - 4 * dayMs).toISOString().slice(0, 10);
  const candidates = result.added.filter((x) =>
    typeof x.amount === 'number' && x.amount > 0 &&          // Plaid: outflow positive
    !x.pending && String(x.date) >= cutoff &&
    !NOT_SPENDING.has(x.personal_finance_category?.primary || ''));
  if (!candidates.length) return 0;

  const earliest = await earliestDate(item.user_id);
  const deepHistory = !!earliest && t(earliest) <= Date.now() - 120 * dayMs;

  const flagged = [];
  for (const c of candidates) {
    const name = c.merchant_name || c.name;
    const key = keyOf(name);
    const run = (String(name).match(/[A-Za-z]{4,}/) || [''])[0];
    if (key.length < 4 || !run) continue;
    const rows = (await history(item.user_id, run)).filter((r) => keyOf(r.name) === key);
    const charge = { amount: -c.amount, date: c.date, account_id: c.account_id };
    const priors = rows.filter((r) => r.transaction_id !== c.transaction_id && r.date < c.date);
    const others = rows.filter((r) => r.transaction_id !== c.transaction_id);
    const reason = judge(charge, priors, others, { deepHistory });
    if (reason) flagged.push({ c, name: String(name).slice(0, 40), reason });
    if (flagged.length >= CAP) break;
  }
  if (!flagged.length) return 0;

  const first = flagged[0];
  const title = flagged.length === 1
    ? (first.reason === 'duplicate' ? 'Possible double charge' : 'Unusual charge')
    : 'Charges worth a look';
  const body = flagged.length === 1
    ? `Check the charge at ${first.name} on ${item.institution_name || 'your account'}`
    : `${flagged.length} charges, including ${first.name}`;
  console.log(`[alerts] ${item.institution_name}: ${flagged.map((f) => f.reason).join(',')}`);
  return pushAll(item.user_id, title, body, {
    txn: String(first.c.transaction_id),
    date: String(first.c.date),
  });
}
