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
console.log(`${n} passed`);
