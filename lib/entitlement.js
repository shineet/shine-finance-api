// Who has paid.
//
// The app buys through StoreKit 2 and sends the signed transactions it holds
// (Transaction.jwsRepresentation). Each one is a JWS signed by Apple: its
// header carries a certificate chain, leaf -> Apple WWDR intermediate -> Apple
// Root CA G3. Checking that chain against the root's known fingerprint, and
// the signature against the leaf, is all the proof needed -- no App Store
// Server API key, and nothing the app says is taken on trust.
//
// Sandbox transactions are accepted as well as Production: App Review buys in
// the sandbox, and so does every TestFlight tester.

import crypto from 'node:crypto';
import { sbHeaders, rest } from './db.js';

const BUNDLE_ID = 'MindGames.MyFinance';
export const PRODUCTS = new Set(['MindGames.MyFinance.monthly', 'MindGames.MyFinance.yearly']);

// SHA-256 of Apple Root CA - G3, from apple.com/certificateauthority.
const APPLE_ROOT_G3 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
// Apple's marker extensions: the WWDR intermediate (1.2.840.113635.100.6.2.1)
// and the App Store receipt-signing leaf (1.2.840.113635.100.6.11.1), DER encoded.
const OID_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex');
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex');

// A renewal can reach the server a little late (the notification is retried,
// or arrives only when the app next opens), so a lapse is only believed a day
// after the stored expiry.
const LEEWAY_MS = 24 * 60 * 60 * 1000;

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/// The decoded payload of anything genuinely signed by the App Store, or throws.
function verifySigned(jws) {
  const [h, p, sig] = String(jws).split('.');
  if (!h || !p || !sig) throw new Error('not a JWS');
  const header = JSON.parse(fromB64url(h).toString());
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error('unexpected JWS header');
  }
  const [leaf, mid, root] = header.x5c.map((c) => new crypto.X509Certificate(Buffer.from(c, 'base64')));
  if (root.fingerprint256 !== APPLE_ROOT_G3) throw new Error('not Apple\'s root');
  if (!mid.verify(root.publicKey) || !leaf.verify(mid.publicKey)) throw new Error('broken chain');
  if (!mid.raw.includes(OID_INTERMEDIATE) || !leaf.raw.includes(OID_LEAF)) throw new Error('not an App Store certificate');
  const now = Date.now();
  for (const c of [leaf, mid]) {
    if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) throw new Error('certificate out of date');
  }
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`),
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, fromB64url(sig));
  if (!ok) throw new Error('bad signature');
  return JSON.parse(fromB64url(p).toString());
}

/// The decoded payload of a genuine Apple-signed transaction, or throws.
export function verifyTransaction(jws) {
  const t = verifySigned(jws);
  if (t.bundleId !== BUNDLE_ID) throw new Error(`wrong app ${t.bundleId}`);
  if (!PRODUCTS.has(t.productId)) throw new Error(`unknown product ${t.productId}`);
  return t;
}

// After a lapse, real banks stay connected this long (but stop refreshing)
// before lib/lapse.js removes them at Plaid, so someone whose card failed, or
// who resubscribes after a week, loses nothing.
export const GRACE_DAYS = 30;

/// When the subscription stopped counting, or null if it never started.
export function lapsedAt(user) {
  return user?.sub_expires_at ? new Date(Date.parse(user.sub_expires_at) + LEEWAY_MS) : null;
}

/// Owner always; anyone else while Apple's last word says they are paid up.
export function isEntitled(user) {
  if (user?.legacy) return true;
  const at = lapsedAt(user);
  return !!at && at.getTime() > Date.now();
}

// ── App Store Server Notifications V2 ────────────────────────────────────────
//
// Without these the server hears of a renewal only when the app next opens,
// so someone who pays every month but rarely opens the app would look lapsed
// and have their banks removed. Apple posts { signedPayload } on every
// renewal, expiry, refund and revocation; it is signed with the same
// certificate chain as a transaction, so it is checked the same way and
// needs no key.

/// Applies one notification. Returns a short description for the log.
export async function applyNotification(signedPayload) {
  const n = verifySigned(signedPayload);
  const data = n.data || {};
  if (data.bundleId !== BUNDLE_ID) throw new Error(`wrong app ${data.bundleId}`);
  const kind = n.subtype ? `${n.notificationType}/${n.subtype}` : n.notificationType;
  if (!data.signedTransactionInfo) return `${kind} (no transaction)`;
  const t = verifyTransaction(data.signedTransactionInfo);

  // Found by the subscription it is about, or, for its first word, by the
  // MyFinance id the app stamped on the purchase.
  const fields = 'id,sub_expires_at,sub_original_txn';
  let r = await fetch(rest(`users?select=${fields}&sub_original_txn=eq.${encodeURIComponent(String(t.originalTransactionId))}&limit=1`),
    { headers: sbHeaders() });
  let user = r.ok ? (await r.json())[0] : null;
  if (!user && t.appAccountToken && /^[0-9a-f-]{36}$/i.test(t.appAccountToken)) {
    r = await fetch(rest(`users?select=${fields}&id=eq.${t.appAccountToken}&limit=1`), { headers: sbHeaders() });
    user = r.ok ? (await r.json())[0] : null;
  }
  if (!user) return `${kind}: no matching account`;

  // Notifications can arrive out of order, so a stale one never shortens a
  // later period. A refund or revocation ends the period it belongs to.
  const stored = user.sub_expires_at ? Date.parse(user.sub_expires_at) : 0;
  let until = t.expiresDate || 0;
  if (t.revocationDate) {
    if (until < stored) return `${kind}: revocation of an earlier period, ignored`;
    until = t.revocationDate;
  } else if (until <= stored) {
    return `${kind}: nothing newer`;
  }
  const patch = {
    sub_expires_at: new Date(until).toISOString(),
    sub_product: t.productId,
    sub_environment: t.environment,
    sub_original_txn: String(t.originalTransactionId),
  };
  r = await fetch(rest(`users?id=eq.${user.id}`), {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`subscription save failed: ${r.status} ${await r.text()}`);
  return `${kind}: ${t.productId} (${t.environment}) until ${patch.sub_expires_at}`;
}

export function entitlement(user) {
  return {
    subscribed: isEntitled(user),
    owner: !!user?.legacy,
    expires_at: user?.sub_expires_at || null,
    product: user?.sub_product || null,
  };
}
