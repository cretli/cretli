/**
 * Harness chat status badge (SDK / OpenCode / OpenRouter).
 * Uses protocol signals only — not PTY buffer heuristics.
 *
 * Priority table applied by `resolveHarnessChatStateMeta` (highest first):
 *   1. pending question / permission          -> awaiting (needs action)
 *   2. server run state waiting / attention   -> awaiting / attention
 *   3. server run state busy                  -> active (tool label when the
 *      server sent an activity key, generic label otherwise)
 *   4. local agent active with a queued count -> active (queue label)
 *   5. local agent active (fallback)          -> active (generic label)
 *   6. connecting / reconnecting              -> connecting (mode bar) or idle
 *      during the sidebar grace window
 *   7. idle / disconnected                    -> ready (idle) or disconnected
 * Work reported by the server always outranks a transient connection state, so a
 * WebSocket reconnect never masks an agent that is still running.
 *
 * `surface: 'sidebar'` is the sidebar-row variant: no `syncing` overlay, a
 * background chat without a socket shows idle instead of disconnected, and
 * `connecting` appears only after `SIDEBAR_CONNECTING_GRACE_MS` of continuous
 * connecting. The active chat mode bar keeps using the default `'bar'` surface.
 */

/** @typedef {{ tone: string, label: string }} ChatStatusMeta */

/** Sidebar rows hide a short-lived `connecting` blink until this grace elapses. */
export const SIDEBAR_CONNECTING_GRACE_MS = 1500;

