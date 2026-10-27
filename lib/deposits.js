// "Money in" notices: a new credit to a checking or savings account.
//
// No amounts anywhere, by Shine's choice (2026-10-26) and for the same reason
// the payday reminders carry none: they land on a lock screen. The name and the
// bank are enough to know what arrived; the app has the figure.

import { plaid } from './plaid.js';
import { pushAll } from './push.js';

/// Announces the deposits in one Item's fresh sync. Quiet for a first sync or
/// a rebuild (`fresh` false), which hand over history rather than news.
export async function announceDeposits(item, result) {
  if (!result.fresh || !result.added.length) return 0;

  // Plaid signs money coming IN as negative.
  const recentCutoff = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  let credits = result.added.filter((t) =>
    typeof t.amount === 'number' && t.amount < 0 && String(t.date) >= recentCutoff
  );
  // A pending deposit that posts arrives again as a NEW transaction pointing
  // at the pending one. The pending one was already announced.
  credits = credits.filter((t) => !t.pending_transaction_id);
  if (!credits.length) return 0;

  // Checking and savings only. A credit on a card is a payment or a refund,
  // not money coming in.
  let depository;
  try {
    const out = await plaid('/accounts/get', { access_token: item.access_token });
    depository = new Set(
      (out.accounts || []).filter((a) => a.type === 'depository').map((a) => a.account_id)
    );
  } catch (err) {
    console.error(`[deposits] ${result.institution}: accounts/get failed (${err.message})`);
    return 0;
  }
  credits = credits.filter((t) => depository.has(t.account_id));
  if (!credits.length) return 0;

  const name = (t) => String(t.merchant_name || t.name || 'a deposit').slice(0, 60);
  const title = 'Money in';
  const body = credits.length === 1
    ? `Deposit from ${name(credits[0])} into ${result.institution}`
    : `${credits.length} deposits into ${result.institution}, including ${name(credits[0])}`;
  console.log(`[deposits] ${result.institution}: ${credits.length} new credit(s), notifying`);
  return pushAll(title, body);
}
