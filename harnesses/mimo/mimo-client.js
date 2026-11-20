/**
 * Xiaomi MiMo chat completions client with SSE streaming.
 * MiMo exposes an OpenAI-compatible API, so this mirrors the OpenRouter
 * client: plain fetch + SSE parse, no external SDK dependency.
 */

import { getEffectiveMimoApiKey, getEffectiveMimoBaseUrl } from './mimo-api-key.js';

const DEFAULT_TIMEOUT_MS = 300000;

/** @returns {string} */
function resolveMimoCompletionsUrl() {
  const base = getEffectiveMimoBaseUrl().replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

/**
 * @typedef {Object} MiMoStreamChunk
 * @property {string} [deltaText]
 * @property {Array<{ index?: number, id?: string, function?: { name?: string, arguments?: string } }>} [toolCallDeltas]
 * @property {string} [finishReason]
 * @property {Record<string, unknown>} [usage]
 * @property {{ message?: string, code?: string }} [error]
 */

/**
 * Parses one SSE data line from a MiMo streaming response.
 *
 * @param {string} block
 * @returns {MiMoStreamChunk | null}
 */
export function parseMimoSseDataLine(block) {
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
 * @returns {AsyncGenerator<MiMoStreamChunk>}
 */
export async function* readMimoSseStream(body, signal) {
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
        const chunk = parseMimoSseDataLine(trimmed);
        if (chunk) yield chunk;
      }
    }
    const tail = buffer.trim();
    if (tail && !tail.startsWith(':')) {
      const chunk = parseMimoSseDataLine(tail);
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
export async function postMimoChatCompletion(options) {
  const apiKey = getEffectiveMimoApiKey();
  if (!apiKey) {
    throw new Error('Missing MiMo API key');
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
    const response = await fetch(resolveMimoCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new Error(
          'MiMo rejected the API key. Check it in Settings → Harness → MiMo (platform.xiaomimimo.com).',
        );
      }
      throw new Error(text || `MiMo HTTP ${response.status}`);
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
 * @returns {AsyncGenerator<MiMoStreamChunk>}
 */
export async function* streamMimoChatCompletion(options) {
  const apiKey = getEffectiveMimoApiKey();
  if (!apiKey) {
    yield {
      error: { message: 'Missing MiMo API key (configure it in Settings → Harness → MiMo).' },
      finishReason: 'error',
    };
    return;
  }
  const response = await postMimoChatCompletion(options);
  if (!response.body) {
    yield { error: { message: 'MiMo response has no body' }, finishReason: 'error' };
    return;
  }
  yield* readMimoSseStream(response.body, options.signal);
}
