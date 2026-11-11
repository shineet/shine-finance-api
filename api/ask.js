// POST /api/ask  { "question": "did I buy anything on Amazon in the last 2 weeks?" }
//
// The "Ask" feature: a question in plain English about the signed-in user's own
// money, answered by Claude. Two tools are available to it:
//
//   search_transactions  -- a CLIENT tool run here, against this user's rows
//   only. Claude picks the filters (merchant, dates, amount, direction); it
//   never picks whose data. The query is always scoped with forUser(user), and
//   `user` comes from the bearer token, not from anything the question says, so
//   one person can only ever reach their own transactions.
//
//   web_search  -- Anthropic's server tool, for general knowledge the app does
//   not hold ("what is DistroKid"). Anthropic runs it; we just pass the turn
//   back when it pauses.
//
// Returns { answer, transactions }: the written reply, plus the full rows the
// search touched so the app can list them (tappable into the detail view).
//
// Privacy: this sends the user's transaction names, amounts and dates to
// Anthropic when they ask. That is disclosed in the app's privacy policy.

import { authorize } from '../lib/auth.js';
import { plaid, listItems } from '../lib/plaid.js';
import { sbHeaders, rest, forUser } from '../lib/db.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 6;

const SYSTEM = `You are the "Ask" assistant inside MyFinance, a personal finance app. You answer questions about the signed-in person's own money, in a warm, plain, concise way. Today is ${new Date().toISOString().slice(0, 10)}.

You have tools that see their REAL financial data. Reach for them instead of giving generic answers:
- get_balances: how much they have right now -- cash, credit-card debt, investments, net worth, available credit, and each account. Call this BEFORE giving any advice about what to do with cash, savings or debt, or any question about their overall position, so the answer fits their actual numbers.
- get_investments: whether their investments are doing well -- total value, cost basis, unrealized gain and percent, each holding's gain, and the recorded balance trend. Use for any question about investment returns, performance, gains or losses, or a specific holding. Lead with the real gain or percent rather than generic market averages; mention the note if cost basis is only partial.
- get_debt: credit-card debt with APR, minimum payment, due date and the avalanche payoff order. Use for paying down debt, which card first, payoff timelines, due dates or minimums. Quote the real APRs.
- get_cashflow: monthly income, spending and surplus. Use for how much they earn or make, whether they spend more than they earn, or what is left over each month.
- get_spending: spending broken down by category, optionally versus the previous period. Use for where their money goes, biggest expenses, spending on a category, or whether spending rose or fell.
- get_subscriptions: recurring charges and subscriptions, with the monthly total and any that went up. Use for what they are subscribed to, recurring charges, or finding things to cancel.
- get_bills: money due soon (card due dates and recurring bills within a window). Use for what is due, upcoming bills, next payment, or whether they can cover what is due before payday.
- get_net_worth_trend: how net worth has changed over time. Use for whether it is going up, how it changed over a period, or progress.
- search_transactions: what they bought, paid, earned or spent, or a specific charge. Amounts are signed: negative is money out (spending), positive is money in.
- web_search: general knowledge the app does not hold (what a merchant or company is, e.g. "what is DistroKid"). If the name also appears in their transactions, you may search those too to tie it to a charge.

Rules:
- Prefer their real numbers over generic guidance. If they ask what to do with spare cash, call get_balances (and search_transactions for their spending if it helps) and tailor the plan to their actual cash, card debt and balances. NEVER say you cannot see their balances -- you can, via get_balances.
- You can only ever see THIS person's data. If they ask about someone else's finances, say you can only look at their own accounts.
- Never invent a number, transaction, or date. If a tool returns nothing, say so plainly.
- Keep answers short. Lead with the direct answer. Use a few bullets only when listing. Do not dump every field; the app shows matching transactions beneath your answer.
- Write amounts as dollars, e.g. $42.17. Do not show negative signs; say "you spent $X", "you have $X", or "you owe $X".
- You are not a licensed financial advisor. For a big or irreversible decision, add one brief line to confirm with a professional. Do not lecture.`;

