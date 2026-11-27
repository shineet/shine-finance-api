// A pay-off plan from a goal: "clear my cards in 8 months" or "I can put
// $6,000 a month toward them". Month by month, highest interest rate first
// (avalanche), minimums on everything, interest applied before the payment
// the way issuers do it.
//
// Shine (2026-11-26): Aura should build the plan, but a long table is hard to
// read or hear, so she says the headline and offers to open or save it. The
// whole plan travels to the app next to her answer.

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const monthKey = (d) => d.toISOString().slice(0, 7);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));

/// The minimum a card asks for: the reported one, else 1% of the balance plus
/// that month's interest (the common US formula), never under $25.
function minimumOf(debt, balance, interest) {
  if (balance <= 0) return 0;
  const base = debt.minimum > 0 ? debt.minimum : balance * 0.01 + interest;
  return Math.min(balance, Math.max(25, base));
}

/// Runs the plan with a fixed monthly amount. `extra` is a map of month key ->
/// money that month cannot go to the cards (tuition and the like); a month
/// short of minimums still pays the minimums (that is the honest outcome).
export function simulate(debts, monthly, { start = new Date(), maxMonths = 120, held = {} } = {}) {
  const bal = debts.map((d) => Math.max(0, Number(d.balance) || 0));
  const schedule = [];
  const cleared = {};
  let totalInterest = 0;
  const first = addMonths(start, 1); // the first payment is next month
  for (let m = 0; m < maxMonths && bal.some((b) => b > 0.005); m++) {
    const when = addMonths(first, m);
    const key = monthKey(when);
    const rows = debts.map((d, i) => {
      const interest = bal[i] * ((Number(d.apr) || 0) / 100) / 12;
      bal[i] += interest;
      totalInterest += interest;
      return { i, interest };
    });
    let budget = Math.max(0, monthly - (held[key] || 0));
    const pay = debts.map(() => 0);
    // Minimums first, on every card.
    for (const { i, interest } of rows) {
      const min = minimumOf(debts[i], bal[i], interest);
      pay[i] = min;
      budget -= min;
    }
    // Then everything left at the highest rate.
    const order = debts.map((d, i) => i).filter((i) => bal[i] > 0).sort((a, b) => (Number(debts[b].apr) || 0) - (Number(debts[a].apr) || 0));
    for (const i of order) {
      if (budget <= 0) break;
      const room = bal[i] - pay[i];
      const amt = Math.min(room, budget);
      pay[i] += amt;
      budget -= amt;
    }
    const line = { month: key, payments: [], total_paid: 0, interest: 0, owed_after: 0 };
    for (const { i, interest } of rows) {
      if (bal[i] <= 0.005 && pay[i] <= 0) continue;
      bal[i] = Math.max(0, bal[i] - pay[i]);
      if (bal[i] <= 0.005 && !cleared[debts[i].name]) cleared[debts[i].name] = key;
      line.payments.push({ debt: debts[i].name, pay: round(pay[i]), interest: round(interest), balance_after: round(bal[i]) });
      line.total_paid += pay[i];
      line.interest += interest;
    }
    line.total_paid = round(line.total_paid);
    line.interest = round(line.interest);
    line.owed_after = round(bal.reduce((t, b) => t + b, 0));
    if (held[key]) line.set_aside = round(held[key]);
    schedule.push(line);
    // Interest outgrowing the payment: say so instead of running to the cap.
    if (m >= 3 && line.owed_after >= schedule[m - 3].owed_after) {
      return { months: null, never: true, schedule, cleared, total_interest: round(totalInterest) };
    }
  }
  const done = bal.every((b) => b <= 0.005);
  return { months: done ? schedule.length : null, never: !done, schedule, cleared, total_interest: round(totalInterest) };
}

/// The smallest monthly amount that clears everything within `months`.
export function monthlyFor(debts, months, opts = {}) {
  const owed = debts.reduce((t, d) => t + (Number(d.balance) || 0), 0);
  let lo = 0, hi = owed * 1.5 + 1000;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const r = simulate(debts, mid, { ...opts, maxMonths: months });
    if (r.months != null && r.months <= months) hi = mid; else lo = mid;
  }
  return Math.ceil(hi / 10) * 10;
}

/// The whole plan from a goal. `available` is the estimated money a month
/// that could go to the debts on top of normal life (may be null).
export function buildPlan(debts, goal, { available = null, held = {}, cuts = [], start = new Date(), notes = [] } = {}) {
  const live = debts.filter((d) => (Number(d.balance) || 0) > 1);
  const owed = round(live.reduce((t, d) => t + Number(d.balance), 0));
  let monthly, target = null;
  if (goal.months) {
    target = Math.max(1, Math.min(120, Math.round(goal.months)));
    monthly = monthlyFor(live, target, { start, held });
  } else {
    monthly = Math.max(0, Number(goal.monthly) || 0);
  }
  const run = simulate(live, monthly, { start, held });
  const minimumsNow = round(live.reduce((t, d) => t + minimumOf(d, Number(d.balance), Number(d.balance) * (Number(d.apr) || 0) / 1200), 0));
  const gap = available == null ? null : round(Math.max(0, monthly - available));
  const feasible = available == null ? null : monthly <= available + 1;
  const end = run.schedule.length ? run.schedule[run.schedule.length - 1].month : null;
  // What the same debts cost at the money actually available, for comparison.
  const atAvailable = available != null && available > 0 && Math.abs(available - monthly) > 50
    ? (() => { const r = simulate(live, available, { start, held }); return { monthly: round(available), months: r.months, finishes: r.months ? r.schedule[r.schedule.length - 1].month : null, total_interest: r.total_interest }; })()
    : null;
  return {
    title: target ? `Pay off ${live.length === 1 ? live[0].name : 'your cards'} in ${target} months` : `Pay off ${live.length === 1 ? live[0].name : 'your cards'} at ${Math.round(monthly).toLocaleString('en-US')} a month`,
    made_on: start.toISOString().slice(0, 10),
    goal: target ? { kind: 'months', months: target } : { kind: 'monthly', monthly },
    owed_now: owed,
    monthly_needed: round(monthly),
    minimums_now: minimumsNow,
    money_available_a_month: available == null ? null : round(available),
    feasible,
    gap_a_month: gap,
    months: run.months,
    never_clears: run.never,
    finishes: run.months ? end : null,
    total_interest: run.total_interest,
    debts: live.map((d) => ({ name: d.name, balance: round(d.balance), apr: d.apr ?? null, minimum: d.minimum ?? null, clears: run.cleared[d.name] || null })),
    order: [...live].sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0)).map((d) => d.name),
    at_money_available: atAvailable,
    cuts,
    set_aside: Object.entries(held).map(([month, amount]) => ({ month, amount: round(amount) })),
    schedule: run.schedule,
    notes,
  };
}
