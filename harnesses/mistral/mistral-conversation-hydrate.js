/**
 * Rebuild Mistral conversation messages from persisted chat history.
 * The stored events are provider-neutral, so the shape matches OpenRouter.
 */

import { buildOpenRouterConversationFromHistory } from '../../lib/providers/openrouter/openrouter-conversation-hydrate.ts';

/**
 * @param {Array<{ rec?: unknown }> | null | undefined} events
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
export function buildMistralConversationFromHistory(events) {
  return buildOpenRouterConversationFromHistory(events);
}
