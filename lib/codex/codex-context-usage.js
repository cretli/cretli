/** Context occupancy comes from the latest CLI call, never turn-wide billing totals. */
import fs from 'node:fs';
import { readCodexContextBreakdown } from './codex-context-breakdown.js';
import { findCodexSessionLogPath } from './codex-exec-error.js';

const MAX_TAIL_BYTES = 512 * 1024;
const POLL_MS = 1000;

/** Validate native counters without converting missing values to zero. */
function readCounter(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Thread-wide counters are reconciliation evidence, never a context size or a new ledger delta. */
function readSessionUsage(raw) {
  if (!raw || readCounter(raw.input_tokens) == null || readCounter(raw.total_tokens) == null) return null;
  return {
    inputTokens: readCounter(raw.input_tokens), outputTokens: readCounter(raw.output_tokens),
    totalTokens: readCounter(raw.total_tokens), cacheReadTokens: readCounter(raw.cached_input_tokens),
    cacheWriteTokens: readCounter(raw.cache_write_input_tokens), reasoningTokens: readCounter(raw.reasoning_output_tokens),
  };
}

/**
 * Extract only numeric telemetry and model identity from native rollout records.
 * @param {string} text
 * @param {string} [fallbackModel]
 * @returns {object|null}
 */
export function parseCodexContextUsage(text, fallbackModel = '') {
  let model = fallbackModel.split('::')[0];
  let latest = null;
  let lastCall = null;
  let contextWindow = null;
  for (const line of String(text || '').split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'turn_context' && typeof record.payload?.model === 'string') model = record.payload.model;
    if (record?.type === 'compacted') {
      lastCall = null;
      latest = { type: 'context_usage', reset: true, observedAt: record.timestamp || null };
      continue;
    }
    const isCall = record?.type === 'token_usage_record';
    const isCount = record?.type === 'event_msg' && record.payload?.type === 'token_count';
    if (record?.type === 'event_msg' && record.payload?.type === 'task_started') contextWindow = readCounter(record.payload.model_context_window);
    if (!isCall && !isCount) continue;
    const info = record.payload.info;
    const last = isCall ? record.payload.usage : info?.last_token_usage;
    const inputTokens = readCounter(last?.input_tokens);
    const outputTokens = readCounter(last?.output_tokens);
    const cached = readCounter(last?.cached_input_tokens);
    const cacheReadTokens = cached != null && inputTokens != null && cached <= inputTokens ? cached : null;
    const totalTokens = readCounter(last?.total_tokens);
    if (inputTokens == null || totalTokens == null || totalTokens <= 0) continue;
    if (isCount && readCounter(info?.model_context_window) != null) contextWindow = readCounter(info.model_context_window);
    const written = readCounter(last?.cache_write_input_tokens);
    const reasoning = readCounter(last?.reasoning_output_tokens);
    const usage = { inputTokens, outputTokens, totalTokens, cacheReadTokens,
      ...(written != null && written <= inputTokens ? { cacheWriteTokens: written } : {}),
      ...(reasoning != null && outputTokens != null && reasoning <= outputTokens ? { reasoningTokens: reasoning } : {}),
    };
    const repeatsCall = !isCall && lastCall && lastCall.usage.inputTokens === inputTokens
      && lastCall.usage.outputTokens === outputTokens && lastCall.usage.cacheReadTokens === cacheReadTokens;
    latest = repeatsCall ? { ...lastCall, contextWindowTokens: contextWindow } : {
      type: 'context_usage', source: 'codex-cli', model, usage,
      contextWindowTokens: contextWindow,
      observedAt: typeof record.timestamp === 'string' ? record.timestamp : null,
      ...(isCall && typeof record.payload.response_id === 'string' ? { measurementId: record.payload.response_id } : {}),
      ...(isCall && typeof record.payload.turn_id === 'string' ? { turnId: record.payload.turn_id } : {}),
    };
    const cumulative = readSessionUsage(isCall ? record.payload.thread_token_usage : info?.total_token_usage);
    if (cumulative) latest.sessionUsage = cumulative;
    if (isCall) lastCall = latest;
  }
  return latest;
}

/**
 * Read a bounded tail; skip its first partial JSONL line and incomplete last line.
 * @param {{ homeDir: string, threadId: string, model?: string, filePath?: string }} input
 * @returns {object|null}
 */
export function readCodexContextUsage({ homeDir, threadId, model = '', filePath = '' }) {
  const file = filePath || findCodexSessionLogPath(homeDir, threadId);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_TAIL_BYTES));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    const usage = parseCodexContextUsage(text, model);
    if (!usage || usage.reset) return usage;
    return { ...usage, breakdown: readCodexContextBreakdown(file, usage.observedAt) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Poll only the root session, coalescing identical readings and always flushing on stop.
 * @param {{ homeDir: string, getThreadId: () => string, getModel: () => string, onUsage: (usage: object) => void }} input
 * @returns {{ poll: () => void, stop: () => void }}
 */
export function watchCodexContextUsage({ homeDir, getThreadId, getModel, onUsage }) {
  let filePath = '';
  let threadId = '';
  let signature = '';
  let previousStamp = '';
  let needsCatchUp = false;
  const poll = () => {
    const currentThread = getThreadId();
    if (!currentThread) return;
    if (currentThread !== threadId) { threadId = currentThread; filePath = ''; signature = ''; previousStamp = ''; }
    if (!filePath) filePath = findCodexSessionLogPath(homeDir, threadId);
    if (!filePath) return;
    try {
      const stat = fs.statSync(filePath);
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      if (stamp === previousStamp && !needsCatchUp) return;
      previousStamp = stamp;
    } catch { filePath = ''; return; }
    const usage = readCodexContextUsage({ homeDir, threadId, model: getModel(), filePath });
    if (!usage) return;
    needsCatchUp = usage.breakdown?.caughtUp === false;
    const nextSignature = JSON.stringify(usage);
    if (nextSignature === signature) return;
    signature = nextSignature;
    onUsage(usage);
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();
  return { poll, stop() { clearInterval(timer); poll(); } };
}
