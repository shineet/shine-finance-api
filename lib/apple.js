// Sign in with Apple, server to server: keeping and revoking each person's grant.
//
// Apple requires an app that offers Sign in with Apple to revoke the person's
// tokens when they delete their account, which ends the link between their
// Apple ID and MyFinance (it disappears from "Apps Using Apple ID"). Revoking
// needs a token, so at sign-in the app also sends Apple's one-time
// authorization code, which is swapped here for a refresh token and kept
// sealed with TOKEN_KEY (lib/secrets.js), like the Plaid tokens.
//
// Env: SIWA_KEY (the Sign in with Apple .p8 file's contents), SIWA_KEY_ID,
// and the team id already set for push (APNS_TEAM_ID).

import crypto from 'node:crypto';

const APPLE = 'https://appleid.apple.com';
// Native apps use their bundle id as the client id; the Mac app shares it.
const CLIENT_ID = 'MindGames.MyFinance';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export const configured = () => !!(process.env.SIWA_KEY && process.env.SIWA_KEY_ID && process.env.APNS_TEAM_ID);

/// Apple's "client secret": a short-lived ES256 JWT signed with the key.
function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.SIWA_KEY_ID }));
  const claims = b64url(JSON.stringify({
    iss: process.env.APNS_TEAM_ID, iat: now, exp: now + 300, aud: APPLE, sub: CLIENT_ID,
  }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`),
    { key: process.env.SIWA_KEY.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(sig)}`;
}

async function post(path, fields) {
  const r = await fetch(`${APPLE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: clientSecret(), ...fields }),
  });
  const text = await r.text();
  // Apple's error bodies are a code like "invalid_grant", never a token.
  if (!r.ok) throw new Error(`Apple ${path} ${r.status} ${text.slice(0, 80)}`);
  return text ? JSON.parse(text) : {};
}

/// The refresh token for a fresh authorization code, checked to belong to
/// `sub` (the person who just signed in).
export async function refreshTokenFor(code, sub) {
  const out = await post('/auth/token', { code, grant_type: 'authorization_code' });
  const idClaims = JSON.parse(fromB64url(String(out.id_token).split('.')[1] || '').toString() || '{}');
  if (idClaims.sub !== sub) throw new Error('authorization code is for a different Apple ID');
  if (!out.refresh_token) throw new Error('Apple returned no refresh token');
  return out.refresh_token;
}

export async function revoke(refreshToken) {
  await post('/auth/revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
}
