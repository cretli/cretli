/**
 * Deterministic (no LLM) preflight for a watcher cycle: an explicit
 * `Requires: <url>` marker in the leaf's acceptance section names a local
 * server that must answer before an implementation delegation is worth
 * starting. Everything else in the body is ignored on purpose.
 */

import {
  isLoopbackHostname,
  isLocalOnlyHostname,
  isPrivateHostname,
} from './browser/url-policy.js';

export const WORKSPACE_WATCHER_PREFLIGHT_MAX_TARGETS = 3;
export const WORKSPACE_WATCHER_PREFLIGHT_TIMEOUT_MS = 3000;

const SECTION_START = /^##\s*(acceptance|akceptacja)\b/i;
const SECTION_END = /^#{1,2}\s/;
const MARKER = /^\s*[-*]?\s*(Requires|Wymaga)\s*:\s*(\S+)\s*$/i;

/**
 * Collect the marker values from the acceptance section of a todo body.
 *
 * @param {unknown} body
 * @returns {string[]} at most `WORKSPACE_WATCHER_PREFLIGHT_MAX_TARGETS` raw values
 */
export function parseWorkspaceWatcherPreflightTargets(body) {
  const out = [];
  let inSection = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (SECTION_START.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && SECTION_END.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const match = MARKER.exec(line);
    if (match) out.push(match[2]);
    if (out.length >= WORKSPACE_WATCHER_PREFLIGHT_MAX_TARGETS) break;
  }
  return out;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  return isLoopbackHostname(host) || isPrivateHostname(host) || isLocalOnlyHostname(host);
}

/**
 * Probe every declared target. Reachable means any HTTP response; a connection
 * error or timeout is unreachable. Non-http values and public hosts only warn.
 *
 * @param {unknown} body
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ unreachable: string[], warnings: string[], probed: string[] }>}
 */
export async function runWorkspaceWatcherPreflight(body, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : WORKSPACE_WATCHER_PREFLIGHT_TIMEOUT_MS;
  const result = { unreachable: [], warnings: [], probed: [] };
  for (const value of parseWorkspaceWatcherPreflightTargets(body)) {
    let url = null;
    if (/^https?:\/\//i.test(value)) {
      try { url = new URL(value); } catch { url = null; }
    }
    if (!url) {
      result.warnings.push(`${value}: not an http(s) URL, not probed`);
      continue;
    }
    if (!isLocalHost(url.hostname)) {
      result.warnings.push(`${value}: public host, not probed`);
      continue;
    }
    result.probed.push(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal });
      // Headers are enough; never read (or buffer) the body.
      try { await response?.body?.cancel?.(); } catch { /* ignore */ }
    } catch {
      result.unreachable.push(value);
    } finally {
      clearTimeout(timer);
    }
  }
  return result;
}