const TOOLS = [
  {
    name: 'search_transactions',
    description:
      "Search the signed-in user's own bank transactions. Returns matching rows newest first. Amounts are signed: negative = money out (spend), positive = money in. Use for any question about what they bought, paid, received or spent, or to look up a specific merchant.",
    input_schema: {
      type: 'object',
      properties: {
        name_contains: {
          type: 'string',
          description:
            "Case-insensitive substring of the merchant or description, e.g. 'amazon', 'adobe', 'distrokid'. Omit to match everything.",
        },
        days: {
          type: 'integer',
          description: 'How many days back from today to look, 1 to 730. Default 90.',
        },
        direction: {
          type: 'string',
          enum: ['spend', 'income', 'any'],
          description: 'spend = money out only, income = money in only, any = both. Default any.',
        },
        min_amount: { type: 'number', description: 'Smallest absolute dollar amount to include.' },
        max_amount: { type: 'number', description: 'Largest absolute dollar amount to include.' },
        limit: { type: 'integer', description: 'Max rows to return, 1 to 100. Default 50.' },
      },
    },
  },
  {
    name: 'get_balances',
    description:
      "Read the signed-in user's current balances from the latest daily snapshot: each account's balance, plus totals for cash, credit-card debt, investments, net worth and available credit. Use for any question about how much they have, their net worth or overall position, or what to do with cash, savings or debt. A credit account's 'current' is the amount OWED (a positive number); cash and investments are assets.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_investments',
    description:
      "Read the user's investment holdings live: total value, cost basis, unrealized gain and percent, each holding's value and gain, and the recorded balance trend over time. Use for any question about whether their investments are doing well, their returns, gains or losses, or a specific holding. Cost basis is provided by the bank and may be missing for some holdings, so the return can cover only part of the portfolio.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_debt',
    description:
      "Read the user's credit-card debt with the terms needed to plan payoff: each card's current balance, APR, minimum payment, due date and days until due, plus totals, the weighted-average APR, and the avalanche payoff order (highest APR first). Use for any question about paying down debt, which card to pay first, how long payoff will take, when a payment is due, or the minimum owed.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_cashflow',
    description:
      "Read the user's monthly money in versus out: regular income (from detected recurring deposits), average monthly spending and deposits over the last 90 days, and the estimated monthly surplus. Use for questions about how much they earn or make, whether they spend more than they earn, or what is left over each month.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_spending',
    description:
      "Break the user's spending down by category over a window, optionally compared with the previous equal-length period. Use for 'where does my money go', biggest expenses, how much on a category (dining, groceries, etc.), or whether spending went up or down. Transfers and card/loan payments are excluded.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days back to total, 1 to 365. Default 30.' },
        compare: { type: 'boolean', description: 'If true, also total the previous equal-length period for comparison. Default false.' },
      },
    },
  },
  {
    name: 'get_subscriptions',
    description:
      "List the user's recurring charges and subscriptions: each one's typical amount, how often it recurs, when it is next due, and whether the latest charge went up, plus the total per month. Use for 'what am I subscribed to', 'what recurring charges do I have', 'did a subscription go up', or finding things to cancel.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_bills',
    description:
      "List money going out soon: credit-card payment due dates (with the minimum) and recurring bills predicted to hit within the next N days (default 14), sorted by date, with a total. Use for 'what's due', 'what bills are coming up', 'when is my next payment', or 'do I have enough before payday'.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days ahead to look, 1 to 90. Default 14.' },
      },
    },
  },
  {
    name: 'get_net_worth_trend',
    description:
      "Read how the user's net worth has changed over time from recorded daily snapshots: the starting and latest value, the change and percent, and a sampled series. Net worth is all assets (cash, investments) minus all debts (cards, loans). Use for 'is my net worth going up', 'how has it changed this year', or progress over a period. Only covers the period since snapshots began.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days back to look, 7 to 1095. Default 180.' },
      },
    },
  },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
];

