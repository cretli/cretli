/**
 * OpenRouter chat completions client with SSE streaming.
 */

import { getOpenRouterRequestHeaders, getEffectiveOpenRouterApiKey } from '../openrouter/openrouter-api-key.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * @typedef {Object} OpenRouterStreamChunk
 * @property {string} [deltaText]
 * @property {Array<{ id?: string, type?: string, function?: { name?: string, arguments?: string } }>} [toolCallDeltas]
 * @property {string} [finishReason]
 * @property {Record<string, unknown>} [usage]
 * @property {{ message?: string, code?: string }} [error]
 */

/**
 * Parses SSE lines from OpenRouter streaming response.
 *
 * @param {string} block
 * @returns {OpenRouterStreamChunk | null}
 */
export function parseOpenRouterSseDataLine(block) {
  const trimmed = String(block || '').trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') {
    return { finishReason: payload === '[DONE]' ? 'stop' : undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.error) {
    const err = parsed.error;
    return {
      error: {
        message: typeof err.message === 'string' ? err.message : String(err),
        code: typeof err.code === 'string' ? err.code : undefined,
      },
      finishReason: 'error',
    };
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  if (!choice || typeof choice !== 'object') {
    return { usage: parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : undefined };
  }
  const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
  const deltaText = typeof delta.content === 'string' ? delta.content : '';
  const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined;
  return {
    deltaText,
    toolCallDeltas,
    finishReason,
    usage: parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : undefined,
  };
}

/**
 * Reads an SSE response body and yields parsed chunks.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<OpenRouterStreamChunk>}
 */
export async function* readOpenRouterSseStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        const chunk = parseOpenRouterSseDataLine(trimmed);
        if (chunk) yield chunk;
      }
    }
    const tail = buffer.trim();
    if (tail && !tail.startsWith(':')) {
      const chunk = parseOpenRouterSseDataLine(tail);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * @param {{
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<Response>}
 */
export async function postOpenRouterChatCompletion(options) {
  const apiKey = getEffectiveOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('Missing OpenRouter API key');
  }
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const requestBody = {
    model: options.model,
    messages: options.messages,
    stream: true,
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    requestBody.tools = options.tools;
  }
  try {
    let response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: getOpenRouterRequestHeaders(),
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok && Array.isArray(options.tools) && options.tools.length > 0) {
      const text = await response.text().catch(() => '');
      const lower = text.toLowerCase();
      const toolsRejected =
        lower.includes('tool')
        || lower.includes('function')
        || lower.includes('not support');
      if (toolsRejected) {
        response = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: getOpenRouterRequestHeaders(),
          body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            stream: true,
          }),
          signal: controller.signal,
        });
      } else {
        throw new Error(text || `OpenRouter HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (
        response.status === 401
        && text.includes('Missing Authentication header')
      ) {
        throw new Error(
          'Invalid OpenRouter API key. Create a key at https://openrouter.ai/keys — it must start with sk-or-v1-.',
        );
      }
      throw new Error(text || `OpenRouter HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {AsyncGenerator<OpenRouterStreamChunk>}
 */
export async function* streamOpenRouterChatCompletion(options) {
  const response = await postOpenRouterChatCompletion(options);
  if (!response.body) {
    throw new Error('OpenRouter response has no body');
  }
  yield* readOpenRouterSseStream(response.body, options.signal);
}

export { OPENROUTER_API_URL };
