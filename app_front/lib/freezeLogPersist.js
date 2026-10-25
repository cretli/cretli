/**
 * Persists freeze-related log entries across app kills (PWA hard close).
 */

import { isUiFreezeReportTag } from './uiFreezeTrace.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from './storageKeyAlias.js';

export const FREEZE_LOG_BUFFER_LS_KEY = 'cretli-freeze-log-buffer';
export const FREEZE_SESSION_ID_LS_KEY = 'cretli-freeze-session-id';

const MAX_PERSISTED_ENTRIES = 400;

/**
 * @returns {string}
 */
function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @returns {string}
 */
export function getOrCreateFreezeSessionId() {
  if (typeof localStorage === 'undefined') return createSessionId();
  try {
    const existing = readStorageValueWithAlias(localStorage, FREEZE_SESSION_ID_LS_KEY, '');
    if (existing) return existing;
    const next = createSessionId();
    writeStorageValueWithAlias(localStorage, FREEZE_SESSION_ID_LS_KEY, next);
    return next;
  } catch {
    return createSessionId();
  }
}

/**
 * Starts a new freeze log session (call once per page load after recovery).
 * @returns {string}
 */
export function rotateFreezeSessionId() {
  const next = createSessionId();
  if (typeof localStorage === 'undefined') return next;
  try {
    writeStorageValueWithAlias(localStorage, FREEZE_SESSION_ID_LS_KEY, next);
  } catch {
    // ignore
  }
  return next;
}

/**
 * @returns {{ sessionId: string, entries: Array<{ ts: number, timeStr: string, tag: string, text: string }> }}
 */
function readBufferDoc() {
  if (typeof localStorage === 'undefined') {
    return { sessionId: '', entries: [] };
  }
  try {
    const raw = readStorageValueWithAlias(localStorage, FREEZE_LOG_BUFFER_LS_KEY, '');
    if (!raw) return { sessionId: '', entries: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { sessionId: '', entries: [] };
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      sessionId,
      entries: entries.filter(
        (entry) =>
          entry &&
          typeof entry.ts === 'number' &&
          typeof entry.timeStr === 'string' &&
          typeof entry.tag === 'string' &&
          typeof entry.text === 'string'
      ),
    };
  } catch {
    return { sessionId: '', entries: [] };
  }
}

/**
 * @param {{ sessionId: string, entries: Array<{ ts: number, timeStr: string, tag: string, text: string }> }} doc
 */
function writeBufferDoc(doc) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, FREEZE_LOG_BUFFER_LS_KEY, JSON.stringify(doc));
  } catch {
    // ignore quota errors
  }
}

/**
 * @param {{ ts: number, timeStr: string, tag: string, text: string }} entry
 */
export function appendFreezeLogEntry(entry) {
  if (!entry || !isUiFreezeReportTag(entry.tag)) return;
  const sessionId = getOrCreateFreezeSessionId();
  const doc = readBufferDoc();
  if (doc.sessionId !== sessionId) {
    doc.sessionId = sessionId;
    doc.entries = [];
  }
  doc.entries.push(entry);
  if (doc.entries.length > MAX_PERSISTED_ENTRIES) {
    doc.entries = doc.entries.slice(-MAX_PERSISTED_ENTRIES);
  }
  writeBufferDoc(doc);
}

/**
 * Returns entries saved by a previous session (before app kill).
 * @param {string} currentSessionId
 * @returns {Array<{ ts: number, timeStr: string, tag: string, text: string }>}
 */
export function readPreviousSessionFreezeEntries(currentSessionId) {
  const doc = readBufferDoc();
  if (!doc.entries.length) return [];
  if (!doc.sessionId || doc.sessionId === currentSessionId) return [];
  return doc.entries.slice();
}

/**
 * Clears persisted buffer after successful recovery export.
 */
export function clearPersistedFreezeLogs() {
  if (typeof localStorage === 'undefined') return;
  try {
    removeStorageValueWithAlias(localStorage, FREEZE_LOG_BUFFER_LS_KEY);
  } catch {
    // ignore
  }
}
