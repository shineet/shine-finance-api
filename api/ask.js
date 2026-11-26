// POST /api/ask  { "question": "did I buy anything on Amazon in the last 2 weeks?", "history": [{role, content}, ...] }
//   `history` is optional: the recent turns of the conversation, kept by the app (nothing is stored here).
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
import { loadDetected } from '../lib/detected.js';
import { cleanHistory, splitFollowups } from '../lib/askHistory.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 6;

const SYSTEM = `You are the "Ask" assistant inside MyFinance, a personal finance app. You answer questions about the signed-in person's own money, in a warm, plain, concise way. Today is ${new Date().toISOString().slice(0, 10)}.

The conversation may include earlier questions and answers. A follow-up such as "and the month before?" or "which of those was biggest?" refers to them, so use what was already said for what "that" means, but still call your tools for the figures themselves, which may have changed.

After your answer, on a new final line, add up to three short follow-up questions the person might ask next, in exactly this form (no other text on that line):
FOLLOWUPS: first question | second question | third question
Make each under 60 characters, phrased as the person would say it. Leave the line out when there is nothing natural to ask.

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

/// What the user is subscribed to: found in their own transactions (a steady
/// price on a steady schedule, still charged), the same list as the app's
/// Subscriptions screen. Bills are listed apart, never mixed in.
async function runSubscriptions(user) {
  const all = await loadDetected(user);
  const shape = (s) => ({
    name: s.description,
    probably: s.known_as || null,
    about: s.about || null,
    amount: s.average_amount,
    frequency: s.frequency,
    monthly: round2(monthlyOf(s)),
    last_paid: s.last_date,
    next_date: s.is_active ? s.predicted_next_date : null,
    since: s.first_date,
    times_charged: s.charges.length,
    price_change: s.price_change,
  });
  const subs = all.filter((s) => s.kind === 'subscription' && s.is_active).map(shape).sort((a, b) => b.monthly - a.monthly);
  const bills = all.filter((s) => s.kind === 'bill' && s.is_active).map(shape).sort((a, b) => b.monthly - a.monthly);
  const topups = all.filter((s) => s.kind === 'topup' && s.is_active).map((s) => ({ name: s.description, probably: s.known_as || null, usual_top_up: s.average_amount, times_a_month: s.times_a_month, about_monthly: s.monthly_spend, last_topped_up: s.last_date }));
  const stopped = all.filter((s) => s.kind === 'subscription' && !s.is_active).map((s) => ({ name: s.description, amount: s.average_amount, last_paid: s.last_date }));
  return {
    count: subs.length,
    total_monthly: round2(subs.reduce((t, x) => t + x.monthly, 0)),
    subscriptions: subs.slice(0, 50),
    bills_not_subscriptions: bills.slice(0, 30),
    top_ups: topups.slice(0, 20),
    stopped_recently: stopped.slice(0, 20),
    recently_went_up: subs.filter((s) => s.price_change).map((s) => ({ name: s.name, from: s.price_change.from, to: s.price_change.to, on: s.price_change.on })),
    note: subs.length ? 'Found in their transactions: the same company, about the same price, on a steady schedule. Bills (mortgage, loans, utilities, phone, insurance, tuition) and top-ups (a toll tag or card reloaded by a fixed amount when it runs low) are listed apart.' : 'No subscriptions were found in their transactions.',
  };
}

const monthlyOf = (s) => s.average_amount * ({ WEEKLY: 52 / 12, BIWEEKLY: 26 / 12, MONTHLY: 1, QUARTERLY: 1 / 3, SEMI_ANNUALLY: 1 / 6, ANNUALLY: 1 / 12 }[s.frequency] ?? 1);

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
    let streams = await fetchRecurringOutflows(user);
    // The banks' own detection said nothing: use what the transactions show.
    if (!streams.length) {
      streams = (await loadDetected(user)).filter((s) => s.is_active).map((s) => ({
        name: s.description, average: s.average_amount, last_amount: s.last_amount,
        next_date: s.predicted_next_date, category: s.category,
      }));
    }
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

// ── Personalised starter questions (GET /api/ask) ───────────────────────────
// Shown under the Ask box. Deterministic rules over the data we already hold,
// so there is no model call and no token cost. The app keeps a static list as
// a fallback if this returns nothing.

const COMMON_MERCHANTS = [
  'amazon', 'walmart', 'target', 'costco', 'uber', 'lyft', 'starbucks', 'mcdonald',
  'netflix', 'spotify', 'apple', 'google', 'paypal', 'venmo', 'zelle', 'chase',
  'wells fargo', 'bank of america', 'shell', 'exxon', 'chevron', 'kroger',
  'whole foods', 'doordash', 'instacart', 'heb', 'h-e-b',
];

function cardLabel(c) {
  const n = (c.institution || c.name || 'card').trim();
  return /card/i.test(n) ? n : `${n} card`;
}

/// A short, name-like recurring merchant the user might want explained -- the
/// "What is X?" starter. Skips big brands, numeric/reference strings and long
/// all-caps bank descriptors.
async function pickDistinctiveMerchant(user) {
  const since = isoDaysAgo(45);
  const url =
    rest(`plaid_transactions?select=name,amount,date&${forUser(user)}`) +
    `&amount=lt.0&date=gte.${since}&order=date.desc&limit=300`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  const counts = new Map();
  for (const t of rows) {
    const raw = (t.name || '').trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (COMMON_MERCHANTS.some((c) => lower.includes(c))) continue;
    if (/\d/.test(raw)) continue; // skip "VISAAUSTINBD3", refs, order numbers
    const tokens = raw.split(/\s+/);
    if (tokens.length > 2) continue;
    if (raw.length < 4 || raw.length > 20) continue;
    if (raw === raw.toUpperCase() && raw.length > 10) continue; // long bank descriptor
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [name, n] of counts) if (n > bestN) { best = name; bestN = n; }
  return best;
}

async function buildSuggestions(user) {
  const picks = [];
  const add = (s) => { if (s && !picks.includes(s)) picks.push(s); };

  let rows = [];
  try { rows = (await latestSnapshots(user)).rows; } catch {}
  const cards = rows.filter((r) => r.type === 'credit');
  const cardDebt = cards.reduce((s, c) => s + (Number(c.current) || 0), 0);
  const cash = rows.filter((r) => r.type === 'depository').reduce((s, c) => s + (Number(c.current) || 0), 0);
  const overLimit = cards.find((c) => c.limit != null && Number(c.current) > Number(c.limit));
  const hasInvest = rows.some((r) => r.type === 'investment');

  // Lead with whatever is most pressing in their actual numbers.
  if (overLimit) add(`How do I pay off my ${cardLabel(overLimit)} fastest?`);
  else if (cards.length > 1 && cardDebt > 0) add('Which card should I pay off first?');
  else if (cardDebt > 0) add('How do I pay down my card debt fastest?');

  if (hasInvest) add('Are my investments giving good returns?');
  if (cash > 0 && cash > cardDebt) add('What should I do with my spare cash?');

  try {
    const merchant = await pickDistinctiveMerchant(user);
    if (merchant) add(`What is ${merchant}?`);
  } catch {}

  add('What am I subscribed to?');
  add('Where did my money go last month?');
  add('Is my net worth going up?');

  // Pad to four from neutral defaults if the user has little data yet.
  for (const d of [
    'How much did I spend on groceries last month?',
    'Am I spending more than I earn?',
    'What bills are coming up this week?',
  ]) add(d);

  return picks.slice(0, 4);
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

// Added to the instructions when the question was SAID aloud: the answer will be read out, so it
// must be short, plain and speakable. The app also shortens what it speaks; this makes the answer
// itself suit the ear rather than relying on a cut.
const SPOKEN_NOTE = `

