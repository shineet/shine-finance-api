// POST /api/ask  { "question": "did I buy anything on Amazon in the last 2 weeks?" }
//
// The "Ask" feature: a question in plain English about the signed-in user's own
// money, answered by Claude. Two tools are available to it:
//
//   search_transactions  -- a CLIENT tool run here, against this user's rows
//   only. Claude picks the filters (merchant, dates, amount, direction); it
//   never picks whose data. The query is always scoped with forUser(user), and
//   `user` comes from the bearer token, not from anything the question says, so
//   one person can only ever reach their own transactions.
//
//   web_search  -- Anthropic's server tool, for general knowledge the app does
//   not hold ("what is DistroKid"). Anthropic runs it; we just pass the turn
//   back when it pauses.
//
// Returns { answer, transactions }: the written reply, plus the full rows the
// search touched so the app can list them (tappable into the detail view).
//
// Privacy: this sends the user's transaction names, amounts and dates to
// Anthropic when they ask. That is disclosed in the app's privacy policy.

import { authorize } from '../lib/auth.js';
import { sbHeaders, rest, forUser } from '../lib/db.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 6;

const SYSTEM = `You are the "Ask" assistant inside MyFinance, a personal finance app. You answer questions about the signed-in person's own money, in a warm, plain, concise way. Today is ${new Date().toISOString().slice(0, 10)}.

You have tools that see their REAL financial data. Reach for them instead of giving generic answers:
- get_balances: how much they have right now -- cash, credit-card debt, investments, net worth, available credit, and each account. Call this BEFORE giving any advice about what to do with cash, savings or debt, or any question about their overall position, so the answer fits their actual numbers.
- search_transactions: what they bought, paid, earned or spent, or a specific charge. Amounts are signed: negative is money out (spending), positive is money in.
- web_search: general knowledge the app does not hold (what a merchant or company is, e.g. "what is DistroKid"). If the name also appears in their transactions, you may search those too to tie it to a charge.

Rules:
- Prefer their real numbers over generic guidance. If they ask what to do with spare cash, call get_balances (and search_transactions for their spending if it helps) and tailor the plan to their actual cash, card debt and balances. NEVER say you cannot see their balances -- you can, via get_balances.
- You can only ever see THIS person's data. If they ask about someone else's finances, say you can only look at their own accounts.
- Never invent a number, transaction, or date. If a tool returns nothing, say so plainly.
- Keep answers short. Lead with the direct answer. Use a few bullets only when listing. Do not dump every field; the app shows matching transactions beneath your answer.
- Write amounts as dollars, e.g. $42.17. Do not show negative signs; say "you spent $X", "you have $X", or "you owe $X".
- You are not a licensed financial advisor. For a big or irreversible decision, add one brief line to confirm with a professional. Do not lecture.`;

const TOOLS = [
  {
    name: 'search_transactions',
    description:
      "Search the signed-in user's own bank transactions. Returns matching rows newest first. Amounts are signed: negative = money out (spend), positive = money in. Use for any question about what they bought, paid, received or spent, or to look up a specific merchant.",
    input_schema: {
      type: 'object',
      properties: {
        name_contains: {
          type: 'string',
          description:
            "Case-insensitive substring of the merchant or description, e.g. 'amazon', 'adobe', 'distrokid'. Omit to match everything.",
        },
        days: {
          type: 'integer',
          description: 'How many days back from today to look, 1 to 730. Default 90.',
        },
        direction: {
          type: 'string',
          enum: ['spend', 'income', 'any'],
          description: 'spend = money out only, income = money in only, any = both. Default any.',
        },
        min_amount: { type: 'number', description: 'Smallest absolute dollar amount to include.' },
        max_amount: { type: 'number', description: 'Largest absolute dollar amount to include.' },
        limit: { type: 'integer', description: 'Max rows to return, 1 to 100. Default 50.' },
      },
    },
  },
  {
    name: 'get_balances',
    description:
      "Read the signed-in user's current balances from the latest daily snapshot: each account's balance, plus totals for cash, credit-card debt, investments, net worth and available credit. Use for any question about how much they have, their net worth or overall position, or what to do with cash, savings or debt. A credit account's 'current' is the amount OWED (a positive number); cash and investments are assets.",
    input_schema: { type: 'object', properties: {} },
  },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
];

