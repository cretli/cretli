/**
 * One structured 'page-resume' log entry per active-chat return so timings can be
 * compared before/after the resume changes across 5s/30s/2min/10min scenarios.
 *
 * Stages (relative to the visible/pageshow event):
 *   decision    - probe / recycle / reconnect chosen
 *   cachedRender- cached (IndexedDB/local) history is on screen before the network answers
 *   probeSent   - resume control ping sent on an apparently-open socket
 *   wsOpen      - WebSocket reached OPEN
 *   firstMessage- first server frame (pong, replay, hello, ...)
 *   replayEnd   - replayBatchEnd received
 *   catchUp     - HTTP history catch-up finished
 *   uiReady     - UI render finished (marked with catchUp when no replay)
 */

export const PAGE_RESUME_LOG_TAG = 'page-resume';

/** Upper bound for a trace that never reaches catch-up, so every resume logs once. */
export const PAGE_RESUME_FINALIZE_MS = 10000;

/**
 * @param {number | undefined} readyState
 * @returns {string}
 */
export function formatResumeReadyState(readyState) {
  switch (Number(readyState)) {
    case 0:
      return 'connecting';
    case 1:
      return 'open';
    case 2:
      return 'closing';
    case 3:
      return 'closed';
    default:
      return 'none';
  }
}

/**
 * @param {{
 *   chatId?: string,
 *   reason?: string,
 *   backgroundMs?: number,
 *   mobile?: boolean,
 *   readyState?: number,
 *   notification?: boolean,
 *   startedAt?: number,
 * }} input
 * @returns {object}
 */
export function createPageResumeTrace(input) {
  const reason = String(input?.reason || 'visibility');
  return {
    chatId: String(input?.chatId || ''),
    reason,
    backgroundMs: Number(input?.backgroundMs) || 0,
    mobile: input?.mobile === true,
    readyStateBefore: formatResumeReadyState(input?.readyState),
    notification: input?.notification === true || reason === 'notification',
    decision: 'unknown',
    probeTimedOut: false,
    firstMessageType: '',
    startedAt: Number(input?.startedAt) || Date.now(),
    stages: {},
    logged: false,
  };
}

/**
 * @param {object | null | undefined} trace
 * @param {string} stage
 * @param {number} [at]
 * @returns {object | null | undefined}
 */
export function markPageResumeStage(trace, stage, at = Date.now()) {
  if (!trace || !stage) return trace;
  if (!trace.stages || typeof trace.stages !== 'object') trace.stages = {};
  if (!Number.isFinite(trace.stages[stage])) trace.stages[stage] = Number(at) || Date.now();
  return trace;
}

/**
 * @param {object | null | undefined} trace
 * @param {string} decision
 * @returns {object | null | undefined}
 */
export function setPageResumeDecision(trace, decision) {
  if (!trace) return trace;
  trace.decision = String(decision || 'unknown');
  return trace;
}

/**
 * @param {object | null | undefined} trace
 * @returns {object | null | undefined}
 */
export function markPageResumeProbeTimeout(trace) {
  if (!trace) return trace;
  trace.probeTimedOut = true;
  return trace;
}

/**
 * @param {object | null | undefined} trace
 * @param {string} messageType
 * @param {number} [at]
 * @returns {object | null | undefined}
 */
export function notePageResumeFirstMessage(trace, messageType, at = Date.now()) {
  if (!trace) return trace;
  if (!trace.firstMessageType) {
    trace.firstMessageType = String(messageType || 'unknown');
    markPageResumeStage(trace, 'firstMessage', at);
  }
  return trace;
}

/**
 * @param {object | null | undefined} trace
 * @returns {Record<string, number | null>}
 */
export function computePageResumeDurations(trace) {
  const base = Number(trace?.startedAt) || 0;
  const stages = trace?.stages || {};
  const rel = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.round(value - base)) : null;
  const lastStage = [
    stages.uiReady,
    stages.catchUp,
    stages.replayEnd,
    stages.firstMessage,
    stages.wsOpen,
    stages.cachedRender,
    stages.probeSent,
    stages.decision,
  ]
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), null);
  return {
    decisionMs: rel(stages.decision),
    cachedRenderMs: rel(stages.cachedRender),
    probeSentMs: rel(stages.probeSent),
    wsOpenMs: rel(stages.wsOpen),
    firstMessageMs: rel(stages.firstMessage),
    replayEndMs: rel(stages.replayEnd),
    catchUpMs: rel(stages.catchUp),
    uiReadyMs: rel(stages.uiReady),
    totalMs: rel(lastStage) ?? 0,
  };
}

/**
 * @param {object} trace
 * @param {string} completedBy
 * @returns {object}
 */
export function buildPageResumeLogPayload(trace, completedBy = 'deadline') {
  return {
    chatId: trace?.chatId || '',
    reason: trace?.reason || '',
    mobile: trace?.mobile === true,
    notification: trace?.notification === true,
    backgroundMs: Number(trace?.backgroundMs) || 0,
    readyStateBefore: trace?.readyStateBefore || 'none',
    decision: trace?.decision || 'unknown',
    probeTimedOut: trace?.probeTimedOut === true,
    firstMessageType: trace?.firstMessageType || '',
    completedBy,
    durations: computePageResumeDurations(trace),
  };
}
