/**
 * Durable access log of tool calls made to external MCP servers (from chats, harnesses
 * and the managed bridge): which server and tool, from which chat and harness, the
 * outcome and the duration. Like the external-client audit it never stores tool
 * arguments, results or secrets.
 *
 * JSON Lines under the data dir, rotated by size so the file cannot grow unbounded.
 * Writing never blocks or fails a tool call.
 */

import fs from 'node:fs';
import { resolveDataPath } from '../runtime-paths.js';
import { listAllMcpSecretValues } from './mcp-secrets.js';

export const MCP_ACCESS_LOG_FILE = 'mcp-access.jsonl';
/** Rotate to `<file>.1` (one generation kept) once the file passes this size. */
export const MCP_ACCESS_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** @typedef {'ok' | 'error' | 'denied' | 'unavailable'} McpAccessOutcome */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

/** Error text from a server can echo a credential; stored secret values are masked. */
function scrub(text) {
  let out = text;
  for (const secret of listAllMcpSecretValues()) out = out.split(secret).join('***');
  return out;
}

function logPath() {
  return resolveDataPath(MCP_ACCESS_LOG_FILE);
}

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size < MCP_ACCESS_LOG_MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Missing file: nothing to rotate.
  }
}

/**
 * @param {{
 *   serverId: string,
 *   serverName?: string,
 *   tool: string,
 *   outcome: McpAccessOutcome,
 *   chatId?: string,
 *   harness?: string,
 *   mode?: string,
 *   durationMs?: number,
 *   reason?: string,
 * }} entry
 */
export function appendMcpAccess(entry) {
  try {
    const file = logPath();
    rotateIfNeeded(file);
    const record = {
      at: new Date().toISOString(),
      serverId: clip(entry.serverId, 80),
      server: clip(entry.serverName, 120),
      tool: clip(entry.tool, 200),
      outcome: entry.outcome,
      chatId: clip(entry.chatId, 80),
      harness: clip(entry.harness, 40),
      mode: clip(entry.mode, 20),
      ms: Number.isFinite(entry.durationMs) ? Math.round(/** @type {number} */ (entry.durationMs)) : undefined,
      reason: entry.reason ? scrub(clip(entry.reason, 300)) : undefined,
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[mcp-access] log write failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Newest records first, optionally for one server.
 *
 * @param {{ serverId?: string, limit?: number }} [options]
 * @returns {Record<string, any>[]}
 */
export function readMcpAccessLog(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
  const wanted = String(options.serverId || '');
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const file of [logPath(), `${logPath()}.1`]) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      if (!lines[i]) continue;
      try {
        const row = JSON.parse(lines[i]);
        if (!wanted || row.serverId === wanted) out.push(row);
      } catch {
        // A torn last line from a crash is skipped.
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
