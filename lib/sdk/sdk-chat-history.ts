/**
 * Renders Agent.messages.list history (@cursor/sdk) as plain text for the chat buffer.
 */

type LooseRecord = Record<string, unknown>;

type SdkConversationStep = { assistantMessage?: { text?: unknown } | null };

/** Shape of an `Agent.messages.list` row as far as this module reads it. */
type SdkMessageRow = {
  type?: string;
  message?: {
    agentConversationTurn?: {
      userMessage?: { text?: unknown } | null;
      steps?: unknown;
    } | null;
  } | null;
} | null;

function extractContentPart(part: unknown): string {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return String(part);
  const rec = part as LooseRecord;
  if (typeof rec.text === 'string') return rec.text;
  if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
  return '';
}

export function extractSdkMessageText(message: unknown): string {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (typeof message !== 'object') return String(message);
  const msg = message as LooseRecord;
  if (typeof msg.text === 'string') return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content.map(extractContentPart).filter(Boolean).join('\n');
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts.map(extractContentPart).filter(Boolean).join('\n');
  }
  try {
    const s = JSON.stringify(message);
    return s.length > 12000 ? `${s.slice(0, 12000)}…` : s;
  } catch {
    return '';
  }
}

export function formatSdkAgentMessagesToBuffer(rows: Array<{ type?: string; message?: unknown }>): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const row of rows as SdkMessageRow[]) {
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
      const steps: Array<SdkConversationStep | null> = Array.isArray(turn.steps) ? turn.steps : [];
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
 */
export function splitSdkFormattedConversation(plain: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const segments: Array<{ role: 'user' | 'assistant'; text: string }> = [];
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
