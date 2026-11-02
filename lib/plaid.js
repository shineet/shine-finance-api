// Shared Plaid + storage helpers.

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

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export function plaidHost() {
  const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const host = PLAID_HOSTS[env];
  if (!host) throw new Error(`Unknown PLAID_ENV "${env}" (expected sandbox or production)`);
  return host;
}

export async function plaid(path, body = {}) {
  const res = await fetch(`${plaidHost()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
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
// Single shared token: this backend serves exactly one user (Shine), so there
// is no account system -- just a check that the caller is his app.
export function authorize(req, res) {
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expected = process.env.APP_TOKEN;
  if (!expected) {
    res.status(500).json({ error: 'APP_TOKEN not configured' });
    return false;
  }
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── Item storage (Supabase) ─────────────────────────────────────────────────
// One row per linked institution. Access tokens are long-lived and are the
// keys to the kingdom, so they only ever move server-side via the service key.

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

export async function saveItem({ itemId, accessToken, institutionName }) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/plaid_items`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      item_id: itemId,
      access_token: accessToken,
      institution_name: institutionName || null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`saveItem failed: ${await res.text()}`);
  return (await res.json())[0];
}

export async function listItems() {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/plaid_items?select=item_id,access_token,institution_name,cursor`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`listItems failed: ${await res.text()}`);
  return res.json();
}

// The response is checked. It used to be discarded, which meant a cursor that
// failed to persist looked exactly like one that saved: the next sync would
// silently start from the beginning again, forever, and nothing would say so.
export async function saveCursor(itemId, cursor) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/plaid_items?item_id=eq.${itemId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ cursor, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`saveCursor failed: ${await res.text()}`);
}
