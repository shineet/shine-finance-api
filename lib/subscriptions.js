// Subscriptions and bills, found in the transactions themselves.
//
// A subscription is the same company, about the same amount, on a steady
// schedule, and still being charged. Shopping that repeats (groceries, Amazon,
// a favourite restaurant) is not one: the amounts differ and the days wander.
// A bill (mortgage, loan, utilities, phone, insurance, tuition) is told apart
// by who it is paid to, and may vary in amount.
//
// Pure functions, no I/O, so they can be checked with made-up transactions
// (test/subscriptions.test.mjs).

const DAY = 86400000;

// Steady schedules, in days, with how far a charge may drift from them.
export const CADENCES = [
  { frequency: 'WEEKLY', days: 7, tol: 2, fewest: 4 },
  { frequency: 'BIWEEKLY', days: 14, tol: 3, fewest: 3 },
  { frequency: 'MONTHLY', days: 30.44, tol: 6, fewest: 3 },
  { frequency: 'QUARTERLY', days: 91.3, tol: 12, fewest: 2 },
  { frequency: 'SEMI_ANNUALLY', days: 182.6, tol: 15, fewest: 2 },
  { frequency: 'ANNUALLY', days: 365.25, tol: 20, fewest: 2 },
];

// Paid to these, it is a bill, whatever the amount does.
const BILL_HINTS = [
  'mortgage', 'rent', 'hoa', 'lease', 'tesla', 'auto loan', 'car loan', 'sofi', 'loan', 'student',
  'electric', 'energy', 'power', 'water', 'sewer', 'trash', 'waste', 'internet', 'fiber', 'comcast',
  'xfinity', 'spectrum', 'at&t', 'att ', 'verizon', 't-mobile', 'tmobile', 'wireless', 'utility', 'utilities',
  'atmos', 'txu', 'reliant', 'insurance', 'geico', 'progressive', 'state farm', 'allstate', 'figo',
  'lemonade', 'aetna', 'cigna', 'blue cross', 'college', 'university', 'tuition', 'school district',
];
const BILL_CATEGORIES = new Set(['RENT_AND_UTILITIES', 'LOAN_PAYMENTS']);

// Names that are subscriptions, so two charges are enough to believe them.
const SUBSCRIPTION_HINTS = [
  'netflix', 'spotify', 'hulu', 'disney', 'hbo', 'peacock', 'paramount', 'apple.com', 'apple ', 'icloud',
  'youtube', 'amazon prime', 'prime video', 'kindle', 'audible', 'chatgpt', 'openai', 'anthropic', 'claude',
  'midjourney', 'github', 'adobe', 'dropbox', 'google', 'microsoft', 'notion', 'canva', 'capcut', 'grammarly',
  'gym', 'fitness', 'planet fit', 'equinox', 'peloton', 'classpass', 'patreon', 'substack', 'nyt', 'wsj',
  'medium', 'linkedin', 'zoom', 'twilio', 'godaddy', 'fly.io', 'vercel', 'supabase', 'spokeo', 'usage.ai',
  'siriusxm', 'uber one', 'dashpass', 'instacart+', 'walmart+', 'costco', 'ring ', 'adt ', 'duolingo',
  'headspace', 'calm', 'xbox', 'playstation', 'nintendo', 'nordvpn', 'expressvpn', '1password', 'oil changers',
  'paddle', 'cursor', 'perplexity', 'elevenlabs', 'suno', 'distrokid',
];

// Where people shop. Here a schedule is not enough: the amount must hardly move.
const SHOPPING_CATEGORIES = new Set([
  'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'TRAVEL', 'TRANSPORTATION', 'HOME_IMPROVEMENT',
]);

// Money moving, not money spent.
const NEVER_CATEGORIES = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES', 'INCOME']);
const MOVEMENT_HINTS = [
  'credit crd', 'credit card', 'card payment', 'cardmember', 'card member', 'epayment', 'e-payment',
  'payment thank you', 'autopay', 'auto pay', 'bankcard', 'pymt', 'transfer', 'xfer', 'zelle', 'venmo',
  'cash app', 'wire', 'to savings', 'repaymen', 'instl', 'inst xfer', 'apple card', 'applecard',
  'gs bank', 'payment to', 'card pmt', 'crd pmt',
];

