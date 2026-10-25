/** Canonical, deduplicated end-of-run snapshots shared by every harness. */
import { randomUUID } from 'node:crypto';
import { decodeModelValue } from '../model-catalog.js';
import { noteFastProviderFailure, noteHarnessUsageLimit, noteUnclassifiedRunError } from '../harness-usage-limits.js';
import { syncUnclassifiedErrors } from './unclassified-errors.js';

const runState = new WeakMap();
/** @type {Set<(snapshot: Record<string, any>, input: Record<string, any>) => void>} */
const runEndListeners = new Set();

/**
 * Subscribe to every captured (deduplicated) run-end snapshot. A listener
 * failure never affects run end. Returns an unsubscribe function.
 */
export function addRunEndListener(listener) {
  runEndListeners.add(listener);
  return () => runEndListeners.delete(listener);
}

function clean(value) {
  return String(value ?? '').trim();
}

function baseModel(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    return clean(decodeModelValue(raw)?.modelId || raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Opens a logical run boundary. Repeated calls before the terminal event only
 * enrich the same boundary (for example when a provider run id arrives late).
 */
export function beginRunEndSnapshot(room, input = {}) {
  if (!room || typeof room !== 'object') return null;
  const previous = runState.get(room);
  const state = previous && previous.captured !== true
    ? previous
    : { nonce: randomUUID(), captured: false };
  const runId = clean(input.runId);
  if (runId) state.runId = runId;
  const sessionId = clean(input.sessionId);
  if (sessionId) state.sessionId = sessionId;
  const startedAt = Number(input.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) state.startedAt = startedAt;
  runState.set(room, state);
  return state;
}

function resolveState(room, input) {
  let state = room && typeof room === 'object' ? runState.get(room) : null;
  if (!state) {
    state = { nonce: randomUUID(), captured: false };
    if (room && typeof room === 'object') runState.set(room, state);
  }
  const hasPayloadRunId = Object.prototype.hasOwnProperty.call(input.payload || {}, 'runId');
  const payloadRunId = hasPayloadRunId ? clean(input.payload.runId) : '';
  // An explicit empty terminal run id must never fall back to room._runId: it
  // may belong to the preceding run and would create a false duplicate.
  const runId = payloadRunId || (!hasPayloadRunId ? clean(state.runId) : '') || `local-${state.nonce}`;
  return { state, runId };
}

function resolveErrorSource(payload, status) {
  const explicit = clean(payload.errorSource).toLowerCase();
  if (explicit) return explicit;
  const code = clean(payload.lastErrorCode || payload.code).toLowerCase();
  if (status === 'cancelled' || code.includes('cancel')) return 'cancellation';
  if (code.includes('auth') || code.includes('unauthorized')) return 'auth';
  if (code.includes('permission') || code.includes('denied')) return 'permission';
  if (code.includes('tool') || code.includes('mcp')) return 'local_tool';
  return status === 'error' ? 'provider' : '';
}

function assistantOutputWasSeen(room) {
  return room?._runOutputSeen === true;
}

function normalizeStatus(value, hasError) {
  const status = clean(value).toLowerCase();
  if (['completed', 'complete', 'success', 'succeeded', 'ok', 'finished'].includes(status)) return 'completed';
  if (status.includes('cancel') || ['aborted', 'interrupted', 'stopped'].includes(status)) return 'cancelled';
  if (['error', 'failed', 'failure'].includes(status) || hasError) return 'error';
  return status || 'unknown';
}

/** Builds the snapshot without mutating or resetting harness telemetry. */
export function buildRunEndSnapshot(input = {}) {
  const room = input.room && typeof input.room === 'object' ? input.room : {};
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const harness = clean(input.harness).toLowerCase();
  const { state, runId } = resolveState(room, { payload });
  const sessionId = clean(input.sessionId || state.sessionId || room.sessionKey || room.sessionId || room.chatId);
  const startedAt = Number(room._runStartedAt || state.startedAt);
  const durationKnown = Number.isFinite(startedAt) && startedAt > 0;
  const usageKnown = room._runHadMeasurement === true;
  const outputSeen = assistantOutputWasSeen(room);
  const explicitProviderRejectionEvidence = payload.providerRejectedBeforeGeneration === true
    || payload.explicitProviderRejection === true;
  const errorMessage = clean(payload.lastErrorMessage || payload.result || payload.message);
  const status = normalizeStatus(payload.status, Boolean(errorMessage));
  const outputTokens = usageKnown && Number.isFinite(Number(room._runOutputTokens))
    ? Math.max(0, Math.floor(Number(room._runOutputTokens)))
    : null;
  return {
    runId,
    harness,
    sessionId,
    model: baseModel(input.model || room.modelId || room.model),
    status,
    errorCode: clean(payload.lastErrorCode || payload.code),
    errorSource: resolveErrorSource(payload, status),
    errorMessage,
    durationMs: durationKnown ? Math.max(0, Date.now() - startedAt) : null,
    durationKnown,
    outputTokens,
    usageKnown,
    outputSeen,
    errorStage: explicitProviderRejectionEvidence ? 'before_generation' : (outputSeen ? 'after_output' : 'unknown'),
    explicitProviderRejectionEvidence,
    ...(Array.isArray(payload.lastErrorMessages) ? { errorMessages: payload.lastErrorMessages } : {}),
  };
}

const SAFE_CHAT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Identifiers only (never message or conversation content) that tie an error to a
 * chat and workspace. Each field is optional; unsafe values are dropped.
 *
 * @param {Record<string, any>} room
 * @returns {{ chatId?: string, workspaceFolder?: string } | null}
 */
function runContext(room) {
  const chatId = typeof room.chatId === 'string' ? room.chatId.trim() : '';
  const workspaceFolder = typeof room.cwd === 'string' ? room.cwd.trim() : '';
  const context = {};
  if (SAFE_CHAT_ID_RE.test(chatId)) context.chatId = chatId;
  if (workspaceFolder && workspaceFolder.length <= 1024 && !/[\0\r\n]/.test(workspaceFolder)) context.workspaceFolder = workspaceFolder;
  return Object.keys(context).length ? context : null;
}

/**
 * Captures one terminal snapshot and runs the shared usage-limit/unclassified
 * error hook. Returns null for a repeated terminal event for the same run.
 */
export function captureRunEnd(input = {}) {
  const room = input.room && typeof input.room === 'object' ? input.room : {};
  const snapshot = buildRunEndSnapshot(input);
  const state = runState.get(room);
  const dedupeKey = JSON.stringify([snapshot.harness, snapshot.sessionId, snapshot.runId]);
  if (state?.captured === true && state.dedupeKey === dedupeKey) return null;
  if (state) {
    state.captured = true;
    state.dedupeKey = dedupeKey;
  }
  if (snapshot.status === 'error') {
    const error = {
      harness: snapshot.harness,
      model: snapshot.model,
      message: snapshot.errorMessage,
      ...(snapshot.errorMessages ? { messages: snapshot.errorMessages } : {}),
      ...(input.authMode ? { authMode: input.authMode } : {}),
      ...(input.limitBinding && typeof input.limitBinding === 'object' ? input.limitBinding : {}),
      ...(runContext(room) ? { context: runContext(room) } : {}),
      dataDir: input.dataDir,
    };
    const limited = noteHarnessUsageLimit(error);
    if (!limited) {
      noteUnclassifiedRunError(error);
      // Episode bookkeeping + the one-per-episode notification; never blocks run end.
      void syncUnclassifiedErrors({ dataDir: input.dataDir }).catch(() => {});
      // Independent of the unclassified store: the fast-failure rule keeps its own observations.
      void noteFastProviderFailure(snapshot, { dataDir: input.dataDir }).catch(() => {});
    }
    else if (typeof input.onUsageLimit === 'function') input.onUsageLimit(snapshot, error);
  }
  if (typeof input.onSnapshot === 'function') input.onSnapshot(snapshot);
  for (const listener of runEndListeners) {
    try { listener(snapshot, input); } catch { /* telemetry must not break run end */ }
  }
  return snapshot;
}
