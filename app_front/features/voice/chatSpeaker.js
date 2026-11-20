/**
 * Reads agent answers aloud.
 *
 * One speaker for the whole app: only the active chat feeds it, so switching
 * chats never turns into two voices talking over each other.
 */

import { getCurrentLang } from '../../i18n/index.js';
import { createSpeechQueue } from './speechQueue.js';
import { findLastVoiceReply } from './voiceReplyMarker.js';
import { firstSentences } from './replyFallback.js';
import { findUnstableTailStart, takeCompleteSentences, toSpeakableText } from './speakableText.js';
import {
  getAzureVoice,
  getBrowserVoiceName,
  getCarMode,
  getOpenAiVoice,
  getReadMode,
  getSpeechRate,
  getTtsEngineId,
} from './voicePrefs.js';

/**
 * Newest `voiceReply` record in the locally stored history of the chat.
 *
 * @param {string} chatId
 * @returns {Promise<{ text: string, turn: string } | null>}
 */
async function loadLastVoiceReplyFromStore(chatId) {
  const { readSdkChatHistoryStateAsync } = await import('../../lib/sdk-chat-history-store.js');
  const state = await readSdkChatHistoryStateAsync(chatId);
  return findLastVoiceReply(state?.events || []);
}

/** Queue tag of car-mode announcements. */
const ANNOUNCEMENT_TAG = 'car-announce';

const SPEECH_LANGS = { en: 'en-US', pl: 'pl-PL' };

/**
 * Each engine names its voices differently, so the queue asks for the one that
 * belongs to the engine currently selected.
 *
 * @returns {string}
 */
function resolveVoiceName() {
  const engineId = getTtsEngineId();
  if (engineId === 'openai') return getOpenAiVoice();
  if (engineId === 'azure') return getAzureVoice(getCurrentLang());
  return getBrowserVoiceName();
}

/** Fired on window so UI controls can show a playing state. */
export const VOICE_SPEAKING_EVENT = 'cr-voice-speaking';

/** Fired on window when an engine fails, so the send bar can say why. */
export const VOICE_ERROR_EVENT = 'cr-voice-error';

/**
 * Fired on window when the "no spoken version" state of a chat changes:
 * `detail: { chatId, turn, missing }`. `missing: false` clears the hint.
 */
export const VOICE_REPLY_MISSING_EVENT = 'cr-voice-reply-missing';

/** @type {ReturnType<typeof createChatSpeaker>|null} */
let sharedSpeaker = null;

function resolveSpeechLang() {
  return SPEECH_LANGS[getCurrentLang()] || SPEECH_LANGS.en;
}

/**
 * @param {{
 *   queue?: { enqueue: (text: string, tag?: string) => void, cancel: () => void, isBusy: () => boolean, cancelTagged?: (tag: string) => void },
 *   isChatActive?: (chatId: string) => boolean,
 *   loadLastVoiceReply?: (chatId: string) => Promise<{ text: string, turn: string } | null>,
 *   isCarMode?: () => boolean,
 * }} [deps]
 *   `queue` replaces the real speech queue and `isChatActive` the active-chat check (tests).
 */