// A hint is matched where a word begins: "att" must not find AT&T inside "Hyatt".
const starts = (s, h) => { let i = s.indexOf(h); while (i >= 0) { if (i === 0 || !/[a-z0-9]/.test(s[i - 1])) return true; i = s.indexOf(h, i + 1); } return false; };
const has = (list, s) => list.some((h) => starts(s, h.trimEnd()) && (h === h.trimEnd() || s.includes(h)));

/// One name for a company however the bank writes it.
export function merchantKey(name) {
  let s = (name || '').toLowerCase();
  s = s.replace(/^(paypal purchase |paypal \*|paypal\*|pp\*|sq \*|sq\*|tst\* ?|sp \* ?|sp\*|py \*)/, '');
  s = s.replace(/ web id.*$/, '');
  s = s.replace(/apple\.com\/bill/, 'apple');
  s = s.replace(/[#*].*$/, '');           // order and store numbers
  s = s.replace(/\b(inc|llc|ltd|co|com|www)\b/g, ' ');
  s = s.replace(/[^a-z0-9.+& ]/g, ' ').replace(/\d{3,}/g, ' ');
  return s.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
}

export function kindOf(name, category) {
  const lower = ` ${(name || '').toLowerCase()} `;
  if (has(BILL_HINTS, lower)) return 'bill';
  if (has(SUBSCRIPTION_HINTS, lower)) return 'subscription';
  if (BILL_CATEGORIES.has(category)) return 'bill';
  return 'subscription';
}

/// True when this outflow is a card payment, a transfer or a fee: never a subscription.
export function isMovement(name, category) {
  const lower = ` ${(name || '').toLowerCase()} `;
  if (/apple ?card|card pmt|crd pmt/.test(lower)) return true;   // a card payment, though "apple" names a subscription
  if (NEVER_CATEGORIES.has(category)) return !has(BILL_HINTS, lower);
  if (has(BILL_HINTS, lower) || has(SUBSCRIPTION_HINTS, lower)) return false;
  return has(MOVEMENT_HINTS, lower);
}

const toDay = (d) => Math.floor(new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() / DAY);
const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const near = (a, b, pct, abs) => Math.abs(a - b) <= Math.max(abs, pct * Math.max(a, b));

/// The same charge seen twice: a PayPal payment and the bank debit behind it,
/// or one card reached through two logins. Kept once, the earlier of the two.
export function dedupe(charges) {
  const out = [];
  const sorted = [...charges].sort((a, b) => a.day - b.day);
  for (const c of sorted) {
    // PayPal's copy may differ from the bank's by a few cents (Shine's Netflix and Spotify, 2026-11-25).
    const viaPaypal = o => o.paypal || c.paypal;
    const twin = out.find((o) => o.account_id !== c.account_id
      && near(o.amount, c.amount, viaPaypal(o) ? 0.03 : 0.005, viaPaypal(o) ? 0.5 : 0.01)
      && c.day - o.day <= (viaPaypal(o) ? 10 : 2) && !o.twinned);
    if (twin) { twin.twinned = true; if (c.paypal && !twin.paypal) Object.assign(twin, { account_id: c.account_id, institution: c.institution, paypal: true }); continue; }
    out.push({ ...c });
  }
  return out.map(({ twinned, ...c }) => c);
}

/// Which schedule the charges keep, or null. Most gaps must be one period
/// (a skipped month may be two), within the drift allowed.
export function cadenceOf(days) {
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const typical = median(gaps);
  for (const c of CADENCES) {
    if (Math.abs(typical - c.days) > c.tol * 1.5) continue;
    let one = 0, ok = 0;
    for (const g of gaps) {
      if (Math.abs(g - c.days) <= c.tol) { one++; ok++; } else if (Math.abs(g - 2 * c.days) <= c.tol * 2) ok++;
    }
    if (ok / gaps.length >= 0.75 && one / gaps.length >= 0.6) return c;
  }
  return null;
}

/// Charges of one company split by amount, so a membership and its yearly fee
/// are two subscriptions, not one muddle.
function byAmount(charges) {
  const groups = [];
  for (const c of charges) {
    const g = groups.find((g) => near(median(g.map((x) => x.amount)), c.amount, 0.12, 1.5));
    if (g) g.push(c); else groups.push([c]);
  }
  return groups;
}

/// A price rise splits one subscription into an old run and a new one. Join
/// runs that keep the same schedule and follow each other without overlap.
function joinPriceChanges(runs) {
  runs.sort((a, b) => a.days[0] - b.days[0]);
  const out = [];
  for (const r of runs) {
    const prev = out.find((p) => p.cadence && r.cadence && p.cadence.frequency === r.cadence.frequency
      && r.days[0] > p.days[p.days.length - 1]
      && r.days[0] - p.days[p.days.length - 1] <= p.cadence.days + p.cadence.tol);
    if (prev) {
      prev.change = { from: prev.charges[prev.charges.length - 1].amount, to: r.charges[0].amount, on: fromDay(r.days[0]) };
      prev.charges.push(...r.charges); prev.days.push(...r.days);
    } else out.push(r);
  }
  return out;
}

/// rows: { date, name, amount (negative is money out), category, account_id, institution, pending }.
/// Returns every subscription and bill found, still going or stopped.
export function detect(rows, { today = new Date() } = {}) {
  const now = toDay(today.toISOString());
  const byMerchant = new Map();
  for (const r of rows) {
    const amount = -Number(r.amount);
    if (!(amount > 0) || r.pending) continue;
    if (isMovement(r.name, r.category)) continue;
    const key = merchantKey(r.name);
    if (key.length < 2) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push({
      day: toDay(r.date), amount, name: r.name, category: r.category || null,
      account_id: r.account_id, institution: r.institution || null,
      paypal: /paypal/i.test(r.institution || ''),
    });
  }

  const found = [];
  for (const [key, all] of byMerchant) {
    const charges = dedupe(all);
    const names = new Map();
    for (const c of charges) names.set(c.name, (names.get(c.name) || 0) + 1);
    const name = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const category = charges[charges.length - 1].category;
    const kind = kindOf(name, category);
    const known = has(SUBSCRIPTION_HINTS, ` ${name.toLowerCase()} `);
    const shopping = SHOPPING_CATEGORIES.has(category) && !known && kind !== 'bill';

    // A bill may vary; a subscription keeps to its price, unless it is billed by
    // use (Fly.io, Twilio, Apple's bundle): then the whole company keeps the
    // schedule while the amount wanders, and it is one subscription, not a new
    // one every time the amount moves (Shine, 2026-11-25: Fly.io showed stopped).
    const amountsAll = charges.map((c) => c.amount);
    // Billed by use means once a period: never two charges three weeks apart or
    // closer, and never a weekly rhythm (CapCut's two plans looked "weekly").
    const daysAll = charges.map((c) => c.day);
    const useCadence = charges.length >= 3 && cadenceOf(daysAll);
    const byUse = kind !== 'bill' && !shopping && useCadence && useCadence.days >= 28
      && daysAll.every((d, i) => i === 0 || d - daysAll[i - 1] >= 20)
      && Math.max(...amountsAll) <= 3 * Math.min(...amountsAll);
    const groups = kind === 'bill' || byUse ? [charges] : byAmount(charges);
    let runs = groups.map((g) => {
      const days = g.map((c) => c.day);
      return { charges: g, days, cadence: cadenceOf(days) };
    });
    if (kind !== 'bill') runs = joinPriceChanges(runs);

    // Two plans at one price on different days of the month (two ChatGPT plans,
    // on the 3rd and the 10th) read as no schedule at all. Split such a run
    // into chains, each charge following the one a month before it.
    runs = runs.flatMap((run) => {
      if (run.cadence || run.charges.length < 2) return [run];
      const chains = [];
      for (const ch of run.charges) {
        const chain = chains.find((k) => Math.abs(ch.day - k[k.length - 1].day - 30.44) <= 6);
        if (chain) chain.push(ch); else chains.push([ch]);
      }
      if (chains.length === 1) return [run];
      return chains.map((k) => ({ charges: k, days: k.map((x) => x.day), cadence: cadenceOf(k.map((x) => x.day)) }));
    });

    for (const run of runs) {
      const c = run.cadence || cadenceOf(run.days);
      if (!c) continue;
      const amounts = run.charges.map((x) => x.amount);
      const recent = amounts.slice(-3);
      const typical = median(recent);
      // Two charges are enough only for a known name, at the same price, a
      // calendar month apart; and such a pair is still going only if the next
      // charge is not yet late.
      let weak = false;
      if (run.charges.length < c.fewest) {
        const [a, b] = run.charges;
        const pair = known && c.frequency === 'MONTHLY' && run.charges.length === 2
          && near(a.amount, b.amount, 0.01, 0.02) && Math.abs(b.day - a.day - 30.44) <= 4;
        if (!pair) continue;
        weak = true;
      }
      if (shopping) {
        // Shopping on a schedule is a subscription only at one price, many times.
        if (run.charges.length < 4 || recent.some((a) => !near(a, typical, 0.02, 0.5))) continue;
      }
      const last = run.days[run.days.length - 1];
      const late = now - last;
      const active = late <= (weak ? c.days : c.days * 1.5) + c.tol;
      const next = c.frequency === 'MONTHLY' || c.frequency === 'QUARTERLY' || c.frequency === 'SEMI_ANNUALLY' || c.frequency === 'ANNUALLY'
        ? addMonths(fromDay(last), { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUALLY: 6, ANNUALLY: 12 }[c.frequency])
        : fromDay(last + c.days);
      const lastCharge = run.charges[run.charges.length - 1];
      // A step in price: the last three agree, the three before agree, and the two differ.
      if (!run.change && amounts.length >= 4) {
        const now3 = amounts.slice(-3), before = amounts.slice(-6, -3);
        const steady = (xs) => xs.length >= 1 && xs.every((a) => near(a, xs[0], 0.01, 0.02));
        if (steady(now3) && steady(before) && !near(now3[0], before[0], 0.03, 0.25)) {
          const at = run.days[amounts.length - 3];
          run.change = { from: before[before.length - 1], to: now3[0], on: fromDay(at) };
        }
      }
      found.push({
        id: `sub:${key}:${c.frequency.toLowerCase()}${groups.length > 1 && kind !== 'bill' ? `:${Math.round(typical)}` : ''}${runs.filter((x) => Math.round(median(x.charges.map((y) => y.amount))) === Math.round(typical)).length > 1 ? `:d${new Date(run.days[0] * DAY).getUTCDate()}` : ''}`,
        kind,
        description: name,
        direction: 'outflow',
        frequency: c.frequency,
        average_amount: round(typical),
        last_amount: round(lastCharge.amount),
        last_date: fromDay(last),
        first_date: fromDay(run.days[0]),
        predicted_next_date: next,
        is_active: active,
        status: 'DETECTED',
        category,
        account_id: lastCharge.account_id,
        institution: lastCharge.institution,
        price_change: run.change ? { from: round(run.change.from), to: round(run.change.to), on: run.change.on } : null,
        charges: run.charges.slice().reverse().map((x) => ({ date: fromDay(x.day), amount: round(x.amount), account_id: x.account_id, institution: x.institution })),
      });
    }
  }
  return found.sort((a, b) => (a.predicted_next_date < b.predicted_next_date ? -1 : 1));
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, end));
  return t.toISOString().slice(0, 10);
}
const round = (x) => Math.round(x * 100) / 100;

