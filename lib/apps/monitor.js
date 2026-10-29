/**
 * Port monitoring helpers for the app registry. Listener data comes from the
 * stage-1 `ss` parser (lib/net-env); this module never kills or signals a process.
 */

import fs from 'node:fs';
import os from 'node:os';
import { isIP } from 'node:net';
import { execute, resolveProcOwners } from '../net-env/index.js';
import { parseSs } from '../net-env/parsers.js';

export const DEFAULT_MONITOR_INTERVAL_MS = 5000;
export const MIN_MONITOR_INTERVAL_MS = 1000;
export const HEALTH_TIMEOUT_MS = 2000;

/** Monitor interval from `CRETLI_APPS_MONITOR_INTERVAL_MS`, clamped to a safe minimum. */
export function resolveMonitorIntervalMs(env = process.env) {
  const n = Number(env.CRETLI_APPS_MONITOR_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_MONITOR_INTERVAL_MS, Math.floor(n)) : DEFAULT_MONITOR_INTERVAL_MS;
}

/**
 * One listener snapshot = exactly one `ss` invocation (plus /proc reads for owners).
 *
 * @param {{ run?: typeof execute, owners?: typeof resolveProcOwners, timeout?: number }} [deps]
 * @returns {() => Promise<{ ok: boolean, listeners: Array<{address:string, port:number, pid:number|null, command:string|null}>, error?: string }>}
 */
export function createListenerSnapshotter(deps = {}) {
  const run = deps.run || execute;
  const owners = deps.owners || resolveProcOwners;
  const timeout = deps.timeout || 1500;
  return async function snapshot() {
    let text;
    try {
      text = String(await run('ss', ['-ltnpH'], { timeout }));
    } catch (err) {
      return { ok: false, listeners: [], error: `ss unavailable: ${err?.code || err?.message || 'error'}` };
    }
    const listeners = parseSs(text);
    try { await owners(listeners); } catch { /* owners stay null */ }
    return { ok: true, listeners };
  };
}

/** @param {number} pid @returns {number|null} */
export function readParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces and parentheses; the ppid follows the last ")".
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` is `rootPid` or one of its descendants.
 *
 * @param {number|null} pid
 * @param {number|null} rootPid
 * @param {(pid: number) => number|null} [parentOf]
 */
export function belongsToProcessTree(pid, rootPid, parentOf = readParentPid) {
  if (!pid || !rootPid) return false;
  let current = pid;
  for (let depth = 0; depth < 64 && current; depth += 1) {
    if (current === rootPid) return true;
    current = parentOf(current);
  }
  return false;
}

const WILDCARD = new Set(['*', '0.0.0.0', '::', '[::]', '']);
export const isWildcardAddress = (address) => WILDCARD.has(String(address));
export const isLoopbackAddress = (address) => /^127\./.test(address) || address === '::1' || address === 'localhost';

/**
 * Port conflicts before a start: any declared port that already has a listener.
 * The app has no run yet, so every owner is foreign.
 *
 * @param {{ ports: Array<{ port: number }> }} app
 * @param {Array<{address:string, port:number, pid:number|null, command:string|null}>} listeners
 */
export function detectPortConflicts(app, listeners) {
  const conflicts = [];
  for (const p of app.ports) {
    for (const l of listeners) {
      if (l.port === p.port) conflicts.push({ port: p.port, address: l.address, pid: l.pid, command: l.command });
    }
  }
  return conflicts;
}

/**
 * Listening ports outside the registry. Read-only information; `killHint` is a
 * string to copy, Cretli never runs it.
 *
 * @param {Array<{address:string, port:number, pid:number|null, command:string|null}>} listeners
 * @param {Array<{ ports: Array<{ port: number }> }>} apps
 * @param {{ selfPid?: number }} [options]
 */
export function findOrphans(listeners, apps, options = {}) {
  const known = new Set(apps.flatMap((a) => a.ports.map((p) => p.port)));
  const selfPid = options.selfPid ?? process.pid;
  const seen = new Set();
  const out = [];
  for (const l of listeners) {
    if (known.has(l.port) || (l.pid && l.pid === selfPid)) continue;
    const key = `${l.address}:${l.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      port: l.port, bind: l.address, pid: l.pid, command: l.command,
      killHint: l.pid ? `kill ${l.pid}` : null,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Per-port status of one app.
 *
 * @param {{ ports: Array<{ port:number, bind:string, role:string }>, exposure: string }} app
 * @param {Array<{address:string, port:number, pid:number|null, command:string|null}>} listeners
 * @param {{ rootPid: number|null, parentOf?: (pid:number)=>number|null }} owner  task-run PID of this app, if any
 */
export function classifyAppPorts(app, listeners, owner) {
  return app.ports.map((p) => {
    const listener = listeners.find((l) => l.port === p.port) || null;
    let ownedBy = 'none';
    if (listener) ownedBy = belongsToProcessTree(listener.pid, owner.rootPid, owner.parentOf) ? 'app' : 'foreign';
    const warnings = [];
    if (listener && app.exposure === 'lan' && isLoopbackAddress(listener.address)) warnings.push('exposure-lan-but-loopback');
    if (listener && app.exposure === 'local' && isWildcardAddress(listener.address)) warnings.push('exposure-local-but-wildcard');
    return {
      port: p.port, bind: p.bind, role: p.role,
      listening: Boolean(listener),
      listener: listener ? { address: listener.address, pid: listener.pid, command: listener.command } : null,
      ownedBy, warnings,
    };
  });
}

// Control characters are rejected on purpose (CRLF injection).
// eslint-disable-next-line no-control-regex
export const HEALTH_PATH_RE = /^\/(?!\/)[^\s\\#\u0000-\u001f\u007f]*$/;

/** True for a path that can only extend the origin: starts with a single "/", no whitespace, CR/LF, backslash or fragment. */
export const isSafeHealthPath = (p) => typeof p === 'string' && HEALTH_PATH_RE.test(p);

/** @returns {Set<string>} addresses currently assigned to local network interfaces */
export function localInterfaceAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) out.add(String(a.address).split('%')[0]);
  }
  return out;
}

