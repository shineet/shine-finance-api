// Paydays found in the transactions themselves, for when the banks' own
// recurring detection returns nothing (2026-11).
//
// The old fallback grouped deposits by their exact description and missed
// every salary: one payroll carries a new ID number in each description,
// and another paid twice on one day, which read as an irregular gap. So:
//   - only credits into checking or savings count (a card credit is a refund),
//   - descriptions are reduced to the payer's words (IDs, dates, numbers and
//     bank boilerplate removed), so one employer is one group,
//   - deposits on the same day from the same payer are one payday,
//   - the cadence is read from the gaps: weekly, every two weeks, twice a
//     month (the 15th and the month end) or monthly.

const BOILERPLATE = new Set([
  'des', 'id', 'indn', 'co', 'ppd', 'ccd', 'web', 'ach', 'credit', 'on', 'deposit', 'dep',
  'direct', 'electronic', 'pmt', 'payment', 'from', 'conf', 'trn', 'ref', 'inc', 'llc', 'corp',
]);
const PAYROLL = /payroll|salary|direct dep|dir dep|paycheck|wages/i;

/// The payer's words: "ACME WIDGETS DES:PAYROLL ID:XXXXX1234567JGM INDN:JANE"
/// and "ACH CREDIT ACME WIDGETS PAYROLL ON 11/26" both become
/// "acme widgets payroll".
export function payerKey(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/indn:\s*\S+(\s+\S+)?/g, ' ');   // the account holder's name
  s = s.replace(/(id|conf#?|trn|ref)[:#]\s*\S+/g, ' ');
  s = s.replace(/[a-z]*\d[\w/-]*/g, ' ');        // any token holding a digit
  s = s.replace(/[^a-z ]+/g, ' ');
  const words = s.split(/\s+/).filter((w) => w.length > 1 && !BOILERPLATE.has(w));
  return words.slice(0, 4).join(' ');
}

const day = (iso) => new Date(`${iso}T12:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0, 12));
/// Pay due on a weekend lands the Friday before.
const businessDay = (d) => {
  const w = d.getUTCDay();
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
};

/// The next twice-a-month payday after `after`: the 15th and the last day.
function nextSemiMonthly(after) {
  for (let i = 0; i < 3; i++) {
    const y = after.getUTCFullYear();
    const m = after.getUTCMonth() + i;
    for (const d of [new Date(Date.UTC(y, m, 15, 12)), lastOfMonth(y, m)]) {
      const pay = businessDay(d);
      if (pay > after) return pay;
    }
  }
  return null;
}

/// Each regular payer: frequency, usual amount per payday, the account it
/// lands in, the last and next payday. Shaped like the app's RecurringStream.
///
/// `rows` are stored transactions (amount signed: money in is positive).
/// `cashAccounts` is the set of checking and savings account ids.
/// `today` is injectable for tests.
export function detectIncome(rows, cashAccounts, today = new Date()) {
  const groups = new Map();
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (amt <= 0 || !cashAccounts.has(r.account_id)) continue;
    if (r.category === 'TRANSFER_IN' && !PAYROLL.test(r.name || '')) continue;
    const key = payerKey(r.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [key, list] of groups) {
    // One payday per date: same-day deposits from one payer are added up. A
    // pending deposit counts only when no posted one sits within three days
    // (otherwise it is the same money seen twice).
    const posted = list.filter((r) => !r.pending);
    const near = (a, b) => Math.abs(day(a) - day(b)) <= 3 * 864e5;
    const usable = posted.concat(list.filter((r) => r.pending && !posted.some((p) => near(p.date, r.date))));
    const byDate = new Map();
    for (const r of usable) {
      const p = byDate.get(r.date) || { date: r.date, amount: 0, account_id: r.account_id, name: r.name };
      p.amount += Number(r.amount);
      byDate.set(r.date, p);
    }
    const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    if (days.length < 3) continue;

    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push((day(days[i].date) - day(days[i - 1].date)) / 864e5);
    const gap = median(gaps);
    // A rhythm: most gaps within a few days of the usual one.
    const steady = gaps.filter((g) => Math.abs(g - gap) <= Math.max(3, gap * 0.2)).length;
    if (steady < Math.ceil(gaps.length * 0.7)) continue;

    let frequency;
    if (gap <= 9) frequency = 'WEEKLY';
    else if (gap <= 17) {
      // Twice a month lands near the 15th and the month end; every two weeks drifts.
      const doms = days.map((p) => day(p.date).getUTCDate());
      const anchored = doms.filter((d) => (d >= 12 && d <= 16) || d >= 27 || d <= 1).length;
      frequency = gap >= 14.5 && anchored === doms.length ? 'SEMI_MONTHLY' : 'BIWEEKLY';
    } else if (gap <= 45) frequency = 'MONTHLY';
    else continue; // pay is not quarterly; anything rarer is not a payday

    const last = days[days.length - 1];
    const lastDay = day(last.date);
    // Stopped: nothing for well over one cycle.
    if ((day(iso(today)) - lastDay) / 864e5 > gap * 1.8 + 3) continue;

    let next;
    if (frequency === 'SEMI_MONTHLY') next = nextSemiMonthly(lastDay);
    else next = addDays(lastDay, frequency === 'WEEKLY' ? 7 : frequency === 'BIWEEKLY' ? 14 : Math.round(gap));
    // Roll forward past today so the planner always has a future payday.
    while (next && next < day(iso(today))) {
      next = frequency === 'SEMI_MONTHLY' ? nextSemiMonthly(next) : addDays(next, Math.round(gap));
    }

    const amounts = days.map((p) => p.amount);
    out.push({
      id: `income:${last.account_id}:${key}`,
      account_id: last.account_id,
      description: last.name,
      payer: key,
      direction: 'inflow',
      // The middle payday, so a one-off bonus does not inflate every forecast.
      average_amount: Math.round(median(amounts.slice(-6)) * 100) / 100,
      last_amount: Math.round(last.amount * 100) / 100,
      frequency,
      last_date: last.date,
      predicted_next_date: next ? iso(next) : null,
      is_active: true,
      status: 'INFERRED',
      category: 'INCOME',
      is_payroll: PAYROLL.test(list.map((r) => r.name).join(' ')),
      paydays_seen: days.length,
    });
  }
  return out.sort((a, b) => b.average_amount - a.average_amount);
}