/// What it costs a month, whatever the schedule.
export function monthly(s) {
  const per = { WEEKLY: 52 / 12, BIWEEKLY: 26 / 12, MONTHLY: 1, QUARTERLY: 1 / 3, SEMI_ANNUALLY: 1 / 6, ANNUALLY: 1 / 12 };
  return s.average_amount * (per[s.frequency] ?? 1);
}

/// Why a well-known subscription name was NOT listed: for the server log while
/// the finder is being tuned on real data. Names, dates and gaps; amounts as
/// whole dollars only.
export function explain(rows, found, { today = new Date() } = {}) {
  const listed = new Set(found.filter((s) => s.is_active).map((s) => merchantKey(s.description)));
  const out = [];
  const by = new Map();
  for (const r of rows) {
    const amount = -Number(r.amount);
    if (!(amount > 0) || r.pending) continue;
    const lower = ` ${(r.name || '').toLowerCase()} `;
    if (!has(SUBSCRIPTION_HINTS, lower)) continue;
    const key = merchantKey(r.name);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ r, amount, moved: isMovement(r.name, r.category) });
  }
  for (const [key, xs] of by) {
    if (listed.has(key)) continue;
    const kept = xs.filter((x) => !x.moved).map((x) => ({ day: toDay(x.r.date), amount: x.amount, account_id: x.r.account_id, paypal: /paypal/i.test(x.r.institution || '') }));
    const d = dedupe(kept).slice(-10);
    out.push({
      key, names: [...new Set(xs.map((x) => x.r.name))].slice(0, 3), raw: xs.length, movement: xs.filter((x) => x.moved).length,
      categories: [...new Set(xs.map((x) => x.r.category))].slice(0, 3),
      last: d.map((c) => `${fromDay(c.day).slice(5)}:${Math.round(c.amount)}${c.paypal ? 'p' : ''}`).join(' '),
    });
  }
  return out;
}