/// Reads this user's investment holdings live from Plaid and works out the
/// unrealized gain against cost basis, plus the recorded balance trend. This is
/// the one thing balances alone cannot answer: "are my investments doing well".
async function runInvestments(user) {
  const items = await listItems(user);
  const holdings = [];
  let value = 0;
  let costBasis = 0;
  let valueWithBasis = 0; // value of only the holdings that report a cost basis

  await Promise.all(
    items.map(async (item) => {
      try {
        const out = await plaid('/investments/holdings/get', { access_token: item.access_token });
        const securities = new Map((out.securities || []).map((s) => [s.security_id, s]));
        for (const h of out.holdings || []) {
          const v = Number(h.institution_value) || 0;
          const cb = h.cost_basis == null ? null : Number(h.cost_basis);
          value += v;
          if (cb != null) {
            costBasis += cb;
            valueWithBasis += v;
          }
          const sec = securities.get(h.security_id) || {};
          if (sec.is_cash_equivalent) continue; // cash sweep, not an investment return
          holdings.push({
            name: sec.name || sec.ticker_symbol || 'Holding',
            ticker: sec.ticker_symbol || null,
            value: round2(v),
            cost_basis: cb == null ? null : round2(cb),
            gain: cb == null ? null : round2(v - cb),
            gain_pct: cb && cb > 0 ? Math.round(((v - cb) / cb) * 1000) / 10 : null,
          });
        }
      } catch {
        // A bank with no investment product, or one that needs extra consent,
        // simply contributes nothing here.
      }
    })
  );

  holdings.sort((a, b) => (b.gain ?? -Infinity) - (a.gain ?? -Infinity));

  // Balance trend from the recorded daily snapshots of investment accounts --
  // the closest thing we have to "how much have they grown".
  let trend = null;
  try {
    const rows = await fetch(
      rest(`balance_snapshots?select=as_of,current&${forUser(user)}&type=eq.investment&order=as_of.asc&limit=4000`),
      { headers: sbHeaders() }
    ).then((r) => r.json());
    const byDate = new Map();
    for (const r of rows || []) byDate.set(r.as_of, (byDate.get(r.as_of) || 0) + (Number(r.current) || 0));
    const dates = [...byDate.keys()].sort();
    if (dates.length > 1) {
      const first = dates[0];
      const last = dates[dates.length - 1];
      trend = {
        from: first,
        from_value: round2(byDate.get(first)),
        to: last,
        to_value: round2(byDate.get(last)),
        days_recorded: dates.length,
      };
    }
  } catch {
    // Trend is a nicety; never fail the whole tool for it.
  }

  return {
    total_value: round2(value),
    cost_basis_covers_value: round2(valueWithBasis),
    total_cost_basis: costBasis ? round2(costBasis) : null,
    unrealized_gain: costBasis ? round2(valueWithBasis - costBasis) : null,
    unrealized_gain_pct: costBasis > 0 ? Math.round(((valueWithBasis - costBasis) / costBasis) * 1000) / 10 : null,
    holdings: holdings.slice(0, 25),
    recorded_trend: trend,
    note:
      valueWithBasis < value - 1
        ? 'Cost basis is missing for some holdings, so the gain figures cover only part of the portfolio.'
        : null,
  };
}

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/// A card can carry several APRs; the purchase APR applies to a carried
/// balance, so prefer it and fall back to the highest quoted.
function primaryApr(aprs = []) {
  const purchase = aprs.find((a) => a.apr_type === 'purchase_apr');
  if (purchase?.apr_percentage != null) return purchase.apr_percentage;
  const values = aprs.map((a) => a.apr_percentage).filter((v) => v != null);
  return values.length ? Math.max(...values) : null;
}

/// Normalise a recurring stream to a monthly figure so cadences can be summed.
function monthlyEquivalent(amount, frequency) {
  const a = Math.abs(Number(amount) || 0);
  switch ((frequency || 'MONTHLY').toUpperCase()) {
    case 'WEEKLY': return (a * 52) / 12;
    case 'BIWEEKLY': return (a * 26) / 12;
    case 'SEMI_MONTHLY':
    case 'SEMIMONTHLY': return a * 2;
    case 'QUARTERLY': return a / 3;
    case 'ANNUALLY':
    case 'YEARLY': return a / 12;
    default: return a;
  }
}

