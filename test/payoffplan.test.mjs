// node test/payoffplan.test.mjs
import { simulate, monthlyFor, buildPlan } from '../lib/payoffplan.js';

let ok = 0, bad = 0;
const check = (what, yes, more = '') => { if (yes) ok++; else { bad++; console.log('FAIL', what, more); } };
const start = new Date('2026-11-26T12:00:00Z');
const debts = [
  { name: 'Card A', balance: 10000, apr: 24 },
  { name: 'Card B', balance: 2000, apr: 30 },
];

// Interest is 2% a month on A: 10000 -> 200 the first month.
let r = simulate([{ name: 'X', balance: 10000, apr: 24 }], 1000, { start });
check('first month interest', r.schedule[0].payments[0].interest === 200, JSON.stringify(r.schedule[0]));
check('first payment next month', r.schedule[0].month === '2026-12');
check('clears', r.months > 10 && r.months < 13, r.months);

// Highest rate first: B clears before A.
r = simulate(debts, 1500, { start });
check('avalanche: B first', r.cleared['Card B'] < r.cleared['Card A'], JSON.stringify(r.cleared));
check('minimum still paid on A while B is attacked', r.schedule[0].payments.find((p) => p.debt === 'Card A').pay >= 25);

// A payment below the interest never clears.
r = simulate([{ name: 'X', balance: 10000, apr: 24 }], 150, { start });
check('never clears flagged', r.never === true && r.months === null);

// monthlyFor hits the target and not much less.
const m = monthlyFor(debts, 8, { start });
const at = simulate(debts, m, { start });
const under = simulate(debts, m - 60, { start, maxMonths: 8 });
check('monthly clears in 8', at.months <= 8, `${m} -> ${at.months}`);
check('and a bit less does not', under.months == null || under.months > 8, `${m - 60} -> ${under.months}`);

// Money set aside in a month (tuition) slows the plan.
const held = { '2027-01': 1000 };
check('set aside costs a month or interest', simulate(debts, 1500, { start, held }).total_interest > simulate(debts, 1500, { start }).total_interest);

// The plan from a goal.
let p = buildPlan(debts, { months: 8 }, { available: 1000, start });
check('needs more than available: not feasible', p.feasible === false && p.gap_a_month > 0, JSON.stringify({ f: p.feasible, g: p.gap_a_month, n: p.monthly_needed }));
check('finishes month given', p.finishes === '2027-07', p.finishes);
check('compares with what is available', p.at_money_available && p.at_money_available.months > 8, JSON.stringify(p.at_money_available));
check('order highest rate first', p.order[0] === 'Card B');
check('every month listed', p.schedule.length === p.months);
p = buildPlan(debts, { monthly: 2000 }, { available: 2500, start });
check('monthly goal feasible', p.feasible === true && p.gap_a_month === 0 && p.months > 0);
check('title names the amount', /2,000 a month/.test(p.title), p.title);
p = buildPlan([{ name: 'Only', balance: 0, apr: 20 }, ...debts], { months: 6 }, { start });
check('paid-off debts left out', p.debts.length === 2);

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
