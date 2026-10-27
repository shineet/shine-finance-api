// POST /api/plaid-webhook   Plaid: "new transactions are waiting" -> sync that
//                           Item and announce any deposit (lib/deposits.js).
// GET  /api/plaid-webhook   (bearer) points every linked Item's webhook here.
//                           Run once, and again after linking a bank.
//
// The POST is open to the internet, so nothing is trusted until Plaid's
// signature checks out: an ES256 JWT in the Plaid-Verification header, signed
// with a key Plaid publishes, carrying the SHA-256 of the exact body bytes.
// An unsigned call is refused before it can make this backend do anything.

import crypto from 'node:crypto';
import { plaid, authorize, listItems } from '../lib/plaid.js';
import { syncItem } from '../lib/sync.js';
import { announceDeposits } from '../lib/deposits.js';

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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!authorize(req, res)) return;
    const items = await listItems();
    const results = [];
    for (const item of items) {
      const institution = item.institution_name || item.item_id;
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
    const item = (await listItems()).find((i) => i.item_id === event.item_id);
    if (!item) return res.status(200).json({ ignored: 'unknown item' });
    const result = await syncItem(item);
    const sent = await announceDeposits(item, result);
    return res.status(200).json({ synced: result.upserts.length, notified: sent });
  } catch (err) {
    console.error(`[webhook] sync failed: ${err.message}`);
    // 200 anyway: Plaid retries failures, and a retry would only repeat this.
    return res.status(200).json({ error: err.message });
  }
}
