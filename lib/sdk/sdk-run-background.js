/**
 * Background subagent work on a live `@cursor/sdk` run.
 *
 * When a steer (or the agent itself) moves a `"task"` subagent to the
 * background, the subagent keeps running and its result comes back to the
 * parent as a *follow-up turn on the same run*. A stream that merely reports
 * `done` is therefore not proof that the run is over: finishing on the first
 * `done` truncates the answer and drops the follow-up turn.
 *
 * The tracker counts outstanding background tasks from the tool-call stream and
 * `decideSdkRunStreamEnd()` turns that plus the run handle status into the only
 * three actions the WS loop needs. The run's own terminal status always wins —
 * this module can only *delay* finishing, never force it past a finished run.
 */

import { readEnvAlias } from '../env-alias.js';

/** SDK tool names that launch a subagent (`AgentOptions.tools` "task"). */
export const SDK_SUBAGENT_TOOL_NAMES = Object.freeze(['task', 'subagent', 'agent']);

/** `RunStatus` values that are terminal for a run handle. */
const TERMINAL_RUN_STATUSES = new Set(['finished', 'error', 'cancelled', 'completed', 'failed']);

/** In-stream status words that mean the run itself is over. */
const TERMINAL_STATUS_EVENT_VALUES = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

export const SDK_BACKGROUND_FOLLOWUP_DEFAULT_BUDGET_MS = 600_000;
export const SDK_BACKGROUND_FOLLOWUP_MIN_BUDGET_MS = 60_000;
export const SDK_BACKGROUND_FOLLOWUP_POLL_INTERVAL_MS = 1_000;