This question was spoken aloud and your answer will be read out loud by a voice, in a back and forth conversation. Talk the way a person would across a table. Lead with the answer. One to three short sentences, each one idea. Use contractions. No lists, no markdown, no tables, no headings, no brackets, no dashes, no abbreviations: write "about two hundred dollars", "a month", "December twelfth", "interest rate". Round amounts unless the exact figure was asked for. Do not repeat the question, and do not open with filler such as "great question" or "based on your data". If the full answer is a list of transactions, give the headline and say the details are on screen. Earlier turns are part of the same conversation, so "what about last month" or "and that one" refers back to them. The words come from speech recognition, which often writes a word that only SOUNDS like the one said ("dead" for "debt", "bounce" for "balance", "spear" for "spare", a shop's name spelled as ordinary words). Take the likeliest meaning for a personal finance app, answer that, and do not mention the mistake. If two meanings fit, ask one short question naming the likelier, such as "Did you mean your debt?". Never treat a misheard word as a feature of MyFinance, and never describe a feature you were not told about. Still add the FOLLOWUPS line.`;

const CANCEL_AGENT = `You cancel ONE subscription on the user's own account, in a browser inside their finance app. The user signed in themselves and is watching every step.
Each turn you get the page (address, title, visible text) and its clickable elements, each with an id, plus what you already did. Choose exactly ONE action.
Actions:
- "click": click element id, to move toward cancelling (account menu, memberships, manage, cancel, "continue to cancel", "no thanks", a reason for leaving, a custom drop-down or its option). Also use it to reach the sign-in page: if the user is plainly signed out (a "Sign in" or "Log in" link or button, no account details on the page), click that link so the sign-in form comes up.
- "choose": for a drop-down list (tag "select"), choose one of its options; put the exact option text in "option". Only for a reason for leaving or a step of cancelling.
- "confirm_final": the ONE click that actually ends the subscription (for example "Cancel membership", "Confirm cancellation", "End membership", "Turn off auto-renew"). Never use "click" for it: the app asks the user first.
- "need_user": the page wants the user: a sign-in form is showing (email, username or password boxes), a verification code, a puzzle or "verify you are human", choosing an account, or anything you must not do. Say what they need to do, for example "Sign in here, then tap Continue".
- "desktop": the page says to open it on a computer or desktop, or shows a cut-down mobile page with no account settings. The app switches to the desktop version of the site.
- "wait": the page is still loading.
- "done": the page says the subscription is cancelled or will end. Put the end date in "say" if shown.
- "failed": you cannot find a way after trying; say what you saw.
You have no tools: never write tool calls, only the JSON object.
Never close a menu or sidebar that may hold the account or settings link; open it instead.
Rules: never buy, upgrade, switch plan, pause instead of cancel, accept an offer or discount, change payment details, or delete the account. Decline offers to stay by choosing the option that continues cancelling. Never type anything. Do not repeat a click that did not change the page; try another way or say failed. If the page is not the right company or account, use need_user.
If the subscription is billed by Apple, Google or PayPal (the page says so, or says to cancel in the App Store), use need_user and say where to cancel.
Reply with ONLY one JSON object: {"action": "...", "id": number or null, "option": "for choose only", "say": "one short sentence for the user", "why": "a few words"}`;

/// The next step of a cancellation, from what the page shows. Only the page's visible text and clickable labels are sent,
/// never what is typed into a field.
async function nextCancelStep(b) {
  const page = b.page || {};
  const els = Array.isArray(page.elements) ? page.elements.slice(0, 150) : [];
  const lines = els.map((e) => `[${Number(e.id)}] ${String(e.tag || '').slice(0, 10)}${e.role ? '/' + String(e.role).slice(0, 12) : ''}: ${String(e.text || '').slice(0, 80)}${e.href ? ' -> ' + String(e.href).slice(0, 100) : ''}${Array.isArray(e.options) ? ' options: ' + e.options.slice(0, 15).map((o) => JSON.stringify(String(o).slice(0, 50))).join(', ') : ''}`);
  const history = (Array.isArray(b.history) ? b.history.slice(-12) : []).map((h) => `- ${String(h).slice(0, 160)}`).join('\n') || '- (nothing yet)';
  const content = `Subscription to cancel: ${String(b.name || '').slice(0, 80)} (${String(b.company || b.name || '').slice(0, 80)}), ${String(b.price || '').slice(0, 40)}.
How it is usually cancelled: ${String(b.how || 'unknown').slice(0, 300)}
Done so far:\n${history}
Page address: ${String(page.url || '').slice(0, 300)}
Page title: ${String(page.title || '').slice(0, 150)}
A password field is on the page: ${page.hasPassword ? 'yes' : 'no'}
A sign-in form (email or username box) is on the page: ${page.hasLoginForm ? 'yes' : 'no'}
Visible text:\n${String(page.text || '').slice(0, 5000)}
Clickable elements:\n${lines.join('\n')}`;
  const ask = async (extra) => {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: CANCEL_AGENT, messages: [{ role: 'user', content: content + extra }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const out = await res.json();
    return { stop: out.stop_reason, text: (out.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('') };
  };
  let { stop, text } = await ask('');
  // An empty answer, or a tool call it does not have: once more, stricter (Shine's CapCut, 2026-11-25).
  if (!/\{[\s\S]*"action"[\s\S]*\}/.test(text)) {
    console.log('[cancel_step] retry', JSON.stringify({ stop, text: text.slice(0, 200) }));
    ({ stop, text } = await ask('\n\nAnswer now with ONLY the JSON object described, starting with { and nothing else.'));
  }
  const m = text.match(/\{[\s\S]*\}/);
  let j = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { j = {}; }
  const said = String(j.action || '').toLowerCase();
  // Words a model may use for the same thing.
  const alias = { select: 'choose', pick: 'choose', press: 'click', tap: 'click', open: 'click', login: 'need_user', sign_in: 'need_user', complete: 'done', cancelled: 'done', confirm: 'confirm_final' };
  const actions = ['click', 'choose', 'confirm_final', 'need_user', 'desktop', 'wait', 'done', 'failed'];
  const action = actions.includes(said) ? said : alias[said] || 'failed';
  if (!actions.includes(said) && !alias[said]) console.log('[cancel_step] not understood', JSON.stringify({ stop, text: text.slice(0, 300) }));
  const n = Number(j.id);
  const id = Number.isInteger(n) && els.some((e) => Number(e.id) === n) ? n : null;
  if ((action === 'click' || action === 'confirm_final' || action === 'choose') && id === null) {
    console.log('[cancel_step] no element', JSON.stringify(text.slice(0, 300)));
    return { action: 'failed', id: null, say: 'I could not tell what to press next.', why: 'no element' };
  }
  const option = action === 'choose' && typeof j.option === 'string' ? j.option.slice(0, 80) : null;
  let host = ''; try { host = new URL(String(page.url || '')).host; } catch {}
  const label = id === null ? '' : String(els.find((e) => Number(e.id) === id)?.text || '').replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 60);
  console.log('[cancel_step]', JSON.stringify({ host, action, label, why: String(j.why || '').slice(0, 80), step: (b.history || []).length, elements: els.length, password: !!page.hasPassword }));
  return { action, id, option, say: typeof j.say === 'string' ? j.say.slice(0, 240) : '', why: typeof j.why === 'string' ? j.why.slice(0, 120) : '' };
}

/// How to cancel a subscription with this company: an email address that takes
/// cancellations, the cancel page, and where each was found. Web search only,
/// no user data is sent: just the name as it appears on a statement.
async function findCancelContact(name) {
  const system = `You find how to cancel a consumer subscription. Search the web. Prefer the company's own help or contact pages; a third-party guide only when the company says nothing. Reply with ONLY one JSON object, no other text:
{"company": "the company's real name", "email": "an email address that takes cancellation or account requests, or null", "email_source": "the URL where that address appears, or null", "email_official": true if that URL is the company's own site, "cancel_url": "the page where the subscription is cancelled online, or null", "how": "one short sentence: the usual way to cancel (for example in the app's settings, on the website, in Apple's or Google's subscriptions, by phone)"}
Never invent an address. If no address is published, use null.`;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: `How do I cancel a subscription that appears on my US card statement as "${name.replace(/"/g, '')}"?` }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const out = await res.json();
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let j = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { j = {}; }
  const email = typeof j.email === 'string' && /^[^@\s<>,;]+@[^@\s<>,;]+\.[A-Za-z]{2,}$/.test(j.email.trim()) ? j.email.trim() : null;
  const url = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  return {
    company: typeof j.company === 'string' ? j.company.slice(0, 80) : null,
    email, email_source: email ? url(j.email_source) : null, email_official: email ? j.email_official === true : false,
    cancel_url: url(j.cancel_url), how: typeof j.how === 'string' ? j.how.slice(0, 300) : null,
  };
}

async function callAnthropic(messages, spoken = false) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: spoken ? SYSTEM + SPOKEN_NOTE : SYSTEM, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await authorize(req, res);
  if (!user) return;

  // GET returns the personalised starter questions. No model call, so it works
  // even before the key is set, and never costs a token.
  if (req.method === 'GET') {
    try {
      return res.status(200).json({ suggestions: await buildSuggestions(user) });
    } catch (err) {
      console.error('[ask] suggestions', err.message);
      return res.status(200).json({ suggestions: [] }); // app falls back to its own defaults
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Ask is not configured yet.' });
  }

  // Cancel it for me: the next step on the page the person is looking at, signed in themselves.
  if (req.body?.mode === 'cancel_step') {
    try { return res.status(200).json(await nextCancelStep(req.body || {})); }
    catch (err) { console.error('[ask] cancel_step', err.message); return res.status(502).json({ error: 'Could not work out the next step just now.' }); }
  }

  // Cancel help: where this company takes cancellations, found by a web search.
  if (req.body?.mode === 'cancel_contact') {
    const name = (req.body?.name || '').toString().trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Name the company.' });
    try { return res.status(200).json(await findCancelContact(name)); }
    catch (err) { console.error('[ask] cancel_contact', err.message); return res.status(502).json({ error: 'Could not search just now.' }); }
  }

  const question = (req.body?.question || '').toString().trim();
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (question.length > 1000) return res.status(400).json({ error: 'That question is too long.' });

  // True when the app took the question by voice: the answer will be spoken, so it is asked to be short.
  const spoken = req.body?.spoken === true;

  // Earlier turns, kept by the app, come first. Stateless here: nothing is stored.
  const messages = [...cleanHistory(req.body?.history), { role: 'user', content: question }];
  const shown = new Map(); // transaction_id -> full row, in search order
  let nudged = false;      // whether we've already asked it to summarise

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callAnthropic(messages, spoken);
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
      const split = splitFollowups(answer);
      return res.status(200).json({
        answer: split.answer || "I could not find an answer to that.",
        followups: split.followups,
        sources,
        transactions,
      });
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
