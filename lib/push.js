// Apple push notifications, with no dependencies: Node's own http2 and crypto.
//
// Env: APNS_KEY (the .p8 file's contents), APNS_KEY_ID, APNS_TEAM_ID,
// APNS_TOPIC (the app's bundle id, MindGames.MyFinance).
//
// Phones register their device tokens into user_prefs under "push.<device>"
// through the ordinary /api/prefs, so no table or endpoint of their own.

import http2 from 'node:http2';
import crypto from 'node:crypto';
import { sbHeaders } from './sync.js';

const HOSTS = {
  production: 'https://api.push.apple.com',
  // Builds installed from Xcode carry the development push entitlement, and
  // Apple only accepts their tokens here.
  sandbox: 'https://api.sandbox.push.apple.com',
};

let cachedJWT = null;
let cachedAt = 0;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Apple wants a fresh-ish token: no older than an hour, not renewed more than
// every 20 minutes.
function providerToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJWT && now - cachedAt < 50 * 60) return cachedJWT;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now }));
  const key = (process.env.APNS_KEY || '').replace(/\\n/g, '\n');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  cachedJWT = `${header}.${claims}.${b64url(sig)}`;
  cachedAt = now;
  return cachedJWT;
}

function sendOne(host, token, payload) {
  return new Promise((resolve) => {
    const client = http2.connect(host);
    client.on('error', (err) => resolve({ status: 0, reason: err.message }));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': process.env.APNS_TOPIC || 'MindGames.MyFinance',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      client.close();
      let reason = '';
      try { reason = JSON.parse(body).reason || ''; } catch { /* empty body on success */ }
      resolve({ status, reason });
    });
    req.on('error', (err) => { client.close(); resolve({ status: 0, reason: err.message }); });
    req.end(JSON.stringify(payload));
  });
}

export async function deviceTokens() {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user_prefs?select=key,value&key=like.push.*`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`deviceTokens failed: ${await res.text()}`);
  const rows = await res.json();
  return rows.map((r) => r.value?.token).filter(Boolean);
}

/// Sends one alert to every registered phone. Production first; a token Apple
/// calls bad there is a development one, which goes to the sandbox instead.
export async function pushAll(title, body) {
  if (!process.env.APNS_KEY || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    console.log('[push] APNS_* not configured; skipped');
    return 0;
  }
  const tokens = await deviceTokens();
  const payload = { aps: { alert: { title, body }, sound: 'default' } };
  let sent = 0;
  for (const token of tokens) {
    let r = await sendOne(HOSTS.production, token, payload);
    if (r.status === 400 && r.reason === 'BadDeviceToken') {
      r = await sendOne(HOSTS.sandbox, token, payload);
    }
    // Token tail only: enough to tell two phones apart in the log.
    console.log(`[push] ...${token.slice(-6)}: ${r.status} ${r.reason}`);
    if (r.status === 200) sent += 1;
  }
  return sent;
}
