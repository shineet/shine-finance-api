// node test/income.test.mjs
import { detectIncome, payerKey } from '../lib/income.js';

let ok = 0, bad = 0;
const check = (what, yes, more = '') => { if (yes) ok++; else { bad++; console.log('FAIL', what, more); } };
const today = new Date('2026-11-26T12:00:00Z');
const cash = new Set(['chk', 'bofa']);
const dep = (date, name, amount, account_id = 'chk', extra = {}) => ({ date, name, amount, account_id, pending: false, category: 'INCOME', ...extra });

// Description shapes seen on real statements (amounts are made up).
check('acme key', payerKey('ACME WIDGETS DES:PAYROLL ID:XXXXX1234567JGM INDN:JANE') === 'acme widgets payroll', payerKey('ACME WIDGETS DES:PAYROLL ID:XXXXX1234567JGM INDN:JANE'));
check('acme key, other wording', payerKey('ACH CREDIT ACME WIDGETS PAYROLL ON 11/26') === 'acme widgets payroll', payerKey('ACH CREDIT ACME WIDGETS PAYROLL ON 11/26'));
check('globex key', payerKey('GLOBEX INC PAYROLL PPD ID: 5550001111') === 'globex payroll', payerKey('GLOBEX INC PAYROLL PPD ID: 5550001111'));

// Twice a month, with two deposits on one day and the 15th moved to a Friday.
const b = 'GLOBEX INC PAYROLL PPD ID: 5550001111';
let rows = [
  dep('2026-09-30', b, 1000), dep('2026-09-30', b, 600),
  dep('2026-10-15', b, 1000), dep('2026-10-30', b, 990), dep('2026-11-13', b, 1020),
];
let f = detectIncome(rows, cash, today);
check('semi-monthly found', f.length === 1 && f[0].frequency === 'SEMI_MONTHLY', JSON.stringify(f));
check('next is the month end', f[0]?.predicted_next_date === '2026-11-30', f[0]?.predicted_next_date);
check('a same-day bonus does not set the usual amount', f[0]?.average_amount >= 990 && f[0]?.average_amount <= 1020, f[0]?.average_amount);
check('lands in checking', f[0]?.account_id === 'chk');
check('payroll flagged', f[0]?.is_payroll === true);

// Every two weeks, a new ID in every description.
const ids = ['1234567', '2345678', '3456789', '4567890', '5678901'];
rows = ['2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13'].map((d, i) =>
  dep(d, `ACME WIDGETS DES:PAYROLL ID:XXXXX${ids[i]}JGM INDN:JANE`, 500, 'bofa'));
rows.push(dep('2026-11-26', 'ACH CREDIT ACME WIDGETS PAYROLL ON 11/26', 520, 'bofa'));
f = detectIncome(rows, cash, today);
check('biweekly found despite changing ids', f.length === 1 && f[0].frequency === 'BIWEEKLY', JSON.stringify(f));
check('next two weeks on', f[0]?.predicted_next_date === '2026-12-10', f[0]?.predicted_next_date);
check('in the other bank', f[0]?.account_id === 'bofa');

// A card credit is not income; refunds and travel credits on a card are ignored.
rows = ['2026-09-01', '2026-09-15', '2026-09-29', '2026-10-13'].map((d) => dep(d, 'NAACH ROOMM LLC', 80, 'card'));
check('card credits ignored', detectIncome(rows, cash, today).length === 0);

// Stopped pay is not a future payday.
rows = ['2026-05-01', '2026-05-15', '2026-05-29', '2026-06-12'].map((d) => dep(d, 'OLD EMPLOYER PAYROLL', 900));
check('stopped pay dropped', detectIncome(rows, cash, today).length === 0);

// Random transfers from people are not a rhythm.
rows = [dep('2026-09-03', 'Zelle from A', 50), dep('2026-09-20', 'Zelle from A', 300), dep('2026-11-02', 'Zelle from A', 20)];
check('irregular transfers dropped', detectIncome(rows, cash, today).length === 0);

// Monthly rent received.
rows = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-02'].map((d) => dep(d, 'TENANT RENT', 1200));
f = detectIncome(rows, cash, today);
check('monthly found', f[0]?.frequency === 'MONTHLY' && f[0]?.predicted_next_date >= '2026-12-01', JSON.stringify(f));

// A pending deposit counts as the latest payday, but never beside its posted twin.
const base = [dep('2026-10-02', b, 1000), dep('2026-10-16', b, 1000), dep('2026-10-30', b, 1000)];
f = detectIncome(base.concat([dep('2026-11-13', b, 1000, 'chk', { pending: true })]), cash, today);
check('pending payday counted', f[0]?.last_date === '2026-11-13' && f[0]?.paydays_seen === 4, JSON.stringify(f));
f = detectIncome(base.concat([dep('2026-11-13', b, 1000), dep('2026-11-13', b, 1000, 'chk', { pending: true })]), cash, today);
check('pending twin not added', f[0]?.last_amount === 1000, JSON.stringify(f));

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
