import { streamOpenRouterChatCompletion } from './openrouter-client.js';
import {
  appendUserMessage,
  getLlmFinishReasonError,
  runLlmToolLoop,
} from './llm-tool-loop.js';

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
 * @param {Parameters<typeof runLlmToolLoop>[0]} options
 * @returns {ReturnType<typeof runLlmToolLoop>}
 */
export function runOpenRouterAgentLoop(options) {
  return runLlmToolLoop({
    ...options,
    transport: 'openrouter',
    providerLabel: 'OpenRouter',
    streamChatCompletion: options.streamChatCompletion || streamOpenRouterChatCompletion,
  });
}

export { appendUserMessage };
