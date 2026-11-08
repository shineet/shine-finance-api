// Shared Plaid + storage helpers.

import { sbHeaders, rest, forUser } from './db.js';
import { seal, open, isSealed } from './secrets.js';

// ── Supabase clock skew ─────────────────────────────────────────────────────
// Supabase now and then answers 401 PGRST303 "JWT issued at future": its
// gateway mints a short-lived token for the secret key and PostgREST, a few
// milliseconds behind it, refuses it. The same request succeeds a moment
// later. It surfaced as a red error bar in the app and a failed webhook sync
// (2026-11-02, twice), so every Supabase call retries that one error. Every
// endpoint imports this file, so wrapping fetch here covers all of them.
if (!globalThis.fetch.__supabaseRetry) {
  const realFetch = globalThis.fetch;
  const wrapped = async (url, opts) => {
    let res = await realFetch(url, opts);
    const base = process.env.SUPABASE_URL;
    if (res.status !== 401 || !base || !String(url).startsWith(base)) return res;
    if (!(await res.clone().text()).includes('PGRST303')) return res;
    for (const wait of [250, 750, 1500]) {
      await new Promise((r) => setTimeout(r, wait));
      res = await realFetch(url, opts);
      if (res.status !== 401) {
        console.warn(`supabase: PGRST303 cleared after a ${wait} ms retry`);
        return res;
      }
    }
    console.error('supabase: PGRST303 persisted through 3 retries');
    return res;
  };
  wrapped.__supabaseRetry = true;
  globalThis.fetch = wrapped;
}
//
// PLAID_ENV switches the whole backend between fake sandbox data and real
// accounts -- nothing else needs to change when production access lands.
//
// One exception runs alongside it: the sample bank ("Try with a sample bank",
// api/exchange.js). It is a Plaid Sandbox Item living next to real ones, so
// every call about it has to go to the sandbox host with the sandbox secret.
// Plaid names the environment in the token itself (access-sandbox-...), so a
// call routes by its access_token and no column records which is which.

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

const plaidEnv = () => (process.env.PLAID_ENV || 'sandbox').toLowerCase();

export function plaidHost() {
  const env = plaidEnv();
  const host = PLAID_HOSTS[env];
  if (!host) throw new Error(`Unknown PLAID_ENV "${env}" (expected sandbox or production)`);
  return host;
}

export const isSandboxToken = (token) => typeof token === 'string' && token.startsWith('access-sandbox-');

/// Host and secret for one call. `sandbox` forces the sample bank's
/// environment; otherwise a sandbox access token chooses it.
function target(body, sandbox) {
  if (!(sandbox || isSandboxToken(body.access_token)) || plaidEnv() === 'sandbox') {
    return { host: plaidHost(), secret: process.env.PLAID_SECRET };
  }
  const secret = process.env.PLAID_SANDBOX_SECRET;
  if (!secret) {
    const err = new Error('The sample bank is not available right now');
    err.status = 503;
    throw err;
  }
  return { host: PLAID_HOSTS.sandbox, secret };
}

export async function plaid(path, body = {}, { sandbox = false } = {}) {
  const { host, secret } = target(body, sandbox);
  const res = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret,
      ...body,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    // Plaid returns a structured error body; surface the useful parts rather
    // than a bare status code, but never echo the request (it holds the secret).
    const msg = json.error_message || json.error_code || `Plaid ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.plaidCode = json.error_code;
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Lives in lib/auth.js; re-exported so every endpoint keeps one import line.
// It is async now and returns the calling user (or null after answering 401).
export { authorize } from './auth.js';

// ── Item storage (Supabase) ─────────────────────────────────────────────────
// One row per linked institution, per person. Access tokens are long-lived and
// are the keys to the kingdom: sealed at rest (lib/secrets.js), opened only
// here, and never sent to the app.

const ITEM_FIELDS = 'item_id,user_id,access_token,institution_name,cursor';

export async function saveItem({ userId, itemId, accessToken, institutionName }) {
  const res = await fetch(rest('plaid_items'), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      item_id: itemId,
      user_id: userId,
      access_token: seal(accessToken),
      institution_name: institutionName || null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`saveItem failed: ${await res.text()}`);
  return (await res.json())[0];
}

// Opens each row's token. A row still holding a bare token (written before
// encryption) is re-sealed in place, so the table converts itself as it is used.
async function opened(rows) {
  for (const row of rows) {
    const stored = row.access_token;
    row.access_token = open(stored);
    if (!isSealed(stored) && process.env.TOKEN_KEY) {
      const r = await fetch(rest(`plaid_items?item_id=eq.${encodeURIComponent(row.item_id)}`), {
        method: 'PATCH',
        headers: { ...sbHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ access_token: seal(stored) }),
      });
      console.log(`[secrets] ${row.institution_name || row.item_id}: re-sealed ${r.ok ? 'ok' : 'FAILED'}`);
    }
  }
  return rows;
}

/// This person's Items.
export async function listItems(user) {
  const res = await fetch(rest(`plaid_items?select=${ITEM_FIELDS}&${forUser(user)}`), { headers: sbHeaders() });
  if (!res.ok) throw new Error(`listItems failed: ${await res.text()}`);
  return opened(await res.json());
}

/// One Item by its Plaid id, whoever owns it. For the webhook only, which is
/// called by Plaid about an Item rather than by a person.
export async function itemById(itemId) {
  const res = await fetch(
    rest(`plaid_items?select=${ITEM_FIELDS}&item_id=eq.${encodeURIComponent(itemId)}&limit=1`),
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`itemById failed: ${await res.text()}`);
  return (await opened(await res.json()))[0] || null;
}

// The response is checked. It used to be discarded, which meant a cursor that
// failed to persist looked exactly like one that saved: the next sync would
// silently start from the beginning again, forever, and nothing would say so.
export async function saveCursor(itemId, cursor) {
  const res = await fetch(rest(`plaid_items?item_id=eq.${encodeURIComponent(itemId)}`), {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ cursor, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`saveCursor failed: ${await res.text()}`);
}
