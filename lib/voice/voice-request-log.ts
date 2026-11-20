/**
 * Append-only HTTP timings for voice endpoints (token mint, session reads).
 * Lives next to session JSON so a session id can be correlated later.
 */

import fs from 'fs';
import path from 'path';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { getVoiceSessionLogDir } from './voice-session-log.ts';

const REQUEST_LOG_NAME = 'http-requests.ndjson';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_KEEP_LINES = 400;

export function getVoiceRequestLogPath(dataDir: string): string {
  return path.join(getVoiceSessionLogDir(dataDir), REQUEST_LOG_NAME);
}

function normalizeRequestEntry(
  entry: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const route = String(entry.route || '').trim();
  if (!route) return null;
  const ts = Number(entry.ts);
  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    method: String(entry.method || 'POST').trim() || 'POST',
    route,
    status: Number.isFinite(Number(entry.status)) ? Math.round(Number(entry.status)) : 0,
    durationMs: Number.isFinite(Number(entry.durationMs)) ? Math.max(0, Math.round(Number(entry.durationMs))) : 0,
    sessionId: String(entry.sessionId || '').trim(),
    model: String(entry.model || '').trim(),
    error: String(entry.error || '').slice(0, 300),
  };
}

function rotateIfNeeded(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_FILE_BYTES) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  const kept = lines.slice(-MAX_KEEP_LINES);
  fs.writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8');
}

export function appendVoiceRequestLog(
  dataDir: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeRequestEntry(entry);
  if (!normalized) throw new Error('Invalid voice request log entry');
  const dir = ensureWritableDir(getVoiceSessionLogDir(dataDir));
  const filePath = path.join(dir, REQUEST_LOG_NAME);
  rotateIfNeeded(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export function listVoiceRequestLogs(dataDir: string, limit: number = 50): Record<string, unknown>[] {
  const filePath = getVoiceRequestLogPath(dataDir);
  if (!fs.existsSync(filePath)) return [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : 50;
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = raw
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        return normalizeRequestEntry(JSON.parse(trimmed));
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, unknown> => row !== null);
  return rows.slice(-max).reverse();
}
