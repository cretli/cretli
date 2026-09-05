/**
 * Persists voice live session debug logs under data/voice-sessions/.
 */

import fs from 'fs';
import path from 'path';
import { ensureWritableDir } from '../ensure-writable-dir.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 600;
const MAX_SESSION_FILE_BYTES = 768 * 1024;

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function getVoiceSessionLogDir(dataDir) {
  const base = String(dataDir || '').trim() || path.join(process.cwd(), 'data');
  return path.join(base, 'voice-sessions');
}

/**
 * @param {unknown} sessionId
 * @returns {string}
 */
export function normalizeVoiceSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error('Invalid voice session id');
  }
  return value.toLowerCase();
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
function ensureVoiceSessionLogDir(dataDir) {
  return ensureWritableDir(getVoiceSessionLogDir(dataDir));
}

/**
 * @param {string} dataDir
 * @param {string} sessionId
 * @returns {string}
 */
function sessionFilePath(dataDir, sessionId) {
  return path.join(ensureVoiceSessionLogDir(dataDir), `${normalizeVoiceSessionId(sessionId)}.json`);
}

/**
 * @param {string} filePath
 * @returns {{ sessionId: string, startedAt: number, endedAt: number|null, provider: string, model: string, chatId: string, entries: object[] }}
 */
function readSessionDoc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid voice session log document');
  }
  return {
    sessionId: String(parsed.sessionId || ''),
    startedAt: Number(parsed.startedAt) || Date.now(),
    endedAt: parsed.endedAt == null ? null : Number(parsed.endedAt) || null,
    provider: String(parsed.provider || ''),
    model: String(parsed.model || ''),
    chatId: String(parsed.chatId || ''),
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

/**
 * @param {string} filePath
 * @param {ReturnType<typeof readSessionDoc>} doc
 */
function writeSessionDoc(filePath, doc) {
  const payload = JSON.stringify(doc);
  if (payload.length > MAX_SESSION_FILE_BYTES) {
    throw new Error('Voice session log is too large');
  }
  fs.writeFileSync(filePath, payload, 'utf8');
}

/**
 * @param {unknown} entry
 * @returns {object|null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ts = Number(entry.ts);
  const event = String(entry.event || entry.kind || '').trim();
  if (!event) return null;
  const normalized = {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    event,
  };
  if (entry.role != null) normalized.role = String(entry.role);
  if (entry.text != null) normalized.text = String(entry.text).slice(0, 4000);
  if (entry.name != null) normalized.name = String(entry.name);
  if (entry.detail != null) normalized.detail = String(entry.detail).slice(0, 2000);
  if (entry.ok === true || entry.ok === false) normalized.ok = entry.ok;
  if (entry.error != null) normalized.error = String(entry.error).slice(0, 500);
  if (Number.isFinite(Number(entry.durationMs))) {
    normalized.durationMs = Math.max(0, Math.round(Number(entry.durationMs)));
  }
  if (Number.isFinite(Number(entry.resultBytes))) {
    normalized.resultBytes = Math.max(0, Math.round(Number(entry.resultBytes)));
  }
  if (Number.isFinite(Number(entry.modelCount))) {
    normalized.modelCount = Math.max(0, Math.round(Number(entry.modelCount)));
  }
  if (entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)) {
    normalized.args = summarizeLogArgs(entry.args);
  }
  if (entry.meta && typeof entry.meta === 'object') {
    normalized.meta = entry.meta;
  }
  return normalized;
}

/**
 * @param {object} args
 * @returns {object}
 */
function summarizeLogArgs(args) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (Object.keys(out).length >= 12) break;
    if (typeof value === 'string') {
      out[key] = value.slice(0, 200);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      out[key] = value;
      continue;
    }
    out[key] = Array.isArray(value) ? `array:${value.length}` : 'object';
  }
  return out;
}

/**
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {{
 *   startedAt?: number,
 *   endedAt?: number|null,
 *   provider?: string,
 *   model?: string,
 *   chatId?: string,
 *   entries?: unknown[],
 * }} patch
 * @returns {{ sessionId: string, entryCount: number }}
 */
export function upsertVoiceSessionLog(dataDir, sessionId, patch = {}) {
  const id = normalizeVoiceSessionId(sessionId);
  const filePath = sessionFilePath(dataDir, id);
  let doc = {
    sessionId: id,
    startedAt: Date.now(),
    endedAt: null,
    provider: '',
    model: '',
    chatId: '',
    entries: [],
  };
  if (fs.existsSync(filePath)) {
    doc = readSessionDoc(filePath);
  }
  if (Number.isFinite(Number(patch.startedAt))) doc.startedAt = Number(patch.startedAt);
  if (patch.endedAt === null) doc.endedAt = null;
  if (Number.isFinite(Number(patch.endedAt))) doc.endedAt = Number(patch.endedAt);
  if (typeof patch.provider === 'string') doc.provider = patch.provider.trim();
  if (typeof patch.model === 'string') doc.model = patch.model.trim();
  if (typeof patch.chatId === 'string') doc.chatId = patch.chatId.trim();
  const incoming = Array.isArray(patch.entries) ? patch.entries.map(normalizeEntry).filter(Boolean) : [];
  if (incoming.length > 0) {
    doc.entries = [...doc.entries, ...incoming].slice(-MAX_ENTRIES);
  }
  writeSessionDoc(filePath, doc);
  return { sessionId: id, entryCount: doc.entries.length };
}

/**
 * @param {string} dataDir
 * @param {string} sessionId
 * @returns {ReturnType<typeof readSessionDoc>|null}
 */
export function readVoiceSessionLog(dataDir, sessionId) {
  const filePath = sessionFilePath(dataDir, sessionId);
  if (!fs.existsSync(filePath)) return null;
  return readSessionDoc(filePath);
}

/**
 * @param {string} dataDir
 * @param {number} [limit]
 * @returns {Array<{ sessionId: string, startedAt: number, endedAt: number|null, provider: string, model: string, chatId: string, entryCount: number }>}
 */
export function listVoiceSessionLogs(dataDir, limit = 20) {
  const dir = ensureVoiceSessionLogDir(dataDir);
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.floor(limit)) : 20;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        const doc = readSessionDoc(path.join(dir, name));
        return {
          sessionId: doc.sessionId,
          startedAt: doc.startedAt,
          endedAt: doc.endedAt,
          provider: doc.provider,
          model: doc.model,
          chatId: doc.chatId,
          entryCount: doc.entries.length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);
  return files.slice(0, max);
}
