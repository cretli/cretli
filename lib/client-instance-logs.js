/**
 * Per-client-instance debug log files on disk.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { normalizeClientInstanceIdForFile } from './client-instance-registry.js';

const MAX_LOG_BYTES = 6 * 1024 * 1024;
const MAX_LINE_CHARS = 2400;
const MAX_LINES_PER_APPEND = 100;

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function getClientInstancesLogDir(dataDir) {
  return path.join(dataDir, 'client-instances');
}

/**
 * @param {string} dataDir
 * @param {string} clientInstanceId
 * @returns {string}
 */
export function getClientInstanceLogPath(dataDir, clientInstanceId) {
  const safeId = normalizeClientInstanceIdForFile(clientInstanceId);
  return path.join(getClientInstancesLogDir(dataDir), `${safeId}.log`);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function prevLogPath(filePath) {
  return `${filePath.replace(/\.log$/, '')}-prev.log`;
}

/**
 * @param {string} dir
 */
function ensureLogDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} filePath
 */
function rotateLogIfNeeded(filePath) {
  if (!existsSync(filePath)) return;
  if (statSync(filePath).size <= MAX_LOG_BYTES) return;
  const prevPath = prevLogPath(filePath);
  try {
    if (existsSync(prevPath)) unlinkSync(prevPath);
  } catch {
    // ignore
  }
  try {
    renameSync(filePath, prevPath);
  } catch {
    // ignore
  }
}

/**
 * @param {string} dataDir
 * @param {string} clientInstanceId
 * @param {string} reason
 * @param {string} ua
 * @param {string[]} lines
 * @returns {number}
 */
export function appendClientInstanceLogFile(dataDir, clientInstanceId, reason, ua, lines) {
  const dir = getClientInstancesLogDir(dataDir);
  ensureLogDir(dir);
  const filePath = getClientInstanceLogPath(dataDir, clientInstanceId);
  rotateLogIfNeeded(filePath);
  const stamp = new Date().toISOString();
  const uaShort = ua ? ua.slice(0, 360).replace(/\s+/g, ' ') : '';
  let block = `\n---------- ${stamp} reason=${String(reason || 'unknown').slice(0, 80)}${uaShort ? ` ua=${uaShort}` : ''} ----------\n`;
  let written = 0;
  for (let i = 0; i < lines.length && written < MAX_LINES_PER_APPEND; i += 1) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    block += `${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}\n`;
    written += 1;
  }
  appendFileSync(filePath, block, 'utf8');
  return written;
}

/**
 * @param {string} dataDir
 * @param {string} clientInstanceId
 * @param {{ since?: number, limit?: number }} [options]
 * @returns {{ lines: string[], totalBytes: number }}
 */
export function readClientInstanceLogTail(dataDir, clientInstanceId, options = {}) {
  const filePath = getClientInstanceLogPath(dataDir, clientInstanceId);
  if (!existsSync(filePath)) return { lines: [], totalBytes: 0 };
  const limit = Number.isFinite(Number(options.limit)) ? Math.min(Math.max(Number(options.limit), 1), 500) : 200;
  const raw = readFileSync(filePath, 'utf8');
  const allLines = raw.split('\n').filter((line) => line.trim());
  return {
    lines: allLines.slice(-limit),
    totalBytes: statSync(filePath).size,
  };
}

/**
 * @param {string} dataDir
 * @param {string} clientInstanceId
 * @returns {boolean}
 */
export function clearClientInstanceLogFile(dataDir, clientInstanceId) {
  const filePath = getClientInstanceLogPath(dataDir, clientInstanceId);
  const prevPath = prevLogPath(filePath);
  let cleared = false;
  if (existsSync(filePath)) {
    writeFileSync(filePath, '', 'utf8');
    cleared = true;
  }
  if (existsSync(prevPath)) {
    try {
      unlinkSync(prevPath);
      cleared = true;
    } catch {
      // ignore
    }
  }
  return cleared;
}

/**
 * @param {string} dataDir
 * @param {string} clientInstanceId
 * @returns {boolean}
 */
export function clientInstanceLogExists(dataDir, clientInstanceId) {
  return existsSync(getClientInstanceLogPath(dataDir, clientInstanceId));
}
