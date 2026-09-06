import { randomUUID } from 'crypto';
import { streamOpenRouterChatCompletion } from './openrouter-client.js';
import { executeTool } from './tool-executor.js';
import { getToolsForMode } from './tool-definitions.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import {
  buildAssistantFullEvent,
  buildToolCallEvent,
} from './event-normalizer.js';
import { fromOpenRouterUsage } from '../usage/usage-normalize.js';
import { safeRecordUsage } from '../usage/usage-ledger.js';

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_MESSAGES = 80;
const SYSTEM_PROMPT = [
  'You are a coding agent running inside Cretli with access to workspace tools.',
  'Use tools to read, search, and modify files when needed.',
  'Prefer small, focused edits. Explain your plan briefly before large changes.',
  'Workspace paths in tools are relative to the project root.',
].join(' ');

/**
 * @param {unknown} finishReason
 * @returns {string}
 */
export function getOpenRouterFinishReasonError(finishReason) {
  const normalized = String(finishReason || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized !== 'network_error') return '';
  return `Provider finish_reason: ${normalized}`;
}

/**
 * @typedef {Object} AgentLoopCallbacks
 * @property {(event: Record<string, unknown>) => void} onEvent
 * @property {(status: string, detail?: string) => void} [onFinished]
 * @property {() => boolean} [isCancelled]
 */

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {number} maxMessages
 * @returns {Array<Record<string, unknown>>}
 */
function trimMessages(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages;
  const system = messages.filter((msg) => msg.role === 'system');
  const rest = messages.filter((msg) => msg.role !== 'system');
  const keep = Math.max(maxMessages - system.length, 4);
  return [...system, ...rest.slice(-keep)];
}

/**
 * Runs the OpenRouter tool loop until the model finishes or limits are hit.
 *
 * @param {{
 *   model: string,
 *   cwd: string,
 *   mode: 'agent' | 'plan',
 *   messages: Array<Record<string, unknown>>,
 *   extraTools?: Array<Record<string, unknown>>,
 *   mcpContext?: object,
 *   signal?: AbortSignal,
 *   maxIterations?: number,
 *   callbacks: AgentLoopCallbacks,
 * }} options
 * @returns {Promise<{ ok: boolean, messages: Array<Record<string, unknown>>, status: string, error?: string }>}
 */
export async function runOpenRouterAgentLoop(options) {
  const callbacks = options.callbacks;
  const mode = normalizeSdkMode(options.mode);
  const maxIterations = Number.isFinite(options.maxIterations)
    ? options.maxIterations
    : DEFAULT_MAX_ITERATIONS;
  let messages = Array.isArray(options.messages) ? [...options.messages] : [];
  if (!messages.some((msg) => msg.role === 'system')) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }
  messages = trimMessages(messages, DEFAULT_MAX_MESSAGES);
  const tools = [
    ...getToolsForMode(mode),
    ...(Array.isArray(options.extraTools) ? options.extraTools : []),
  ];
  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;
    if (callbacks.isCancelled?.()) {
      callbacks.onFinished?.('cancelled');
      return { ok: false, messages, status: 'cancelled' };
    }
    let assistantText = '';
    /** @type {Array<{ id: string, name: string, arguments: string }>} */
    const pendingToolCalls = [];
    /** @type {Record<number, { id?: string, name?: string, arguments?: string }>} */
    const toolCallBuilders = {};
    let finishReason = '';
    /** @type {Record<string, unknown>|null} */
    let lastUsage = null;
    try {
      for await (const chunk of (options.streamChatCompletion || streamOpenRouterChatCompletion)({
        model: options.model,
        messages,
        tools,
        signal: options.signal,
      })) {
        if (callbacks.isCancelled?.()) {
          callbacks.onFinished?.('cancelled');
          return { ok: false, messages, status: 'cancelled' };
        }
        if (chunk.error) {
          const message = chunk.error.message || 'OpenRouter stream error';
          callbacks.onFinished?.('error', message);
          return { ok: false, messages, status: 'error', error: message };
        }
        if (chunk.deltaText) {
          assistantText += chunk.deltaText;
          callbacks.onEvent(buildAssistantFullEvent(assistantText));
        }
        if (Array.isArray(chunk.toolCallDeltas)) {
          for (const delta of chunk.toolCallDeltas) {
            const index = typeof delta.index === 'number' ? delta.index : 0;
            if (!toolCallBuilders[index]) toolCallBuilders[index] = {};
            const entry = toolCallBuilders[index];
            if (typeof delta.id === 'string') entry.id = delta.id;
            if (delta.function && typeof delta.function.name === 'string') {
              entry.name = delta.function.name;
            }
            if (delta.function && typeof delta.function.arguments === 'string') {
              entry.arguments = `${entry.arguments || ''}${delta.function.arguments}`;
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage && typeof chunk.usage === 'object') lastUsage = chunk.usage;
      }
      if (lastUsage) {
        safeRecordUsage({
          provider: 'openrouter',
          feature: 'chat',
          model: options.model,
          tokens: fromOpenRouterUsage(lastUsage),
          source: 'server',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onFinished?.('error', message);
      return { ok: false, messages, status: 'error', error: message };
    }
    for (const key of Object.keys(toolCallBuilders).sort((a, b) => Number(a) - Number(b))) {
      const built = toolCallBuilders[Number(key)];
      if (!built?.name) continue;
      pendingToolCalls.push({
        id: built.id || randomUUID(),
        name: built.name,
        arguments: built.arguments || '{}',
      });
    }
    const finishReasonError = getOpenRouterFinishReasonError(finishReason);
    if (finishReasonError) {
      callbacks.onFinished?.('error', finishReasonError);
      return {
        ok: false,
        messages,
        status: 'error',
        error: finishReasonError,
      };
    }
    if (pendingToolCalls.length === 0) {
      if (assistantText.trim()) {
        messages.push({ role: 'assistant', content: assistantText });
      }
      callbacks.onFinished?.('completed');
      return { ok: true, messages, status: 'completed' };
    }
    const assistantMessage = {
      role: 'assistant',
      content: assistantText || null,
      tool_calls: pendingToolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
    messages.push(assistantMessage);
    for (const call of pendingToolCalls) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      callbacks.onEvent(
        buildToolCallEvent({
          callId: call.id,
          name: call.name,
          status: 'running',
          args: parsedArgs,
        }),
      );
      const result = await executeTool(call.name, parsedArgs, {
        cwd: options.cwd,
        mode,
        mcpContext: options.mcpContext,
      });
      const toolContent = result.ok
        ? result.output
        : `Error: ${result.error || 'tool failed'}\n${result.output || ''}`.trim();
      callbacks.onEvent(
        buildToolCallEvent({
          callId: call.id,
          name: call.name,
          status: result.ok ? 'completed' : 'error',
          args: parsedArgs,
          result: { output: toolContent, ok: result.ok },
        }),
      );
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolContent,
      });
    }
    if (finishReason === 'stop') {
      callbacks.onFinished?.('completed');
      return { ok: true, messages, status: 'completed' };
    }
  }
  callbacks.onFinished?.('error', 'Max tool iterations reached');
  return { ok: false, messages, status: 'error', error: 'Max tool iterations reached' };
}

/**
 * @param {string} userText
 * @param {Array<Record<string, unknown>>} existingMessages
 * @returns {Array<Record<string, unknown>>}
 */
export function appendUserMessage(existingMessages, userText) {
  const messages = Array.isArray(existingMessages) ? [...existingMessages] : [];
  messages.push({ role: 'user', content: userText });
  return messages;
}