/// Credit-card debt with the terms that turn a balance into a payoff plan:
/// current balance (from the snapshot), APR, minimum payment and due date
/// (live from Plaid's liabilities product), plus an avalanche payoff order.
async function runDebt(user) {
  const { rows: snap } = await latestSnapshots(user);
  const cards = new Map(); // account_id -> card
  for (const a of snap) {
    if (a.type !== 'credit') continue;
    cards.set(a.account_id, {
      name: a.name,
      institution: a.institution,
      balance: round2(a.current),
      limit: a.limit == null ? null : round2(a.limit),
      apr: null,
      minimum_payment: null,
      due_date: null,
      days_until_due: null,
      last_statement_balance: null,
      is_overdue: null,
    });
  }

  const items = await listItems(user);
  await Promise.all(
    items.map(async (item) => {
      try {
        const out = await plaid('/liabilities/get', { access_token: item.access_token });
        for (const card of out.liabilities?.credit || []) {
          const c = cards.get(card.account_id) || {
            name: null,
            institution: item.institution_name || null,
            balance: null,
            limit: null,
          };
          c.apr = primaryApr(card.aprs);
          c.minimum_payment = card.minimum_payment_amount ?? null;
          c.due_date = card.next_payment_due_date ?? null;
          c.last_statement_balance = card.last_statement_balance ?? null;
          c.is_overdue = card.is_overdue ?? null;
          if (c.due_date) {
            c.days_until_due = Math.round((new Date(c.due_date) - new Date()) / 864e5);
          }
          cards.set(card.account_id, c);
        }
      } catch {
        // A bank without the liabilities product simply adds no terms.
      }
    })
  );

  const list = [...cards.values()].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  const totalOwed = list.reduce((s, c) => s + (c.balance || 0), 0);
  const totalMin = list.reduce((s, c) => s + (c.minimum_payment || 0), 0);
  const withApr = list.filter((c) => c.apr != null && c.balance);
  const aprBase = withApr.reduce((s, c) => s + c.balance, 0);
  const weightedApr = aprBase > 0 ? Math.round((withApr.reduce((s, c) => s + c.apr * c.balance, 0) / aprBase) * 10) / 10 : null;
  const payoffOrder = [...withApr]
    .sort((a, b) => b.apr - a.apr)
    .map((c) => ({ name: c.name, apr: c.apr, balance: c.balance }));

  return {
    cards: list,
    total_owed: round2(totalOwed),
    total_minimum_payment: round2(totalMin),
    weighted_avg_apr: weightedApr,
    payoff_order_highest_apr_first: payoffOrder,
    note: withApr.length < list.length ? 'APR is missing for some cards (the bank did not report it), so the payoff order covers only the cards that have it.' : null,
  };
}

/// Monthly money in versus out. Regular income is taken from Plaid's detected
/// recurring deposits (salary), spending from the last 90 days of
/// transactions. Both are approximate and labelled as such.
async function runCashflow(user) {
  // Regular income from recurring inflow streams.
  let regularIncome = 0;
  let hasRecurring = false;
  const items = await listItems(user);
  await Promise.all(
    items.map(async (item) => {
      try {
        const out = await plaid('/transactions/recurring/get', { access_token: item.access_token });
        for (const s of out.inflow_streams || []) {
          if (s.is_active === false) continue;
          hasRecurring = true;
          regularIncome += monthlyEquivalent(s.average_amount?.amount, s.frequency);
        }
      } catch {
        // No recurring product on this bank; fall back to transaction totals.
      }
    })
  );

  // Spending and all deposits over the last 90 days, averaged per month.
  const since = isoDaysAgo(90);
  const url =
    rest(`plaid_transactions?select=date,amount,category&${forUser(user)}`) +
    `&date=gte.${since}&order=date.desc&limit=5000`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  const SKIP = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
  let out90 = 0;
  let in90 = 0;
  for (const t of rows) {
    const amt = Number(t.amount) || 0;
    if (SKIP.has(t.category)) continue; // moving your own money is not income or spending
    if (amt < 0) out90 += -amt;
    else in90 += amt;
  }
  const spendingPerMonth = round2(out90 / 3);
  const depositsPerMonth = round2(in90 / 3);
  const income = hasRecurring ? round2(regularIncome) : depositsPerMonth;

  return {
    regular_monthly_income: hasRecurring ? round2(regularIncome) : null,
    all_deposits_per_month: depositsPerMonth,
    spending_per_month: spendingPerMonth,
    estimated_monthly_surplus: round2(income - spendingPerMonth),
    income_basis: hasRecurring ? 'detected recurring deposits (salary)' : 'average of all deposits over 90 days',
    window: 'spending and deposits averaged over the last 90 days; transfers between your own accounts and card/loan payments are excluded',
  };
}

