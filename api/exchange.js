// POST /api/exchange  { link_token }
// Finishes a Hosted Link session.
//
// After the user completes Link in the browser, the app calls this with the
// link_token it started with. /link/token/get reports the session's results,
// including the public_token, which is then swapped for the long-lived
// access_token. The access_token never leaves the server.

import { plaid, authorize, saveItem } from '../lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  const { link_token } = req.body || {};
  if (!link_token) return res.status(400).json({ error: 'link_token required' });

  try {
    const session = await plaid('/link/token/get', { link_token });

    // link_sessions is newest-last; a session only has results once the user
    // actually finished. Anything else means they bailed or are mid-flow.
    const sessions = session.link_sessions || [];
    const results = sessions
      .flatMap((s) => s.results?.item_add_results || [])
      .filter((r) => r.public_token);

    if (!results.length) {
      return res.status(409).json({ error: 'Link not completed yet', linked: 0 });
    }

    const linked = [];
    for (const result of results) {
      const exchanged = await plaid('/item/public_token/exchange', {
        public_token: result.public_token,
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
