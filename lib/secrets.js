// Plaid access tokens, encrypted at rest.
//
// An access token reads a person's bank for as long as the Item lives. With one
// user that was a risk to one person; with many, a leaked plaid_items table
// would be everyone's banks at once. So tokens are stored AES-256-GCM sealed
// with TOKEN_KEY (32 random bytes, base64), which lives only in Vercel's env.
//
// LOSING TOKEN_KEY LOSES EVERY BANK LINK: the tokens cannot be recovered and
// every person would have to link again. Keep a copy of it somewhere safe.
//
// Rows written before encryption hold the bare token. `open` passes those
// through, and lib/plaid.js re-seals them the first time it reads them.

import crypto from 'node:crypto';

const PREFIX = 'enc1:';

function key() {
  const raw = process.env.TOKEN_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64');
  return buf;
}

export const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/// Seals a token. Without TOKEN_KEY it is stored bare and says so in the log,
/// so a missing env var degrades to the old behaviour instead of breaking links.
export function seal(token) {
  const k = key();
  if (!k) {
    console.warn('[secrets] TOKEN_KEY not set; access token stored unencrypted');
    return token;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function open(stored) {
  if (!isSealed(stored)) return stored;
  const k = key();
  if (!k) throw new Error('TOKEN_KEY not set; cannot read an encrypted access token');
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
