/**
 * Workspace Watcher — restart evidence for a cycle slot (leaf R11).
 *
 * Answers one question: "was this cycle interrupted by a server restart?". The
 * answer must come from evidence, never from the mere fact that the slot is an
 * orphan. The only source is the process instance token stored on the slot at
 * reservation (R9 `getProcessInstance`): a slot reserved by another process
 * lives in a dead adapter registry.
 *
 * Watcher cycles are NOT written to the recovery registry (its request ids are
 * `req_<uuid>`, a cycle id is a bare UUID), so no registry lookup is attempted.
 */

import { getProcessInstance } from './recovery/recovery-shutdown.ts';
import { listQueueEntries } from './recovery/recovery-queue.ts';
import { listRuns } from './recovery/recovery-store.ts';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Whether the slot was reserved by a process other than the current one.
 * A legacy slot without a token is "unknown", reported as not foreign.
 *
 * @param {Record<string, any>} cycle
 * @param {string} [currentInstanceId]
 * @returns {boolean}
 */
export function isWorkspaceWatcherCycleForeignInstance(cycle, currentInstanceId = getProcessInstance().instanceId) {
  const slotInstance = text(cycle?.instanceId);
  return Boolean(slotInstance) && slotInstance !== text(currentInstanceId);
}

/**
 * Resolve restart evidence from the slot token.
 *
 * `interrupted` is true only with a foreign instance token. A cycle that
 * already reported an outcome is never reclassified: its report is the
 * stronger evidence.
 *
 * @param {{ cycle: Record<string, any>, currentInstanceId?: string }} input
 * @returns {{ interrupted: boolean, source: string, foreignInstance: boolean }}
 */
export function resolveWorkspaceWatcherCycleRestartEvidence(input) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const foreignInstance = isWorkspaceWatcherCycleForeignInstance(cycle, input.currentInstanceId);
  if (text(cycle.reportedOutcome)) return { interrupted: false, source: 'reported', foreignInstance };
  if (foreignInstance) return { interrupted: true, source: 'instance_token', foreignInstance };
  return { interrupted: false, source: 'none', foreignInstance };
}

const ABSENT_PROBE_REASONS = new Set(['state_missing', 'adapter_missing', 'chat_missing']);

/**
 * Whether the probe proves the cycle's room is gone or idle. The run-scoped
 * probe decides when it is `known`; a missing-room answer must be confirmed by
 * a second probe without `runId`. `busy` and every other unknown answer
 * (`adapter_error`, `run_mismatch`, `probe_failed`) are NOT absence.
 *
 * @param {Record<string, any>} cycle
 * @param {Function} probe
 * @returns {boolean}
 */
export function isWorkspaceWatcherCycleAbsentFromAdapters(cycle, probe) {
  const chatId = text(cycle?.chatId);
  if (!chatId || typeof probe !== 'function') return false;
  const runId = text(cycle?.runId);
  const withRun = probe({ chatId, ...(runId ? { runId } : {}) });
  if (withRun?.known === true) return withRun.busy === false;
  if (!ABSENT_PROBE_REASONS.has(text(withRun?.reason))) return false;
  const withoutRun = probe({ chatId });
  if (withoutRun?.known === true) return withoutRun.busy === false;
  return ABSENT_PROBE_REASONS.has(text(withoutRun?.reason));
}

/**
 * THE shared restart-interrupted rule, used by both the boot/heartbeat path
 * (workspace-watcher-cycle.js) and the runtime reconcile path
 * (workspace-watcher.js).
 *
 * A cycle counts as restart-interrupted only when BOTH hold:
 *  1. positive evidence: the slot carries a foreign instance token (see
 *     `resolveWorkspaceWatcherCycleRestartEvidence`), and
 *  2. the probe proves the room is absent from every adapter (gone or idle).
 * A `busy` or `unknown` probe is never treated as finished: such a cycle stays
 * alive (not closed, not neutral) until the probe resolves. A same-token or
 * token-less slot is never restart-interrupted.
 *
 * @param {{ cycle: Record<string, any>, probe: Function, currentInstanceId?: string }} input
 * @returns {boolean}
 */
export function isWorkspaceWatcherCycleRestartInterrupted(input) {
  const evidence = resolveWorkspaceWatcherCycleRestartEvidence({
    cycle: input.cycle,
    currentInstanceId: input.currentInstanceId,
  });
  if (!evidence.foreignInstance) return false;
  if (!text(input.cycle?.chatId)) return false;
  return isWorkspaceWatcherCycleAbsentFromAdapters(input.cycle, input.probe);
}

/** Run states a restart can leave behind for an executor whose room is gone. */
const LEAF_RESTART_RUN_STATES = new Set(['starting', 'running', 'interrupted', 'unknown']);
/** Queue entry states that mean the recovery registry still owns the run. */
const LEAF_RESTART_BLOCKING_QUEUE_STATES = new Set(['queued', 'launched', 'waiting']);

/**
 * Restart evidence for a `doing` leaf's executor chat (not a cycle slot).
 *
 * True only when ALL hold, read from the recovery registry:
 *  1. the chat's latest chat-family run carries a process instance token that
 *     differs from the current process (it was accepted by a process that is
 *     gone; a legacy run without a token proves nothing),
 *  2. that run is in a state a restart leaves behind and is not `waiting` for a
 *     human, `recovering`, or terminal-by-user (`cancelled`/`completed`),
 *  3. recovery has not claimed it for resume (no resume request on the run) and
 *     no queue entry for it is queued/launched/waiting.
 * The caller must additionally have a probe that proves the room is absent from
 * this process. Any registry error is "no evidence": the row stays `unknown`.
 *
 * @param {string} chatId
 * @param {{
 *   currentInstanceId?: string,
 *   store?: Record<string, any>,
 *   listRuns?: Function,
 *   listQueueEntries?: Function,
 * }} [options]
 * @returns {boolean}
 */
export function hasWorkspaceWatcherLeafRestartEvidence(chatId, options = {}) {
  const id = text(chatId);
  if (!id) return false;
  const current = text(options.currentInstanceId) || getProcessInstance().instanceId;
  const runsFn = options.listRuns || listRuns;
  const queueFn = options.listQueueEntries || listQueueEntries;
  try {
    const runs = runsFn({ family: 'chat', chatIds: [id], order: 'desc', limit: 1 }, options.store);
    const run = Array.isArray(runs) ? runs[0] : null;
    if (!run) return false;
    const token = text(run.instanceToken);
    if (!token || token === current) return false;
    if (!LEAF_RESTART_RUN_STATES.has(text(run.state))) return false;
    const resumeRequests = run.resumeRequests && typeof run.resumeRequests === 'object' ? run.resumeRequests : {};
    if (text(run.resumeActor) || Object.keys(resumeRequests).length > 0) return false;
    const queued = queueFn({ logicalRunId: text(run.logicalRunId), limit: 20 }, options.store);
    if (!Array.isArray(queued)) return false;
    return !queued.some((entry) => LEAF_RESTART_BLOCKING_QUEUE_STATES.has(text(entry?.state)));
  } catch {
    return false;
  }
}
