import { streamOpenRouterChatCompletion } from '../../lib/providers/openrouter/openrouter-client.ts';
import { planOpenRouterInstructionDelivery } from '../../lib/providers/openrouter/openrouter-conversation-hydrate.ts';
import {
  appendUserMessage,
  getLlmFinishReasonError,
  runLlmToolLoop,
} from '../../lib/agent-harness/llm-tool-loop.ts';

/**
 * @param {unknown} finishReason
 * @returns {string}
 */
export function getOpenRouterFinishReasonError(finishReason) {
  return getLlmFinishReasonError(finishReason);
}

/**
 * Runs the OpenRouter tool loop (thin wrapper over the shared LLM tool loop).
 *
 * @param {Parameters<typeof runLlmToolLoop>[0] & { room?: Record<string, any> }} options
 * @returns {ReturnType<typeof runLlmToolLoop>}
 */
export function runOpenRouterAgentLoop(options) {
  return runLlmToolLoop({
    ...options,
    transport: 'openrouter',
    providerLabel: 'OpenRouter',
    streamChatCompletion: options.streamChatCompletion || streamOpenRouterChatCompletion,
    onHistoryTrimmed: (info) => {
      if (options.room) planOpenRouterInstructionDelivery(options.room, { trimmedCount: info.dropped });
      options.onHistoryTrimmed?.(info);
    },
  });
}

export { appendUserMessage };
