/**
 * Browser voice mode: hands-free dictation with the Web Speech API.
 *
 * Works without an OpenAI or Gemini key. Each utterance (speech followed by a
 * pause) is either a local command (`localCommands.js`) or a prompt for the
 * active chat. The microphone is paused while the app reads an answer aloud
 * (`VOICE_SPEAKING_EVENT`), so its own voice is never heard as input.
 *
 * With the car view open a prompt is not sent at once: it is read back and waits in
 * an undo window (`sendUndoWindow.js`) so a stray sentence never reaches an agent.
 */

import { IDLE_STATE, browserVoiceState } from './browserVoiceState.js';
import { VOICE_SPEAKING_EVENT, getChatSpeaker } from './chatSpeaker.js';
import { isVoiceSessionActive, voiceSessionStatus } from './voiceSessionState.js';
import { subscribe } from '../../state/sharedState.js';
import { createBrowserSpeechInput } from './browserSpeechInput.js';
import { FATAL_VOICE_ERRORS } from './voiceDiagnostics.js';
import { hasPendingChoice } from '../car/carChoicePending.js';
import { commandHandlers } from './commandHandlers.js';
import { createLocalExecutors, matchLocalCommand, matchSendWindowCommand, runLocalCommand } from './localCommands.js';
import { getVoiceSendGate, promptExcerpt, resetSharedVoiceSendGate } from './voiceSendGate.js';
import { isCarViewOpen } from '../car/carViewProbe.js';
import { t } from '../../i18n/index.js';
import { getCurrentLang } from '../../i18n/index.js';

/**
 * @param {{
 *   createInput?: typeof createBrowserSpeechInput,
 *   handlers?: typeof commandHandlers,
 *   executors?: Record<string, (args: any) => Promise<object>>,
 *   match?: typeof matchLocalCommand,
 *   eventTarget?: { addEventListener: Function, removeEventListener: Function }|null,
 *   getLang?: () => string,
 *   state?: { get: () => BrowserVoiceState, set: (value: BrowserVoiceState) => void },
 *   isRealtimeActive?: () => boolean,
 *   isSpeaking?: () => boolean,
 *   speak?: (text: string) => Promise<void>|void,
 *   isCarMode?: () => boolean,
 *   readBack?: (text: string, options?: { onStart?: () => void }) => void,
 *   gate?: ReturnType<typeof import('./voiceSendGate.js').createVoiceSendGate>,
 *   speakingClock?: { setTimer?: Function, clearTimer?: Function },
 *   onUtteranceHandled?: (info: { kind: 'prompt'|'command', text: string, result: object }) => void,
 * }} [deps]
 */
