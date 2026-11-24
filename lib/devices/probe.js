/**
 * Live status probe. Never throws: every failure maps to a status. External
 * commands go through `execFile` with an argv array (never a shell string),
 * carry a timeout and return a partial result, like lib/net-env.
 *
 * Statuses: reachable | asleep | chrome-down | unreachable | adb-missing | timeout | refused
 */

import { execFile } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { checkEndpoint, isValidHostSyntax, isValidPort, isValidSerial } from './endpoint-guard.js';

export const DEFAULT_TIMEOUT_MS = 4000;
const CHROME_PACKAGE = 'com.android.chrome';

/**
 * Default command runner.
 * @param {string} file @param {string[]} args @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, errorCode?: string, timedOut?: boolean }>}
 */
export function defaultRunner(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const e = /** @type {any} */ (err);
      resolve({
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        errorCode: typeof e.code === 'string' ? e.code : undefined,
        timedOut: Boolean(e.killed && e.signal),
      });
    });
  });
}

/** GET /json/version on a resolved address. @returns {Promise<any>} parsed JSON; rejects on failure. */
export function defaultFetchVersion(address, port, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    // Idempotent: the first outcome wins and the timer is always cleared.
    const settle = (/** @type {(v: any) => void} */ fn, /** @type {any} */ v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = http.get({ host: address, port, path: '/json/version', timeout, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(new Error('too large')); });
      res.on('end', () => { ended = true; try { settle(resolve, JSON.parse(body)); } catch (e) { settle(reject, e); } });
      // A peer that sends headers plus a partial body and then drops the socket.
      res.on('error', (e) => settle(reject, e));
      res.on('aborted', () => settle(reject, new Error('response aborted')));
      res.on('close', () => { if (!ended) settle(reject, new Error('response closed before end')); });
    });
    // Overall deadline, independent of socket inactivity.
    timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => settle(reject, e));
  });
}

/**
 * Collects hardware facts over one CDP socket: `SystemInfo.getInfo` (GPU, model)
 * plus `Runtime.evaluate` in a page target for CPU cores and devicePixelRatio.
 * The page part is best effort. Rejects only when SystemInfo itself fails.
 */
export function defaultSystemInfo(wsUrl, timeout) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl, { handshakeTimeout: timeout });
    let info = null;
    const timer = setTimeout(() => finish(info ? resolve : reject, info ? info : new Error('timeout')), timeout);
    function finish(fn, v) { clearTimeout(timer); try { sock.close(); } catch { /* ignore */ } fn(v); }
    const send = (id, method, params, sessionId) => sock.send(JSON.stringify({ id, method, params, sessionId }));
    sock.on('open', () => send(1, 'SystemInfo.getInfo'));
    sock.on('message', (m) => {
      try {
        const msg = JSON.parse(String(m));
        if (msg.id === 1) { info = msg.result || {}; send(2, 'Target.getTargets'); return; }
        if (msg.id === 2) {
          const page = (msg.result?.targetInfos || []).find((t) => t.type === 'page');
          if (!page) return finish(resolve, info);
          send(3, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
          return;
        }
        if (msg.id === 3) {
          if (!msg.result?.sessionId) return finish(resolve, info);
          send(4, 'Runtime.evaluate', { expression: 'JSON.stringify({dpr:window.devicePixelRatio,cores:navigator.hardwareConcurrency})', returnByValue: true }, msg.result.sessionId);
          return;
        }
        if (msg.id === 4) {
          try { info = { ...info, page: JSON.parse(msg.result?.result?.value) }; } catch { /* keep SystemInfo only */ }
          finish(resolve, info);
        }
      } catch (e) { finish(info ? resolve : reject, info ? info : e); }
    });
    sock.on('error', (e) => finish(info ? resolve : reject, info ? info : e));
  });
}

