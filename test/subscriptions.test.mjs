// node test/subscriptions.test.mjs
import { detect, merchantKey, isMovement, kindOf, dedupe, cadenceOf, monthly } from '../lib/subscriptions.js';

let ok = 0, bad = 0;
const check = (what, yes, more = '') => { if (yes) ok++; else { bad++; console.log('FAIL', what, more); } };
const today = new Date('2026-11-25T12:00:00Z');
const day = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const month = (n, d = 5) => { const t = new Date(Date.UTC(2026, 10 - n, d)); return t.toISOString().slice(0, 10); };
const tx = (date, name, amount, extra = {}) => ({ date, name, amount: -amount, category: 'ENTERTAINMENT', account_id: 'a1', institution: 'Chase', pending: false, ...extra });
const find = (f, name) => f.filter((s) => s.description === name);

// A plain monthly subscription
let rows = [0, 1, 2, 3, 4, 5].map((n) => tx(month(n), 'Netflix', 15.49));
let f = detect(rows, { today });
check('monthly found', find(f, 'Netflix').length === 1 && f[0].frequency === 'MONTHLY' && f[0].is_active, JSON.stringify(f));
check('next is a month after the last', f[0].predicted_next_date === '2026-12-05', f[0].predicted_next_date);
check('every charge listed, newest first', f[0].charges.length === 6 && f[0].charges[0].date === month(0));
check('kind subscription', f[0].kind === 'subscription');

// Groceries every week at different amounts: not a subscription
rows = Array.from({ length: 20 }, (_, i) => tx(day('2026-07-01', i * 7 + (i % 3)), 'H-E-B', 30 + (i * 37) % 90, { category: 'FOOD_AND_DRINK' }));
check('groceries are not a subscription', detect(rows, { today }).length === 0, JSON.stringify(detect(rows, { today })));
// Amazon shopping at random
rows = Array.from({ length: 40 }, (_, i) => tx(day('2026-05-01', i * 5 + (i * 7) % 4), 'Amazon', 10 + (i * 53) % 140, { category: 'GENERAL_MERCHANDISE' }));
check('shopping is not a subscription', detect(rows, { today }).length === 0, JSON.stringify(detect(rows, { today }).map((s) => s.average_amount)));
// ... but Prime at one price every month is, beside the shopping
rows = rows.concat([0, 1, 2, 3, 4].map((n) => tx(month(n, 12), 'Amazon Prime', 14.99, { category: 'GENERAL_MERCHANDISE' })));
check('Prime among the shopping', detect(rows, { today }).map((s) => s.description).join() === 'Amazon Prime');

// Several gym charges a month: the membership is found at its own price, not added up
rows = [0, 1, 2, 3].flatMap((n) => [tx(month(n, 13), '24 Hour Fitness', 39.28, { category: 'PERSONAL_CARE' }), tx(month(n, 13), '24 Hour Fitness', 3.79, { category: 'PERSONAL_CARE', account_id: 'a2' })]);
rows.push(tx(month(1, 20), '24 Hour Fitness', 76.5, { category: 'PERSONAL_CARE' }));
f = detect(rows, { today });
check('membership at its own price', f.some((s) => s.average_amount === 39.28 && s.frequency === 'MONTHLY'), JSON.stringify(f.map((s) => [s.average_amount, s.frequency])));
check('a one-off is not a subscription', !f.some((s) => s.average_amount === 76.5));
check('never weekly', !f.some((s) => s.frequency === 'WEEKLY'));

// PayPal and the bank debit behind it are one charge
rows = [0, 1, 2, 3].flatMap((n) => [tx(month(n, 5), 'Spotify', 23.8, { account_id: 'pp', institution: 'PayPal' }), tx(month(n, 5), 'Spotify', 23.8, { account_id: 'chk' })]);
f = detect(rows, { today });
check('PayPal twin counted once', f.length === 1 && f[0].charges.length === 4, JSON.stringify(f.map((s) => s.charges.length)));
check('PayPal days later still one', dedupe([{ day: 1, amount: 29.43, account_id: 'pp', paypal: true }, { day: 9, amount: 29.43, account_id: 'chk' }]).length === 1);
check('two cards, same day, same amount: one', dedupe([{ day: 1, amount: 9.99, account_id: 'x' }, { day: 1, amount: 9.99, account_id: 'y' }]).length === 1);
check('same card, two months: two', dedupe([{ day: 1, amount: 9.99, account_id: 'x' }, { day: 31, amount: 9.99, account_id: 'x' }]).length === 2);