export function createBrowserVoiceMode(deps = {}) {
  const createInput = deps.createInput || createBrowserSpeechInput;
  const handlers = deps.handlers || commandHandlers;
  const executors = deps.executors || createLocalExecutors(handlers, { getGate: () => getGate() });
  const match = deps.match || matchLocalCommand;
  const eventTarget = deps.eventTarget === undefined
    ? (typeof window === 'undefined' ? null : window)
    : deps.eventTarget;
  const getLang = deps.getLang || getCurrentLang;
  const state = deps.state || browserVoiceState;
  // Web Speech and a Realtime session must never listen at the same time.
  const isRealtimeActive = deps.isRealtimeActive || isVoiceSessionActive;
  const readSpeakerState = deps.isSpeaking || (() => {
    try {
      return getChatSpeaker().isSpeaking() === true;
    } catch {
      return false;
    }
  });
  let speakingEvent = false;
  const onUtteranceHandled = deps.onUtteranceHandled || (() => {});
  const speakAloud = deps.speak || (async (text) => {
    try {
      const { getChatSpeaker } = await import('./chatSpeaker.js');
      getChatSpeaker().toggleSpeakMarkdown(text, 'car-choice');
    } catch {
      // The notice on screen is the fallback.
    }
  });

  const isCarMode = deps.isCarMode || isCarViewOpen;
  // Tagged and queued after what is playing, so it never cuts off an answer being read.
  const readBack = deps.readBack || ((text, options) => {
    try {
      getChatSpeaker().speakAnnouncement(text, options);
    } catch {
      // The notice on screen is the fallback.
    }
  });

  const getGate = () => deps.gate || getVoiceSendGate();
  const speakingSetTimer = deps.speakingClock?.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const speakingClearTimer = deps.speakingClock?.clearTimer || ((id) => clearTimeout(id));
  /** If the app never reports the end of its speech, the microphone is released after this long. */
  const MAX_SPEAKING_HOLD_MS = 15000;
  let speakingFailsafe = null;
  let unsubscribeGate = null;

  /** Late outcomes of prompts the undo window sends (by timer, button or "send"). */
  function onGateEvent(event) {
    if (event.type === 'delivered' && event.pending.meta.source === 'speech') {
      const { pending, result } = event;
      patch({
        notice: result?.ok === false
          ? { kind: 'failed', text: String(result.error || '') }
          : { kind: 'sent', text: pending.text },
      });
      if (result?.ok === false && result.error) readBack(String(result.error));
      // A steer that went out as a normal message is delivered, but the driver must hear it.
      if (result?.ok !== false && result?.degraded && result.message) {
        patch({ notice: { kind: 'message', text: String(result.message) } });
        readBack(String(result.message));
      }
      onUtteranceHandled({ kind: 'prompt', text: pending.text, result });
    } else if (event.type === 'replaced' && event.pending.meta.source === 'speech') {
      // The new words were meant for another chat: say loudly that the old ones are gone.
      const message = t('car.undo.replaced', { chat: event.previous.chatTitle || t('car.untitled') });
      patch({ notice: { kind: 'failed', text: message } });
      readBack(message);
    }
  }

  /** @type {ReturnType<typeof createBrowserSpeechInput>|null} */
  let input = null;
  let speakingListenerAttached = false;
  let sessionUnsubscribe = null;

  /** @param {Partial<BrowserVoiceState>} patch */
  function patch(next) {
    state.set({ ...state.get(), ...next });
  }

  /** @param {Event} event */
  function onSpeaking(event) {
    const speaking = Boolean(/** @type {CustomEvent} */ (event).detail?.active);
    speakingEvent = speaking;
    if (speakingFailsafe !== null) speakingClearTimer(speakingFailsafe);
    speakingFailsafe = null;
    // The microphone is deaf while the read-back plays: the countdown waits for it too.
    if (speaking) {
      getGate().hold();
      // Without a final "speech ended" event the microphone would stay deaf forever.
      speakingFailsafe = speakingSetTimer(() => {
        speakingFailsafe = null;
        speakingEvent = false;
        input?.resume();
      }, MAX_SPEAKING_HOLD_MS);
    } else {
      getGate().release();
    }
    if (!input) return;
    if (speaking) input.pause();
    else input.resume();
  }

  function attachSpeakingListener() {
    if (speakingListenerAttached || !eventTarget) return;
    eventTarget.addEventListener(VOICE_SPEAKING_EVENT, onSpeaking);
    speakingListenerAttached = true;
  }

  function detachSpeakingListener() {
    if (!speakingListenerAttached || !eventTarget) return;
    eventTarget.removeEventListener(VOICE_SPEAKING_EVENT, onSpeaking);
    speakingListenerAttached = false;
  }

  /** @param {string} text */
  async function handleUtterance(text) {
    if (isRealtimeActive()) {
      // A live Realtime session owns the microphone and the commands; shut this pipeline down.
      api.stop();
      return;
    }
    const carMode = isCarMode();
    // Priority: a waiting prompt (undo / send) > a waiting card pick > every other command.
    const gate = carMode ? getGate() : null;
    if (gate?.getPending()) {
      const windowCommand = matchSendWindowCommand(text);
      if (windowCommand === 'send_now') {
        // The outcome reaches the screen through the gate's "delivered" event.
        await gate.sendNow();
        return;
      }
      if (windowCommand === 'undo_send') {
        gate.undo();
        const message = t('car.undo.cancelled');
        patch({ notice: { kind: 'message', text: message } });
        readBack(message);
        onUtteranceHandled({ kind: 'command', text, result: { ok: true, message } });
        return;
      }
    }
    const command = match(text, { hasPendingChoice: hasPendingChoice(), carMode });
    if (command) {
      const result = await runLocalCommand(command, executors);
      patch({
        notice: result?.ok === false
          ? { kind: 'failed', text: String(result.error || '') }
          : result?.message
            ? { kind: 'message', text: String(result.message) }
            : { kind: 'done', text: command.id },
      });
      if (result?.pending_undo && gate) {
        // A queued / steered message waits in the undo window like a prompt: the read-back opens the countdown.
        if (speakingEvent) gate.hold({ queued: true });
        readBack(String(result.message || ''), { onStart: () => gate.hold() });
      } else if (result?.message && result.ok !== false) {
        // A read-back such as "Choosing: X. Yes?" is only useful if the driver hears it.
        void speakAloud(String(result.message));
      }
      onUtteranceHandled({ kind: 'command', text, result });
      return;
    }
    if (carMode) {
      // The gate remembers the chat and the session generation; a stop() during its lookups cancels the send.
      const result = await gate.submit(text, { source: 'speech' });
      if (result.ok && result.pending_undo) {
        const message = t('car.undo.readback', { chat: result.chat, text: promptExcerpt(text) });
        patch({ notice: { kind: 'message', text: message } });
        // Speech already playing means the read-back queues behind it: keep the window shut until it has been heard.
        if (speakingEvent) gate.hold({ queued: true });
        // The queue reports the real start of this read-back: the hold limit counts from there.
        readBack(message, { onStart: () => gate.hold() });
      } else if (result.code !== 'cancelled') {
        patch({ notice: { kind: 'failed', text: String(result.error || '') } });
        readBack(String(result.error || ''));
      }
      return;
    }
    const result = await handlers.sendPrompt(text);
    patch({
      notice: result?.ok === false
        ? { kind: 'failed', text: String(result.error || '') }
        : { kind: 'sent', text },
    });
    onUtteranceHandled({ kind: 'prompt', text, result });
  }

  const api = {
    /** @returns {{ ok: true } | { ok: false, code: string }} */
    start() {
      if (isRealtimeActive()) return { ok: false, code: 'realtime_active' };
      if (input) input.stop();
      // A new Web Speech session starts without proposals read or confirmations asked in the previous one.
      handlers.resetSession?.();
      speakingEvent = false;
      input = createInput({
        getLang,
        isSpeaking: () => speakingEvent || readSpeakerState(),
        onInterim: (text) => patch({ interim: text }),
        onState: ({ listening, paused }) => patch({ listening, paused, active: listening || paused }),
        onUtterance: (text) => {
          void handleUtterance(text);
        },
        onError: ({ code }) => {
          if (FATAL_VOICE_ERRORS.includes(code)) {
            patch({ error: code, active: false, listening: false, paused: false });
            detachSpeakingListener();
          } else {
            patch({ error: 'error' });
          }
        },
      });
      patch({ ...IDLE_STATE, active: true });
      const result = input.start();
      if (result.ok) {
        attachSpeakingListener();
        unsubscribeGate?.();
        unsubscribeGate = getGate().subscribe(onGateEvent);
        if (!deps.isRealtimeActive && !sessionUnsubscribe) {
          sessionUnsubscribe = subscribe(voiceSessionStatus, () => {
            if (isRealtimeActive()) api.stop();
          });
        }
      }
      else patch({ error: 'unsupported', active: false });
      return result;
    },
    stop() {
      // Ends the session for the gate too: a waiting prompt is dropped, work in flight is invalidated.
      if (deps.gate) deps.gate.reset();
      else resetSharedVoiceSendGate();
      handlers.resetSession?.();
      unsubscribeGate?.();
      unsubscribeGate = null;
      if (speakingFailsafe !== null) speakingClearTimer(speakingFailsafe);
      speakingFailsafe = null;
      detachSpeakingListener();
      sessionUnsubscribe?.();
      sessionUnsubscribe = null;
      input?.stop();
      input = null;
      state.set(IDLE_STATE);
    },
    toggle() {
      if (state.get().active) {
        api.stop();
        return { ok: true, active: false };
      }
      const result = api.start();
      return { ...result, active: result.ok };
    },
    isActive() {
      return state.get().active;
    },
    /** Clears a shown error or notice without touching the microphone. */
    dismiss() {
      patch({ error: '', notice: null });
    },
  };
  return api;
}

let shared = null;

/** @returns {ReturnType<typeof createBrowserVoiceMode>} */
export function getBrowserVoiceMode() {
  if (!shared) shared = createBrowserVoiceMode();
  return shared;
}