/// Spending grouped by category over a window, optionally compared with the
/// previous equal-length window. Transfers and debt payments are excluded so
/// the breakdown reflects actual outgoings.
async function runSpending(user, input) {
  const days = Math.min(Math.max(parseInt(input.days, 10) || 30, 1), 365);
  const compare = !!input.compare;
  const lookback = compare ? days * 2 : days;
  const since = isoDaysAgo(lookback);
  const boundary = isoDaysAgo(days);

  const url =
    rest(`plaid_transactions?select=date,name,amount,category,category_label&${forUser(user)}`) +
    `&date=gte.${since}&amount=lt.0&order=date.desc&limit=5000`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();

  const SKIP = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
  const cur = new Map();
  const prev = new Map();
  let curTotal = 0;
  let prevTotal = 0;
  for (const t of rows) {
    if (SKIP.has(t.category)) continue;
    const spend = Math.abs(Number(t.amount) || 0);
    if (!spend) continue;
    const label = t.category_label || t.category || 'Uncategorised';
    if (t.date >= boundary) {
      cur.set(label, (cur.get(label) || 0) + spend);
      curTotal += spend;
    } else if (compare) {
      prev.set(label, (prev.get(label) || 0) + spend);
      prevTotal += spend;
    }
  }

  const categories = [...cur.entries()]
    .map(([name, total]) => {
      const row = { name, total: round2(total) };
      if (compare) row.previous_period = round2(prev.get(name) || 0);
      return row;
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  const result = {
    window_days: days,
    total_spent: round2(curTotal),
    categories,
    excludes: 'transfers between your own accounts and card/loan payments',
  };
  if (compare) {
    result.previous_period_days = days;
    result.previous_total_spent = round2(prevTotal);
  }
  return result;
}

/// Active recurring outflow streams from Plaid (subscriptions and bills), each
/// normalised to a monthly figure, with a flag when the last charge was higher
/// than its usual amount. Shared by get_subscriptions and get_bills.
async function fetchRecurringOutflows(user) {
  const items = await listItems(user);
  const streams = [];
  await Promise.all(
    items.map(async (item) => {
      try {
        const r = await plaid('/transactions/recurring/get', { access_token: item.access_token });
        for (const s of r.outflow_streams || []) {
          if (s.is_active === false) continue;
          const avg = Math.abs(s.average_amount?.amount ?? 0);
          const last = Math.abs(s.last_amount?.amount ?? 0);
          streams.push({
            name: s.merchant_name || s.description || 'Recurring charge',
            average: round2(avg),
            last_amount: round2(last),
            monthly: round2(monthlyEquivalent(avg, s.frequency)),
            frequency: s.frequency || null,
            next_date: s.predicted_next_date || null,
            category: s.personal_finance_category?.primary || null,
            went_up: avg > 0 && last > avg * 1.05,
          });
        }
      } catch {
        // No recurring product on this bank; it simply adds nothing.
      }
    })
  );
  return streams;
}

/// What the user is subscribed to / pays on a schedule.
async function runSubscriptions(user) {
  const streams = await fetchRecurringOutflows(user);
  streams.sort((a, b) => b.monthly - a.monthly);
  const totalMonthly = streams.reduce((s, x) => s + (x.monthly || 0), 0);
  return {
    count: streams.length,
    total_monthly: round2(totalMonthly),
    recurring_charges: streams.slice(0, 40),
    recently_went_up: streams
      .filter((s) => s.went_up)
      .map((s) => ({ name: s.name, average: s.average, last_amount: s.last_amount })),
    note: streams.length
      ? null
      : 'No recurring charges were detected. This bank plan may not provide recurring-transaction data.',
  };
}

/// Money going out in the near future: card payment due dates plus recurring
/// bills predicted to hit within the window.
async function runBills(user, input) {
  const days = Math.min(Math.max(parseInt(input.days, 10) || 14, 1), 90);
  const horizon = isoDaysAgo(-days); // today + days
  const today = isoDaysAgo(0);
  const upcoming = [];

  try {
    const debt = await runDebt(user);
    for (const c of debt.cards) {
      if (!c.due_date) continue;
      if (c.due_date <= horizon && (c.days_until_due == null || c.days_until_due >= -5)) {
        upcoming.push({
          date: c.due_date,
          name: `${c.name || c.institution || 'Card'} payment`,
          amount: c.minimum_payment,
          kind: 'card minimum payment',
          days_until: c.days_until_due,
          overdue: !!c.is_overdue,
        });
      }
    }
  } catch {
    // Liabilities unavailable; recurring bills below still populate the list.
  }

  try {
    const streams = await fetchRecurringOutflows(user);
    for (const s of streams) {
      if (s.next_date && s.next_date >= today && s.next_date <= horizon) {
        upcoming.push({
          date: s.next_date,
          name: s.name,
          amount: s.last_amount || s.average,
          kind: 'recurring bill',
          days_until: Math.round((new Date(s.next_date) - new Date()) / 864e5),
          category: s.category,
        });
      }
    }
  } catch {
    // Recurring unavailable; card dues above still populate the list.
  }

  upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const total = upcoming.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return {
    window_days: days,
    items: upcoming.slice(0, 40),
    total_due: round2(total),
    note: 'Card amounts are the minimum payment; recurring amounts are the last or typical charge. Both are estimates.',
  };
}

/// Net worth over time from the recorded daily snapshots. Net worth is all
/// assets (cash, investments) minus all debts (cards, loans), consistent with
/// get_balances. Only covers the period since snapshots began.
async function runNetWorthTrend(user, input) {
  const days = Math.min(Math.max(parseInt(input.days, 10) || 180, 7), 1095);
  const since = isoDaysAgo(days);
  const url =
    rest(`balance_snapshots?select=as_of,type,current&${forUser(user)}`) +
    `&as_of=gte.${since}&order=as_of.asc&limit=20000`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();

  const isDebt = (t) => t === 'credit' || t === 'loan';
  const byDate = new Map();
  for (const row of rows) {
    const d = row.as_of;
    if (!byDate.has(d)) byDate.set(d, { assets: 0, debts: 0 });
    const b = byDate.get(d);
    const v = Number(row.current) || 0;
    if (isDebt(row.type)) b.debts += v;
    else b.assets += v;
  }

  const series = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, b]) => ({ date, net: round2(b.assets - b.debts) }));
  if (!series.length) return { days_recorded: 0, note: 'No balance history recorded yet.' };

  const first = series[0];
  const last = series[series.length - 1];
  const change = round2(last.net - first.net);
  const changePct = first.net ? Math.round((change / Math.abs(first.net)) * 1000) / 10 : null;

  // Downsample to ~10 points so the model can describe the shape cheaply.
  const step = Math.max(1, Math.floor(series.length / 10));
  const sampled = series.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1].date !== last.date) sampled.push(last);

  return {
    days_recorded: series.length,
    from: first,
    to: last,
    change,
    change_pct: changePct,
    series: sampled,
    note: series.length < 2 ? 'Only one day of history so far; the trend needs more days to be meaningful.' : null,
  };
}

