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

const BUNDLE_ID = 'MindGames.MyFinance';
export const PRODUCTS = new Set(['MindGames.MyFinance.monthly', 'MindGames.MyFinance.yearly']);

// SHA-256 of Apple Root CA - G3, from apple.com/certificateauthority.
const APPLE_ROOT_G3 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
// Apple's marker extensions: the WWDR intermediate (1.2.840.113635.100.6.2.1)
// and the App Store receipt-signing leaf (1.2.840.113635.100.6.11.1), DER encoded.
const OID_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex');
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex');

// Renewals reach the server when the app next opens, so a lapse is only
// believed a day after the stored expiry.
const LEEWAY_MS = 24 * 60 * 60 * 1000;

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/// The decoded payload of a genuine Apple-signed transaction, or throws.
export function verifyTransaction(jws) {
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

  const t = JSON.parse(fromB64url(p).toString());
  if (t.bundleId !== BUNDLE_ID) throw new Error(`wrong app ${t.bundleId}`);
  if (!PRODUCTS.has(t.productId)) throw new Error(`unknown product ${t.productId}`);
  return t;
}

/// Owner always; anyone else while Apple's last word says they are paid up.
export function isEntitled(user) {
  if (user?.legacy) return true;
  const until = user?.sub_expires_at ? Date.parse(user.sub_expires_at) : 0;
  return until + LEEWAY_MS > Date.now();
}

export function entitlement(user) {
  return {
    subscribed: isEntitled(user),
    owner: !!user?.legacy,
    expires_at: user?.sub_expires_at || null,
    product: user?.sub_product || null,
  };
}
