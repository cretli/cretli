/**
 * Persists voice live session debug logs under data/voice-sessions/.
 */

import fs from 'fs';
import path from 'path';
import { ensureWritableDir } from '../ensure-writable-dir.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 600;
const MAX_SESSION_FILE_BYTES = 768 * 1024;

export interface VoiceSessionDoc {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  provider: string;
  model: string;
  chatId: string;
  entries: Record<string, unknown>[];
}

export function getVoiceSessionLogDir(dataDir: string): string {
  const base = String(dataDir || '').trim() || path.join(process.cwd(), 'data');
  return path.join(base, 'voice-sessions');
}

export function normalizeVoiceSessionId(sessionId: unknown): string {
  const value = String(sessionId || '').trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error('Invalid voice session id');
  }
  return value.toLowerCase();
}

function ensureVoiceSessionLogDir(dataDir: string): string {
  return ensureWritableDir(getVoiceSessionLogDir(dataDir));
}

function sessionFilePath(dataDir: string, sessionId: string): string {
  return path.join(ensureVoiceSessionLogDir(dataDir), `${normalizeVoiceSessionId(sessionId)}.json`);
}

function readSessionDoc(filePath: string): VoiceSessionDoc {
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

function writeSessionDoc(filePath: string, doc: VoiceSessionDoc): void {
  const payload = JSON.stringify(doc);
  if (payload.length > MAX_SESSION_FILE_BYTES) {
    throw new Error('Voice session log is too large');
  }
  fs.writeFileSync(filePath, payload, 'utf8');
}

function normalizeEntry(entry: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const ts = Number(entry.ts);
  const event = String(entry.event || entry.kind || '').trim();
  if (!event) return null;
  const normalized: Record<string, unknown> = {
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
    normalized.args = summarizeLogArgs(entry.args as Record<string, unknown>);
  }
  if (entry.meta && typeof entry.meta === 'object') {
    normalized.meta = entry.meta;
  }
  return normalized;
}

function summarizeLogArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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

export function upsertVoiceSessionLog(
  dataDir: string,
  sessionId: string,
  patch: {
    startedAt?: number;
    endedAt?: number | null;
    provider?: string;
    model?: string;
    chatId?: string;
    entries?: unknown[];
  } = {},
): { sessionId: string; entryCount: number } {
  const id = normalizeVoiceSessionId(sessionId);
  const filePath = sessionFilePath(dataDir, id);
  let doc: VoiceSessionDoc = {
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
  const incoming = Array.isArray(patch.entries) ? patch.entries
        .map((entry) => normalizeEntry(entry as Record<string, unknown> | null | undefined))
        .filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  if (incoming.length > 0) {
    doc.entries = [...doc.entries, ...incoming].slice(-MAX_ENTRIES);
  }
  writeSessionDoc(filePath, doc);
  return { sessionId: id, entryCount: doc.entries.length };
}

export function readVoiceSessionLog(dataDir: string, sessionId: string): VoiceSessionDoc | null {
  const filePath = sessionFilePath(dataDir, sessionId);
  if (!fs.existsSync(filePath)) return null;
  return readSessionDoc(filePath);
}

export function listVoiceSessionLogs(
  dataDir: string,
  limit: number = 20,
): Array<{
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  provider: string;
  model: string;
  chatId: string;
  entryCount: number;
}> {
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
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
  return files.slice(0, max);
}
