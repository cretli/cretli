/**
 * Renders Agent.messages.list history (@cursor/sdk) as plain text for the chat buffer.
 */

/**
 * @param {unknown} part
 * @returns {string}
 */
function extractContentPart(part) {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return String(part);
  if (typeof part.text === 'string') return part.text;
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  return '';
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function extractSdkMessageText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (typeof message !== 'object') return String(message);
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content.map(extractContentPart).filter(Boolean).join('\n');
  }
  if (Array.isArray(message.parts)) {
    return message.parts.map(extractContentPart).filter(Boolean).join('\n');
  }
  try {
    const s = JSON.stringify(message);
    return s.length > 12000 ? `${s.slice(0, 12000)}…` : s;
  } catch {
    return '';
  }
}

/**
 * @param {Array<{ type?: string, message?: unknown }>} rows
 * @returns {string}
 */
export function formatSdkAgentMessagesToBuffer(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  const parts = [];
  for (const row of rows) {
    const turn =
      row &&
      typeof row === 'object' &&
      row.message &&
      typeof row.message === 'object' &&
      row.message.agentConversationTurn &&
      typeof row.message.agentConversationTurn === 'object'
        ? row.message.agentConversationTurn
        : null;
    if (turn) {
      const userText =
        turn.userMessage && typeof turn.userMessage === 'object' && typeof turn.userMessage.text === 'string'
          ? turn.userMessage.text.trim()
          : '';
      if (userText) {
        parts.push(`\n> ${userText}\n`);
      }
      const steps = Array.isArray(turn.steps) ? turn.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const assistantText =
          step.assistantMessage &&
          typeof step.assistantMessage === 'object' &&
          typeof step.assistantMessage.text === 'string'
            ? step.assistantMessage.text.trim()
            : '';
        if (assistantText) {
          parts.push(`${assistantText}\n\n`);
        }
      }
      continue;
    }
    const text = extractSdkMessageText(row?.message).trim();
    if (!text) continue;
    if (row?.type === 'user') {
      parts.push(`\n> ${text}\n`);
    } else {
      parts.push(`${text}\n\n`);
    }
  }
  return parts.join('');
}

/**
 * Recovers the user/assistant turn order from the buffer produced by
 * {@link formatSdkAgentMessagesToBuffer} (without the collapsible "history" frame).
 *
 * @param {string} plain
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>}
 */
export function splitSdkFormattedConversation(plain) {
  /** @type {Array<{ role: 'user' | 'assistant', text: string }>} */
  const segments = [];
  const s = String(plain ?? '').replace(/\r\n/g, '\n');
  if (!/\S/.test(s)) {
    return segments;
  }

  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === '\n') i++;
    if (i >= s.length) break;

    if (s.slice(i, i + 2) === '> ') {
      const nl = s.indexOf('\n', i + 2);
      const userText =
        nl === -1 ? s.slice(i + 2) : s.slice(i + 2, nl);
      segments.push({ role: 'user', text: userText.trimEnd() });
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }

    if (s.slice(i, i + 7) === '[user] ') {
      const restStart = i + 7;
      const nl = s.indexOf('\n', restStart);
      const userText = nl === -1 ? s.slice(restStart) : s.slice(restStart, nl);
      segments.push({ role: 'user', text: userText.trimEnd() });
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }

    const nextGt = s.indexOf('\n> ', i);
    const nextUserTag = s.indexOf('\n[user] ', i);
    let assistantEnd = s.length;
    if (nextGt !== -1) assistantEnd = Math.min(assistantEnd, nextGt);
    if (nextUserTag !== -1) assistantEnd = Math.min(assistantEnd, nextUserTag);
    let assistantText = s.slice(i, assistantEnd);
    assistantText = assistantText.replace(/\s+$/, '').replace(/\n{3,}/g, '\n\n');
    if (assistantText.trim()) {
      segments.push({ role: 'assistant', text: assistantText.trimEnd() });
    }
    i = assistantEnd >= s.length ? s.length : assistantEnd + 1;
  }
  return segments;
}
