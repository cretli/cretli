/**
 * Helpers for waiting on OpenCode async prompt completion via SSE events.
 */

import { formatOpenCodeSessionError } from '../agent-harness/opencode-event-normalizer.js';
import { loadSettings } from '../persist/settings.js';

const DEFAULT_PROMPT_TIMEOUT_MS = 600000;
const MIN_PROMPT_TIMEOUT_MS = 60000;
const MAX_PROMPT_TIMEOUT_MS = 7200000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 60000;

/**
 * @returns {number}
 */
export function resolveOpenCodePromptTimeoutMs() {
  const fromEnv = Number.parseInt(String(process.env.OPENCODE_PROMPT_TIMEOUT_MS ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const settings = loadSettings();
  const idleSec = Number.parseInt(String(settings.sdkRunIdleTimeoutSeconds ?? ''), 10);
  if (Number.isFinite(idleSec) && idleSec > 0) {
    return Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(MIN_PROMPT_TIMEOUT_MS, idleSec * 1000));
  }
  return DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * @returns {number}
 */
export function resolveOpenCodeFirstEventTimeoutMs() {
  const fromEnv = Number.parseInt(String(process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(DEFAULT_FIRST_EVENT_TIMEOUT_MS, fromEnv));
  }
  const settings = loadSettings();
  const fromSettingsSec = Number.parseInt(String(settings.sdkRunFirstEventTimeoutSeconds ?? ''), 10);
  if (Number.isFinite(fromSettingsSec) && fromSettingsSec > 0) {
    const fromSettingsMs = fromSettingsSec * 1000;
    return Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(DEFAULT_FIRST_EVENT_TIMEOUT_MS, fromSettingsMs));
  }
  return DEFAULT_FIRST_EVENT_TIMEOUT_MS;
}

/**
 * @param {any} room
 */
export function bumpOpenCodePromptRunActivity(room) {
  room?._promptRunWaiter?.bumpActivity?.();
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {boolean}
 */
export function shouldBumpOpenCodePromptRunActivity(event, context = {}) {
  if (!event || typeof event !== 'object') return false;
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!properties) return false;
  const sessionId = context.opencodeSessionId ? String(context.opencodeSessionId) : '';
  if (!sessionId) return true;
  const eventSessionId = typeof properties.sessionID === 'string'
    ? properties.sessionID
    : typeof properties.sessionId === 'string'
      ? properties.sessionId
      : '';
  if (!eventSessionId) return false;
  return eventSessionId === sessionId;
}

/**
 * @param {any} room
 * @param {number} [timeoutMs]
 * @param {number} [firstEventTimeoutMs]
 * @returns {Promise<{ status: 'completed' | 'error' | 'cancelled', message?: string }>}
 */
export function createOpenCodePromptRunWaiter(
  room,
  timeoutMs = resolveOpenCodePromptTimeoutMs(),
  firstEventTimeoutMs = resolveOpenCodeFirstEventTimeoutMs()
) {
  if (room?._promptRunWaiter?.reject) {
    room._promptRunWaiter.reject(new Error('Prompt superseded'));
  }
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let hasSeenFirstEvent = false;
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : resolveOpenCodePromptTimeoutMs();
    const safeFirstEventTimeoutMs = Number.isFinite(firstEventTimeoutMs) && firstEventTimeoutMs > 0
      ? firstEventTimeoutMs
      : 0;
    /**
     * @param {number} delayMs
     * @param {string} timeoutMessage
     */
    const scheduleTimeout = (delayMs, timeoutMessage) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (room._promptRunWaiter) room._promptRunWaiter = null;
        reject(new Error(timeoutMessage));
      }, delayMs);
    };
    const schedulePromptTimeout = () => {
      scheduleTimeout(safeTimeoutMs, 'OpenCode prompt timed out');
    };
    const scheduleFirstEventTimeout = () => {
      if (safeFirstEventTimeoutMs <= 0) {
        schedulePromptTimeout();
        return;
      }
      scheduleTimeout(safeFirstEventTimeoutMs, 'OpenCode prompt first event timed out');
    };
    room._promptRunWaiter = {
      resolve: (result) => {
        if (timer) clearTimeout(timer);
        room._promptRunWaiter = null;
        resolve(result);
      },
      reject: (err) => {
        if (timer) clearTimeout(timer);
        room._promptRunWaiter = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
      bumpActivity: () => {
        if (!hasSeenFirstEvent) {
          hasSeenFirstEvent = true;
        }
        schedulePromptTimeout();
      },
    };
    scheduleFirstEventTimeout();
  });
}

/**
 * @param {any} room
 * @param {{ status: 'completed' | 'error' | 'cancelled', message?: string }} result
 */
export function notifyOpenCodePromptRunEnd(room, result) {
  const waiter = room?._promptRunWaiter;
  if (!waiter?.resolve) return;
  waiter.resolve(result);
}

/**
 * @param {any} room
 * @param {unknown} err
 */
export function rejectOpenCodePromptRun(room, err) {
  const waiter = room?._promptRunWaiter;
  if (!waiter?.reject) return;
  waiter.reject(err);
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {{ status: 'completed' | 'error', message?: string } | null}
 */
export function resolveOpenCodePromptRunFromEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.type === 'string' ? event.type : '';
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!properties) return null;
  const sessionId = context.opencodeSessionId ? String(context.opencodeSessionId) : '';
  const eventSessionId = typeof properties.sessionID === 'string'
    ? properties.sessionID
    : typeof properties.sessionId === 'string'
      ? properties.sessionId
      : '';
  if (sessionId && eventSessionId && eventSessionId !== sessionId) return null;
  if (type === 'session.error') {
    return {
      status: 'error',
      message: formatOpenCodeSessionError(properties.error),
    };
  }
  if (type === 'session.idle') {
    return { status: 'completed' };
  }
  if (type === 'session.status') {
    const status = properties.status && typeof properties.status === 'object' ? properties.status : null;
    if (status?.type === 'idle') return { status: 'completed' };
  }
  return null;
}