/**
 * Where a health probe may connect. Wildcards probe loopback; loopback binds probe
 * themselves; any other address is allowed only when it belongs to a local
 * interface, so a definition can never make Cretli request a remote host.
 *
 * @param {string|null|undefined} bind
 * @param {() => Set<string>} [localAddresses]
 * @returns {{ ok: true, host: string } | { ok: false, reason: string }}
 */
export function resolveProbeHost(bind, localAddresses = localInterfaceAddresses) {
  const b = String(bind ?? '').trim().replace(/^\[|\]$/g, '');
  if (!b || b === '*' || b === '0.0.0.0' || b === 'localhost') return { ok: true, host: '127.0.0.1' };
  if (b === '::') return { ok: true, host: '::1' };
  if (!isIP(b)) return { ok: false, reason: 'bind-not-an-ip' };
  if (isLoopbackAddress(b)) return { ok: true, host: b };
  if (localAddresses().has(b)) return { ok: true, host: b };
  return { ok: false, reason: 'non-local-address' };
}

/**
 * HTTP health probe: status code and latency, never throws. The target is derived
 * from `bind` through {@link resolveProbeHost}; an unsafe host or path is skipped.
 *
 * @param {{ bind?: string|null, port: number, path: string, timeoutMs?: number, fetchFn?: typeof fetch, localAddresses?: () => Set<string> }} input
 */
export async function probeHealth({ bind, port, path, timeoutMs = HEALTH_TIMEOUT_MS, fetchFn = fetch, localAddresses }) {
  if (!isSafeHealthPath(path)) return { ok: false, code: null, latencyMs: 0, skipped: 'invalid-health-path' };
  const target = resolveProbeHost(bind, localAddresses);
  if (!target.ok) return { ok: false, code: null, latencyMs: 0, skipped: /** @type {any} */ (target).reason };
  const origin = new URL(`http://${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${Number(port)}`);
  const started = Date.now();
  try {
    // The origin is fixed first and the path is appended to it, so the path cannot change the host.
    const res = await fetchFn(`${origin.origin}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: res.status < 500, code: res.status, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, code: null, latencyMs: Date.now() - started, error: String(err?.name || 'error') };
  }
}