export function createChatSpeaker(deps = {}) {
  /** Latest raw markdown of the answer block currently streaming in. */
  let blockMarkdown = '';
  /** Stable speakable prefix of the block already handed to the queue. */
  let committedText = '';
  /**
   * Set by the first non-append change of the block; a muted block enqueues
   * nothing until it ends. The divergence path is unreachable for append-only
   * accumulators (criterion 5): if it is ever hit, the block goes silent rather
   * than risk replaying speech. Accepted cost: the rest of that block is not spoken.
   */
  let blockMuted = false;
  /** Finalized answer blocks of the same run, used by `final` mode and read-back. */
  let finishedBlocks = '';
  /** Identifies who asked for the current playback, for per-block button state. */
  let activeToken = '';
  /** Last completed answer, kept so the voice agent can read it back on request. */
  let lastAnswerSpeakable = '';
  /** Last completed answer per chat: per-chat UI must never read another chat's answer. @type {Map<string, string>} */
  const lastAnswerByChat = new Map();
  /** Voice mode needs the text even with reading off; parsing every delta is not free. */
  let trackingForced = false;
  /**
   * `agent` read mode state per chat. `issued`: turns whose prompt carried the
   * voice-reply marker and that have not been spoken. `pending`: entries that
   * arrived during the current run (insertion order = arrival order; a repeat
   * entry of a turn replaces the earlier one). `done`: turns already handled.
   * Kept per page load: after a reload old entries are unknown and stay silent.
   * `missingText`: full answer captured when a turn ended without an entry (for the fallback
   * read). `lastReply`: newest entry received for the chat (manual "listen to the short version").
   * @type {Map<string, { issued: Set<string>, pending: Map<string, string>, done: Set<string>, missingShown: Set<string>, missingText: Map<string, string>, lastReply: { text: string, turn: string } | null, running: boolean }>}
   */
  const replyStates = new Map();
  const isChatActive = deps.isChatActive || (() => true);
  const loadStoredVoiceReply = deps.loadLastVoiceReply || loadLastVoiceReplyFromStore;
  const isCarMode = deps.isCarMode || getCarMode;

  /**
   * @param {string} chatId
   * @param {string} turn
   * @param {boolean} missing
   */
  function emitReplyMissing(chatId, turn, missing) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(VOICE_REPLY_MISSING_EVENT, { detail: { chatId, turn, missing } }));
  }

  /** Drops the hint of every turn of the chat that was flagged. */
  function clearMissing(chatId, state) {
    if (state.missingText.size === 0) return;
    for (const turn of state.missingText.keys()) emitReplyMissing(chatId, turn, false);
    state.missingText.clear();
  }

  /** @param {string} chatId */
  function replyState(chatId) {
    let state = replyStates.get(chatId);
    if (!state) {
      state = {
        issued: new Set(), pending: new Map(), done: new Set(), missingShown: new Set(),
        missingText: new Map(), lastReply: null, running: false,
      };
      replyStates.set(chatId, state);
    }
    return state;
  }

  const queue = deps.queue || createSpeechQueue({
    getEngineId: getTtsEngineId,
    getLang: resolveSpeechLang,
    getRate: getSpeechRate,
    getVoiceName: resolveVoiceName,
    onStateChange: (speaking) => {
      const token = activeToken;
      if (!speaking) activeToken = '';
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent(VOICE_SPEAKING_EVENT, { detail: { active: speaking, token } })
      );
    },
    onError: (error, meta) => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent(VOICE_ERROR_EVENT, {
          detail: { message: error.message, engineId: meta?.engineId || '', permanent: meta?.permanent === true },
        })
      );
    },
  });

  function resetAnswerState() {
    blockMarkdown = '';
    committedText = '';
    blockMuted = false;
    finishedBlocks = '';
  }

  /**
   * Speakable text of the part of the block that no later chunk can rewrite.
   * A trailing whitespace of the source is kept as one space so the last
   * sentence boundary of the prefix is still recognised.
   *
   * @returns {{ text: string, pad: number }}
   */
  function stableSpeakable() {
    const end = findUnstableTailStart(blockMarkdown);
    const prefix = blockMarkdown.slice(0, end);
    const text = toSpeakableText(prefix);
    if (text && /\s$/.test(prefix)) return { text: `${text} `, pad: 1 };
    return { text, pad: 0 };
  }

  /**
   * Hands newly completed sentences of the stable prefix to the queue. Only text
   * that continues the committed text is spoken, so nothing is ever replayed.
   */
  function commitStable() {
    const { text, pad } = stableSpeakable();
    if (!text || blockMuted) return;
    const handled = committedText.trimEnd();
    if (!text.startsWith(handled)) {
      blockMuted = true;
      return;
    }
    const rest = text.slice(handled.length);
    const { ready, consumed } = takeCompleteSentences(rest);
    if (!ready) return;
    committedText = text.slice(0, handled.length + Math.min(consumed, rest.length - pad));
    queue.enqueue(ready);
  }

  /** The block is over: whatever is still pending or deferred is owed now. */
  function finalizeBlock() {
    const markdown = blockMarkdown;
    if (!markdown) return;
    const full = toSpeakableText(markdown);
    if (getReadMode() === 'stream' && !blockMuted) {
      const handled = committedText.trimEnd();
      // A forced flush owes everything left, not just the complete sentences.
      // A rewritten block speaks nothing (see blockMuted).
      const ready = full.startsWith(handled) ? full.slice(handled.length).trim() : '';
      if (ready) queue.enqueue(ready);
    }
    if (full) finishedBlocks = finishedBlocks ? `${finishedBlocks}\n${full}` : full;
    blockMarkdown = '';
    committedText = '';
    blockMuted = false;
  }

  /**
   * `agent` mode: the run of `chatId` ended. Speaks the entry of the newest turn
   * whose entry arrived and retires exactly the turns that had an entry; turns
   * still waiting (a queued prompt) stay issued. With no entry at all, the
   * oldest issued turn is reported as having no spoken version.
   *
   * @param {string} chatId
   * @param {string} [runText] speakable answer of this run only (empty for an empty or cancelled run)
   */
  function finishReplyRun(chatId, runText = '') {
    const state = replyStates.get(String(chatId || ''));
    if (!state) return;
    state.running = false;
    if (state.pending.size > 0) {
      const entries = [...state.pending.entries()];
      const latest = entries[entries.length - 1][1];
      for (const [turn] of entries) {
        state.issued.delete(turn);
        state.done.add(turn);
        state.missingShown.delete(turn);
        state.missingText.delete(turn);
      }
      state.pending.clear();
      queue.enqueue(latest);
      return;
    }
    const missing = [...state.issued].find((turn) => !state.missingShown.has(turn));
    if (!missing) return;
    const answer = lastAnswerByChat.get(String(chatId || '')) || '';
    // The driver cannot tap the "read it" hint: car mode reads the opening of this run's answer.
    // An empty run reads nothing: `answer` may still hold the previous run's text.
    if (isCarMode() && isChatActive(String(chatId || ''))) {
      const opening = firstSentences(runText);
      if (opening) queue.enqueue(opening);
    }
    if (typeof window === 'undefined') return;
    state.missingShown.add(missing);
    state.missingText.set(missing, answer);
    emitReplyMissing(String(chatId || ''), missing, true);
  }

  /**
   * Output of a run proves it is running, e.g. a queued prompt that just started.
   *
   * @param {string} chatId
   */
  function noteRunActivity(chatId) {
    const state = replyStates.get(String(chatId || ''));
    if (state && state.issued.size > 0) state.running = true;
  }

  return {
    /**
     * Any live run signal (user echo, thinking, tool call, assistant text): the run of
     * `chatId` is in progress even before the first answer text arrives.
     *
     * @param {string} chatId
     * @returns {void}
     */
    noteRunActivity(chatId) {
      if (getReadMode() === 'agent') noteRunActivity(chatId);
    },

    /**
     * Streaming assistant text of the active chat, as a growing accumulator.
     *
     * @param {string} fullMarkdown
     * @param {string} [chatId] chat the text belongs to (`agent` mode state is per chat)
     * @returns {void}
     */
    handleAssistantText(fullMarkdown, chatId = '') {
      const mode = getReadMode();
      if (mode === 'agent') noteRunActivity(chatId);
      if (mode === 'off' && !trackingForced) return;
      const markdown = String(fullMarkdown || '');
      if (!markdown.trim()) return;
      blockMarkdown = markdown;
      // `agent` mode never speaks the stream; the text is only kept for the
      // "read the full answer" fallback.
      if (mode !== 'stream') return;
      commitStable();
    },

    /** The active answer block ended (thinking, tool call, other event): drain its tail. */
    onAssistantBlockEnd() {
      finalizeBlock();
    },

    /**
     * The run ended: speak whatever is still owed.
     *
     * @param {string} [chatId] chat whose run ended (`agent` mode state is per chat)
     */
    endAnswer(chatId = '') {
      const mode = getReadMode();
      finalizeBlock();
      const fullText = finishedBlocks.trim();
      if (fullText) {
        lastAnswerSpeakable = fullText;
        lastAnswerByChat.set(String(chatId || ''), fullText);
      }
      if (mode === 'final' && fullText) queue.enqueue(fullText);
      resetAnswerState();
      if (mode === 'agent') finishReplyRun(chatId, fullText);
    },

    /**
     * A prompt carrying the voice-reply marker was sent (`agent` mode).
     *
     * @param {string} chatId
     * @param {string} turn
     * @returns {void}
     */
    issueVoiceTurn(chatId, turn) {
      const id = String(turn || '');
      if (!id) return;
      const state = replyState(String(chatId || ''));
      // The next send in a chat retires the hint of the previous turn.
      clearMissing(String(chatId || ''), state);
      state.issued.add(id);
      state.running = true;
    },

    /**
     * A `voiceReply` history record arrived live. Only entries of turns issued
     * by this page are spoken; everything else (hydration, another client, an
     * old page) stays silent.
     *
     * @param {string} chatId
     * @param {{ text?: string, turn?: string }} payload
     * @returns {void}
     */
    handleVoiceReply(chatId, payload) {
      if (getReadMode() !== 'agent') return;
      const id = String(chatId || '');
      if (!isChatActive(id)) return;
      const turn = typeof payload?.turn === 'string' ? payload.turn : '';
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      const state = replyState(id);
      if (text) {
        state.lastReply = { text, turn };
        clearMissing(id, state);
      }
      if (!text || !turn || !state.issued.has(turn) || state.done.has(turn)) return;
      if (state.running) {
        // The later entry of the same turn wins, and arrival order picks the newest turn.
        state.pending.delete(turn);
        state.pending.set(turn, text);
        return;
      }
      state.issued.delete(turn);
      state.done.add(turn);
      state.missingShown.delete(turn);
      queue.enqueue(text);
    },

    /** A new prompt was sent: the previous answer is no longer worth hearing. */
    resetAnswer() {
      queue.cancel();
      resetAnswerState();
    },

    /**
     * Manual read of one answer block. Clicking again while it plays stops it.
     *
     * @param {string} markdown
     * @param {string} [token]
     * @returns {void}
     */
    toggleSpeakMarkdown(markdown, token = '') {
      if (queue.isBusy()) {
        const wasSameSource = !!token && token === activeToken;
        queue.cancel();
        if (wasSameSource) return;
      }
      const text = toSpeakableText(markdown);
      if (!text) return;
      activeToken = token;
      queue.enqueue(text);
    },

    stop() {
      queue.cancel();
    },

    /**
     * Speaks a car-mode announcement after whatever is playing (never cancels it).
     * Tagged, so `cancelAnnouncements` can drop it without touching the user's answer.
     *
     * @param {string} text
     * @param {{ onStart?: () => void }} [options] `onStart` fires when this announcement actually starts playing
     * @returns {void}
     */
    speakAnnouncement(text, options = {}) {
      const spoken = String(text || '').trim();
      if (!spoken) return;
      if (options.onStart) queue.enqueue(spoken, ANNOUNCEMENT_TAG, { onStart: options.onStart });
      else queue.enqueue(spoken, ANNOUNCEMENT_TAG);
    },

    isSpeaking() {
      return queue.isBusy();
    },

    /** Drops queued and current announcements only. */
    cancelAnnouncements() {
      queue.cancelTagged?.(ANNOUNCEMENT_TAG);
    },

    /**
     * Keeps the last answer available while voice mode is live, even with
     * read-aloud switched off.
     *
     * @param {boolean} enabled
     * @returns {void}
     */
    setAnswerTracking(enabled) {
      trackingForced = enabled === true;
    },

    /** @returns {string} speakable text of the last completed answer of any chat (voice agent read-back) */
    getLastAnswerText() {
      return lastAnswerSpeakable;
    },

    /**
     * Reads the last full answer of one chat once; the fallback when a turn has no voice reply.
     * A chat without a completed answer reads nothing.
     *
     * @param {string} [token]
     * @param {string} [chatId]
     * @returns {void}
     */
    speakLastAnswer(token = '', chatId = '') {
      const text = lastAnswerByChat.get(String(chatId || '')) || '';
      if (text) this.toggleSpeakMarkdown(text, token);
    },

    /**
     * Reads the full answer of the turn that ended without a spoken version; the hint
     * click acts on exactly that turn. Falls back to the last answer.
     *
     * @param {string} chatId
     * @param {string} turn
     * @param {string} [token]
     * @returns {void}
     */
    speakMissingTurnAnswer(chatId, turn, token = '') {
      const state = replyStates.get(String(chatId || ''));
      const text = state?.missingText.get(turn) || lastAnswerByChat.get(String(chatId || '')) || '';
      if (state) {
        state.missingText.delete(turn);
        emitReplyMissing(String(chatId || ''), turn, false);
      }
      if (text) this.toggleSpeakMarkdown(text, token);
    },

    /**
     * Manual "listen to the short version": the newest `voiceReply` entry of the chat,
     * from the live in-memory state first, then from the stored history. Without any
     * entry it reads the last full answer instead.
     *
     * @param {string} chatId
     * @param {string} [token]
     * @returns {Promise<'reply'|'answer'|'none'>}
     */
    async speakLastVoiceReply(chatId, token = '') {
      const id = String(chatId || '');
      let entry = replyStates.get(id)?.lastReply || null;
      if (!entry) {
        try {
          entry = await loadStoredVoiceReply(id);
        } catch {
          entry = null;
        }
      }
      if (entry?.text) {
        this.toggleSpeakMarkdown(entry.text, token);
        return 'reply';
      }
      if (lastAnswerByChat.get(id)) {
        this.speakLastAnswer(token, id);
        return 'answer';
      }
      return 'none';
    },
  };
}

/**
 * @returns {ReturnType<typeof createChatSpeaker>}
 */
export function getChatSpeaker() {
  if (!sharedSpeaker) sharedSpeaker = createChatSpeaker();
  return sharedSpeaker;
}

/**
 * Replaces the shared speaker (tests); `null` restores lazy creation.
 *
 * @param {ReturnType<typeof createChatSpeaker>|null} speaker
 * @returns {void}
 */
export function setChatSpeakerForTests(speaker) {
  sharedSpeaker = speaker;
}
