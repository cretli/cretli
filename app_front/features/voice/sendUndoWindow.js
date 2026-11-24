/**
 * Undo window for a spoken prompt (pure logic, injected clock).
 *
 * In car mode an unrecognized utterance is not sent at once: it waits here for
 * `windowMs`, during which the driver can cancel it or send it early. The module
 * knows nothing about chats, speech or the DOM; the caller supplies `onSend`.
 */

/** Default length of the window; the single place to tune it. */
export const DEFAULT_SEND_UNDO_MS = 5000;

/** A hold (read-back playing) never lasts longer than this, so a missing "speech ended" event cannot freeze the window. */
export const DEFAULT_MAX_HOLD_MS = 15000;

/**
 * Longest a hold may wait for a read-back that is still queued behind a long answer.
 * Once the read-back starts, `hold()` is called again and the limit restarts from that moment.
 */
export const DEFAULT_MAX_QUEUE_HOLD_MS = 60000;

/**
 * @typedef {{
 *   text: string,
 *   chatId: string,
 *   chatTitle: string,
 *   startedAt: number,
 *   deadline: number,
 *   held: boolean,
 *   meta: Record<string, any>,
 * }} PendingSend
 */

/**
 * @template T
 * @param {{
 *   windowMs?: number,
 *   maxHoldMs?: number,
 *   maxQueueHoldMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 *   onSend: (pending: PendingSend) => T | Promise<T>,
 *   onChange?: (pending: PendingSend|null, reason: 'begin'|'merge'|'hold'|'release'|'send'|'cancel'|'replace', previous?: PendingSend|null) => void,
 * }} deps
 */
export function createSendUndoWindow(deps) {
  const windowMs = deps.windowMs ?? DEFAULT_SEND_UNDO_MS;
  const maxHoldMs = deps.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const maxQueueHoldMs = deps.maxQueueHoldMs ?? DEFAULT_MAX_QUEUE_HOLD_MS;
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(/** @type {any} */ (id)));
  const onChange = deps.onChange || (() => {});

  /** @type {PendingSend|null} */
  let pending = null;
  let timerId = null;
  let holdTimerId = null;

  function clear() {
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    if (holdTimerId !== null) clearTimer(holdTimerId);
    holdTimerId = null;
  }

  function arm() {
    clear();
    if (!pending) return;
    pending.startedAt = now();
    pending.deadline = pending.startedAt + windowMs;
    pending.held = false;
    timerId = setTimer(() => {
      timerId = null;
      void api.sendNow();
    }, windowMs);
  }

  const api = {
    windowMs,

    /**
     * Starts a window. Dictation often splits on a pause, so a follow-up for the
     * same chat (and the same steer mode) is appended and the countdown restarts; a different chat replaces
     * the old text (it was meant for another conversation).
     *
     * @param {{ text: string, chatId: string, chatTitle?: string, meta?: Record<string, any> }} input
     * @returns {PendingSend|null}
     */
    begin(input) {
      const text = String(input?.text || '').trim();
      if (!text) return pending;
      const chatId = String(input?.chatId || '');
      let reason = 'begin';
      let previous = null;
      // Only messages of the same delivery mode merge: joining a steer with a queued text (or the reverse)
      // would send both under the first one's mode. A different mode replaces the waiting text, and the
      // 'replaced' event tells the driver loudly that the earlier words were not sent.
      if (pending && pending.chatId === chatId && Boolean(pending.meta.steer) === Boolean(input?.meta?.steer)) {
        pending.text = `${pending.text} ${text}`;
        reason = 'merge';
      } else {
        if (pending) {
          reason = 'replace';
          previous = pending;
        }
        pending = { text, chatId, chatTitle: String(input?.chatTitle || ''), startedAt: 0, deadline: 0, held: false, meta: { ...input?.meta } };
      }
      arm();
      onChange(pending, /** @type {any} */ (reason), previous);
      return pending;
    },

    /**
     * Pauses the countdown, e.g. while the read-back is spoken and the microphone is deaf.
     * Calling it again while held restarts the failsafe, so the limit counts from the latest
     * call (the moment the read-back starts), not from when holding began.
     *
     * @param {{ queued?: boolean }} [options] `queued`: the read-back is only enqueued and may
     *   wait behind a long answer, so the failsafe is the longer queue limit until speech starts
     */
    hold(options = {}) {
      if (!pending) return;
      const wasHeld = pending.held;
      if (holdTimerId !== null) clearTimer(holdTimerId);
      holdTimerId = null;
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      pending.held = true;
      // Failsafe: if the end of the speech is never reported, resume on our own.
      holdTimerId = setTimer(() => {
        holdTimerId = null;
        api.release();
      }, options.queued ? maxQueueHoldMs : maxHoldMs);
      if (!wasHeld) onChange(pending, 'hold');
    },

    /** Resumes after a hold with a fresh full window, so the driver hears the read-back and still has time. */
    release() {
      if (!pending || !pending.held) return;
      arm();
      onChange(pending, 'release');
    },

    /**
     * @returns {PendingSend|null} the dropped send
     */
    cancel() {
      if (!pending) return null;
      const dropped = pending;
      clear();
      pending = null;
      onChange(null, 'cancel');
      return dropped;
    },

    /**
     * Sends right away (the "send" command, the button or the timer).
     * @returns {Promise<T|null>}
     */
    async sendNow() {
      if (!pending) return null;
      const taken = pending;
      clear();
      pending = null;
      onChange(null, 'send');
      return deps.onSend(taken);
    },

    /** @returns {PendingSend|null} */
    getPending() {
      return pending;
    },

    /** @returns {number} ms left, 0 without a window; a held window reports the full length */
    remainingMs() {
      if (!pending) return 0;
      if (pending.held) return windowMs;
      return Math.max(0, pending.deadline - now());
    },
  };
  return api;
}
