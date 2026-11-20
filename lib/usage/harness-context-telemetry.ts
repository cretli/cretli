/** Shared numeric-only context observations, separate from billable token deltas. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import { writeTextAtomic } from '../persist/atomic-write.js';
import { USAGE_HARNESSES } from './usage-event.js';

const MAX_SAMPLES = 5000;
const stores = new Map();
const RETENTION_MS = 92 * 86400000;
const CATEGORY_IDS = new Set(['messages', 'instructions', 'skills', 'memory', 'systemPrompt', 'toolCalls', 'toolResults', 'reasoning', 'systemTools', 'mcpTools', 'mcpInstructions', 'agents', 'compactBuffer', 'deferredTools']);

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e10 ? value : null;
}
function filePath(dataDir) {
  return dataDir ? path.join(dataDir, 'usage', 'context-samples.jsonl') : resolveDataPath('usage', 'context-samples.jsonl');
}
/** Compaction cadence: every N appends, or when the file is large but at most once per MIN_APPENDS_BETWEEN_COMPACTIONS. */
const COMPACT_EVERY_APPENDS = 100;
const COMPACT_SIZE_BYTES = 8 * 1024 * 1024;
const MIN_APPENDS_BETWEEN_COMPACTIONS = 20;

// observedAt values are ISO strings, so lexical order is chronological.
function byObservedAt(a, b) { return a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0; }
function newStore(signature = '') {
  // rows: ascending by observedAt; byId/lines: O(1) lookup and the serialized line per id, so compaction never re-stringifies.
  return { signature, rows: [], byId: new Map(), lines: new Map(), appends: 0, compactedAt: 0, torn: false };
}
function loadStore(file) {
  let signature = '';
  try { const stat = fs.statSync(file); signature = `${stat.size}:${stat.mtimeMs}`; } catch { return null; }
  const cached = stores.get(file);
  if (cached?.signature === signature) return cached;
  const unique = new Map();
  const lines = new Map();
  let torn = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    torn = text.length > 0 && !text.endsWith('\n');
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      try { const row = JSON.parse(line); if (row?.v === 1 && typeof row.id === 'string' && USAGE_HARNESSES.includes(row.harness)
        && typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt))
        && count(row.inputTokens) != null && count(row.totalTokens) != null) { unique.set(row.id, row); lines.set(row.id, line); } } catch { /* Skip torn records. */ }
    }
  } catch { return null; }
  // The last occurrence of an id wins; one stable sort puts rows in chronological order (ties keep file order).
  const store = newStore(signature);
  store.rows = [...unique.values()].sort(byObservedAt);
  store.byId = unique;
  store.lines = lines;
  store.torn = torn;
  stores.set(file, store);
  if (stores.size > 50) stores.delete(stores.keys().next().value);
  return store;
}
function readStore(file) { return loadStore(file)?.rows ?? []; }

/** First index whose observedAt is greater than `value` (new rows end the group of equal timestamps). */
function upperBound(rows, value) {
  let lo = 0; let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].observedAt <= value) lo = mid + 1; else hi = mid; }
  return lo;
}
function lowerBound(rows, value) {
  let lo = 0; let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].observedAt < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function dropRows(store, from, deleteCount) {
  for (const row of store.rows.splice(from, deleteCount)) { store.byId.delete(row.id); store.lines.delete(row.id); }
}

