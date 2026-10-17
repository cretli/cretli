/**
 * Voice live session debug log — local ring buffer + server persistence.
 */

import { appendVoiceSessionEvents } from '../../api.js';
import { appLogger } from '../../logger.js';
import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import {
  clearActiveVoiceSessionId,
  getActiveVoiceSessionId,
  setActiveVoiceSessionId,
} from './voiceSessionContext.js';
import {
  VOICE_RESPONSE_END_EVENT,
  VOICE_RESPONSE_FIRST_AUDIO_EVENT,
  createVoiceResponseTimingTracker,
} from './voiceResponseTiming.js';

export const VOICE_SESSION_HISTORY_LS_KEY = 'cretli-voice-session-history';
const LOCAL_MAX_ENTRIES = 200;
const FLUSH_BATCH_SIZE = 24;

/** Per-response streaming timing for the active session. */
const responseTiming = createVoiceResponseTimingTracker();

/**
 * @returns {string}
 */
function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `vs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @typedef {{
 *   sessionId: string,
 *   startedAt: number,
 *   provider: string,
 *   model: string,
 *   chatId: string,
 *   entries: Array<{ ts: number, event: string, [key: string]: unknown }>,
 *   pendingFlush: Array<{ ts: number, event: string, [key: string]: unknown }>,
 * }} VoiceSessionLogState
 */

/** @type {VoiceSessionLogState|null} */
let activeState = null;

/**
 * @returns {Array<{ sessionId: string, startedAt: number, provider: string, model: string }>}
 */
export function readVoiceSessionHistory() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = readStorageValueWithAlias(localStorage, VOICE_SESSION_HISTORY_LS_KEY, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.sessionId === 'string')
      .slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * @param {{ sessionId: string, startedAt: number, provider?: string, model?: string }} item
 */
function rememberSessionHistory(item) {
  if (typeof localStorage === 'undefined') return;
  const history = readVoiceSessionHistory().filter((entry) => entry.sessionId !== item.sessionId);
  history.unshift({
    sessionId: item.sessionId,
    startedAt: item.startedAt,
    provider: String(item.provider || ''),
    model: String(item.model || ''),
  });
  try {
    writeStorageValueWithAlias(localStorage, VOICE_SESSION_HISTORY_LS_KEY, JSON.stringify(history.slice(0, 30)));
  } catch {
    // Quota errors must not break voice mode.
  }
}

/**
 * @param {string} chatId
 * @param {{ provider?: string, model?: string }} meta
 * @returns {string}
 */
export function startVoiceSessionLog(chatId, meta = {}) {
  const sessionId = createSessionId();
  responseTiming.reset();
  activeState = {
    sessionId,
    startedAt: Date.now(),
    provider: String(meta.provider || ''),
    model: String(meta.model || ''),
    chatId: String(chatId || ''),
    entries: [],
    pendingFlush: [],
  };
  setActiveVoiceSessionId(sessionId);
  rememberSessionHistory({
    sessionId,
    startedAt: activeState.startedAt,
    provider: activeState.provider,
    model: activeState.model,
  });
  appendVoiceSessionEvent('session.start', {
    provider: activeState.provider,
    model: activeState.model,
    chatId: activeState.chatId,
  });
  return sessionId;
}

/**
 * @returns {string}
 */
export function getVoiceSessionLogId() {
  return activeState?.sessionId || getActiveVoiceSessionId();
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
export function appendVoiceSessionEvent(event, detail = {}) {
  const name = String(event || '').trim();
  if (!name) return;
  const entry = {
    ts: Date.now(),
    event: name,
    ...detail,
  };
  if (activeState) {
    activeState.entries.push(entry);
    if (activeState.entries.length > LOCAL_MAX_ENTRIES) {
      activeState.entries = activeState.entries.slice(-LOCAL_MAX_ENTRIES);
    }
    activeState.pendingFlush.push(entry);
    if (activeState.pendingFlush.length >= FLUSH_BATCH_SIZE) {
      void flushVoiceSessionLogNow(false);
    }
  }
  appLogger.log('voice-session', `[${getVoiceSessionLogId() || 'none'}] ${name}`, detail);
}

/**
 * Logs per-response streaming latency (`response.first_audio` / `response.end`).
 *
 * It is a no-op when no session is recording, so provider code may call it
 * unconditionally. Repeated calls for the same response are ignored: the first
 * audio is logged at most once and every response ends at most once.
 *
 * @param {'start'|'first_audio'|'end'} phase
 * @param {{ provider?: string, responseId?: string, userSpeechEndedAt?: number }} [detail]
 * @returns {void}
 */
export function appendVoiceResponseTiming(phase, detail = {}) {
  if (!activeState) return;
  const name = String(phase || '').trim();
  try {
    if (name === 'start') {
      responseTiming.begin(detail);
      return;
    }
    if (name === 'first_audio') {
      const timing = responseTiming.firstAudio(detail);
      if (timing) appendVoiceSessionEvent(VOICE_RESPONSE_FIRST_AUDIO_EVENT, timing);
      return;
    }
    if (name === 'end') {
      const timing = responseTiming.end(detail);
      if (timing) appendVoiceSessionEvent(VOICE_RESPONSE_END_EVENT, timing);
    }
  } catch {
    // A timing measurement must never break a live voice session.
  }
}

/**
 * @param {boolean} ended
 * @returns {Promise<void>}
 */
export async function flushVoiceSessionLogNow(ended = false) {
  if (!activeState) return;
  const batch = activeState.pendingFlush.splice(0, activeState.pendingFlush.length);
  if (batch.length === 0 && !ended) return;
  try {
    await appendVoiceSessionEvents(activeState.sessionId, {
      startedAt: activeState.startedAt,
      endedAt: ended ? Date.now() : null,
      provider: activeState.provider,
      model: activeState.model,
      chatId: activeState.chatId,
      entries: batch,
    });
  } catch (error) {
    activeState.pendingFlush.unshift(...batch);
    appLogger.log('voice-session', 'flush failed', {
      sessionId: activeState.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {{ status?: string, totalUsd?: number }} [detail]
 * @returns {Promise<void>}
 */
export async function finishVoiceSessionLog(detail = {}) {
  if (!activeState) {
    responseTiming.reset();
    clearActiveVoiceSessionId();
    return;
  }
  appendVoiceSessionEvent('session.end', detail);
  await flushVoiceSessionLogNow(true);
  activeState = null;
  responseTiming.reset();
  clearActiveVoiceSessionId();
}

/**
 * @returns {string}
 */
export function exportActiveVoiceSessionLogText() {
  if (!activeState) return '';
  return JSON.stringify(
    {
      sessionId: activeState.sessionId,
      startedAt: activeState.startedAt,
      provider: activeState.provider,
      model: activeState.model,
      chatId: activeState.chatId,
      entries: activeState.entries,
    },
    null,
    2
  );
}

/**
 * Copies the active session id to the clipboard when available.
 *
 * @returns {Promise<boolean>}
 */
export async function copyVoiceSessionIdToClipboard() {
  const sessionId = getVoiceSessionLogId();
  if (!sessionId || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(sessionId);
    return true;
  } catch {
    return false;
  }
}
