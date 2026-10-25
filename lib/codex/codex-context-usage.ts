/** Context occupancy comes from the latest CLI call, never turn-wide billing totals. */
import fs from 'node:fs';
import { readCodexContextBreakdown } from './codex-context-breakdown.ts';
import { findCodexSessionLogPath } from './codex-exec-error.ts';

export interface CodexSessionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface CodexCallUsage {
  inputTokens: number;
  outputTokens: number | null;
  totalTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** Context-usage reading derived from a native rollout log. */
export interface CodexContextUsage {
  type: 'context_usage';
  reset?: boolean;
  source?: string;
  model?: string;
  usage?: CodexCallUsage;
  contextWindowTokens?: number | null;
  compactedAt?: string;
  observedAt: string | null;
  measurementId?: string;
  turnId?: string;
  sessionUsage?: CodexSessionUsage;
  breakdown?: ReturnType<typeof readCodexContextBreakdown>;
}

/** The reset reading emitted when Codex compacts a thread (rollout record or native app-server signal). */
export function buildCodexCompactionEvent(observedAt: string | null): CodexContextUsage {
  return { type: 'context_usage', reset: true, observedAt: observedAt || null };
}

/** Loose view of a rollout record (JSON-parsed; only the fields read here). */
type RolloutCounters = Record<string, unknown>;
interface RolloutRecord {
  type?: string;
  timestamp?: unknown;
  payload?: {
    model?: unknown;
    type?: string;
    model_context_window?: unknown;
    info?: { last_token_usage?: RolloutCounters; total_token_usage?: RolloutCounters; model_context_window?: unknown } | null;
    usage?: RolloutCounters;
    thread_token_usage?: RolloutCounters;
    response_id?: unknown;
    turn_id?: unknown;
  };
}

const MAX_TAIL_BYTES = 512 * 1024;
const POLL_MS = 1000;

/** Validate native counters without converting missing values to zero. */
function readCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Thread-wide counters are reconciliation evidence, never a context size or a new ledger delta. */
function readSessionUsage(raw: RolloutCounters | null | undefined): CodexSessionUsage | null {
  if (!raw || readCounter(raw.input_tokens) == null || readCounter(raw.total_tokens) == null) return null;
  return {
    inputTokens: readCounter(raw.input_tokens), outputTokens: readCounter(raw.output_tokens),
    totalTokens: readCounter(raw.total_tokens), cacheReadTokens: readCounter(raw.cached_input_tokens),
    cacheWriteTokens: readCounter(raw.cache_write_input_tokens), reasoningTokens: readCounter(raw.reasoning_output_tokens),
  };
}

/**
 * Extract only numeric telemetry and model identity from native rollout records.
 */
export function parseCodexContextUsage(text: string, fallbackModel: string = ''): CodexContextUsage | null {
  let model = fallbackModel.split('::')[0];
  let latest: CodexContextUsage | null = null;
  let lastCall: (CodexContextUsage & { usage: CodexCallUsage }) | null = null;
  let contextWindow: number | null = null;
  // Codex logs a zero-input token_count right after `compacted`; keep the marker so it is not lost.
  let compactedAt: string | null = null;
  for (const line of String(text || '').split('\n')) {
    let record: RolloutRecord | null;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'turn_context' && typeof record.payload?.model === 'string') model = record.payload.model;
    if (record?.type === 'compacted') {
      lastCall = null;
      compactedAt = typeof record.timestamp === 'string' && record.timestamp ? record.timestamp : 'unknown';
      latest = buildCodexCompactionEvent(typeof record.timestamp === 'string' ? record.timestamp : null);
      continue;
    }
    const isCall = record?.type === 'token_usage_record';
    const isCount = record?.type === 'event_msg' && record.payload?.type === 'token_count';
    if (record?.type === 'event_msg' && record.payload?.type === 'task_started') contextWindow = readCounter(record.payload.model_context_window);
    if (!isCall && !isCount) continue;
    const payload = record!.payload!;
    const info = payload.info;
    const last = isCall ? payload.usage : info?.last_token_usage;
    const inputTokens = readCounter(last?.input_tokens);
    const outputTokens = readCounter(last?.output_tokens);
    const cached = readCounter(last?.cached_input_tokens);
    const cacheReadTokens = cached != null && inputTokens != null && cached <= inputTokens ? cached : null;
    const totalTokens = readCounter(last?.total_tokens);
    if (inputTokens == null || totalTokens == null || totalTokens <= 0) continue;
    if (isCount && readCounter(info?.model_context_window) != null) contextWindow = readCounter(info?.model_context_window);
    const written = readCounter(last?.cache_write_input_tokens);
    const reasoning = readCounter(last?.reasoning_output_tokens);
    const usage: CodexCallUsage = { inputTokens, outputTokens, totalTokens, cacheReadTokens,
      ...(written != null && written <= inputTokens ? { cacheWriteTokens: written } : {}),
      ...(reasoning != null && outputTokens != null && reasoning <= outputTokens ? { reasoningTokens: reasoning } : {}),
    };
    const repeatsCall = !isCall && lastCall && lastCall.usage.inputTokens === inputTokens
      && lastCall.usage.outputTokens === outputTokens && lastCall.usage.cacheReadTokens === cacheReadTokens;
    const next: CodexContextUsage = repeatsCall && lastCall ? { ...lastCall, contextWindowTokens: contextWindow } : {
      type: 'context_usage', source: 'codex-cli', model, usage,
      contextWindowTokens: contextWindow,
      ...(compactedAt ? { compactedAt } : {}),
      observedAt: typeof record?.timestamp === 'string' ? record.timestamp : null,
      ...(isCall && typeof payload.response_id === 'string' ? { measurementId: payload.response_id } : {}),
      ...(isCall && typeof payload.turn_id === 'string' ? { turnId: payload.turn_id } : {}),
    };
    const cumulative = readSessionUsage(isCall ? payload.thread_token_usage : info?.total_token_usage);
    if (cumulative) next.sessionUsage = cumulative;
    latest = next;
    if (isCall) lastCall = next as CodexContextUsage & { usage: CodexCallUsage };
  }
  return latest;
}

/**
 * Read a bounded tail; skip its first partial JSONL line and incomplete last line.
 */
export function readCodexContextUsage(
  { homeDir, threadId, model = '', filePath = '' }: { homeDir: string; threadId: string; model?: string; filePath?: string },
): CodexContextUsage | null {
  const file = filePath || findCodexSessionLogPath(homeDir, threadId);
  if (!file) return null;
  let fd: number | undefined;
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
 */
export function watchCodexContextUsage(
  { homeDir, getThreadId, getModel, onUsage }: { homeDir: string; getThreadId: () => string; getModel: () => string; onUsage: (usage: CodexContextUsage) => void },
): { poll: () => void; stop: () => void } {
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
