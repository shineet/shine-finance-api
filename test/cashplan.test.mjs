// node test/cashplan.test.mjs
import { runCashPlan } from '../lib/cashplan.js';
import { labelOf } from '../lib/accounts.js';

let ok = 0, bad = 0;
const check = (what, yes, more = '') => { if (yes) ok++; else { bad++; console.log('FAIL', what, more); } };
const today = new Date('2026-11-26T12:00:00Z');

check('label checking', labelOf({ institution: 'Bank of America', type: 'depository', subtype: 'checking', mask: '1111' }) === 'Bank of America checking ending 1111');
check('label card', labelOf({ institution: 'Chase', type: 'credit', subtype: 'credit card', mask: '2222' }) === 'Chase card ending 2222');

const book = new Map([
  ['chase', { id: 'chase', label: 'Chase checking ending 0001', type: 'depository', current: 200, available: 200 }],
  ['bofa', { id: 'bofa', label: 'Bank of America checking ending 0002', type: 'depository', current: 3000, available: 3000 }],
  ['card', { id: 'card', label: 'Chase card ending 0003', type: 'credit', current: 990, limit: 1000 }],
]);
const ev = [
  { date: '2026-11-30', name: 'Salary', amount: 2000, account_id: 'chase' },
  { date: '2026-12-02', name: 'Mortgage', amount: -2500, account_id: 'chase' },
  { date: '2026-11-29', name: 'Car lease', amount: -1000, account_id: 'bofa' },
  { date: '2026-12-02', name: 'Rent', amount: -300, account_id: 'card' },
  { date: '2027-02-01', name: 'Far away', amount: -9999, account_id: 'bofa' },
];
let p = runCashPlan(book, ev, { today });
const chase = p.shortfalls.find((s) => s.account.startsWith('Chase checking'));
check('chase runs short on the mortgage', chase && chase.first_short_on === '2026-12-02' && chase.caused_by === 'Mortgage', JSON.stringify(p.shortfalls));
check('needs the gap', chase?.needs === 300, chase?.needs);
check('bofa is fine', !p.shortfalls.some((s) => s.account.startsWith('Bank of America')));
check('move from bofa to chase before the date', p.moves.length === 1 && p.moves[0].from.startsWith('Bank of America') && p.moves[0].to.startsWith('Chase checking') && p.moves[0].amount === 300 && p.moves[0].before === '2026-12-02', JSON.stringify(p.moves));
check('card with no room flagged', p.card_problems.length === 1 && p.card_problems[0].name === 'Rent' && p.card_problems[0].room_left === 10, JSON.stringify(p.card_problems));
check('outside the window ignored', !p.accounts.some((a) => a.events.some((e) => e.name === 'Far away')));

// The cushion counts: bofa can only spare down to it.
p = runCashPlan(book, ev, { today, cushion: 1800 });
const fromBofa = p.moves.filter((m) => m.from.startsWith('Bank of America')).reduce((t, m) => t + m.amount, 0);
check('never moves below the cushion', fromBofa <= 200, JSON.stringify(p.moves));
check('says what is still short', p.shortfalls.find((s) => s.account.startsWith('Chase checking'))?.still_short_after_moves > 0, JSON.stringify(p.shortfalls));

// Same day: the payment is drafted before the deposit clears.
const b2 = new Map([['x', { id: 'x', label: 'X', type: 'depository', current: 100 }]]);
p = runCashPlan(b2, [{ date: '2026-12-01', name: 'Pay', amount: 1000, account_id: 'x' }, { date: '2026-12-01', name: 'Bill', amount: -500, account_id: 'x' }], { today });
check('same-day bill before pay', p.shortfalls.length === 1 && p.shortfalls[0].caused_by === 'Bill', JSON.stringify(p.shortfalls));

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
