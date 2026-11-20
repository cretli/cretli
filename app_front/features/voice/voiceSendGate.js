/**
 * The one door for a spoken prompt while the car view is open.
 *
 * Web Speech (`browserVoiceMode.js`) and Realtime (`realtimeTools.js`) both call
 * `submit`, so the undo window, the chat check and the session generation cannot
 * differ between them. Outside the car view `submit` is a plain
 * `handlers.sendPrompt`. Delivery outcomes and replaced prompts are published to
 * subscribers, because the timer (not the caller) is what finally sends.
 */

import { t } from '../../i18n/index.js';
import { isCarViewOpen } from '../car/carViewProbe.js';
import { commandHandlers } from './commandHandlers.js';
import { pendingVoiceSend, voiceSendOutcome } from './browserVoiceState.js';
import { createSendUndoWindow } from './sendUndoWindow.js';

/** First ~8 words, so a read-back stays short enough to hear before the window closes. */
export function promptExcerpt(text) {
  const words = String(text).trim().split(/\s+/);
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : words.join(' ');
}

/**
 * @param {{
 *   handlers?: typeof commandHandlers,
 *   isCarMode?: () => boolean,
 *   windowMs?: number,
 *   maxHoldMs?: number,
 *   maxQueueHoldMs?: number,
 *   clock?: { now?: () => number, setTimer?: Function, clearTimer?: Function },
 *   onPending?: (pending: import('./sendUndoWindow.js').PendingSend|null) => void,
 * }} [deps]
 */
export function createVoiceSendGate(deps = {}) {
  const handlers = deps.handlers || commandHandlers;
  const isCarMode = deps.isCarMode || isCarViewOpen;
  const onPending = deps.onPending || (() => {});
  /** Bumped whenever the session ends (mic off, view closed): older work must not send. */
  let generation = 0;
  /** @type {Set<(event: any) => void>} */
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not block delivery.
      }
    }
  };

  /** @param {import('./sendUndoWindow.js').PendingSend} pending */
  async function deliver(pending) {
    const current = () => pending.meta.generation === generation;
    if (!current()) return { ok: false, code: 'cancelled', error: t('car.undo.cancelled') };
    const result = await handlers.sendPrompt(pending.text, {
      expectChatId: pending.chatId,
      isCurrent: current,
      ...(pending.meta.steer === true ? { steer: true } : {}),
    });
    emit({ type: 'delivered', pending, result });
    return result;
  }

  /**
   * True from a Realtime submit until the model's spoken read-back begins: the response that
   * issued the tool call ends in between and must not release the window.
   */
  let readBackExpected = false;

  const undoWindow = createSendUndoWindow({
    windowMs: deps.windowMs,
    maxHoldMs: deps.maxHoldMs,
    maxQueueHoldMs: deps.maxQueueHoldMs,
    ...deps.clock,
    onSend: deliver,
    onChange: (pending, reason, previous) => {
      onPending(pending ? { ...pending } : null);
      if (reason === 'replace' && previous) emit({ type: 'replaced', previous, pending });
    },
  });

  return {
    windowMs: undoWindow.windowMs,

    /** @returns {boolean} whether prompts currently go through the undo window */
    isActive: () => isCarMode(),

    /**
     * @param {string} text
     * @param {{ source?: 'speech'|'realtime', steer?: boolean }} [options] `steer`: inject into the running turn
     *   (the send bar's Steer action) instead of queueing behind it
     * @returns {Promise<object>} car mode: `pending_undo` (nothing sent yet); otherwise the send result
     */
    async submit(text, options = {}) {
      if (!isCarMode()) return options.steer === true ? handlers.sendPrompt(text, { steer: true }) : handlers.sendPrompt(text);
      const started = generation;
      const chat = await handlers.getActiveChat?.();
      // The session may have ended while the chat was looked up: begin() would resurrect a send.
      if (started !== generation || !isCarMode()) {
        return { ok: false, code: 'cancelled', error: t('car.undo.cancelled') };
      }
      if (!chat) return { ok: false, code: 'no_chat', error: t('car.err.no_chat_open') };
      const chatTitle = chat.title || t('car.untitled');
      const source = options.source || 'speech';
      undoWindow.begin({ text, chatId: chat.id, chatTitle, meta: { source, generation: started, ...(options.steer === true ? { steer: true } : {}) } });
      if (source === 'realtime') {
        // The model is about to say "I will send to X in 5 s": the countdown starts after it has said it.
        readBackExpected = true;
        undoWindow.hold();
      }
      const seconds = Math.round(undoWindow.windowMs / 1000);
      return {
        ok: true,
        pending_undo: true,
        chat: chatTitle,
        window_seconds: seconds,
        text: promptExcerpt(text),
        message: t('car.undo.pendingForModel', { chat: chatTitle, seconds }),
      };
    },

    /** @returns {boolean} whether a waiting prompt was dropped */
    undo: () => undoWindow.cancel() !== null,
    /** @returns {Promise<object|null>} the send result, null when nothing waited */
    sendNow: () => undoWindow.sendNow(),
    getPending: () => undoWindow.getPending(),
    hold: (options) => undoWindow.hold(options),
    release: () => undoWindow.release(),

    /**
     * Realtime model audio edge. Active: hold the window while the model speaks. Inactive: the
     * model stopped, so the driver gets a fresh full window (ignored until the read-back began).
     *
     * @param {boolean} active
     */
    noteModelSpeech(active) {
      const pending = undoWindow.getPending();
      if (!pending || pending.meta.source !== 'realtime') return;
      if (active) {
        readBackExpected = false;
        undoWindow.hold();
      } else if (!readBackExpected) {
        undoWindow.release();
      }
    },

    /** Ends the session: drops the waiting prompt and invalidates sends already in flight. */
    reset() {
      generation += 1;
      readBackExpected = false;
      undoWindow.cancel();
    },

    /** @param {(event: any) => void} listener @returns {() => void} unsubscribe */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** @type {ReturnType<typeof createVoiceSendGate>|null} */
let shared = null;

/** @returns {ReturnType<typeof createVoiceSendGate>} */
export function getVoiceSendGate() {
  if (!shared) {
    shared = createVoiceSendGate({
      onPending: (pending) => {
        pendingVoiceSend.set(pending);
        if (pending) voiceSendOutcome.set(null);
      },
    });
    // Realtime has no listening bar to report to: late outcomes of its prompts go to the car view.
    shared.subscribe((event) => {
      if (event.type === 'delivered' && event.pending.meta.source === 'realtime') {
        voiceSendOutcome.set(event.result?.ok === false
          ? { kind: 'error', text: String(event.result.error || t('car.err.generic')) }
          // A steer that became a normal message is still delivered, but the driver is told.
          : event.result?.degraded ? { kind: 'error', text: String(event.result.message || '') } : null);
      } else if (event.type === 'replaced' && event.pending.meta.source === 'realtime') {
        voiceSendOutcome.set({ kind: 'error', text: t('car.undo.replaced', { chat: event.previous.chatTitle }) });
      }
    });
  }
  return shared;
}

/** Ends the shared session if one exists (never creates it). */
export function resetSharedVoiceSendGate() {
  shared?.reset();
}
