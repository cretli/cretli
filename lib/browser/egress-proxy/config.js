/**
 * Egress proxy configuration from environment variables.
 * Invalid values fail closed (throws) so the operator entry point can exit non-zero.
 */

import path from 'node:path';

const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_PORT = 3129;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * @typedef {Object} EgressProxyConfig
 * @property {string} bind
 * @property {number} port
 * @property {string} dataDir
 * @property {string} policyFile
 * @property {number[]} blockedPorts
 * @property {string[]} selfOrigins
 * @property {string} probePath
 * @property {number} connectTimeoutMs
 * @property {number} idleTimeoutMs
 * @property {number} maxHeaderBytes
 */

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function parsePort(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} bounds
 * @returns {number}
 */
function parseDurationMs(raw, fallback, bounds = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const ms = Number.parseInt(String(raw), 10);
  const min = bounds.min ?? 1;
  const max = bounds.max ?? 86_400_000;
  if (!Number.isInteger(ms) || ms < min || ms > max) {
    throw new Error(`Invalid duration ms: ${raw}`);
  }
  return ms;
}

/**
 * @param {unknown} raw
 * @returns {number[]}
 */
function parsePortList(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  const parts = String(raw).split(/[,;\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const port = Number.parseInt(part, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in list: ${part}`);
    }
    if (!out.includes(port)) out.push(port);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseOriginList(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw).split(/[,;\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {EgressProxyConfig}
 */
export function loadEgressProxyConfig(env = process.env) {
  const bind = String(env?.CRETLI_EGRESS_BIND ?? DEFAULT_BIND).trim();
  if (!bind) throw new Error('CRETLI_EGRESS_BIND must not be empty');
  const port = parsePort(env?.CRETLI_EGRESS_PORT, DEFAULT_PORT);
  const dataDir = path.resolve(String(env?.CRETLI_EGRESS_DATA_DIR ?? '').trim() || 'data');
  const policyFile = String(env?.CRETLI_EGRESS_POLICY_FILE ?? '').trim();
  const blockedPorts = parsePortList(env?.CRETLI_EGRESS_BLOCKED_PORTS);
  const selfOrigins = parseOriginList(env?.CRETLI_EGRESS_SELF_ORIGINS);
  const probePath = String(env?.CRETLI_EGRESS_PROBE_PATH ?? '/_egress_ready').trim() || '/_egress_ready';
  if (!probePath.startsWith('/')) throw new Error('CRETLI_EGRESS_PROBE_PATH must start with /');
  const connectTimeoutMs = parseDurationMs(
    env?.CRETLI_EGRESS_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    { min: 1000, max: 600_000 },
  );
  const idleTimeoutMs = parseDurationMs(
    env?.CRETLI_EGRESS_IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    { min: 1000, max: 3_600_000 },
  );
  const maxHeaderBytes = parseDurationMs(
    env?.CRETLI_EGRESS_MAX_HEADER_BYTES,
    65_536,
    { min: 4096, max: 1_048_576 },
  );
  return {
    bind,
    port,
    dataDir,
    policyFile,
    blockedPorts,
    selfOrigins,
    probePath,
    connectTimeoutMs,
    idleTimeoutMs,
    maxHeaderBytes,
  };
}
