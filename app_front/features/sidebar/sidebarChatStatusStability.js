/**
 * Sidebar row status stability layer.
 *
 * Sits above `resolveHarnessChatStateMeta`: the resolver stays pure and maps the
 * current signals to a tone, while this layer owns the per-chat timers that stop
 * the row from blinking when the three signal sources tick at different rates:
 *   - leaving "working" is delayed (exit hysteresis) until both the server and
 *     the local agent agree, or a short threshold elapses. Entering "working" or
 *     "needs action" is immediate.
 *   - a tool label is shown for a minimum time, so a burst of tools does not
 *     flicker through labels.
 *   - a busy server without an activity key keeps the previous tool label for
 *     the same threshold instead of snapping back to the generic label.
 *
 * Every timer only asks the caller to re-evaluate (`onExpire`); nothing here
 * touches CSS or the DOM.
 */

import { SIDEBAR_CONNECTING_GRACE_MS } from '../chat/chatStatusMeta.js';

export const SIDEBAR_STATUS_EXIT_HYSTERESIS_MS = 500;
export const SIDEBAR_ACTIVITY_LABEL_MIN_MS = 500;

/** Tones that count as "the agent is working" for the exit hysteresis. */
const WORK_TONES = new Set([
  'active',
  'running',
  'generating',
  'reading',
  'grepping',
  'editing',
  'thinking',
]);

/**
 * Tones that must appear immediately, even while leaving "working": waiting for
 * the user is more important than a smooth transition.
 */
const ACTION_TONES = new Set([
  'awaiting',
  'attention',
  'approval',
  'question',
  'textarea',
  'choice',
]);

/**
 * @param {object|null|undefined} meta
 * @returns {{ tone: string, label: string, activityKey: string, status: string }}
 */
function normalizeMeta(meta) {
  return {
    tone: typeof meta?.tone === 'string' ? meta.tone : 'idle',
    label: typeof meta?.label === 'string' ? meta.label : '',
    activityKey: typeof meta?.activityKey === 'string' ? meta.activityKey : '',
    status: typeof meta?.status === 'string' ? meta.status : '',
  };
}

/**
 * @param {{
 *   now?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (id: unknown) => void,
 *   onExpire?: (chatId: string) => void,
 *   exitHysteresisMs?: number,
 *   activityLabelMinMs?: number,
 * }} [options]
 */