/** Ack outcomes the tracker has settled (used by tests and diagnostics). */
export const SDK_BACKGROUND_DECISIONS = Object.freeze({
  FINISH: 'finish',
  AWAIT: 'await_background',
  BUDGET_EXCEEDED: 'budget_exceeded',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {Record<string, unknown>} rec
 * @param {string[]} keys
 * @returns {unknown}
 */
function pickFirst(rec, keys) {
  for (const key of keys) {
    if (rec[key] !== undefined && rec[key] !== null) return rec[key];
  }
  return undefined;
}

/**
 * True when the event is a tool call that drives a subagent.
 *
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isSubagentToolEvent(rec) {
  const type = trimText(rec.type).toLowerCase();
  if (type === 'task') return true;
  if (type !== 'tool_call' && type !== 'tool_use') return false;
  const name = trimText(
    pickFirst(rec, ['name', 'tool', 'toolName', 'tool_name'])
  ).toLowerCase();
  if (!name) return false;
  return SDK_SUBAGENT_TOOL_NAMES.some((candidate) => name === candidate
    || name.endsWith(`/${candidate}`));
}

/**
 * Reads `isBackground` / `backgroundReason` off the ToolResult payload. Both
 * camelCase (SDK/protobuf JSON) and snake_case (raw server payload) are
 * accepted; the payload may sit on `result`, `result.value` or the event root.
 *
 * @param {Record<string, unknown>} rec
 * @returns {{ isBackground: boolean | null, reason: string }}
 */
function readBackgroundFields(rec) {
  const containers = [rec];
  const result = rec.result;
  if (result && typeof result === 'object') {
    containers.push(result);
    const value = result.value;
    if (value && typeof value === 'object') containers.push(value);
  }
  let isBackground = null;
  let reason = '';
  for (const box of containers) {
    const flag = pickFirst(box, ['isBackground', 'is_background']);
    if (typeof flag === 'boolean' && isBackground === null) isBackground = flag;
    const rawReason = pickFirst(box, ['backgroundReason', 'background_reason']);
    if (!reason && typeof rawReason === 'string') reason = rawReason.trim();
  }
  return { isBackground, reason };
}

/**
 * @param {unknown} event
 * @returns {{ id: string, isBackground: boolean, reason: string, status: string } | null}
 */
export function readSdkBackgroundTaskSignal(event) {
  if (!event || typeof event !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (event);
  if (!isSubagentToolEvent(rec)) return null;
  const { isBackground, reason } = readBackgroundFields(rec);
  if (isBackground !== true && !reason) return null;
  const id = trimText(
    pickFirst(rec, ['call_id', 'callId', 'toolCallId', 'requestId', 'id', 'run_id', 'runId'])
  ) || trimText(pickFirst(rec, ['agent_id', 'agentId'])) || 'task';
  return {
    id,
    isBackground: isBackground === true,
    reason,
    status: trimText(pickFirst(rec, ['status'])).toLowerCase(),
  };
}

/**
 * @returns {{ pending: Map<string, { reason: string, startedAt: number }>, settled: number, lastEventAt: number }}
 */
export function createSdkBackgroundWorkState() {
  return {
    pending: new Map(),
    settled: 0,
    lastEventAt: 0,
  };
}

/**
 * @param {ReturnType<typeof createSdkBackgroundWorkState> | null | undefined} state
 */
export function resetSdkBackgroundWorkState(state) {
  if (!state) return;
  state.pending.clear();
  state.settled = 0;
  state.lastEventAt = 0;
}

/**
 * @param {ReturnType<typeof createSdkBackgroundWorkState> | null | undefined} state
 * @returns {number}
 */
export function outstandingSdkBackgroundWork(state) {
  return state && state.pending instanceof Map ? state.pending.size : 0;
}

/**
 * @param {ReturnType<typeof createSdkBackgroundWorkState> | null | undefined} state
 * @returns {boolean}
 */
export function hasOutstandingSdkBackgroundWork(state) {
  return outstandingSdkBackgroundWork(state) > 0;
}

/**
 * Feeds one stream event to the tracker.
 *
 * A background task is opened when a subagent tool call reports
 * `isBackground: true`; it is settled when the same id comes back with a
 * terminal tool status and no longer claims background, or when the run itself
 * reaches a terminal status (`noteSdkRunTerminalStatus`).
 *
 * @param {ReturnType<typeof createSdkBackgroundWorkState> | null | undefined} state
 * @param {unknown} event
 * @returns {{ opened: string, settledId: string, cleared: boolean, outstanding: number }}
 */
export function noteSdkBackgroundWorkEvent(state, event) {
  const result = { opened: '', settledId: '', cleared: false, outstanding: 0 };
  if (!state || !event || typeof event !== 'object') {
    result.outstanding = outstandingSdkBackgroundWork(state);
    return result;
  }
  const rec = /** @type {Record<string, unknown>} */ (event);
  state.lastEventAt = Date.now();

  if (trimText(rec.type).toLowerCase() === 'status') {
    const status = trimText(rec.status).toUpperCase();
    if (TERMINAL_STATUS_EVENT_VALUES.has(status)) {
      result.cleared = state.pending.size > 0;
      state.settled += state.pending.size;
      state.pending.clear();
    }
    result.outstanding = outstandingSdkBackgroundWork(state);
    return result;
  }

  const signal = readSdkBackgroundTaskSignal(rec);
  if (!signal) {
    result.outstanding = outstandingSdkBackgroundWork(state);
    return result;
  }
  const terminalToolStatus = signal.status === 'completed' || signal.status === 'error';
  if (signal.isBackground && !terminalToolStatus) {
    if (!state.pending.has(signal.id)) {
      state.pending.set(signal.id, { reason: signal.reason || 'unspecified', startedAt: Date.now() });
      result.opened = signal.id;
    }
    result.outstanding = outstandingSdkBackgroundWork(state);
    return result;
  }
  if (state.pending.has(signal.id)) {
    state.pending.delete(signal.id);
    state.settled += 1;
    result.settledId = signal.id;
  } else if (signal.isBackground && terminalToolStatus) {
    // The task went to the background and finished without an in-stream open:
    // record it as a follow-up turn that has already been delivered.
    state.pending.set(signal.id, { reason: signal.reason || 'unspecified', startedAt: Date.now() });
    result.opened = signal.id;
    result.outstanding = outstandingSdkBackgroundWork(state);
    return result;
  }
  result.outstanding = outstandingSdkBackgroundWork(state);
  return result;
}

/**
 * Marks the run terminal: nothing can still be owed to a finished run.
 *
 * @param {ReturnType<typeof createSdkBackgroundWorkState> | null | undefined} state
 * @returns {boolean} true when it dropped pending background work
 */
export function noteSdkRunTerminalStatus(state) {
  if (!state || !(state.pending instanceof Map) || state.pending.size === 0) return false;
  state.settled += state.pending.size;
  state.pending.clear();
  return true;
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalSdkRunStatus(status) {
  const normalized = trimText(status).toLowerCase();
  if (!normalized) return false;
  return TERMINAL_RUN_STATUSES.has(normalized);
}

/**
 * The single decision the stream loop needs when `stream()` reports `done`.
 *
 * @param {{
 *   runStatus?: unknown,
 *   outstanding?: number,
 *   waitedMs?: number,
 *   budgetMs?: number,
 *   canFollow?: boolean,
 * }} [input]
 * @returns {'finish' | 'await_background' | 'budget_exceeded'}
 */
export function decideSdkRunStreamEnd(input = {}) {
  const outstanding = Number.isFinite(input.outstanding) ? Number(input.outstanding) : 0;
  if (isTerminalSdkRunStatus(input.runStatus)) {
    return SDK_BACKGROUND_DECISIONS.FINISH;
  }
  if (outstanding <= 0) return SDK_BACKGROUND_DECISIONS.FINISH;
  if (input.canFollow === false) return SDK_BACKGROUND_DECISIONS.BUDGET_EXCEEDED;
  const waitedMs = Number.isFinite(input.waitedMs) ? Number(input.waitedMs) : 0;
  const budgetMs = Number.isFinite(input.budgetMs) && input.budgetMs > 0
    ? Number(input.budgetMs)
    : SDK_BACKGROUND_FOLLOWUP_DEFAULT_BUDGET_MS;
  if (waitedMs >= budgetMs) return SDK_BACKGROUND_DECISIONS.BUDGET_EXCEEDED;
  return SDK_BACKGROUND_DECISIONS.AWAIT;
}

/**
 * A handle can only be followed to the end of background work if the SDK gives
 * us something to wait on: `wait()` or a status listener.
 *
 * @param {unknown} run
 * @returns {boolean}
 */
export function canFollowSdkRunToCompletion(run) {
  if (!run || typeof run !== 'object') return false;
  return typeof run.wait === 'function'
    || typeof run.onDidChangeStatus === 'function'
    || typeof run.status === 'string';
}

/**
 * `sdkRunIdleTimeoutMs` is the per-event budget; background follow-ups need
 * more than one idle window but must stay bounded so a wedged subagent cannot
 * hold a room forever.
 *
 * @param {unknown} idleTimeoutMs
 * @param {unknown} envValue
 * @returns {number}
 */
export function resolveSdkBackgroundFollowupBudgetMs(idleTimeoutMs, envValue = undefined) {
  const fromEnv = Number.parseInt(String(envValue ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv >= SDK_BACKGROUND_FOLLOWUP_MIN_BUDGET_MS) {
    return fromEnv;
  }
  const idle = Number.isFinite(idleTimeoutMs) && Number(idleTimeoutMs) > 0
    ? Number(idleTimeoutMs)
    : SDK_BACKGROUND_FOLLOWUP_DEFAULT_BUDGET_MS / 2;
  return Math.min(Math.max(idle * 2, SDK_BACKGROUND_FOLLOWUP_MIN_BUDGET_MS), 15 * 60_000);
}

/**
 * @param {object} [input]
 * @returns {number}
 */
export function resolveRoomBackgroundFollowupBudgetMs(input = {}) {
  const env = readEnvAlias({
    current: 'CRETLI_SDK_BACKGROUND_FOLLOWUP_TIMEOUT_MS',
    legacy: 'CURSOR_REMOTE_SDK_BACKGROUND_FOLLOWUP_TIMEOUT_MS',
  });
  return resolveSdkBackgroundFollowupBudgetMs(input.idleTimeoutMs, env ?? '');
}

/**
 * @param {{
 *   outstanding?: number,
 *   openedId?: string,
 *   settledId?: string,
 *   reason?: string,
 *   phase?: string,
 *   waitedMs?: number,
 *   runId?: string,
 * }} [input]
 * @returns {Record<string, unknown>}
 */
export function buildSdkBackgroundWorkPayload(input = {}) {
  const outstanding = Number.isFinite(input.outstanding) ? Number(input.outstanding) : 0;
  return {
    type: 'sdkBackgroundWork',
    phase: trimText(input.phase) || (outstanding > 0 ? 'running' : 'idle'),
    outstanding,
    running: outstanding > 0,
    openedId: trimText(input.openedId),
    settledId: trimText(input.settledId),
    reason: trimText(input.reason),
    runId: trimText(input.runId),
    waitedMs: Number.isFinite(input.waitedMs) ? Number(input.waitedMs) : 0,
    at: Date.now(),
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepMs(ms) {
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}