/// Reads this user's latest account balances and sums them into a plain
/// summary the model can give advice from. Source is balance_snapshots (written
/// on every app open), so it needs no live Plaid call. Scoped by forUser.
/// The newest balance snapshot per account. The most recent snapshot date
/// holds the live accounts' fresh balances; older dates also carry accounts
/// that have since been re-linked or removed, so only today's rows are kept.
async function latestSnapshots(user) {
  const url =
    rest(
      `balance_snapshots?select=account_id,institution,name,type,subtype,current,available,limit,as_of&${forUser(user)}`
    ) + '&order=as_of.desc&limit=500';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const all = await r.json();
  if (!all.length) return { as_of: null, rows: [] };
  const newest = all[0].as_of;
  const seen = new Set();
  const rows = [];
  for (const row of all) {
    if (row.as_of !== newest || seen.has(row.account_id)) continue;
    seen.add(row.account_id);
    rows.push(row);
  }
  return { as_of: newest, rows };
}

async function runBalances(user) {
  const { as_of: newest, rows } = await latestSnapshots(user);
  if (!rows.length) return { as_of: null, summary: null, accounts: [] };

  const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
  const isDebt = (t) => t === 'credit' || t === 'loan';
  let cash = 0, cardDebt = 0, investments = 0, otherAssets = 0, availableCredit = 0;
  const accounts = rows.map((a) => {
    const cur = Number(a.current) || 0;
    if (a.type === 'depository') cash += cur;
    else if (a.type === 'credit') {
      cardDebt += cur;
      if (a.limit != null) availableCredit += Number(a.limit) - cur;
    } else if (a.type === 'investment' || a.type === 'brokerage') investments += cur;
    else if (!isDebt(a.type)) otherAssets += cur;
    return {
      name: a.name,
      institution: a.institution,
      type: a.type,
      subtype: a.subtype,
      current: num(a.current),
      available: num(a.available),
      limit: num(a.limit),
    };
  });
  const assets = cash + investments + otherAssets;
  const debts = rows
    .filter((a) => isDebt(a.type))
    .reduce((s, a) => s + (Number(a.current) || 0), 0);
  const summary = {
    as_of: newest,
    cash: num(cash),
    credit_card_debt: num(cardDebt),
    investments: num(investments),
    other_assets: num(otherAssets),
    available_credit: num(availableCredit),
    net_worth: num(assets - debts),
  };
  return { as_of: newest, summary, accounts };
}