// English mirrors the default locale; callers that pass a `translate` function
// (the app) never reach these, so they only cover direct/test usage.
const FALLBACK_LABELS = {
  'status.connecting': 'Connecting…',
  'status.disconnected': 'Disconnected',
  'status.agentWorking': 'Agent working',
  'status.agentWorkingQueued': 'Agent working · queue: {count}',
  'status.needsAction': 'Needs action',
  'status.ready': 'Ready',
  'chat.historySyncing': 'Syncing messages…',
  'chat.delegationStatus.completed': 'Completed',
  'chat.delegationStatus.failed': 'Failed',
  'chat.delegationStatus.interrupted': 'Interrupted',
  'chat.delegationWaitingForAgents': 'Waiting for {n} agents',
  'chat.presenceActivity.read': 'Read {arg}',
  'chat.presenceActivity.grep': 'Grep {arg}',
  'chat.presenceActivity.search': 'Search {arg}',
  'chat.presenceActivity.bash': 'Bash',
  'chat.presenceActivity.write': 'Write {arg}',
  'chat.presenceActivity.edit': 'Edit {arg}',
  'chat.presenceActivity.thinking': 'Thinking',
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
/**
 * Protocol busy/queued signals — excludes local `_agentState`, which is itself
 * driven by the idle timer.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function hasProtocolAgentRun(chat) {
  if (!chat) return false;
  if (chat._sdkServerBusy === true) return true;
  if (chat._serverRunState?.state === 'busy') return true;
  if (readQueuedCount(chat._sdkServerQueuedCount) > 0) return true;
  return readQueuedCount(chat._sdkRichView?.queuedCount) > 0;
}

/**
 * Keep the idle timer from flipping to idle while the harness still has work.
 * Must not use `_agentState === 'active'` or the timer never settles.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function hasKeepAliveHarnessWork(chat) {
  if (!chat) return false;
  if (hasProtocolAgentRun(chat)) return true;
  const pending = readHarnessPendingFlags(chat);
  if (pending.hasPendingQuestion || pending.hasPendingPermission) return true;
  return chat._serverRunState?.state === 'waiting';
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
  return hasProtocolAgentRun(chat);
}

/**
 * History replay may omit FINISHED. Close leftover running tiles unless the
 * protocol still reports a live run.
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function shouldCloseLiveTurnAfterHistoryReplay(chat) {
  return !hasProtocolAgentRun(chat);
}

/**
 * History catch-up on the mode bar. Overrides stale generating/connecting.
 *
 * @param {boolean} isInFlight
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} [translate]
 * @returns {ChatStatusMeta | null}
 */
export function overlayHistorySyncingMeta(isInFlight, translate) {
  if (isInFlight !== true) return null;
  const tFn = typeof translate === 'function' ? translate : translateFallback;
  return {
    tone: 'syncing',
    labelKey: 'chat.historySyncing',
    label: tFn('chat.historySyncing'),
  };
}

/**
 * Mode-bar label: history catch-up wins over generating/connecting.
 *
 * @param {boolean} isInFlight
 * @param {ChatStatusMeta | null | undefined} fallbackMeta
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} [translate]
 * @returns {ChatStatusMeta | null}
 */
export function resolveChatStatusWithHistorySync(isInFlight, fallbackMeta, translate) {
  const overlay = overlayHistorySyncingMeta(isInFlight, translate);
  if (overlay) return overlay;
  return fallbackMeta || null;
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
    const waitingCount = Number(serverRunState.waitingAgentCount) || 0;
    if (waitingCount > 0) {
      return { tone: 'awaiting', label: translate('chat.delegationWaitingForAgents', { n: String(waitingCount) }) };
    }
    return { tone: 'awaiting', label: translate('status.needsAction') };
  }
  if (state === 'busy') {
    const activityKey = typeof serverRunState.activityKey === 'string'
      ? serverRunState.activityKey.trim()
      : '';
    if (activityKey) {
      const arg = typeof serverRunState.activityArg === 'string' ? serverRunState.activityArg : '';
      const key = `chat.presenceActivity.${activityKey}`;
      let label = translate(key, { arg });
      if (!arg) label = label.replace(/\s*\{arg\}\s*/g, '').trim();
      return {
        tone: 'active',
        label: label === key ? activityKey : label,
        activityKey,
      };
    }
    return { tone: 'active', label: translate('status.agentWorking') };
  }
  if (state === 'attention') {
    const status = String(serverRunState.delegationStatus || 'completed');
    const key = `chat.delegationStatus.${status}`;
    const label = translate(key);
    return { tone: 'attention', label: label === key ? status : label, status };
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
 * @param {'bar' | 'sidebar'} [input.surface] Sidebar-row variant (default 'bar').
 * @param {number} [input.connectingForMs] Sidebar: continuous connecting time.
 * @param {boolean} [input.socketExpected] Sidebar: false when the background
 *   policy deliberately keeps this chat without a socket, so a missing socket is
 *   normal idle rather than a connection error.
 * @param {(key: string, vars?: Record<string, string|number>|null) => string} [input.translate]
 * @returns {ChatStatusMeta}
 */
export function resolveHarnessChatStateMeta(input = {}) {
  const translate = typeof input.translate === 'function' ? input.translate : translateFallback;
  const surface = input.surface === 'sidebar' ? 'sidebar' : 'bar';
  const connection = String(input.connection || 'disconnected');

  // 1. Pending question / permission outranks every other signal.
  const pending = input.hasPendingQuestion === true || input.hasPendingPermission === true;
  if (pending) {
    return { tone: 'awaiting', label: translate('status.needsAction') };
  }

  // 2./3. Server run state: waiting / attention, then busy (with or without tool label).
  const serverMeta = resolveServerRunStateMeta(input.serverRunState, translate);
  const serverState = String(input.serverRunState?.state || '');
  if (serverMeta && (serverState === 'waiting' || serverState === 'attention')) {
    return serverMeta;
  }
  if (serverMeta) return serverMeta;

  // 4. Local queue count only when the server is not reporting busy work.
  const queuedCount = readQueuedCount(input.queuedCount);
  if (queuedCount > 0 && String(input.agent || 'idle') === 'active') {
    return { tone: 'active', label: translate('status.agentWorkingQueued', { count: queuedCount }) };
  }

  // 5. Local agent run fallback.
  const liveMeta = resolveLiveHarnessStateMeta(input, translate);
  if (liveMeta) return liveMeta;

  // 6. Connection fallback — reached only when no work signal exists.
  if (connection === 'connecting' || connection === 'reconnecting') {
    if (surface === 'sidebar') {
      const connectingForMs = Number(input.connectingForMs) || 0;
      if (connectingForMs < SIDEBAR_CONNECTING_GRACE_MS) {
        return { tone: 'idle', label: translate('status.ready') };
      }
    }
    return { tone: 'connecting', label: translate('status.connecting') };
  }
  if (connection === 'disconnected') {
    if (surface === 'sidebar' && input.socketExpected === false) {
      return { tone: 'idle', label: translate('status.ready') };
    }
    return { tone: 'disconnected', label: translate('status.disconnected') };
  }
  const agent = String(input.agent || 'idle');
  if (agent === 'disconnected') {
    return { tone: 'disconnected', label: translate('status.disconnected') };
  }
  return { tone: 'idle', label: translate('status.ready') };
}
