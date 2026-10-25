/**
 * Rate limit and durable audit trail for external MCP clients (`/mcp`).
 *
 * The audit file is append-only JSON Lines under the data dir. A record holds
 * only time, client id, tool name and outcome — never tool arguments, results
 * or the client token.
 */

import fs from 'node:fs';
import { resolveDataPath } from '../runtime-paths.js';

/** Tool calls allowed per external client within one window. */
export const EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW = 60;
export const EXTERNAL_MCP_RATE_WINDOW_MS = 60_000;
export const EXTERNAL_MCP_AUDIT_FILE = 'mcp-external-audit.jsonl';

/** @typedef {'started' | 'ok' | 'error' | 'rejected'} ExternalMcpAuditOutcome */

/**
 * Sliding-window limiter keyed by an arbitrary id. The clock is a parameter of
 * `consume`, so callers and tests can inject time.
 *
 * @param {() => number} getLimit
 * @param {number} windowMs
 */
export function createSlidingWindowLimiter(getLimit, windowMs) {
  /** @type {Map<string, number[]>} key -> timestamps of calls inside the window */
  const times = new Map();
  return {
    /**
     * Records `count` calls when they all fit.
     *
     * @param {string} key
     * @param {number} [count]
     * @param {number} [now]
     * @returns {boolean} false when the limit would be exceeded (nothing recorded)
     */
    consume(key, count = 1, now = Date.now()) {
      const recent = (times.get(key) || []).filter((at) => now - at < windowMs);
      if (recent.length + count > getLimit()) {
        times.set(key, recent);
        return false;
      }
      for (let i = 0; i < count; i += 1) recent.push(now);
      times.set(key, recent);
      return true;
    },
    clear() {
      times.clear();
    },
  };
}

/**
 * Per-window limit: `CRETLI_EXTERNAL_MCP_RATE_LIMIT` (a positive integer) raises or
 * lowers the default for a busy operator client; anything else keeps the default.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveExternalMcpRateLimit(env = process.env) {
  const value = Number(String(env.CRETLI_EXTERNAL_MCP_RATE_LIMIT ?? '').trim());
  return Number.isInteger(value) && value > 0 ? value : EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW;
}

let rateLimit = resolveExternalMcpRateLimit();
const externalLimiter = createSlidingWindowLimiter(() => rateLimit, EXTERNAL_MCP_RATE_WINDOW_MS);

/**
 * Override the per-window limit (tests); pass nothing to restore the default.
 *
 * @param {number} [limit]
 */
export function setExternalMcpRateLimit(limit = resolveExternalMcpRateLimit()) {
  rateLimit = limit;
  externalLimiter.clear();
}

/**
 * Sliding-window check; records `count` calls when they all fit.
 *
 * @param {string} clientId
 * @param {number} [count] tool calls in this HTTP request
 * @param {number} [now]
 * @returns {boolean} false when the limit would be exceeded (nothing recorded)
 */
export function consumeExternalMcpRateLimit(clientId, count = 1, now = Date.now()) {
  return externalLimiter.consume(clientId, count, now);
}

/**
 * @param {{ clientId: string, tool: string, outcome: ExternalMcpAuditOutcome }} entry
 */
function writeAuditRecord({ clientId, tool, outcome }) {
  const record = { at: new Date().toISOString(), clientId, tool, outcome };
  fs.appendFileSync(resolveDataPath(EXTERNAL_MCP_AUDIT_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Append the `started` record that must be durable before a tool runs. Throws
 * when the write fails so the caller can refuse the call (fail-closed).
 *
 * @param {{ clientId: string, tool: string }} entry
 */
export function appendExternalMcpAuditStarted({ clientId, tool }) {
  writeAuditRecord({ clientId, tool, outcome: 'started' });
}

/**
 * Append one audit record after the decision is made (result or rejection).
 * Failures are logged, never thrown: the tool already ran or was refused, and
 * the preceding `started` record is the fail-closed gate.
 *
 * @param {{ clientId: string, tool: string, outcome: ExternalMcpAuditOutcome }} entry
 */
export function appendExternalMcpAudit(entry) {
  try {
    writeAuditRecord(entry);
  } catch (err) {
    console.warn(`[mcp-external] audit write failed: ${err instanceof Error ? err.message : err}`);
  }
}
