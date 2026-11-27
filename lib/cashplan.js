// Account by account: what lands, what leaves, and where it runs short.
//
// Shine (2026-11-26): "Cash could run short on Dec 1" is not something he can
// act on. He needs "your Ally payment comes out of Bank of America, which will
// not have enough; move $X from Chase before then". So every bill and payday
// is placed in the account it actually hits, each cash account is run forward
// day by day, and each shortfall names the account, the date, the amount and
// an account that can spare it. Charges that go on a card are checked against
// what is left on that card.

const iso = (d) => d.toISOString().slice(0, 10);

/// `book`: Map of account id -> { label, type, current, available, limit }.
/// `events`: [{ date, name, amount (signed: + in, - out), account_id, kind }].
/// `cushion`: money the person never wants a cash account to drop below.
/// Returns { accounts: [...], shortfalls: [...], card_problems: [...], moves: [...] }.
export function runCashPlan(book, events, { cushion = 0, today = new Date(), until } = {}) {
  const start = iso(today);
  const end = until || iso(new Date(today.getTime() + 30 * 864e5));
  const inWindow = events
    .filter((e) => e.date >= start && e.date <= end && e.account_id && book.has(e.account_id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amount - b.amount)));

  // A PayPal balance is not where its charges really come from (PayPal draws
  // on the card or bank behind it), so it is never "short".
  const cashIds = [...book.values()].filter((a) => a.type === 'depository' && a.subtype !== 'paypal').map((a) => a.id);
  const accounts = [];
  const shortfalls = [];

  for (const id of cashIds) {
    const a = book.get(id);
    let bal = Number(a.available ?? a.current ?? 0);
    const startBal = bal;
    let low = bal, lowDate = start, firstShort = null;
    const timeline = [];
    // Payments on one day are drafted before that day's deposit clears, so a
    // day's money out is applied first: the cautious order.
    for (const e of inWindow.filter((x) => x.account_id === id)) {
      bal += e.amount;
      timeline.push({ date: e.date, name: e.name, amount: round(e.amount), balance_after: round(bal) });
      if (bal < low) { low = bal; lowDate = e.date; }
      if (!firstShort && bal < cushion) firstShort = { date: e.date, name: e.name, balance_after: round(bal) };
    }
    const spare = Math.max(0, low - cushion); // can leave without ever dipping under the cushion
    accounts.push({
      account: a.label,
      balance_now: round(startBal),
      lowest: round(low),
      lowest_on: lowDate,
      can_spare: round(spare),
      events: timeline,
    });
    if (firstShort) {
      shortfalls.push({
        account: a.label,
        account_id: id,
        first_short_on: firstShort.date,
        caused_by: firstShort.name,
        lowest: round(low),
        lowest_on: lowDate,
        needs: round(cushion - low),
      });
    }
  }

  // Where to move money from: the account with the most to spare, never more
  // than it can lose without running short itself.
  const spares = accounts.filter((a) => a.can_spare > 0).map((a) => ({ ...a }));
  const moves = [];
  for (const s of shortfalls.sort((x, y) => (x.first_short_on < y.first_short_on ? -1 : 1))) {
    let need = s.needs;
    for (const from of spares.sort((x, y) => y.can_spare - x.can_spare)) {
      if (need <= 0) break;
      if (from.account === s.account || from.can_spare <= 0) continue;
      const amt = Math.min(need, from.can_spare);
      from.can_spare -= amt;
      need -= amt;
      moves.push({ amount: round(Math.ceil(amt)), from: from.account, to: s.account, before: s.first_short_on, reason: `${s.caused_by} on ${s.first_short_on}` });
    }
    if (need > 0) s.still_short_after_moves = round(need);
  }

  // Charges set to go on a card that has no room left.
  const card_problems = [];
  const used = new Map();
  for (const e of inWindow) {
    const a = book.get(e.account_id);
    if (a.type !== 'credit' || e.amount >= 0 || a.limit == null) continue;
    const room = Number(a.limit) - Number(a.current || 0) - (used.get(a.id) || 0);
    used.set(a.id, (used.get(a.id) || 0) - e.amount);
    if (-e.amount > room) {
      card_problems.push({ date: e.date, name: e.name, amount: round(-e.amount), card: a.label, room_left: round(Math.max(0, room)), problem: 'the card does not have enough credit left, so it may be declined or go over the limit' });
    }
  }

  return { from: start, to: end, cushion, accounts, shortfalls, moves, card_problems };
}

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
