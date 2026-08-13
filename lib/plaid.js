// Shared Plaid + storage helpers.
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

export async function saveCursor(itemId, cursor) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/plaid_items?item_id=eq.${itemId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ cursor, updated_at: new Date().toISOString() }),
  });
}