export function createSidebarStatusStabilizer(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (id) => clearTimeout(id);
  const onExpire = typeof options.onExpire === 'function' ? options.onExpire : () => {};
  const exitMs = Number.isFinite(options.exitHysteresisMs)
    ? options.exitHysteresisMs
    : SIDEBAR_STATUS_EXIT_HYSTERESIS_MS;
  const labelMs = Number.isFinite(options.activityLabelMinMs)
    ? options.activityLabelMinMs
    : SIDEBAR_ACTIVITY_LABEL_MIN_MS;

  /** @type {Map<string, object>} */
  const states = new Map();

  function ensure(chatId) {
    let state = states.get(chatId);
    if (!state) {
      state = {
        tone: '',
        meta: normalizeMeta(null),
        labelSince: 0,
        activityKeyLostSince: 0,
        exitSince: 0,
        connectingSince: 0,
        timer: null,
        connectingTimer: null,
      };
      states.set(chatId, state);
    }
    return state;
  }

  function cancelTimer(state) {
    if (state?.timer != null) {
      clearTimer(state.timer);
      state.timer = null;
    }
  }

  function cancelConnectingTimer(state) {
    if (state?.connectingTimer != null) {
      clearTimer(state.connectingTimer);
      state.connectingTimer = null;
    }
  }

  function schedule(chatId, state, delayMs) {
    cancelTimer(state);
    state.timer = setTimer(() => {
      state.timer = null;
      onExpire(chatId);
    }, Math.max(0, delayMs));
  }

  return {
    exitHysteresisMs: exitMs,
    activityLabelMinMs: labelMs,

    /**
     * Milliseconds the chat has been continuously connecting/reconnecting.
     * Resets as soon as the connection leaves that state.
     *
     * @param {string} chatId
     * @param {string} connection
     * @returns {number}
     */
    connectingForMs(chatId, connection) {
      const state = ensure(chatId);
      const nowValue = clock();
      if (connection !== 'connecting' && connection !== 'reconnecting') {
        state.connectingSince = 0;
        cancelConnectingTimer(state);
        return 0;
      }
      if (!state.connectingSince) state.connectingSince = nowValue;
      const elapsed = Math.max(0, nowValue - state.connectingSince);
      // Wake the row again when the grace window ends, so it can finally show
      // `connecting` even if no socket event arrives in the meantime. This timer
      // is separate from the hold timer: accepting an idle meta must not cancel it.
      if (elapsed < SIDEBAR_CONNECTING_GRACE_MS && state.connectingTimer == null) {
        state.connectingTimer = setTimer(() => {
          state.connectingTimer = null;
          onExpire(chatId);
        }, SIDEBAR_CONNECTING_GRACE_MS - elapsed);
      }
      return elapsed;
    },

    /**
     * @param {string} chatId
     * @param {object} rawMeta resolver output
     * @param {{ serverBusy?: boolean, serverKnown?: boolean, localActive?: boolean }} [sources]
     * @returns {object} the meta the row should keep showing right now
     */
    stabilize(chatId, rawMeta, sources = {}) {
      const state = ensure(chatId);
      const nowValue = clock();
      const raw = normalizeMeta(rawMeta);
      const serverBusy = sources.serverBusy === true;
      const localActive = sources.localActive === true;
      const serverKnown = sources.serverKnown === true;

      // Exit hysteresis: never drop straight out of "working" while a source
      // still reports work. Both sources agreeing, or the threshold passing,
      // releases the hold. Needs-action targets are always immediate.
      const targetLeavesWork = !WORK_TONES.has(raw.tone) && !ACTION_TONES.has(raw.tone);
      if (WORK_TONES.has(state.tone) && targetLeavesWork) {
        const bothAgreeIdle = serverKnown && !serverBusy && !localActive;
        if (!bothAgreeIdle) {
          if (!state.exitSince) state.exitSince = nowValue;
          if (nowValue - state.exitSince < exitMs) {
            schedule(chatId, state, exitMs - (nowValue - state.exitSince));
            return state.meta;
          }
        }
      }
      state.exitSince = 0;

      // Label stability while staying in "working".
      if (raw.tone === 'active' && state.tone === 'active') {
        const unchanged =
          raw.label === state.meta.label && raw.activityKey === state.meta.activityKey;
        if (unchanged) return state.meta;
        const labelElapsed = nowValue - state.labelSince;
        const rawHasActivity = raw.activityKey !== '';
        const shownHasActivity = state.meta.activityKey !== '';
        if (rawHasActivity) {
          state.activityKeyLostSince = 0;
          if (labelElapsed < labelMs) {
            schedule(chatId, state, labelMs - labelElapsed);
            return state.meta;
          }
        } else if (shownHasActivity) {
          // Server busy without an activity key: hold from when the key dropped, not
          // from when the label was first shown (which may already exceed labelMs).
          if (!state.activityKeyLostSince) state.activityKeyLostSince = nowValue;
          const lostElapsed = nowValue - state.activityKeyLostSince;
          if (lostElapsed < labelMs) {
            schedule(chatId, state, labelMs - lostElapsed);
            return state.meta;
          }
        }
      }

      cancelTimer(state);
      state.tone = raw.tone;
      state.meta = raw;
      state.labelSince = nowValue;
      if (raw.activityKey !== '') state.activityKeyLostSince = 0;
      else if (raw.tone !== 'active') state.activityKeyLostSince = 0;
      return raw;
    },

    /** @param {string} chatId */
    reset(chatId) {
      const state = states.get(chatId);
      if (!state) return;
      cancelTimer(state);
      cancelConnectingTimer(state);
      states.delete(chatId);
    },

    clear() {
      for (const state of states.values()) {
        cancelTimer(state);
        cancelConnectingTimer(state);
      }
      states.clear();
    },
  };
}