/// Runs one search_transactions call against this user's rows. Returns the full
/// rows (for the app) and a compact form (for the model).
async function runSearch(user, input) {
  const days = Math.min(Math.max(parseInt(input.days, 10) || 90, 1), 730);
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 100);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  let url =
    rest(
      `plaid_transactions?select=transaction_id,account_id,institution,date,name,amount,currency,pending,category,category_label,channel&${forUser(user)}`
    ) + `&date=gte.${sinceStr}&order=date.desc&limit=${limit}`;

  const term = (input.name_contains || '').trim();
  if (term) url += `&name=ilike.*${encodeURIComponent(term)}*`;

  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  let rows = await r.json();

  // direction and amount bounds are easier (and safe) to apply here than in the
  // PostgREST query, since amount is signed.
  const dir = input.direction || 'any';
  if (dir === 'spend') rows = rows.filter((t) => Number(t.amount) < 0);
  if (dir === 'income') rows = rows.filter((t) => Number(t.amount) > 0);
  if (typeof input.min_amount === 'number') rows = rows.filter((t) => Math.abs(Number(t.amount)) >= input.min_amount);
  if (typeof input.max_amount === 'number') rows = rows.filter((t) => Math.abs(Number(t.amount)) <= input.max_amount);

  // Compact view for the model: enough to reason and answer, no ids.
  const compact = rows.slice(0, limit).map((t) => ({
    date: t.date,
    name: t.name,
    amount: Number(t.amount),
    category: t.category_label || t.category || null,
    pending: t.pending || false,
  }));
  return { rows, compact };
}

