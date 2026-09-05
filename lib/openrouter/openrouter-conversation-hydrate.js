/**
 * Rebuild OpenRouter conversation messages from persisted chat history.
 */

import { extractAssistantPlainText } from '../context-compression.js';

/**
 * @param {Array<{ rec?: unknown }> | null | undefined} events
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
export function buildOpenRouterConversationFromHistory(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */
  const messages = [];
  let lastAssistantText = '';
  for (const row of events) {
    const rec = row?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser' && typeof record.text === 'string') {
      const userText = record.text.trim();
      lastAssistantText = '';
      if (!userText) continue;
      messages.push({ role: 'user', content: userText });
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type !== 'assistant') {
      lastAssistantText = '';
      continue;
    }
    const assistantText = extractAssistantPlainText(event).trim();
    if (!assistantText) continue;
    if (lastAssistantText && assistantText.startsWith(lastAssistantText)) {
      if (assistantText.length <= lastAssistantText.length) continue;
      if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        messages.pop();
      }
    } else if (lastAssistantText && lastAssistantText.startsWith(assistantText)) {
      continue;
    }
    lastAssistantText = assistantText;
    messages.push({ role: 'assistant', content: assistantText });
  }
  return messages;
}
