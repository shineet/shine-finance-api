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

Rules:
- For anything about what they bought, paid, earned, spent, or any specific transaction, use search_transactions. Amounts are signed: negative is money out (spending), positive is money in.
- You can only ever see this one person's transactions. If they ask about someone else's finances, say you can only look at their own accounts.
- For general knowledge the app does not hold (what a merchant or company is, e.g. "what is DistroKid"), use web_search, and if it is a name that appears in their transactions you may also search their transactions to tie it to a charge.
- Never invent a transaction, amount, or date. If a search returns nothing, say so plainly.
- Keep answers short. Lead with the direct answer. Use a few bullet points only when listing. Do not dump every field; the app shows the matching transactions beneath your answer.
- Write amounts as dollars, e.g. $42.17. Do not show negative signs to the user; say "you spent $X" or "you received $X".`;

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
  { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
];

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
          if (block.type !== 'tool_use' || block.name !== 'search_transactions') continue;
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
