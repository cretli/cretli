/**
 * Pure decisions and feedback mapping for the manual recovery actions
 * ("Resume" / "Keep stopped").
 *
 * The server is the source of truth: `describeRecoveryRun` (lib/recovery/
 * recovery-ui.js) decides which actions exist and whether an unknown run needs
 * explicit confirmation. These helpers only translate that view into UI
 * decisions and i18n keys, never re-derive resumability on the client.
 */

/** Action identifiers used by the DOM layer and the feedback mapping. */
export const RECOVERY_ACTION = Object.freeze({
  RESUME: 'resume',
  KEEP_STOPPED: 'keep-stopped',
});

/**
 * Delegation statuses that can still own a recovery item. A completed/running
 * delegation card does not render recovery actions: the widget itself stays
 * scoped to the server-provided `canResume` / `canKeepStopped`.
 */
export const RECOVERY_DELEGATION_STATUSES = Object.freeze([
  'interrupted',
  'failed',
  'waiting_for_input',
  'cancelling',
]);

/**
 * @param {string} status
 * @returns {boolean}
 */
export function shouldLoadDelegationRecovery(status) {
  return RECOVERY_DELEGATION_STATUSES.includes(String(status || '').trim());
}

/**
 * `unknown` liveness must never be confirmed implicitly: the server rejects a
 * resume without `confirmUnknown` and the UI has to ask the user first.
 *
 * @param {{ state?: string, needsConfirm?: boolean } | null | undefined} run
 * @returns {boolean}
 */
export function recoveryResumeNeedsConfirm(run) {
  if (run?.needsConfirm === true) return true;
  return String(run?.state || '').trim() === 'unknown';
}

/**
 * Value sent as `confirmUnknown` for one resume request. Only an explicit user
 * confirmation turns an unknown run into `true`; everything else stays `false`.
 *
 * @param {{ state?: string, needsConfirm?: boolean } | null | undefined} run
 * @param {boolean} userConfirmed
 * @returns {boolean}
 */
export function resolveRecoveryConfirmUnknown(run, userConfirmed) {
  return userConfirmed === true && recoveryResumeNeedsConfirm(run);
}

/**
 * @param {string} tone
 * @param {string} key
 * @returns {{ tone: 'success' | 'error' | 'info', key: string }}
 */
function feedback(tone, key) {
  return { tone, key };
}

const RESUME_FEEDBACK = Object.freeze({
  resumed: feedback('success', 'chat.recoveryResumeStarted'),
  in_progress: feedback('info', 'chat.recoveryResumeInProgress'),
  already_recovering: feedback('info', 'chat.recoveryResumeInProgress'),
  reattach_deferred: feedback('error', 'chat.recoveryResumeReattachDeferred'),
  superseded: feedback('error', 'chat.recoveryResumeSuperseded'),
  invalid: feedback('error', 'chat.recoveryResumeInvalid'),
  not_found: feedback('error', 'chat.recoveryResumeNotFound'),
  conflict: feedback('error', 'chat.recoveryResumeConflict'),
  not_resumable: feedback('error', 'chat.recoveryResumeNotResumable'),
  cancelled: feedback('error', 'chat.recoveryResumeCancelled'),
  waiting: feedback('error', 'chat.recoveryResumeWaiting'),
  stopping: feedback('error', 'chat.recoveryResumeStopping'),
  limit_blocked: feedback('error', 'chat.recoveryResumeLimitBlocked'),
  family_blocked: feedback('error', 'chat.recoveryResumeFamilyBlocked'),
  liveness_unknown: feedback('error', 'chat.recoveryResumeLivenessUnknown'),
  executor_alive: feedback('error', 'chat.recoveryResumeExecutorAlive'),
  unsupported: feedback('error', 'chat.recoveryResumeUnsupported'),
  launch_failed: feedback('error', 'chat.recoveryResumeLaunchFailed'),
  error: feedback('error', 'chat.recoveryActionFailed'),
});

const KEEP_STOPPED_FEEDBACK = Object.freeze({
  kept_stopped: feedback('success', 'chat.recoveryKeepStoppedDone'),
  not_found: feedback('error', 'chat.recoveryKeepStoppedNotFound'),
  conflict: feedback('error', 'chat.recoveryKeepStoppedConflict'),
  not_resumable: feedback('error', 'chat.recoveryKeepStoppedNotResumable'),
  error: feedback('error', 'chat.recoveryActionFailed'),
});

