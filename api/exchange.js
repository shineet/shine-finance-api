// POST /api/exchange  { link_token }   Finishes a Hosted Link session.
// POST /api/exchange  { sample: true }  Adds the sample bank (below).
//
// After the user completes Link in the browser, the app calls this with the
// link_token it started with. /link/token/get reports the session's results,
// including the public_token, which is then swapped for the long-lived
// access_token. The access_token never leaves the server.

import { plaid, authorize, saveItem, listItems, isSandboxToken } from '../lib/plaid.js';
import { syncItem } from '../lib/sync.js';

// "Try with a sample bank": Plaid's Sandbox test institution, so someone can
// see the app working before trusting it with a real bank, and App Review can
// try it without one. It lives in this endpoint because the project is at
// Vercel's 12-function limit. Its calls route to the sandbox by the token
// (lib/plaid.js); it is removed like any other bank, and costs nothing.
const SAMPLE_INSTITUTION = 'ins_109508'; // First Platypus Bank
export const SAMPLE_NAME = 'Sample Bank (test data)';

async function addSample(user) {
  const existing = (await listItems(user)).find((i) => isSandboxToken(i.access_token));
  if (existing) return { linked: 0, institutions: [], already: true };

  const created = await plaid('/sandbox/public_token/create', {
    institution_id: SAMPLE_INSTITUTION,
    initial_products: ['transactions', 'liabilities', 'investments'],
  }, { sandbox: true });
  const exchanged = await plaid('/item/public_token/exchange', {
    public_token: created.public_token,
  }, { sandbox: true });
  await saveItem({
    userId: user.id,
    itemId: exchanged.item_id,
    accessToken: exchanged.access_token,
    institutionName: SAMPLE_NAME,
  });

  // Sandbox prepares transactions a moment after the Item exists, and with no
  // webhook on a sample Item nothing would say when. Wait for the first batch
  // here, so the app shows a populated sample rather than an empty one.
  const item = {
    item_id: exchanged.item_id, user_id: user.id, access_token: exchanged.access_token,
    institution_name: SAMPLE_NAME, cursor: null,
  };
  for (const wait of [0, 1500, 2500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      if ((await syncItem(item)).upserts.length) break;
    } catch (err) {
      console.warn(`[sample] first sync: ${err.message}`);
    }
  }
  console.log(`[sample] added for user ${user.id}`);
  return { linked: 1, institutions: [SAMPLE_NAME] };
}


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  const { link_token, sample } = req.body || {};
  if (sample === true) {
    try {
      return res.status(200).json(await addSample(user));
    } catch (err) {
      console.error(`[sample] failed: ${err.message}`);
      return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
    }
  }
  if (!link_token) return res.status(400).json({ error: 'link_token required' });

  try {
    const session = await plaid('/link/token/get', { link_token });

    // A session only carries a public token once the user actually finished.
    // Plaid exposes it at two paths: results.item_add_results[] is the current
    // structure but requires an account migration to populate, so by default
    // only the deprecated on_success.public_token is set. Read both, dedupe.
    const sessions = session.link_sessions || [];
    const tokens = new Set();
    for (const s of sessions) {
      for (const r of s.results?.item_add_results || []) {
        if (r.public_token) tokens.add(r.public_token);
      }
      if (s.on_success?.public_token) tokens.add(s.on_success.public_token);
    }

    if (!tokens.size) {
      return res.status(409).json({ error: 'Link not completed yet', linked: 0 });
    }

    const linked = [];
    for (const publicToken of tokens) {
      const exchanged = await plaid('/item/public_token/exchange', {
        public_token: publicToken,
      });

      // Institution name is only for display in the app's account list.
      let institutionName = null;
      try {
        const item = await plaid('/item/get', { access_token: exchanged.access_token });
        const instId = item.item?.institution_id;
        if (instId) {
          const inst = await plaid('/institutions/get_by_id', {
            institution_id: instId,
            country_codes: ['US'],
          });
          institutionName = inst.institution?.name || null;
        }
      } catch {
        // Non-fatal: a missing display name shouldn't fail the link.
      }

      await saveItem({
        userId: user.id,
        itemId: exchanged.item_id,
        accessToken: exchanged.access_token,
        institutionName,
      });
      linked.push(institutionName || exchanged.item_id);
    }

    return res.status(200).json({ linked: linked.length, institutions: linked });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
