// Everything Aura needs to answer "what is due, from which account, and is
// there enough": the accounts, the paydays, the bills (each in the account it
// comes out of), card payments (from the account that paid that card last),
// and what the person typed into the app (cushion, scheduled payments,
// expected income, homes and leases, goals).

import { sbHeaders, rest, forUser } from './db.js';
import { plaid, listItems } from './plaid.js';
import { accountBook } from './accounts.js';
import { allRows } from './detected.js';
import { detect } from './subscriptions.js';
import { identify } from './merchants.js';
import { detectIncome } from './income.js';

const SWIFT_EPOCH = 978307200; // the app's dates are seconds since 2001-01-01
export const fromSwift = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date((Number(v) + SWIFT_EPOCH) * 1000).toISOString().slice(0, 10);
};
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function loadPrefs(user) {
  const r = await fetch(rest(`user_prefs?select=key,value&${forUser(user)}`), { headers: sbHeaders() });
  if (!r.ok) return {};
  const out = {};
  for (const row of await r.json()) if (row.value != null) out[row.key] = row.value;
  return out;
}

/// Which cash account paid each card most recently, read from the payments
/// themselves ("Payment to Chase card ending 5678", "AMERICAN EXPRESS ACH PMT").
export function cardPayers(rows, book) {
  const payers = new Map();
  const cards = [...book.values()].filter((a) => a.type === 'credit');
  const cash = new Set([...book.values()].filter((a) => a.type === 'depository').map((a) => a.id));
  const outs = rows.filter((r) => Number(r.amount) < 0 && cash.has(r.account_id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const c of cards) {
    const bank = (c.institution || '').toLowerCase();
    const words = bank.includes('american express') ? ['american express', 'amex'] : bank ? [bank.split(' ')[0]] : [];
    // The card's last four in the description, or the bank's name with a
    // payment word (two cards at one bank can then share a payment, so the
    // recent ones are all listed and the newest decides).
    const hits = outs.filter((r) => {
      const n = (r.name || '').toLowerCase();
      if (c.mask && n.includes(c.mask)) return true;
      const otherMask = cards.some((o) => o !== c && o.mask && n.includes(o.mask));
      return !otherMask && words.some((w) => n.includes(w)) && /card|crd|pmt|payment|epay|autopay/.test(n);
    }).slice(0, 3);
    if (hits.length) payers.set(c.id, {
      account_id: hits[0].account_id, last_paid: hits[0].date, last_amount: round(-hits[0].amount),
      recent: hits.map((h) => ({ account_id: h.account_id, on: h.date, amount: round(-h.amount) })),
    });
  }
  return payers;
}

/// Card terms from the banks: minimum, due date, statement balance, APR.
export async function cardTerms(user) {
  const terms = new Map();
  const items = await listItems(user);
  await Promise.all(items.map(async (item) => {
    try {
      const out = await plaid('/liabilities/get', { access_token: item.access_token });
      for (const c of out.liabilities?.credit || []) {
        const purchase = (c.aprs || []).find((a) => a.apr_type === 'purchase_apr');
        terms.set(c.account_id, {
          minimum: c.minimum_payment_amount ?? null,
          due: c.next_payment_due_date ?? null,
          statement: c.last_statement_balance ?? null,
          apr: purchase?.apr_percentage ?? null,
          overdue: c.is_overdue ?? null,
        });
      }
    } catch {}
  }));
  return terms;
}

/// Plaid's own recurring streams (with the account each one uses), when the
/// bank offers them.
async function plaidStreams(user) {
  const items = await listItems(user);
  const inflows = [], outflows = [];
  await Promise.all(items.map(async (item) => {
    try {
      const r = await plaid('/transactions/recurring/get', { access_token: item.access_token });
      const shape = (s) => ({
        description: s.merchant_name || s.description, account_id: s.account_id,
        average_amount: Math.abs(s.average_amount?.amount ?? 0), last_amount: Math.abs(s.last_amount?.amount ?? 0),
        frequency: s.frequency, predicted_next_date: s.predicted_next_date, last_date: s.last_date,
        category: s.personal_finance_category?.primary || null, is_active: s.is_active !== false,
      });
      for (const s of r.inflow_streams || []) if (s.is_active !== false) inflows.push(shape(s));
      for (const s of r.outflow_streams || []) if (s.is_active !== false) outflows.push(shape(s));
    } catch {}
  }));
  return { inflows, outflows };
}

const STEP = { WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15, MONTHLY: 30, QUARTERLY: 91 };
/// Every date a stream lands on between today and `end`.
export function datesOf(s, today, end) {
  if (!s.predicted_next_date) return [];
  const out = [];
  let d = new Date(`${s.predicted_next_date}T12:00:00Z`);
  const step = STEP[s.frequency] || 30;
  const t0 = today.toISOString().slice(0, 10);
  for (let i = 0; i < 40 && d.toISOString().slice(0, 10) <= end; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso >= t0) out.push(iso);
    if (s.frequency === 'MONTHLY' || s.frequency === 'QUARTERLY') {
      const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + (s.frequency === 'QUARTERLY' ? 3 : 1)); d = n;
    } else if (s.frequency === 'SEMI_MONTHLY') {
      const dom = d.getUTCDate();
      d = dom <= 16 ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15, 12));
    } else d = new Date(d.getTime() + step * 864e5);
  }
  return out;
}