/** Store one observation per chat/epoch/time, replacing later refinements of that observation. */
export function recordHarnessContextSample({ room, harness, event, dataDir, role = 'chat' }) {
  if (!USAGE_HARNESSES.includes(harness) || !room?.chatId || event?.reset) return null;
  const inputTokens = count(event?.usage?.inputTokens);
  const totalTokens = count(event?.usage?.totalTokens);
  const observedMs = Date.parse(event?.observedAt);
  if (inputTokens == null || totalTokens == null || !Number.isFinite(observedMs)) return null;
  // A resumed session first replays the preceding call; it does not belong to the new run.
  if (Number.isFinite(room._runStartedAt) && observedMs < room._runStartedAt) return null;
  const cached = count(event.usage.cacheReadTokens);
  const written = count(event.usage.cacheWriteTokens);
  const written5m = count(event.usage.cacheWrite5mTokens);
  const written1h = count(event.usage.cacheWrite1hTokens);
  const contextWindowTokens = count(event.contextWindowTokens);
  const observedAt = new Date(observedMs).toISOString();
  const measurementId = typeof event.measurementId === 'string' ? event.measurementId.slice(0, 200) : '';
  const identity = [harness, room.chatId, room._contextEpoch || 0, measurementId || observedAt].join(':');
  const prefixParts = [room._promptDecorationState?.staticHash, room._codexMcpRevision, room._codexMcpToolNames];
  const prefixFingerprint = prefixParts.some((value) => value != null)
    ? createHash('sha256').update(JSON.stringify(prefixParts)).digest('hex') : null;
  const sample = {
    v: 1, id: createHash('sha256').update(identity).digest('hex'), harness,
    prefixFingerprint, prefixEvidenceSource: prefixFingerprint ? 'cretli-instructions-and-tools' : null,
    measurementId: measurementId || null, turnId: typeof event.turnId === 'string' ? event.turnId.slice(0, 200) : null,
    contextEpochReason: String(room._contextEpochReason || '').slice(0, 64),
    chatId: String(room.chatId), runId: String(room._runId || ''),
    delegationId: String(room.delegationId || ''), attemptId: String(room.delegationAttemptId || ''),
    workspaceFile: String(room.workspaceFile || ''), workspaceFolder: String(room.cwd || ''),
    role,
    model: typeof event.model === 'string' ? event.model : String(room.modelId || ''),
    contextEpoch: count(room._contextEpoch) ?? 0, observedAt,
    source: event.source === 'codex-cli' || event.source === 'claude-sdk' ? event.source : 'harness-event',
    provenance: event.estimated === true ? 'estimated' : 'reported',
    inputTokens, outputTokens: count(event.usage.outputTokens), totalTokens,
    reasoningTokens: count(event.usage.reasoningTokens),
    sessionUsage: event.sessionUsage && typeof event.sessionUsage === 'object' ? Object.fromEntries(
      ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].map((key) => [key, count(event.sessionUsage[key])])
    ) : null,
    cacheReadTokens: cached != null && cached <= inputTokens ? cached : null,
    cacheWriteTokens: written != null && written <= inputTokens ? written : null,
    // Per-lifetime split of the write; it tells which cache TTL the provider actually applied.
    cacheWrite5mTokens: written5m != null && written5m <= inputTokens ? written5m : null,
    cacheWrite1hTokens: written1h != null && written1h <= inputTokens ? written1h : null,
    contextWindowTokens: contextWindowTokens > 0 ? contextWindowTokens : null,
    breakdown: event.breakdown && Array.isArray(event.breakdown.rows) ? {
      estimated: true, complete: event.breakdown.complete === true,
      rows: event.breakdown.rows.filter((row) => CATEGORY_IDS.has(row?.id)).map((row) => ({ id: row.id, tokens: count(row.tokens), count: count(row.count), estimated: row.estimated === true })),
    } : null,
  };
  const file = filePath(dataDir);
  const store = loadStore(file) ?? newStore();
  const line = JSON.stringify(sample);
  const previous = store.byId.get(sample.id);
  if (previous && store.lines.get(sample.id) === line && Date.parse(previous.observedAt) >= Date.now() - RETENTION_MS) return previous;
  try {
    // Mutate the cached sorted rows in place (O(log N) search + O(k) trims); a failed write drops the cache below.
    const { rows } = store;
    const retentionStart = Date.now() - RETENTION_MS;
    let expired = 0;
    while (expired < rows.length && Date.parse(rows[expired].observedAt) < retentionStart) expired++;
    if (expired) dropRows(store, 0, expired);
    const old = store.byId.get(sample.id);
    if (old) {
      let at = lowerBound(rows, old.observedAt);
      while (at < rows.length && rows[at] !== old) at++;
      if (at < rows.length) dropRows(store, at, 1);
    }
    if (!rows.length || sample.observedAt >= rows[rows.length - 1].observedAt) rows.push(sample);
    else rows.splice(upperBound(rows, sample.observedAt), 0, sample);
    store.byId.set(sample.id, sample);
    store.lines.set(sample.id, line);
    if (rows.length > MAX_SAMPLES) dropRows(store, 0, rows.length - MAX_SAMPLES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (store.torn ? '\n' : '') + line + '\n', 'utf8');
    store.torn = false;
    store.appends += 1;
    let stat = fs.statSync(file);
    const sinceCompaction = store.appends - store.compactedAt;
    if (store.appends % COMPACT_EVERY_APPENDS === 0
      || (stat.size > COMPACT_SIZE_BYTES && sinceCompaction >= MIN_APPENDS_BETWEEN_COMPACTIONS)) {
      writeTextAtomic(file, rows.map((row) => store.lines.get(row.id)).join('\n') + '\n');
      store.compactedAt = store.appends;
      stat = fs.statSync(file);
    }
    store.signature = `${stat.size}:${stat.mtimeMs}`;
    stores.set(file, store);
    if (stores.size > 50) stores.delete(stores.keys().next().value);
  } catch (error) { stores.delete(file); console.warn('[context-telemetry] write failed:', error.message); return null; }
  return sample;
}

/** Context observations can be joined to ledger/run records without storing any prompt text. */
export function readHarnessContextSamples({ dataDir, harness, chatId, workspaceFile, workspaceFolder, model, runId, delegationId, role, from, to }: Record<string, any> = {}) {
  const start = from && String(from).length === 10 ? `${from}T00:00:00.000Z` : from;
  const end = to && String(to).length === 10 ? `${to}T23:59:59.999Z` : to;
  return readStore(filePath(dataDir)).filter((row) =>
    (!harness || row.harness === harness) && (!chatId || row.chatId === chatId)
    && (!workspaceFile || row.workspaceFile === workspaceFile) && (!workspaceFolder || row.workspaceFolder === workspaceFolder)
    && (!model || row.model === model) && (!runId || row.runId === runId)
    && (!delegationId || row.delegationId === delegationId) && (!role || row.role === role)
    && (!start || row.observedAt >= start) && (!end || row.observedAt <= end));
}

/** Occupancy is averaged/peaked, never summed into token consumption. */
export function summarizeHarnessContextSamples(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const measured = rows.filter((row) => row.provenance !== 'estimated');
  const fills = measured.filter((row) => row.contextWindowTokens > 0).map((row) => row.totalTokens / row.contextWindowTokens * 100);
  return {
    samples: rows.length, measuredSamples: measured.length, estimatedSamples: rows.length - measured.length,
    windowKnownSamples: fills.length,
    cacheKnownSamples: measured.filter((row) => row.cacheReadTokens != null).length,
    chats: new Set(rows.map((row) => row.chatId)).size,
    averageFillPercent: fills.length ? fills.reduce((sum, value) => sum + value, 0) / fills.length : null,
    peakFillPercent: fills.length ? Math.max(...fills) : null,
    peakContextTokens: rows.length ? Math.max(...rows.map((row) => row.totalTokens)) : null,
    latest: rows.length ? rows.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] : null,
  };
}
