// The person behind the app.
//
// POST   /api/account  { op: 'signin', identity_token, email?, device? }
//          Sign in with Apple. Verifies Apple's identity token, finds or makes
//          the users row, and returns a session token the app sends as its
//          Bearer from then on. No other credential is ever issued.
// GET    /api/account  (session)  who this is, and how many banks are linked
// POST   /api/account  { op: 'signout' }  (session)  ends this device's session
// DELETE /api/account  { confirm: 'DELETE' }  (session)
//          Deletes the account: every bank connection released at Plaid, then
//          the users row, which takes every row of theirs with it (each table's
//          user_id is ON DELETE CASCADE). Apple requires this to be in the app.
//
// The owner's first Apple sign-in claims the owner row. A device still holding
// the owner's APP_TOKEN sends it as the Bearer on that sign-in, and the Apple
// id is attached to the existing owner row instead of making a new, empty one.
// That is the only way to reach the owner row by Apple id, so nobody else's
// sign-in can land on his data.

import {
  authorize, isOwnerToken, ownerUser, callerToken,
  createSession, endSession, verifyAppleIdentity,
} from '../lib/auth.js';
import { plaid, listItems } from '../lib/plaid.js';
import { sbHeaders, rest } from '../lib/db.js';

async function findByAppleSub(sub) {
  const r = await fetch(
    rest(`users?select=id,email,legacy&apple_sub=eq.${encodeURIComponent(sub)}&limit=1`),
    { headers: sbHeaders() }
  );
  if (!r.ok) throw new Error(`user lookup failed: ${await r.text()}`);
  return (await r.json())[0] || null;
}

async function patchUser(id, fields) {
  const r = await fetch(rest(`users?id=eq.${id}`), {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`user update failed: ${await r.text()}`);
  return (await r.json())[0];
}

async function createUser(fields) {
  const r = await fetch(rest('users'), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`user create failed: ${await r.text()}`);
  return (await r.json())[0];
}

function signupAllowed(claims) {
  if ((process.env.SIGNUPS || '').toLowerCase() === 'open') return true;
  const allowed = (process.env.SIGNUP_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  // Only Apple's own claim counts, and only when Apple says it is verified;
  // an email the app sends is not proof of anything.
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return verified && !!claims.email && allowed.includes(String(claims.email).toLowerCase());
}

async function signIn(req, res) {
  const { identity_token, email, device } = req.body || {};
  let claims;
  try {
    claims = await verifyAppleIdentity(identity_token);
  } catch (err) {
    console.error('[account] Apple sign-in refused:', err.message);
    return res.status(401).json({ error: 'Sign in with Apple could not be verified' });
  }
  // Apple puts the email in the token on every sign-in when the person shared
  // it; the app's own copy only arrives the first time.
  const mail = claims.email || (typeof email === 'string' ? email.slice(0, 200) : null);
  const now = new Date().toISOString();

  let user = await findByAppleSub(claims.sub);
  let isNew = false;
  if (!user && isOwnerToken(callerToken(req))) {
    const owner = await ownerUser();
    if (owner && !owner.apple_sub) {
      user = await patchUser(owner.id, { apple_sub: claims.sub, email: mail, last_seen_at: now });
      console.log('[account] owner row claimed by Apple sign-in');
    }
  }
  if (!user) {
    // Closed until launch. Each person can link banks, and the Plaid Trial plan
    // allows 10 connections in total across everyone; an open door would let
    // any Apple id spend them. SIGNUPS=open lets anyone in; otherwise only the
    // Apple-verified emails listed in SIGNUP_EMAILS (comma separated) get in.
    if (!signupAllowed(claims)) {
      console.log('[account] sign-up refused: not open yet');
      return res.status(403).json({ error: 'MyFinance is not open for new accounts yet.' });
    }
    user = await createUser({ apple_sub: claims.sub, email: mail, last_seen_at: now });
    isNew = true;
    console.log('[account] new user');
  } else {
    await patchUser(user.id, { last_seen_at: now, ...(mail ? { email: mail } : {}) });
  }

  const session = await createSession(user.id, device);
  return res.status(200).json({ session, user: { id: user.id, email: mail || user.email || null, is_new: isNew } });
}

async function deleteAccount(req, res, user) {
  if ((req.body || {}).confirm !== 'DELETE') {
    return res.status(400).json({ error: "confirm: 'DELETE' required" });
  }
  // The owner's history predates accounts and exists nowhere else.
  if (user.legacy) {
    return res.status(403).json({ error: "The owner's account cannot be deleted from the app" });
  }

  // Release each bank at Plaid first. Deleting rows alone leaves the Item live
  // at Plaid, still billable and still able to read the bank.
  const items = await listItems(user);
  const failed = [];
  for (const item of items) {
    try {
      await plaid('/item/remove', { access_token: item.access_token });
    } catch (err) {
      // Already gone at Plaid is fine; anything else is logged and the delete
      // carries on, because keeping the data is not an answer to a Plaid error.
      if (err.plaidCode !== 'ITEM_NOT_FOUND') failed.push(err.plaidCode || err.message);
    }
  }

  const r = await fetch(rest(`users?id=eq.${user.id}&legacy=is.false`), {
    method: 'DELETE',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
  });
  if (!r.ok) throw new Error(`delete failed: ${await r.text()}`);
  const gone = (await r.json()).length;
  console.log(`[account] deleted: ${items.length} connection(s) released, ${failed.length} Plaid error(s)`);
  return res.status(200).json({ deleted: gone === 1, connections_released: items.length - failed.length });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST' && (req.body || {}).op === 'signin') return await signIn(req, res);

    const user = await authorize(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const items = await listItems(user);
      return res.status(200).json({
        id: user.id,
        email: user.email || null,
        owner: !!user.legacy,
        signed_in_with_apple: !!user.apple_sub,
        connections: items.length,
      });
    }
    if (req.method === 'POST' && (req.body || {}).op === 'signout') {
      if (!isOwnerToken(callerToken(req))) await endSession(callerToken(req));
      return res.status(200).json({ signed_out: true });
    }
    if (req.method === 'DELETE') return await deleteAccount(req, res, user);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[account]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
