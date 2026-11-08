// POST /api/plaid-webhook   Plaid: "new transactions are waiting" -> sync that
//                           Item and announce any deposit (lib/deposits.js).
// GET  /api/plaid-webhook   (bearer) points every linked Item's webhook here.
//                           Run once, and again after linking a bank.
//
// Two more inbound callers live here too, because Vercel Hobby allows twelve
// functions and api/ already has twelve:
// POST /api/app-store-notifications  (rewritten to ?source=app-store) Apple's
//                           Server Notifications V2: renewals, expiries,
//                           refunds (lib/entitlement.js applyNotification).
// GET  /api/plaid-webhook?task=lapse  Vercel Cron, daily, with CRON_SECRET:
//                           removes real banks 30 days after a subscription
//                           ends (lib/lapse.js). &dry=1 only reports.
//
// The POST is open to the internet, so nothing is trusted until Plaid's
// signature checks out: an ES256 JWT in the Plaid-Verification header, signed
// with a key Plaid publishes, carrying the SHA-256 of the exact body bytes.
// An unsigned call is refused before it can make this backend do anything.

import crypto from 'node:crypto';
import { plaid, authorize, listItems, itemById, isSandboxToken } from '../lib/plaid.js';
import { syncItem } from '../lib/sync.js';
import { announceDeposits } from '../lib/deposits.js';
import { pushAll } from '../lib/push.js';
import { applyNotification, isEntitled } from '../lib/entitlement.js';
import { sweepLapsed } from '../lib/lapse.js';
import { sbHeaders, rest } from '../lib/db.js';

export const WEBHOOK_URL = 'https://shine-finance-api.vercel.app/api/plaid-webhook';

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const keyCache = new Map();

async function verify(req, raw) {
  const jwt = req.headers['plaid-verification'];
  if (!jwt) return 'no Plaid-Verification header';
  const [h, c, sig] = String(jwt).split('.');
  if (!h || !c || !sig) return 'malformed JWT';
  const header = JSON.parse(fromB64url(h).toString());
  if (header.alg !== 'ES256' || !header.kid) return `unexpected alg ${header.alg}`;

  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    const out = await plaid('/webhook_verification_key/get', { key_id: header.kid });
    jwk = out.key;
    if (jwk.expired_at) return 'signing key expired';
    keyCache.set(header.kid, jwk);
  }
  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, fromB64url(sig));
  if (!ok) return 'bad signature';

  const claims = JSON.parse(fromB64url(c).toString());
  if (Math.abs(Date.now() / 1000 - claims.iat) > 5 * 60) return 'stale (iat over 5 minutes)';
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  if (digest !== claims.request_body_sha256) return 'body hash mismatch';
  return null;
}

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset means no one
// gets in, not everyone.
function isCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

async function appStoreNotification(req, res) {
  try {
    const { signedPayload } = JSON.parse((await readRaw(req)).toString() || '{}');
    const what = await applyNotification(signedPayload);
    console.log(`[app-store] ${what}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    // Anything unsigned or for another app is refused for good; a database
    // failure gets a 500 so Apple tries again later.
    const refused = !/save failed/.test(err.message);
    console.error(`[app-store] ${refused ? 'refused' : 'failed'}: ${err.message}`);
    return res.status(refused ? 401 : 500).json({ error: refused ? 'unverified' : 'try again' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST' && req.query.source === 'app-store') return appStoreNotification(req, res);
  if (req.method === 'GET' && req.query.task === 'lapse') {
    if (!isCron(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const report = await sweepLapsed({ dry: req.query.dry === '1' });
      console.log(`[lapse] warned ${report.warned}, removed ${report.removed}, errors ${report.errors.length}`);
      return res.status(200).json(report);
    } catch (err) {
      console.error(`[lapse] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method === 'GET') {
    const user = await authorize(req, res);
    if (!user) return;
    // ?test=1 sends a sample notice to every registered phone and nothing else.
    if (req.query.test === '1') {
      const sent = await pushAll(user, 'Money in', 'Test: deposit notices are working');
      return res.status(200).json({ sent });
    }
    const items = await listItems(user);
    const results = [];
    for (const item of items) {
      const institution = item.institution_name || item.item_id;
      // Sandbox webhooks are signed with sandbox keys, which the production
      // check cannot verify, so the sample bank gets none.
      if (isSandboxToken(item.access_token)) continue;
      try {
        await plaid('/item/webhook/update', { access_token: item.access_token, webhook: WEBHOOK_URL });
        results.push({ institution, ok: true });
      } catch (err) {
        results.push({ institution, ok: false, error: err.message });
      }
    }
    return res.status(200).json({ webhook: WEBHOOK_URL, items: results });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRaw(req);
  try {
    const problem = await verify(req, raw);
    if (problem) {
      console.error(`[webhook] refused: ${problem}`);
      return res.status(401).json({ error: 'unverified' });
    }
  } catch (err) {
    console.error(`[webhook] verification failed: ${err.message}`);
    return res.status(401).json({ error: 'unverified' });
  }

  const event = JSON.parse(raw.toString() || '{}');
  console.log(`[webhook] ${event.webhook_type}/${event.webhook_code} item=${String(event.item_id).slice(-6)}`);

  // SYNC_UPDATES_AVAILABLE is the transactions/sync signal. The older codes
  // (DEFAULT_UPDATE and friends) still arrive for some Items and mean the same.
  const wanted = ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'];
  if (event.webhook_type !== 'TRANSACTIONS' || !wanted.includes(event.webhook_code)) {
    return res.status(200).json({ ignored: true });
  }

  try {
    const item = await itemById(event.item_id);
    if (!item) return res.status(200).json({ ignored: 'unknown item' });
    // Same rule as /api/sync: a lapsed account's real banks keep what they
    // have but are not refreshed.
    if (!isSandboxToken(item.access_token)) {
      const r = await fetch(rest(`users?select=legacy,sub_expires_at&id=eq.${item.user_id}&limit=1`), { headers: sbHeaders() });
      const owner = r.ok ? (await r.json())[0] : null;
      if (!isEntitled(owner)) return res.status(200).json({ ignored: 'not subscribed' });
    }
    const result = await syncItem(item);
    const sent = await announceDeposits(item, result);
    return res.status(200).json({ synced: result.upserts.length, notified: sent });
  } catch (err) {
    console.error(`[webhook] sync failed: ${err.message}`);
    // 200 anyway: Plaid retries failures, and a retry would only repeat this.
    return res.status(200).json({ error: err.message });
  }
}