// A price rise is one subscription with the change noted
rows = [5, 4, 3].map((n) => tx(month(n), 'Spotify', 11.99)).concat([2, 1, 0].map((n) => tx(month(n), 'Spotify', 13.99)));
f = detect(rows, { today });
check('price rise is one subscription', f.length === 1 && f[0].charges.length === 6 && f[0].average_amount === 13.99, JSON.stringify(f.map((s) => [s.average_amount, s.charges.length])));
check('and says so', f[0]?.price_change?.from === 11.99 && f[0]?.price_change?.to === 13.99, JSON.stringify(f[0]?.price_change));

// Stopped: no charge for three months
rows = [8, 7, 6, 5, 4].map((n) => tx(month(n), 'Hulu', 14.06));
f = detect(rows, { today });
check('stopped is not active', f.length === 1 && !f[0].is_active);

// A yearly one
rows = [tx('2024-12-02', 'Microsoft', 129.99), tx('2025-12-01', 'Microsoft', 129.99)];
f = detect(rows, { today });
check('yearly', f[0]?.frequency === 'ANNUALLY' && f[0].is_active && f[0].predicted_next_date === '2026-12-01', JSON.stringify(f));

// Bills
rows = [0, 1, 2, 3, 4].map((n) => tx(month(n, 20), 'TXU Energy', 180 + n * 40, { category: 'RENT_AND_UTILITIES' }));
f = detect(rows, { today });
check('a utility that varies is a bill', f.length === 1 && f[0].kind === 'bill' && f[0].frequency === 'MONTHLY', JSON.stringify(f));
check('mortgage is a bill', kindOf('Freedom Mortgage', 'LOAN_PAYMENTS') === 'bill');
check('Hyatt is not AT&T', kindOf('Hyatt Resorts', 'TRAVEL') === 'subscription' && kindOf('AT&T', null) === 'bill');
rows = [0, 1, 2].map((n) => tx(month(n, 3), 'Hyatt Resorts', 359, { category: 'TRAVEL' }));
check('a hotel is never a bill', !detect(rows, { today }).some((s) => s.kind === 'bill'));

// Movement
check('card payment is movement', isMovement('CHASE CREDIT CRD AUTOPAY', 'LOAN_PAYMENTS'));
check('PayPal repayment is movement', isMovement('PAYPAL INST XFER CREDIT REPAYMEN', null));
check('a transfer is movement', isMovement('Online transfer to savings', 'TRANSFER_OUT'));
check('Tesla autopay is not', !isMovement('TESLA AUTOPAY', 'LOAN_PAYMENTS'));
rows = [0, 1, 2, 3].map((n) => tx(month(n), 'CHASE CREDIT CRD AUTOPAY', 1200, { category: 'LOAN_PAYMENTS' }));
check('card payments never listed', detect(rows, { today }).length === 0);

// Names
check('PayPal prefix', merchantKey('PAYPAL *NETFLIX') === merchantKey('Netflix'), merchantKey('PAYPAL *NETFLIX'));
check('store numbers', merchantKey('SQ *OIL CHANGERS #123') === merchantKey('Oil Changers'), merchantKey('SQ *OIL CHANGERS #123'));

// Schedules
check('weekly needs week gaps', cadenceOf([0, 7, 14, 21])?.frequency === 'WEEKLY' && cadenceOf([0, 1, 2, 5, 9]) === null);
check('a skipped month is still monthly', cadenceOf([0, 30, 61, 122, 152])?.frequency === 'MONTHLY');
check('monthly costs', Math.abs(monthly({ average_amount: 120, frequency: 'ANNUALLY' }) - 10) < 0.001 && monthly({ average_amount: 10, frequency: 'MONTHLY' }) === 10);

console.log(`subscriptions: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
