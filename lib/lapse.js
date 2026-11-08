// What happens to real banks when a subscription ends.
//
// Day 0, the lapse (lib/entitlement.js lapsedAt): real banks stop refreshing
//   and no new bank can be linked. Nothing is removed.
// Day GRACE_DAYS - 7: one push, "your banks will be disconnected in 7 days".
// Day GRACE_DAYS: each real bank is removed at Plaid (/item/remove), so it is
//   no longer read or billed, and its connection row is deleted.
//
// What the person already has STAYS: transactions, balance history, settings.
// Same rule as unlinking by hand (api/unlink.js): losing a connection is never
// a reason to lose recorded history. Deleting the account deletes that.
//
// The sample bank is free and is left alone. The owner never lapses.
//
// Run once a day by Vercel Cron (vercel.json -> GET /api/plaid-webhook?task=lapse).

import { plaid, listItems, isSandboxToken } from './plaid.js';
import { sbHeaders, rest, forUser } from './db.js';
import { GRACE_DAYS, lapsedAt } from './entitlement.js';
import { pushAll } from './push.js';

const DAY = 24 * 60 * 60 * 1000;
const WARN_DAYS = 7;

// Every page of them: people already swept stay in this list for good (their
// sample bank, or nothing, is left), so a single capped page would one day
// fill with them and hide everyone newer.
async function lapsedUsers(before) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const r = await fetch(
      rest(`users?select=id,legacy,sub_expires_at&legacy=is.false&sub_expires_at=lt.${before.toISOString()}&order=id&limit=500&offset=${offset}`),
      { headers: sbHeaders() }
    );
    if (!r.ok) throw new Error(`lapsed users query failed: ${await r.text()}`);
    const page = await r.json();
    all.push(...page);
    if (page.length < 500) return all;
  }
}

/// One pass. With dry, reports what it would do and changes nothing.
export async function sweepLapsed({ dry = false, now = Date.now() } = {}) {
  const report = { warned: 0, removed: 0, errors: [] };
  const removeBefore = now - GRACE_DAYS * DAY;
  const warnFrom = now - (GRACE_DAYS - WARN_DAYS + 1) * DAY;
  const warnTo = now - (GRACE_DAYS - WARN_DAYS) * DAY;

  // Anyone lapsed at least GRACE_DAYS - WARN_DAYS days ago; the leeway is
  // added by lapsedAt, so query a day wide and decide per person.
  for (const user of await lapsedUsers(new Date(warnTo))) {
    const at = lapsedAt(user).getTime();
    const real = (await listItems(user)).filter((i) => !isSandboxToken(i.access_token));
    if (!real.length) continue;
    const who = user.id.slice(0, 8);

    if (at <= removeBefore) {
      let gone = 0;
      for (const item of real) {
        const institution = item.institution_name || 'a bank';
        if (dry) { report.removed += 1; console.log(`[lapse] would remove ${institution} for ${who}`); continue; }
        try {
          await plaid('/item/remove', { access_token: item.access_token });
        } catch (err) {
          // Already gone at Plaid still needs the local row gone.
          if (err.plaidCode !== 'ITEM_NOT_FOUND' && err.plaidCode !== 'INVALID_ACCESS_TOKEN') {
            report.errors.push({ user: who, institution, error: err.message });
            continue;
          }
        }
        const r = await fetch(rest(`plaid_items?${forUser(user)}&item_id=eq.${encodeURIComponent(item.item_id)}`), {
          method: 'DELETE',
          headers: { ...sbHeaders(), Prefer: 'return=minimal' },
        });
        if (!r.ok) { report.errors.push({ user: who, institution, error: `delete row: ${r.status}` }); continue; }
        report.removed += 1;
        gone += 1;
        console.log(`[lapse] removed ${institution} for ${who}, history kept`);
      }
      if (gone) {
        await pushAll(user, 'Banks disconnected',
          'Your MyFinance subscription ended, so your banks were disconnected. Everything already in the app is still there.');
      }
    } else if (at > warnFrom && at <= warnTo) {
      report.warned += 1;
      console.log(`[lapse] ${dry ? 'would warn' : 'warning'} ${who}`);
      if (!dry) {
        await pushAll(user, 'Subscription ended',
          `Your banks will be disconnected in ${WARN_DAYS} days. Resubscribe in Settings to keep them updating.`);
      }
    }
  }
  return report;
}
