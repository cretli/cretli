/**
 * Mistral chat completions client with streaming via @mistralai/mistralai.
 * Yields the same chunk shape as streamOpenRouterChatCompletion.
 */

import { getEffectiveMistralApiKey, getMistralServerUrl } from './mistral-api-key.js';
import { loadMistralSdk } from './mistral-sdk.js';

const DEFAULT_TIMEOUT_MS = 300000;

/**
 * @typedef {Object} MistralStreamChunk
 * @property {string} [deltaText]
 * @property {Array<{ index?: number, id?: string, function?: { name?: string, arguments?: string } }>} [toolCallDeltas]
 * @property {string} [finishReason]
 * @property {Record<string, unknown>} [usage]
 * @property {{ message?: string, code?: string }} [error]
 */

/**
 * Maps OpenAI-style messages to the SDK's camelCase message shape.
 *
 * @param {Array<Record<string, any>>} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function toMistralMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((msg) => {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const { tool_calls: toolCalls, ...rest } = msg;
      return { ...rest, toolCalls };
    }
    if (msg?.role === 'tool' && msg.tool_call_id !== undefined) {
      const { tool_call_id: toolCallId, ...rest } = msg;
      return { ...rest, toolCallId };
    }
    return msg;
  });
}

/**
 * @param {unknown} content String or array of content chunks.
 * @returns {string}
 */
function readDeltaText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * @param {unknown} usage
 * @returns {Record<string, unknown> | undefined}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = /** @type {Record<string, any>} */ (usage);
  return {
    ...raw,
    prompt_tokens: raw.prompt_tokens ?? raw.promptTokens,
    completion_tokens: raw.completion_tokens ?? raw.completionTokens,
    total_tokens: raw.total_tokens ?? raw.totalTokens,
  };
}

/**
 * Converts one SDK stream event (`{ data }` or the bare completion chunk).
 *
 * @param {any} event
 * @returns {MistralStreamChunk | null}
 */
export function parseMistralStreamEvent(event) {
  const data = event && typeof event === 'object' && event.data && typeof event.data === 'object'
    ? event.data
    : event;
  if (!data || typeof data !== 'object') return null;
  const usage = normalizeUsage(data.usage);
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice || typeof choice !== 'object') return usage ? { usage } : null;
  const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
  const rawCalls = delta.toolCalls ?? delta.tool_calls;
  const toolCallDeltas = Array.isArray(rawCalls)
    ? rawCalls.map((call, position) => {
      const fn = call?.function || {};
      const args = fn.arguments;
      return {
        index: typeof call?.index === 'number' ? call.index : position,
        id: typeof call?.id === 'string' ? call.id : undefined,
        function: {
          name: typeof fn.name === 'string' ? fn.name : undefined,
          arguments: typeof args === 'string' ? args : (args && typeof args === 'object' ? JSON.stringify(args) : undefined),
        },
      };
    })
    : undefined;
  const finish = choice.finishReason ?? choice.finish_reason;
  return {
    deltaText: readDeltaText(delta.content),
    toolCallDeltas,
    finishReason: typeof finish === 'string' ? finish : undefined,
    usage,
  };
}

/**
 * @param {unknown} err
 * @returns {{ message: string, code?: string }}
 */
function toStreamError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err && typeof err === 'object' && 'statusCode' in err ? String(err.statusCode) : '';
  return status ? { message, code: status } : { message };
}

/**
 * @param {{
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   client?: { chat: { stream: Function } },
 * }} options `client` injects an SDK client (tests).
 * @returns {AsyncGenerator<MistralStreamChunk>}
 */
export async function* streamMistralChatCompletion(options) {
  let client = options.client;
  if (!client) {
    const apiKey = getEffectiveMistralApiKey();
    if (!apiKey) throw new Error('Missing Mistral API key');
    const sdk = await loadMistralSdk();
    const serverURL = getMistralServerUrl();
    client = new sdk.Mistral({ apiKey, ...(serverURL ? { serverURL } : {}) });
  }
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const request = { model: options.model, messages: toMistralMessages(options.messages) };
  if (Array.isArray(options.tools) && options.tools.length > 0) request.tools = options.tools;
  try {
    const stream = await client.chat.stream(request, { fetchOptions: { signal: controller.signal } });
    for await (const event of stream) {
      if (controller.signal.aborted) break;
      const chunk = parseMistralStreamEvent(event);
      if (chunk) yield chunk;
    }
  } catch (err) {
    if (controller.signal.aborted && options.signal?.aborted) return;
    yield { error: toStreamError(err), finishReason: 'error' };
  } finally {
    clearTimeout(timeout);
  }
}
