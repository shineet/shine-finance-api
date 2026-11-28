// Balance history roll-ups for /api/history (api/records.js), kept apart so they can be tested.

// One total per day. Counted the way the app counts today's net worth, so a change over time compares like with
// like: cash, investments and anything else owned add; cards and loans subtract. assets/debts keep their old meaning
// (cash and cards) for the screens that chart them.
export function rollup(rows) {
  const byDate = new Map();
  for (const row of rows) {
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
    .map((d) => ({ ...d, net: d.assets + d.investments + d.other - d.debts - d.loans }));
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
