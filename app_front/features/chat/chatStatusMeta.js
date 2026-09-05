/**
 * Harness chat status badge (SDK / OpenCode / OpenRouter).
 * Uses protocol signals only — not PTY buffer heuristics.
 */

/** @typedef {{ tone: string, label: string }} ChatStatusMeta */

// English mirrors the default locale; callers that pass a `translate` function
// (the app) never reach these, so they only cover direct/test usage.
const FALLBACK_LABELS = {
  'status.connecting': 'Connecting…',
  'status.disconnected': 'Disconnected',
  'status.agentWorking': 'Agent working',
  'status.agentWorkingQueued': 'Agent working · queue: {count}',
  'status.needsAction': 'Needs action',
  'status.ready': 'Ready',
  'chat.delegationStatus.completed': 'Completed',
  'chat.delegationStatus.failed': 'Failed',
  'chat.delegationStatus.interrupted': 'Interrupted',
};

/**
 * @param {string} key
 * @param {Record<string, string|number>|null} [vars]
 * @returns {string}
 */
function translateFallback(key, vars = null) {
  let label = FALLBACK_LABELS[key] || key;
  if (!vars) return label;
  for (const [name, value] of Object.entries(vars)) {
    label = label.split(`{${name}}`).join(String(value));
  }
  return label;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readQueuedCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

/**
 * @param {object|null|undefined} chat
 * @returns {{ hasPendingQuestion: boolean, hasPendingPermission: boolean }}
 */
export function readHarnessPendingFlags(chat) {
  const hasPendingQuestion =
    chat?._opencodePendingQuestion != null
    || Number(chat?._sdkServerPendingQuestionCount || 0) > 0;
  const hasPendingPermission =
    chat?._opencodePendingPermission != null
    || Number(chat?._sdkServerPendingPermissionCount || 0) > 0;
  return { hasPendingQuestion, hasPendingPermission };
}

/**
 * True when the harness still has live work, even if the local socket is down.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function hasLiveHarnessWork(chat) {
  if (!chat) return false;
  if (hasActiveAgentRun(chat)) return true;
  const pending = readHarnessPendingFlags(chat);
  if (pending.hasPendingQuestion || pending.hasPendingPermission) return true;
  return chat._serverRunState?.state === 'waiting';
}

/**
 * True when the agent is in an active run (busy or queued), not waiting on the user.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function hasActiveAgentRun(chat) {
  if (!chat) return false;
  if (chat._agentState === 'active') return true;
  if (chat._sdkServerBusy === true) return true;
  if (chat._serverRunState?.state === 'busy') return true;
  if (readQueuedCount(chat._sdkServerQueuedCount) > 0) return true;
  return readQueuedCount(chat._sdkRichView?.queuedCount) > 0;
}

/**
 * @param {string} tone
 * @returns {'disconnected' | 'idle' | 'awaiting' | 'active'}
 */
export function resolveChatListDotState(tone) {
  if (tone === 'disconnected') return 'disconnected';
  if (tone === 'idle') return 'idle';
  if (
    tone === 'awaiting'
    || tone === 'attention'
    || tone === 'approval'
    || tone === 'question'
    || tone === 'textarea'
    || tone === 'choice'
  ) {
    return 'awaiting';
  }
  return 'active';
}

/**
 * @param {object} input
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} translate
 * @returns {ChatStatusMeta | null}
 */
function resolveLiveHarnessStateMeta(input, translate) {
  if (input.hasPendingQuestion === true || input.hasPendingPermission === true) {
    return { tone: 'awaiting', label: translate('status.needsAction') };
  }
  if (String(input.agent || 'idle') !== 'active') return null;
  const queuedCount = readQueuedCount(input.queuedCount);
  if (queuedCount > 0) {
    return { tone: 'active', label: translate('status.agentWorkingQueued', { count: queuedCount }) };
  }
  return { tone: 'active', label: translate('status.agentWorking') };
}

/**
 * @param {object | null | undefined} serverRunState
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} translate
 * @returns {ChatStatusMeta | null}
 */
function resolveServerRunStateMeta(serverRunState, translate) {
  if (!serverRunState || typeof serverRunState !== 'object') return null;
  const state = String(serverRunState.state || '');
  if (state === 'waiting') {
    return { tone: 'awaiting', label: translate('status.needsAction') };
  }
  if (state === 'busy') {
    return { tone: 'active', label: translate('status.agentWorking') };
  }
  if (state === 'attention') {
    const status = String(serverRunState.delegationStatus || 'completed');
    const key = `chat.delegationStatus.${status}`;
    const label = translate(key);
    return { tone: 'attention', label: label === key ? status : label };
  }
  return null;
}

/**
 * @param {object} [input]
 * @param {string} [input.connection]
 * @param {string} [input.agent]
 * @param {boolean} [input.hasPendingQuestion]
 * @param {boolean} [input.hasPendingPermission]
 * @param {number} [input.queuedCount]
 * @param {object | null} [input.serverRunState]
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} [input.translate]
 * @returns {ChatStatusMeta}
 */
export function resolveHarnessChatStateMeta(input = {}) {
  const translate = typeof input.translate === 'function' ? input.translate : translateFallback;
  const connection = String(input.connection || 'disconnected');
  if (connection === 'connecting' || connection === 'reconnecting') {
    return { tone: 'connecting', label: translate('status.connecting') };
  }
  const liveMeta = resolveLiveHarnessStateMeta(input, translate);
  if (liveMeta) return liveMeta;
  const serverMeta = resolveServerRunStateMeta(input.serverRunState, translate);
  if (serverMeta) return serverMeta;
  if (connection === 'disconnected') {
    return { tone: 'disconnected', label: translate('status.disconnected') };
  }
  const agent = String(input.agent || 'idle');
  if (agent === 'disconnected') {
    return { tone: 'disconnected', label: translate('status.disconnected') };
  }
  return { tone: 'idle', label: translate('status.ready') };
}