const FALLBACK_FEEDBACK = feedback('error', 'chat.recoveryActionFailed');

/**
 * Map the resume endpoint body to a feedback message.
 *
 * @param {{ status?: string } | null | undefined} response
 * @returns {{ tone: 'success' | 'error' | 'info', key: string }}
 */
export function resolveRecoveryResumeFeedback(response) {
  const status = String(response?.status || '').trim();
  return RESUME_FEEDBACK[status] || FALLBACK_FEEDBACK;
}

/**
 * Map the keep-stopped endpoint body to a feedback message.
 *
 * @param {{ status?: string } | null | undefined} response
 * @returns {{ tone: 'success' | 'error' | 'info', key: string }}
 */
export function resolveRecoveryKeepStoppedFeedback(response) {
  const status = String(response?.status || '').trim();
  return KEEP_STOPPED_FEEDBACK[status] || FALLBACK_FEEDBACK;
}

/**
 * Dispatch feedback by action.
 *
 * @param {'resume' | 'keep-stopped' | string} action
 * @param {{ status?: string } | null | undefined} response
 * @returns {{ tone: 'success' | 'error' | 'info', key: string }}
 */
export function resolveRecoveryActionFeedback(action, response) {
  if (action === RECOVERY_ACTION.KEEP_STOPPED) return resolveRecoveryKeepStoppedFeedback(response);
  return resolveRecoveryResumeFeedback(response);
}

/**
 * Read the run list from a `recovery-runs` response. A failed response
 * (`ok: false`, HTTP 500, missing array) is `null`, never an empty list, so a
 * transient error cannot remove actions that are still valid.
 *
 * @param {{ ok?: boolean, runs?: unknown } | null | undefined} data
 * @returns {object[] | null}
 */
export function readRecoveryRunsResponse(data) {
  if (!data || data.ok === false || !Array.isArray(data.runs)) return null;
  return data.runs;
}

/**
 * Ordering guard for overlapping reads: only the newest started request may
 * apply its result, so a delayed GET cannot resurrect actions removed by a
 * newer response.
 *
 * @returns {{ begin: () => number, isCurrent: (ticket: number) => boolean }}
 */
export function createLatestRequestGuard() {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (ticket) => ticket === latest,
  };
}

const recoveryWidgetListeners = new Map();

/**
 * Register a refresher for a rendered recovery surface of `chatId` (banner or
 * delegation card). Returns an unregister function; the caller owns the
 * lifecycle and must call it when the surface is destroyed or evicted.
 *
 * @param {string} chatId
 * @param {(feedback?: { tone?: string, key?: string } | null) => void} refresh
 * @returns {() => void}
 */
export function registerRecoveryWidget(chatId, refresh) {
  const key = String(chatId || '');
  if (!key || typeof refresh !== 'function') return () => {};
  let set = recoveryWidgetListeners.get(key);
  if (!set) {
    set = new Set();
    recoveryWidgetListeners.set(key, set);
  }
  set.add(refresh);
  return () => {
    set.delete(refresh);
    if (set.size === 0 && recoveryWidgetListeners.get(key) === set) recoveryWidgetListeners.delete(key);
  };
}

/**
 * Ask every rendered recovery surface of `chatId` to re-read persisted state
 * (presence change from another device, or a local action). `feedback` is the
 * action result the calling surface just produced: forwarding it keeps a
 * confirmation/error visible when the refreshed run list comes back empty
 * (for example after "Keep stopped" removes the last recovery row).
 *
 * `skipRefresh` is the surface that already refreshed itself with the same
 * feedback; skipping it avoids a duplicate GET.
 *
 * @param {string} chatId
 * @param {{ tone?: string, key?: string } | null} [feedback]
 * @param {((feedback?: { tone?: string, key?: string } | null) => void) | null} [skipRefresh]
 * @returns {number} Number of surfaces notified.
 */
export function notifyRecoveryWidgets(chatId, feedback = null, skipRefresh = null) {
  const set = recoveryWidgetListeners.get(String(chatId || ''));
  if (!set) return 0;
  for (const refresh of [...set]) {
    if (skipRefresh && refresh === skipRefresh) continue;
    try { refresh(feedback); } catch { /* a broken surface must not block the others */ }
  }
  return set.size;
}
