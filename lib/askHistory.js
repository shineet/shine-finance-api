// Conversation support for /api/ask. Pure functions, no I/O, so they can be tested alone.
//
// The app keeps the thread on the device and sends the recent turns back with each new
// question; the server stores nothing. Claude requires user and assistant messages to
// alternate, starting with a user message, so whatever arrives is cleaned first.

export const MAX_HISTORY_MESSAGES = 12;   // about six exchanges
export const MAX_HISTORY_CHARS = 1500;    // per message

/** `history` as sent by the app -> messages ready to precede the new question. */
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = [];
  for (const m of history) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    const text = typeof m?.content === 'string' ? m.content.trim().slice(0, MAX_HISTORY_CHARS) : '';
    if (!role || !text) continue;
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === role) { last.content = text; continue; } // keep the newer of two in a row
    cleaned.push({ role, content: text });
  }
  const recent = cleaned.slice(-MAX_HISTORY_MESSAGES);
  while (recent.length && recent[0].role !== 'user') recent.shift();    // must start with the user
  while (recent.length && recent[recent.length - 1].role !== 'assistant') recent.pop(); // the new question is the user's turn
  return recent;
}

/**
 * The model ends an answer with a line "FOLLOWUPS: one | two | three". Split it off so the
 * app can show the answer and the suggestions separately. Returns { answer, followups }.
 */
export function splitFollowups(text) {
  const m = /(?:^|\n)\s*FOLLOWUPS:\s*(.+?)\s*$/is.exec(text || '');
  if (!m) return { answer: (text || '').trim(), followups: [] };
  const followups = m[1]
    .split('|')
    .map((s) => s.replace(/^[\s"'\-*\d.)]+|["'\s]+$/g, '').trim())
    .filter((s) => s.length >= 4 && s.length <= 70)
    .slice(0, 3);
  return { answer: (text || '').slice(0, m.index).trim(), followups };
}