/// The whole picture for the next `days` days.
export async function moneyMap(user, { days = 30, today = new Date() } = {}) {
  const end = new Date(today.getTime() + days * 864e5).toISOString().slice(0, 10);
  const [book, prefs, rows, terms, pl] = await Promise.all([
    accountBook(user),
    loadPrefs(user).catch(() => ({})),
    allRows(user, 'transaction_id,account_id,institution,date,name,amount,category,pending', 760),
    cardTerms(user).catch(() => new Map()),
    plaidStreams(user).catch(() => ({ inflows: [], outflows: [] })),
  ]);
  const label = (id) => book.get(id)?.label || 'an account that is not linked';
  const cash = new Set([...book.values()].filter((a) => a.type === 'depository').map((a) => a.id));
  const excluded = new Set(Array.isArray(prefs.excludedCashAccounts) ? prefs.excludedCashAccounts : []);

  const income = pl.inflows.length ? pl.inflows : detectIncome(rows, cash, today);
  let bills = pl.outflows;
  if (!bills.length) {
    bills = identify(detect(rows)).filter((s) => s.is_active && s.kind !== 'topup').map((s) => ({
      description: s.known_as ? `${s.description} (${s.known_as})` : s.description,
      account_id: s.account_id, average_amount: s.average_amount, last_amount: s.last_amount,
      frequency: s.frequency, predicted_next_date: s.predicted_next_date, last_date: s.last_date, category: s.category, kind: s.kind,
    }));
  }

  const events = [];
  for (const s of income) for (const d of datesOf(s, today, end)) {
    events.push({ date: d, name: s.description, amount: round(s.average_amount), account_id: s.account_id, kind: 'income' });
  }
  for (const s of bills) for (const d of datesOf(s, today, end)) {
    events.push({ date: d, name: s.description, amount: -round(s.last_amount || s.average_amount), account_id: s.account_id, kind: s.kind === 'subscription' ? 'subscription' : 'bill', category: s.category });
  }
  // Card payments: the minimum, from the account that paid the card last time.
  const payers = cardPayers(rows, book);
  const cardsDue = [];
  for (const [id, t] of terms) {
    if (!t.due || t.due > end) continue;
    const payer = payers.get(id);
    const card = book.get(id);
    const row = {
      date: t.due, card: label(id), minimum: t.minimum, statement_balance: t.statement, balance_now: card?.current ?? null,
      apr: t.apr, overdue: t.overdue,
      usually_paid_from: payer ? label(payer.account_id) : null,
      last_paid: payer ? { on: payer.last_paid, amount: payer.last_amount } : null,
    };
    cardsDue.push(row);
    if (payer && t.minimum > 0 && t.due >= today.toISOString().slice(0, 10)) {
      events.push({ date: t.due, name: `${label(id)} minimum payment`, amount: -round(t.minimum), account_id: payer.account_id, kind: 'card payment' });
    }
  }
  // What the person told the app: scheduled payments and expected income have no account, so they are listed, not placed.
  const scheduled = (Array.isArray(prefs.scheduledExpenses) ? prefs.scheduledExpenses : []).map((x) => ({ label: x.label, amount: x.amount, date: fromSwift(x.date) }));
  const expected = (Array.isArray(prefs.expectedIncome) ? prefs.expectedIncome : []).map((x) => ({ label: x.label, amount: x.amount, date: fromSwift(x.date) }));
  const cushion = typeof prefs.cashBuffer === 'number' ? prefs.cashBuffer : Number(prefs.cashBuffer?.amount ?? 0) || 0;

  // Cash accounts the person left out of their cash (e.g. a child's account) still get bills, but are marked.
  for (const id of excluded) if (book.has(id)) book.get(id).left_out_of_cash = true;

  return { book, events, income, bills, cardsDue, scheduled, expected, cushion, prefs, rows, label, end };
}
