/**
 * Rebuild OpenRouter conversation messages from persisted chat history.
 */

import { extractAssistantPlainText } from '../../context-compression.js';
import { INSTRUCTION_EPOCH_REASON, bumpInstructionEpoch } from '../../context/instruction-epoch.ts';

export function buildOpenRouterConversationFromHistory(events: Array<{ rec?: unknown }> | null | undefined): Array<{ role: 'user' | 'assistant', content: string }> {
  if (!Array.isArray(events) || events.length === 0) return [];
  const messages: Array<{ role: 'user' | 'assistant', content: string }> = [];
  let lastAssistantText = '';
  for (const row of events) {
    const rec = row?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = rec as Record<string, unknown>;
    if (record.kind === 'localUser' && typeof record.text === 'string') {
      const userText = record.text.trim();
      lastAssistantText = '';
      if (!userText) continue;
      messages.push({ role: 'user', content: userText });
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = record.event as Record<string, unknown>;
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

/**
 * Instruction handling after the in-memory conversation is rebuilt from the
 * persisted history (`hydrated`) or shortened at the start of a run
 * (`trimmedCount`). Both drop earlier messages, and the rebuilt history holds
 * the raw user text without the instruction prefix, so the manifest of an
 * earlier send proves nothing about what is still in the conversation.
 *
 * The room's instruction epoch is bumped and the caller must put the required
 * blocks (static rules, mode hint, current plan, selected skills) into the
 * next user message. OpenRouter never dedupes: it has no retention proof.
 */
export function planOpenRouterInstructionDelivery(room: Record<string, any>, event: { hydrated?: boolean, trimmedCount?: number } = {}): { staticMode: 'always', reassembleRequired: boolean, epoch: number, reasons: string[] } {
  const reasons: string[] = [];
  let epoch = Number(room?._instructionEpoch?.epoch) || 0;
  if (event.hydrated) {
    reasons.push(INSTRUCTION_EPOCH_REASON.HYDRATE);
    epoch = bumpInstructionEpoch(room, INSTRUCTION_EPOCH_REASON.HYDRATE) ?? epoch;
  }
  if (Number(event.trimmedCount) > 0) {
    reasons.push(INSTRUCTION_EPOCH_REASON.HISTORY_TRIM);
    epoch = bumpInstructionEpoch(room, INSTRUCTION_EPOCH_REASON.HISTORY_TRIM) ?? epoch;
  }
  return { staticMode: 'always', reassembleRequired: reasons.length > 0, epoch, reasons };
}
