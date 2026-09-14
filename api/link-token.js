// POST /api/link-token
// Creates a Plaid Link session and returns a Hosted Link URL.
//
// Hosted Link means the app never embeds Plaid's SDK: it opens this URL in a
// browser (Safari on iOS, default browser on macOS), the user authenticates
// with their bank, and Plaid redirects back to the app's custom scheme.

import { plaid, authorize, listItems } from '../lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  try {
    // UPDATE MODE: repairing one bank rather than adding another.
    //
    // When a login expires, Plaid stops returning that institution's accounts
    // entirely -- which is how Chase hid two pay cycles. The obvious remedy,
    // remove it and link it again, is the wrong one: it drops the Item and
    // every transaction filed under its accounts, so the history goes with it.
    //
    // Passing the existing access_token opens Link on that bank's own login,
    // fixes the Item in place, and keeps the id, the accounts and the
    // transactions exactly as they were.
    const { item_id } = req.body || {};
    let updateFor = {};
    if (item_id) {
      const items = await listItems();
      const target = items.find((i) => i.item_id === item_id);
      if (!target) return res.status(404).json({ error: 'No such connection' });
      updateFor = { access_token: target.access_token };
    }
    // Which mode this is, named in the log. Update mode and a fresh link look
    // identical from outside and behave completely differently: one repairs a
    // broken Item, the other creates a second one beside it. When a reconnect
    // "did not work", the first thing worth knowing is which of the two ran.
    console.log('link-token:', item_id ? `UPDATE mode for ${item_id}` : 'NEW link');
    // The completion redirect is the likeliest thing to break a session AFTER
    // the bank has authorised: Plaid rejects a redirect URI that is not
    // registered in the dashboard, and the failure surfaces as Link's generic
    // "Something went wrong" with nothing said about why.
    console.log('link-token: completion redirect =',
                process.env.COMPLETION_REDIRECT_URI || '(none set)');

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
      // liabilities supplies APR, minimum payment, due dates and statement
      // balances -- the inputs payoff projection needs. It MUST be optional,
      // not required: as a required product Plaid rejects any institution
      // with no credit account ("No liability accounts"), which blocks
      // linking a checking-only bank entirely.
      // Both are omitted in update mode: Plaid rejects a product list when
      // repairing an existing Item, since it already knows what it was
      // authorised for.
      ...(item_id ? {} : { products: ['transactions'], optional_products: ['liabilities'] }),
      // How much history a NEW Item starts with. This is where days_requested
      // actually belongs; it was on /transactions/sync, which rejects it.
      // Recurring detection needs at least 180 days to be reliable, so ask for
      // two years and let income and bill patterns be visible from day one.
      // Omitted in update mode, along with the product list.
      ...(item_id ? {} : { transactions: { days_requested: 730 } }),
      hosted_link: hostedLink,
      ...updateFor,
    });

    console.log('link-token: created ok');
    return res.status(200).json({
      link_token: out.link_token,
      hosted_link_url: out.hosted_link_url,
      expiration: out.expiration,
    });
  } catch (err) {
    console.error('link-token failed:', err.plaidCode || '(no code)', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
