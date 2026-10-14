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
function readStore(file) {
  let signature = '';
  try { const stat = fs.statSync(file); signature = `${stat.size}:${stat.mtimeMs}`; } catch { return []; }
  if (stores.get(file)?.signature === signature) return stores.get(file).rows;
  const unique = new Map();
  let torn = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    torn = text.length > 0 && !text.endsWith('\n');
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      try { const row = JSON.parse(line); if (row?.v === 1 && typeof row.id === 'string' && USAGE_HARNESSES.includes(row.harness)
        && typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt))
        && count(row.inputTokens) != null && count(row.totalTokens) != null) unique.set(row.id, row); } catch { /* Skip torn records. */ }
    }
  } catch { return []; }
  const rows = [...unique.values()];
  stores.set(file, { signature, rows, appends: 0, torn });
  if (stores.size > 50) stores.delete(stores.keys().next().value);
  return rows;
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
  const rows = readStore(file).filter((row) => Date.parse(row.observedAt) >= Date.now() - RETENTION_MS);
  const previous = rows.find((row) => row.id === sample.id);
  if (previous && JSON.stringify(previous) === JSON.stringify(sample)) return previous;
  const next = rows.filter((row) => row.id !== sample.id).concat(sample).sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-MAX_SAMPLES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (stores.get(file)?.torn ? '\n' : '') + JSON.stringify(sample) + '\n', 'utf8');
    const appends = (stores.get(file)?.appends || 0) + 1;
    if (appends % 100 === 0 || fs.statSync(file).size > 8 * 1024 * 1024) {
      writeTextAtomic(file, next.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    const stat = fs.statSync(file);
    stores.set(file, { signature: `${stat.size}:${stat.mtimeMs}`, rows: next, appends });
  } catch (error) { console.warn('[context-telemetry] write failed:', error.message); return null; }
  return sample;
}

/** Context observations can be joined to ledger/run records without storing any prompt text. */
export function readHarnessContextSamples({ dataDir, harness, chatId, workspaceFile, workspaceFolder, model, runId, delegationId, role, from, to } = {}) {
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
