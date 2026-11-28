// Balance history roll-ups for /api/history (api/records.js), kept apart so they can be tested.

// One total per day. Counted the way the app counts today's net worth, so a change over time compares like with
// like: cash, investments and anything else owned add; cards and loans subtract. assets/debts keep their old meaning
// (cash and cards) for the screens that chart them.
// An account that misses a day but reports before and after it did not drop to zero: a failed sync, or a bank
// re-linked under new account ids, which drew a large fall and a recovery days later. Its last balance
// stands in, and the day says how many accounts were filled, so the app can mark it instead of hiding it. Accounts are
// matched by id, and across a re-link by bank + name + type. A genuine fall in a balance that DID report is left alone.
export function fillGaps(rows) {
  const days = [...new Set(rows.map((r) => r.as_of))].sort();
  const keyOf = (r) => [r.institution || '', r.name || '', r.type || '', r.subtype || ''].join('|');
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.account_id)) byId.set(r.account_id, new Map());
    byId.get(r.account_id).set(r.as_of, r);
  }
  const out = [...rows];
  const filled = new Map();   // day -> count
  const present = new Map();  // day -> Set of keys present
  const addPresent = (day, key) => { if (!present.has(day)) present.set(day, new Set()); present.get(day).add(key); };
  for (const r of rows) addPresent(r.as_of, keyOf(r));
  // 1. Gaps inside one account id.
  for (const [, m] of byId) {
    const mine = [...m.keys()].sort();
    if (mine.length < 2) continue;
    let last = m.get(mine[0]);
    for (const day of days) {
      if (day <= mine[0] || day >= mine[mine.length - 1]) continue;
      if (m.has(day)) { last = m.get(day); continue; }
      out.push({ ...last, as_of: day, filled: true });
      filled.set(day, (filled.get(day) || 0) + 1);
      addPresent(day, keyOf(last));
    }
  }
  // 2. A whole account missing across a re-link: same bank, name and type, absent between its old and new ids.
  const byKey = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, new Map());
    const m = byKey.get(k);
    if (!m.has(r.as_of)) m.set(r.as_of, []);
    m.get(r.as_of).push(r);
  }
  for (const [k, m] of byKey) {
    const mine = [...m.keys()].sort();
    if (mine.length < 2) continue;
    let last = m.get(mine[0]);
    for (const day of days) {
      if (day <= mine[0] || day >= mine[mine.length - 1]) continue;
      if (m.has(day)) { last = m.get(day); continue; }
      if (present.get(day)?.has(k)) continue;
      for (const r of last) out.push({ ...r, as_of: day, filled: true });
      filled.set(day, (filled.get(day) || 0) + last.length);
      addPresent(day, k);
    }
  }
  return { rows: out, filled };
}

export function rollup(rows) {
  const { rows: all, filled } = fillGaps(rows);
  const byDate = new Map();
  for (const row of all) {
    const day = row.as_of;
    if (!byDate.has(day)) byDate.set(day, { as_of: day, assets: 0, debts: 0, investments: 0, loans: 0, other: 0 });
    const b = byDate.get(day);
    const value = Number(row.current) || 0;
    if (row.type === 'credit' || row.subtype === 'credit card') b.debts += value;
    else if (row.type === 'loan') b.loans += value;
    else if (row.type === 'depository') b.assets += value;
    else if (row.type === 'investment') b.investments += value;
    else b.other += value;
  }
  return [...byDate.values()]
    .sort((a, b) => (a.as_of < b.as_of ? -1 : 1))
    .map((d) => ({ ...d, net: d.assets + d.investments + d.other - d.debts - d.loans, filled: filled.get(d.as_of) || 0 }));
}

// Long ranges: every row of the last `keepDays` days, and only month starts and Mondays before that, so a two-year
// history stays a small download. Daily totals are built from every row either way.
export function thin(rows, now = new Date(), keepDays = 120) {
  const recent = new Date(now); recent.setDate(recent.getDate() - keepDays);
  const cut = recent.toISOString().slice(0, 10);
  return rows.filter((r) => {
    if (r.as_of >= cut) return true;
    const d = new Date(r.as_of + 'T12:00:00Z');
    return d.getUTCDate() === 1 || d.getUTCDay() === 1;
  });
}