/// Reads this user's latest account balances and sums them into a plain
/// summary the model can give advice from. Source is balance_snapshots (written
/// on every app open), so it needs no live Plaid call. Scoped by forUser.
async function runBalances(user) {
  const url =
    rest(
      `balance_snapshots?select=account_id,institution,name,type,subtype,current,available,limit,as_of&${forUser(user)}`
    ) + '&order=as_of.desc&limit=500';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const all = await r.json();
  if (!all.length) return { as_of: null, summary: null, accounts: [] };

  // The most recent snapshot date holds the live accounts' fresh balances;
  // older dates also carry accounts that have since been re-linked or removed.
  const newest = all[0].as_of;
  const seen = new Set();
  const rows = [];
  for (const row of all) {
    if (row.as_of !== newest || seen.has(row.account_id)) continue;
    seen.add(row.account_id);
    rows.push(row);
  }

  const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
  const isDebt = (t) => t === 'credit' || t === 'loan';
  let cash = 0, cardDebt = 0, investments = 0, otherAssets = 0, availableCredit = 0;
  const accounts = rows.map((a) => {
    const cur = Number(a.current) || 0;
    if (a.type === 'depository') cash += cur;
    else if (a.type === 'credit') {
      cardDebt += cur;
      if (a.limit != null) availableCredit += Number(a.limit) - cur;
    } else if (a.type === 'investment' || a.type === 'brokerage') investments += cur;
    else if (!isDebt(a.type)) otherAssets += cur;
    return {
      name: a.name,
      institution: a.institution,
      type: a.type,
      subtype: a.subtype,
      current: num(a.current),
      available: num(a.available),
      limit: num(a.limit),
    };
  });
  const assets = cash + investments + otherAssets;
  const debts = rows
    .filter((a) => isDebt(a.type))
    .reduce((s, a) => s + (Number(a.current) || 0), 0);
  const summary = {
    as_of: newest,
    cash: num(cash),
    credit_card_debt: num(cardDebt),
    investments: num(investments),
    other_assets: num(otherAssets),
    available_credit: num(availableCredit),
    net_worth: num(assets - debts),
  };
  return { as_of: newest, summary, accounts };
}

/// Runs one search_transactions call against this user's rows. Returns the full
/// rows (for the app) and a compact form (for the model).
async function runSearch(user, input) {
  const days = Math.min(Math.max(parseInt(input.days, 10) || 90, 1), 730);
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 100);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  let url =
    rest(
      `plaid_transactions?select=transaction_id,account_id,institution,date,name,amount,currency,pending,category,category_label,channel&${forUser(user)}`
    ) + `&date=gte.${sinceStr}&order=date.desc&limit=${limit}`;

  const term = (input.name_contains || '').trim();
  if (term) url += `&name=ilike.*${encodeURIComponent(term)}*`;

  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  let rows = await r.json();

  // direction and amount bounds are easier (and safe) to apply here than in the
  // PostgREST query, since amount is signed.
  const dir = input.direction || 'any';
  if (dir === 'spend') rows = rows.filter((t) => Number(t.amount) < 0);
  if (dir === 'income') rows = rows.filter((t) => Number(t.amount) > 0);
  if (typeof input.min_amount === 'number') rows = rows.filter((t) => Math.abs(Number(t.amount)) >= input.min_amount);
  if (typeof input.max_amount === 'number') rows = rows.filter((t) => Math.abs(Number(t.amount)) <= input.max_amount);

  // Compact view for the model: enough to reason and answer, no ids.
  const compact = rows.slice(0, limit).map((t) => ({
    date: t.date,
    name: t.name,
    amount: Number(t.amount),
    category: t.category_label || t.category || null,
    pending: t.pending || false,
  }));
  return { rows, compact };
}

async function callAnthropic(messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await authorize(req, res);
  if (!user) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Ask is not configured yet.' });
  }

  const question = (req.body?.question || '').toString().trim();
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (question.length > 1000) return res.status(400).json({ error: 'That question is too long.' });

  const messages = [{ role: 'user', content: question }];
  const shown = new Map(); // transaction_id -> full row, in search order

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callAnthropic(messages);
      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason === 'tool_use') {
        // Answer every client tool call; the web_search server tool is run by
        // Anthropic, so it is not in this list.
        const results = [];
        for (const block of reply.content) {
          if (block.type !== 'tool_use') continue;
          if (block.name === 'search_transactions') {
            try {
              const { rows, compact } = await runSearch(user, block.input || {});
              for (const row of rows) if (!shown.has(row.transaction_id)) shown.set(row.transaction_id, row);
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ count: compact.length, transactions: compact }),
              });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `search failed: ${err.message}`,
                is_error: true,
              });
            }
          } else if (block.name === 'get_balances') {
            try {
              const snapshot = await runBalances(user);
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(snapshot),
              });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `balances failed: ${err.message}`,
                is_error: true,
              });
            }
          }
          // web_search is a server tool, run by Anthropic, not answered here.
        }
        if (results.length) {
          messages.push({ role: 'user', content: results });
          continue;
        }
        // tool_use with only server tools (web_search): fall through to resend.
      }

      if (reply.stop_reason === 'pause_turn' || reply.stop_reason === 'tool_use') {
        continue; // hand the turn back so Anthropic can run / finish the search
      }

      // end_turn (or anything else): collect the answer text and any citations.
      const answer = reply.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      const sources = [];
      for (const b of reply.content) {
        for (const c of b.citations || []) {
          if (c.url && !sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title });
        }
      }

      const transactions = [...shown.values()].slice(0, 25);
      return res.status(200).json({ answer: answer || "I could not find an answer to that.", sources, transactions });
    }

    return res.status(200).json({
      answer: 'That turned into a longer search than expected. Try asking it a simpler way.',
      sources: [],
      transactions: [...shown.values()].slice(0, 25),
    });
  } catch (err) {
    console.error('[ask]', err.message);
    return res.status(502).json({ error: 'Ask could not answer just now.' });
  }
}