/** Extracts the hardware facts worth keeping: GPU, CPU cores, DPR and model. */
export function summarizeSystemInfo(info) {
  const gpu = info?.gpu?.devices?.[0] || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  return {
    gpu: [gpu.vendorString, gpu.deviceString].filter(Boolean).join(' ') || null,
    cpuCores: num(info?.page?.cores),
    dpr: num(info?.page?.dpr),
    model: info?.modelName || null,
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * The adb transport is always derived from the validated host:port. A stored
 * serial is accepted only when it equals that endpoint, so it can never select
 * an unrelated transport. Returns null when it does not.
 */
export function adbSerialFor(device) {
  const endpoint = `${device?.host}:${device?.port}`;
  const stored = String(device?.serial || '').trim();
  if (stored && stored !== endpoint) return null;
  return isValidSerial(endpoint) ? endpoint : null;
}

/**
 * @param {Record<string, any>} device
 * @param {{ runner?: typeof defaultRunner, adbPath?: string, timeoutMs?: number, lookup?: (h: string) => Promise<string>,
 *   fetchVersion?: typeof defaultFetchVersion, systemInfo?: typeof defaultSystemInfo, passive?: boolean }} [opts]
 * @returns {Promise<{ status: string, detail: string, hardware?: Record<string, any> }>}
 */
export async function probeDevice(device, opts = {}) {
  try {
    return await probeInner(device, opts);
  } catch (err) {
    return { status: 'unreachable', detail: String(/** @type {any} */ (err)?.message || err) };
  }
}

async function probeInner(device, opts) {
  const runner = opts.runner || defaultRunner;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adb = opts.adbPath || 'adb';
  const fetchVersion = opts.fetchVersion || defaultFetchVersion;
  const systemInfo = opts.systemInfo || defaultSystemInfo;

  if (!isValidHostSyntax(device.host || '127.0.0.1')) return { status: 'unreachable', detail: 'Invalid host.' };

  if (device.kind === 'adb-wifi') {
    const serial = adbSerialFor(device);
    if (!isValidHostSyntax(device.host) || !isValidPort(device.port) || !serial) {
      return { status: 'unreachable', detail: 'Invalid adb endpoint or serial does not match host:port.' };
    }
    const guard = await checkEndpoint({ host: device.host, port: device.port, lookup: opts.lookup });
    if (!guard.ok) return { status: 'unreachable', detail: /** @type {any} */ (guard).message };
    const res = await runner(adb, ['-s', serial, 'shell', 'dumpsys', 'power'], { timeout });
    if (res.errorCode === 'ENOENT') return { status: 'adb-missing', detail: `adb binary "${adb}" was not found.` };
    if (res.timedOut || res.errorCode === 'ETIMEDOUT') return { status: 'timeout', detail: 'adb did not answer in time.' };
    if (res.code !== 0) return { status: 'unreachable', detail: (res.stderr || res.stdout || 'adb failed').trim().slice(0, 200) };
    if (/mWakefulness=(Asleep|Dozing)/.test(res.stdout)) return { status: 'asleep', detail: 'Screen is asleep.' };
    return cdpStatus('127.0.0.1', device.cdpPort || 9222, { timeout, fetchVersion, systemInfo, passive: opts.passive, lookup: opts.lookup });
  }

  if (!device.host || !isValidPort(device.port)) return { status: 'unreachable', detail: 'Host and port are required.' };
  return cdpStatus(device.host, device.port, { timeout, fetchVersion, systemInfo, passive: opts.passive, lookup: opts.lookup });
}

async function cdpStatus(host, port, { timeout, fetchVersion, systemInfo, lookup, passive }) {
  const guard = await checkEndpoint({ host, port, lookup });
  if (!guard.ok) return { status: 'unreachable', detail: /** @type {any} */ (guard).message };
  let version;
  try {
    version = await fetchVersion(guard.address, port, timeout);
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'ETIMEDOUT') return { status: 'timeout', detail: 'Chrome DevTools endpoint timed out.' };
    return { status: 'chrome-down', detail: 'Chrome DevTools endpoint is not answering.' };
  }
  /** @type {{ status: string, detail: string, hardware?: Record<string, any> }} */
  const result = { status: 'reachable', detail: String(version?.Browser || 'Chrome reachable.') };
  const wsUrl = String(version?.webSocketDebuggerUrl || '');
  if (!passive && /^wss?:\/\//.test(wsUrl)) {
    try {
      // Connect to the already-resolved address, not the host the endpoint advertises.
      const u = pinEndpoint(wsUrl, guard.address, port);
      result.hardware = summarizeSystemInfo(await systemInfo(u.toString(), timeout));
    } catch { /* Keep the previous hardware facts when the call fails. */ }
  }
  return result;
}

/**
 * Wakes Chrome on an Android device. REST/UI only; no MCP tool maps here.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function launchChrome(device, opts = {}) {
  const runner = opts.runner || defaultRunner;
  const serial = adbSerialFor(device);
  if (device?.kind !== 'adb-wifi' || !isValidHostSyntax(device.host) || !isValidPort(device.port) || !serial) {
    return { ok: false, detail: 'Launching Chrome needs a valid adb-wifi device.' };
  }
  const guard = await checkEndpoint({ host: device.host, port: device.port, lookup: opts.lookup });
  if (!guard.ok) return { ok: false, detail: /** @type {any} */ (guard).message };
  const res = await runner(opts.adbPath || 'adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', CHROME_PACKAGE], { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (res.errorCode === 'ENOENT') return { ok: false, detail: 'adb binary not found.' };
  if (res.timedOut) return { ok: false, detail: 'adb timed out.' };
  return res.code === 0 ? { ok: true, detail: 'Chrome launch requested.' } : { ok: false, detail: (res.stderr || 'adb failed').trim().slice(0, 200) };
}

/** Resolve and pin the CDP endpoint to a guarded address, ignoring advertised hosts. */
export async function resolveDeviceEndpoint(device, opts = {}) {
  const host = device.kind === 'adb-wifi' ? '127.0.0.1' : device.host;
  const port = device.kind === 'adb-wifi' ? device.cdpPort || 9222 : device.port;
  const guard = await checkEndpoint({ host, port, lookup: opts.lookup });
  if (!guard.ok) throw new Error('endpoint-refused');
  const version = await (opts.fetchVersion || defaultFetchVersion)(guard.address, port, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  return pinEndpoint(version.webSocketDebuggerUrl, guard.address, port).toString();
}

function pinEndpoint(wsUrl, address, port) {
  const url = new URL(wsUrl);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('endpoint-refused');
  url.hostname = address.includes(':') ? `[${address}]` : address;
  url.port = String(port);
  url.username = ''; url.password = '';
  return url.toString();
}
