// Every linked account by id, with a name a person recognises ("Bank of
// America checking ending 1234") and its balance now. Aura needs this to say
// which account a bill comes out of and whether that account can cover it.

import { plaid, listItems } from './plaid.js';
import { sbHeaders, rest, forUser } from './db.js';

const KIND = { checking: 'checking', savings: 'savings', 'credit card': 'card', paypal: 'balance', 'money market': 'money market', cd: 'CD' };

/// "Bank of America checking ending 1234", "Chase card ending 5678".
export function labelOf(a) {
  const bank = a.institution || 'Account';
  const kind = KIND[a.subtype] || (a.type === 'credit' ? 'card' : a.type === 'loan' ? 'loan' : a.subtype || a.type || 'account');
  if (a.subtype === 'paypal' && a.type === 'depository') return 'PayPal (charged to the card or bank PayPal uses)';
  return `${bank} ${kind}${a.mask ? ` ending ${a.mask}` : ''}`;
}

/// Map of account_id -> { id, label, institution, type, subtype, mask, current, available, limit }.
/// Live from Plaid (masks and today's balances); the stored snapshot fills in
/// any bank that does not answer.
export async function accountBook(user) {
  const book = new Map();
  const items = await listItems(user);
  await Promise.all(items.map(async (item) => {
    try {
      const out = await plaid('/accounts/get', { access_token: item.access_token });
      for (const a of out.accounts || []) {
        const row = {
          id: a.account_id,
          institution: item.institution_name || null,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          mask: a.mask || null,
          current: a.balances?.current ?? null,
          available: a.balances?.available ?? null,
          limit: a.balances?.limit ?? null,
        };
        row.label = labelOf(row);
        book.set(a.account_id, row);
      }
    } catch {
      // Falls back to the snapshot below.
    }
  }));

  try {
    const r = await fetch(rest(`balance_snapshots?select=account_id,institution,name,type,subtype,current,available,limit,as_of&${forUser(user)}`) + '&order=as_of.desc&limit=500', { headers: sbHeaders() });
    if (r.ok) {
      for (const s of await r.json()) {
        if (book.has(s.account_id)) continue;
        const row = { id: s.account_id, institution: s.institution, name: s.name, type: s.type, subtype: s.subtype, mask: null, current: s.current, available: s.available, limit: s.limit };
        row.label = labelOf(row);
        book.set(s.account_id, row);
      }
    }
  } catch {}
  return book;
}

/// Money you can spend from an account today: a cash account's available
/// balance (or current), a card's remaining credit.
export function spendable(a) {
  if (!a) return null;
  if (a.type === 'depository') return Number(a.available ?? a.current ?? 0);
  if (a.type === 'credit') return a.limit == null ? null : Number(a.available ?? (a.limit - (a.current || 0)));
  return null;
}
