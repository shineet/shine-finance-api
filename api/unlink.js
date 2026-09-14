// POST /api/unlink   { item_id }  or  { all: true }
// Releases an Item at Plaid, then removes the local copy.
//
// Deleting our database row alone is NOT enough: the Item stays active at
// Plaid and keeps consuming a slot (10 on the Trial plan). /item/remove is
// what actually frees it.

import { plaid, authorize, listItems } from '../lib/plaid.js';

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

async function forget(itemId, accountIds, deleteTransactions) {
  // Transactions reference accounts, not items, so clearing them means going
  // by account id.
  //
  // But by DEFAULT nothing is cleared. A bank that has stopped talking is a
  // reason to remove a connection; it is never a reason to lose years of
  // recorded spending. The rows stay, keyed by account ids that no longer
  // resolve to a live account, and the Transactions list still shows them
  // because it reads by date rather than by account.
  //
  // This used to default the other way, and it cost a real Chase history: the
  // connection broke, removing it was the only remedy on offer, and removing
  // it took everything Chase had ever recorded. Deleting is now something that
  // has to be asked for in as many words.
  if (accountIds.length && deleteTransactions) {
    const list = accountIds.map(encodeURIComponent).join(',');
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/plaid_transactions?account_id=in.(${list})`,
      { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } }
    );
  }
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/plaid_items?item_id=eq.${itemId}`, {
    method: 'DELETE',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorize(req, res)) return;

  // Deletion is opt-in and explicit. Anything else -- a missing field, an old
  // build, a caller that has not thought about it -- keeps the history, which
  // is the direction a mistake should fail in. An older app sending
  // keep_transactions:false now keeps rather than erases, deliberately: that
  // flag was the one that lost the Chase history.
  const { item_id, all, delete_transactions } = req.body || {};
  const deleteTransactions = delete_transactions === true;
  if (!item_id && !all) return res.status(400).json({ error: 'item_id or all required' });

  try {
    const items = await listItems();
    const targets = all ? items : items.filter((i) => i.item_id === item_id);
    if (!targets.length) return res.status(404).json({ error: 'No matching item' });

    const removed = [];
    const errors = [];

    for (const item of targets) {
      const institution = item.institution_name || item.item_id;
      // Collect account ids before the token dies, so the transactions for
      // this item can still be identified afterwards.
      let accountIds = [];
      try {
        const accts = await plaid('/accounts/get', { access_token: item.access_token });
        accountIds = (accts.accounts || []).map((a) => a.account_id);
      } catch {
        // Token may already be invalid; proceed with local cleanup regardless.
      }

      try {
        await plaid('/item/remove', { access_token: item.access_token });
      } catch (err) {
        // Already-removed or invalid tokens still need the local row gone,
        // otherwise a dead item lingers in the UI forever.
        errors.push({ institution, error: err.message, code: err.plaidCode });
      }

      await forget(item.item_id, accountIds, deleteTransactions);
      console.log(
        `[unlink] ${institution}: connection removed, ` +
        `${deleteTransactions ? `${accountIds.length} account(s) of transactions DELETED` : 'history kept'}`
      );
      removed.push(institution);
    }

    return res.status(200).json({
      removed: removed.length,
      institutions: removed,
      keptTransactions: !deleteTransactions,
      errors,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });
  }
}