async function callAnthropic(messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Ask is not configured yet.' });
  }

  const question = (req.body?.question || '').toString().trim();
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (question.length > 1000) return res.status(400).json({ error: 'That question is too long.' });

  const messages = [{ role: 'user', content: question }];
  const shown = new Map(); // transaction_id -> full row, in search order
  let nudged = false;      // whether we've already asked it to summarise

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callAnthropic(messages);
      console.log('[ask] turn', turn, reply.stop_reason, reply.content.map((b) => b.type).join('|'));
      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason === 'tool_use') {
        // Answer every client tool call; the web_search server tool is run by
        // Anthropic, so it is not in this list.
        const results = [];
        for (const block of reply.content) {
          if (block.type !== 'tool_use') continue;
          if (block.name === 'search_transactions') {
            try {
              const { rows, compact } = await runSearch(user, block.input || {});
              for (const row of rows) if (!shown.has(row.transaction_id)) shown.set(row.transaction_id, row);
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ count: compact.length, transactions: compact }),
              });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `search failed: ${err.message}`,
                is_error: true,
              });
            }
          } else if (block.name === 'get_balances') {
            try {
              const snapshot = await runBalances(user);
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(snapshot),
              });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `balances failed: ${err.message}`,
                is_error: true,
              });
            }
          } else if (block.name === 'get_investments') {
            try {
              const inv = await runInvestments(user);
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(inv),
              });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `investments failed: ${err.message}`,
                is_error: true,
              });
            }
          } else if (block.name === 'get_debt') {
            try {
              const debt = await runDebt(user);
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(debt) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `debt failed: ${err.message}`, is_error: true });
            }
          } else if (block.name === 'get_cashflow') {
            try {
              const cf = await runCashflow(user);
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(cf) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `cashflow failed: ${err.message}`, is_error: true });
            }
          } else if (block.name === 'get_spending') {
            try {
              const sp = await runSpending(user, block.input || {});
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(sp) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `spending failed: ${err.message}`, is_error: true });
            }
          } else if (block.name === 'get_subscriptions') {
            try {
              const subs = await runSubscriptions(user);
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(subs) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `subscriptions failed: ${err.message}`, is_error: true });
            }
          } else if (block.name === 'get_bills') {
            try {
              const bills = await runBills(user, block.input || {});
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(bills) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `bills failed: ${err.message}`, is_error: true });
            }
          } else if (block.name === 'get_net_worth_trend') {
            try {
              const trend = await runNetWorthTrend(user, block.input || {});
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(trend) });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: `net worth trend failed: ${err.message}`, is_error: true });
            }
          }
          // web_search is a server tool, run by Anthropic, not answered here.
        }
        if (results.length) {
          messages.push({ role: 'user', content: results });
          continue;
        }
        // tool_use with only server tools (web_search): fall through to resend.
      }

      if (reply.stop_reason === 'pause_turn' || reply.stop_reason === 'tool_use') {
        continue; // hand the turn back so Anthropic can run / finish the search
      }

      // end_turn (or anything else): collect the answer text and any citations.
      const answer = reply.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      // It gathered data but wrote no conclusion -- e.g. the previous turn was
      // truncated mid-tool-call. Ask once for a plain summary rather than
      // showing "could not find an answer" on top of a full data pull.
      if (!answer && !nudged) {
        nudged = true;
        messages.push({
          role: 'user',
          content:
            'Answer my question now in a few plain sentences, using what you already found. Do not call any more tools.',
        });
        continue;
      }

      const sources = [];
      for (const b of reply.content) {
        for (const c of b.citations || []) {
          if (c.url && !sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title });
        }
      }

      const transactions = [...shown.values()].slice(0, 25);
      return res.status(200).json({ answer: answer || "I could not find an answer to that.", sources, transactions });
    }

    return res.status(200).json({
      answer: 'That turned into a longer search than expected. Try asking it a simpler way.',
      sources: [],
      transactions: [...shown.values()].slice(0, 25),
    });
  } catch (err) {
    console.error('[ask]', err.message);
    return res.status(502).json({ error: 'Ask could not answer just now.' });
  }
}
