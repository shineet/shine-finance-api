// POST /api/link-token
// Creates a Plaid Link session and returns a Hosted Link URL.
//
// Hosted Link means the app never embeds Plaid's SDK: it opens this URL in a
// browser (Safari on iOS, default browser on macOS), the user authenticates
// with their bank, and Plaid redirects back to the app's custom scheme.

import { plaid, authorize } from '../lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    // Without a completion_redirect_uri, Plaid ends on its own "all set"
    // screen and the user simply switches back to the app, which finishes the
    // exchange on becoming active. Only set one if a real https URL is
    // configured -- pointing at an unregistered custom scheme would show a
    // browser error after a link that actually succeeded.
    const redirect = process.env.COMPLETION_REDIRECT_URI;
    const hostedLink = redirect?.startsWith('https://')
      ? { completion_redirect_uri: redirect }
      : {};

    const out = await plaid('/link/token/create', {
      client_name: 'MyFinance',
      language: 'en',
      country_codes: ['US'],
      // Stable per-user id. One human uses this backend, so a constant is fine
      // and keeps re-links mapping to the same Plaid user.
      user: { client_user_id: 'shine' },
      products: ['transactions'],
      hosted_link: hostedLink,
    });

    return res.status(200).json({
      link_token: out.link_token,
      hosted_link_url: out.hosted_link_url,
      expiration: out.expiration,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
