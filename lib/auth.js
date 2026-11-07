// Who is calling.
//
// Two kinds of caller:
//
//   A SESSION: the app signed in with Apple and was handed a random session
//   token by /api/account. Only its SHA-256 is stored, so a leaked sessions
//   table cannot be replayed.
//
//   The OWNER'S APP_TOKEN: the shared secret this backend used when it served
//   one person. It still works, and always means the owner (the one users row
//   with legacy = true), so Shine's installed builds keep working through the
//   change. It can be retired once every device has signed in with Apple.
//
// authorize() answers 401 itself and returns null, or returns the user row.

import crypto from 'node:crypto';
import { sbHeaders, rest } from './db.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function bearer(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isOwnerToken(token) {
  const expected = process.env.APP_TOKEN;
  return !!expected && !!token && sameSecret(token, expected);
}

const USER_FIELDS = 'id,apple_sub,email,legacy,plaid_client_user_id,created_at';

export async function ownerUser() {
  const r = await fetch(rest(`users?select=${USER_FIELDS}&legacy=is.true&limit=1`), { headers: sbHeaders() });
  if (!r.ok) throw new Error(`owner lookup failed: ${await r.text()}`);
  return (await r.json())[0] || null;
}

export async function userForSession(token) {
  const r = await fetch(
    rest(`sessions?select=token_hash,user:users(${USER_FIELDS})&token_hash=eq.${sha256(token)}&limit=1`),
    { headers: sbHeaders() }
  );
  if (!r.ok) throw new Error(`session lookup failed: ${await r.text()}`);
  const row = (await r.json())[0];
  return row?.user || null;
}

/// The calling user, or null after answering 401 (or 500 when misconfigured).
export async function authorize(req, res) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  try {
    const user = isOwnerToken(token) ? await ownerUser() : await userForSession(token);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return user;
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ error: 'Could not check sign-in' });
    return null;
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(userId, device) {
  const token = 'mfs_' + crypto.randomBytes(32).toString('base64url');
  const r = await fetch(rest('sessions'), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      token_hash: sha256(token),
      user_id: userId,
      device: device ? String(device).slice(0, 80) : null,
    }),
  });
  if (!r.ok) throw new Error(`createSession failed: ${await r.text()}`);
  return token;
}

export async function endSession(token) {
  await fetch(rest(`sessions?token_hash=eq.${sha256(token)}`), {
    method: 'DELETE',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
  });
}

export const callerToken = bearer;

// ── Sign in with Apple ──────────────────────────────────────────────────────
// The app sends the identity token Apple gave it: an RS256 JWT signed with one
// of the keys Apple publishes. Checked here: signature, issuer, audience (this
// app's bundle id) and expiry. `sub` is the person's stable Apple id for this
// developer team, and is what a users row is keyed on.

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
let appleKeys = null;
let appleKeysAt = 0;

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function appleKey(kid, fetchKeys) {
  const fresh = Date.now() - appleKeysAt < 60 * 60 * 1000;
  if (!appleKeys || !fresh || !appleKeys.find((k) => k.kid === kid)) {
    appleKeys = (await fetchKeys()).keys || [];
    appleKeysAt = Date.now();
  }
  return appleKeys.find((k) => k.kid === kid) || null;
}

export function audiences() {
  return (process.env.APPLE_AUDIENCE || 'MindGames.MyFinance').split(',').map((s) => s.trim()).filter(Boolean);
}

/// The verified claims, or throws with the reason. `fetchKeys` is replaceable
/// for tests.
export async function verifyAppleIdentity(idToken, {
  fetchKeys = () => fetch(APPLE_KEYS_URL).then((r) => r.json()),
  now = Date.now(),
} = {}) {
  const [h, c, sig] = String(idToken || '').split('.');
  if (!h || !c || !sig) throw new Error('malformed identity token');
  const header = JSON.parse(fromB64url(h).toString());
  if (header.alg !== 'RS256' || !header.kid) throw new Error(`unexpected alg ${header.alg}`);
  const jwk = await appleKey(header.kid, fetchKeys);
  if (!jwk) throw new Error('unknown signing key');
  const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, fromB64url(sig));
  if (!ok) throw new Error('bad signature');
  const claims = JSON.parse(fromB64url(c).toString());
  if (claims.iss !== APPLE_ISSUER) throw new Error('wrong issuer');
  if (!audiences().includes(claims.aud)) throw new Error(`wrong audience ${claims.aud}`);
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('expired');
  if (!claims.sub) throw new Error('no subject');
  return claims;
}
