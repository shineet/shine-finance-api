// History roll-ups. Run: node test/history.test.mjs (made-up accounts and figures).
import assert from 'node:assert/strict';
import { rollup, thin } from '../lib/history.js';

let n = 0; const ok = (name, f) => { f(); n++; console.log('ok', name); };
const row = (as_of, type, current, subtype) => ({ as_of, type, subtype, current });

ok('cash, investments and other add; cards and loans subtract', () => {
  const t = rollup([row('2026-01-01', 'depository', 1000), row('2026-01-01', 'investment', 5000),
    row('2026-01-01', 'credit', 300, 'credit card'), row('2026-01-01', 'loan', 2000), row('2026-01-01', 'other', 50)]);
  assert.equal(t.length, 1);
  assert.equal(t[0].assets, 1000); assert.equal(t[0].debts, 300);
  assert.equal(t[0].investments, 5000); assert.equal(t[0].loans, 2000);
  assert.equal(t[0].net, 1000 + 5000 + 50 - 300 - 2000);
});
ok('days come out in order', () => {
  const t = rollup([row('2026-01-03', 'depository', 1), row('2026-01-01', 'depository', 2), row('2026-01-02', 'depository', 3)]);
  assert.deepEqual(t.map((d) => d.as_of), ['2026-01-01', '2026-01-02', '2026-01-03']);
});
ok('thin keeps recent rows and only month starts and Mondays before', () => {
  const now = new Date('2026-06-30T12:00:00Z');
  const rows = [row('2026-06-20', 'depository', 1),            // recent: kept
    row('2026-01-01', 'depository', 1),                         // month start: kept
    row('2026-01-05', 'depository', 1),                         // a Monday: kept
    row('2026-01-07', 'depository', 1)];                        // Wednesday: dropped
  assert.deepEqual(thin(rows, now).map((r) => r.as_of), ['2026-06-20', '2026-01-01', '2026-01-05']);
});
ok('an account missing for a day is carried at its last balance, not zero, and the day is marked', () => {
  const r = (as_of, id, type, current) => ({ as_of, account_id: id, institution: 'Bank', name: id, type, current });
  const t = rollup([r('2026-03-10', 'ira', 'investment', 100000), r('2026-03-10', 'chk', 'depository', 5000),
    r('2026-03-11', 'chk', 'depository', 4800),
    r('2026-03-12', 'ira', 'investment', 101000), r('2026-03-12', 'chk', 'depository', 4700)]);
  const d11 = t.find((d) => d.as_of === '2026-03-11');
  assert.equal(d11.net, 104800); assert.equal(d11.filled, 1);
  assert.equal(t.find((d) => d.as_of === '2026-03-10').filled, 0);
});
ok('a bank re-linked under new ids is bridged by bank, name and type', () => {
  const r = (as_of, id, current) => ({ as_of, account_id: id, institution: 'Broker', name: 'IRA', type: 'investment', current });
  const c = (as_of) => ({ as_of, account_id: 'chk', institution: 'Bank', name: 'Checking', type: 'depository', current: 1000 });
  const t = rollup([r('2026-03-10', 'old', 50000), c('2026-03-10'), c('2026-03-11'), c('2026-03-12'), r('2026-03-13', 'new', 50500), c('2026-03-13')]);
  assert.equal(t.find((d) => d.as_of === '2026-03-11').net, 51000);
  assert.equal(t.find((d) => d.as_of === '2026-03-12').filled, 1);
});
ok('a real fall in a balance that reported is kept', () => {
  const r = (as_of, current) => ({ as_of, account_id: 'brk', institution: 'B', name: 'Brokerage', type: 'investment', current });
  const t = rollup([r('2026-10-01', 20000), r('2026-10-02', 12000), r('2026-10-03', 12500)]);
  assert.equal(t[1].net, 12000); assert.equal(t[1].filled, 0);
});
ok('an account that stopped for good is not carried forward', () => {
  const r = (as_of, id, current) => ({ as_of, account_id: id, institution: 'B', name: id, type: 'depository', current });
  const t = rollup([r('2026-10-01', 'a', 100), r('2026-10-01', 'b', 50), r('2026-10-02', 'a', 100), r('2026-10-03', 'a', 100)]);
  assert.equal(t[2].net, 100); assert.equal(t[2].filled, 0);
});
console.log(`${n} passed`);
