/** Streams GLM completions through the official Z.ai Python SDK. */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getEffectiveZaiSdkApiKey, getZaiSdkProvider } from './zai-api-key.js';
import { resolveZaiPythonExecutable } from './zai-sdk-runtime.js';
import { buildAgentChildEnv } from '../../lib/agent-env.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const PYTHON_WORKER_PATH = fileURLToPath(new URL('./zai_sdk_worker.py', import.meta.url));
const ZAI_API_BASE_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4/';

/**
 * @param {unknown} usage
 * @returns {Record<string, unknown> | undefined}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = /** @type {Record<string, unknown>} */ (usage);
  return {
    ...raw,
    prompt_tokens: raw.prompt_tokens ?? raw.promptTokens,
    completion_tokens: raw.completion_tokens ?? raw.completionTokens,
    total_tokens: raw.total_tokens ?? raw.totalTokens,
  };
}

/**
 * @param {{ model: string, messages: Array<Record<string, unknown>>, tools?: Array<Record<string, unknown>>, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* streamZaiSdkCompletion(options) {
  const apiKey = getEffectiveZaiSdkApiKey();
  if (!apiKey) {
    yield { error: { message: 'Missing Z.AI SDK API key (configure it in Settings → Harness → Z.AI).' }, finishReason: 'error' };
    return;
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const provider = getZaiSdkProvider();
  const baseUrl = provider === 'zai-coding-plan' ? ZAI_CODING_BASE_URL : ZAI_API_BASE_URL;
  const python = resolveZaiPythonExecutable();
  const child = spawn(python, ['-u', PYTHON_WORKER_PATH], {
    env: buildAgentChildEnv('zai', { overrides: { ZAI_API_KEY: apiKey, ZAI_BASE_URL: baseUrl } }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const onAbort = () => child.kill('SIGTERM');
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.end(JSON.stringify({
    model: options.model,
    messages: options.messages,
    tools: Array.isArray(options.tools) && options.tools.length ? options.tools : undefined,
    timeoutMs,
  }));
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.error) {
        yield { error: { message: String(event.error).split(apiKey).join('[redacted]') }, finishReason: 'error' };
        continue;
      }
      yield {
        ...event,
        usage: normalizeUsage(event?.usage),
      };
    }
    const result = await closed;
    if (result.code !== 0 && !options.signal?.aborted) {
      const detail = String(stderr || `Z.ai SDK worker exited with code ${result.code}.`).trim();
      yield { error: { message: detail.split(apiKey).join('[redacted]') }, finishReason: 'error' };
    }
  } catch (error) {
    if (!options.signal?.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      yield { error: { message: message.split(apiKey).join('[redacted]') }, finishReason: 'error' };
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    lines.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  }
}
