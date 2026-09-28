/**
 * HTTP helpers for isolated Cretli processes used by delegation E2E tests.
 */

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

/**
 * @returns {Promise<number>}
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * @param {{
 *   port: number,
 *   method: string,
 *   url: string,
 *   body?: object,
 *   cookie?: string,
 *   csrf?: string,
 *   timeoutMs?: number,
 * }} input
 */
export function requestJson(input) {
  return new Promise((resolve, reject) => {
    const payload = input.body ? JSON.stringify(input.body) : '';
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 0;
    const req = http.request({
      host: '127.0.0.1',
      port: input.port,
      method: input.method,
      path: input.url,
      headers: {
        'content-type': 'application/json',
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.csrf ? { 'x-cretli-csrf': input.csrf } : {}),
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = { raw };
        }
        const setCookie = res.headers['set-cookie'];
        const cookie = Array.isArray(setCookie)
          ? setCookie.map((row) => String(row).split(';')[0]).join('; ')
          : '';
        resolve({ status: res.statusCode, json, cookie, raw });
      });
    });
    const timer = timeoutMs
      ? setTimeout(() => {
        req.destroy(new Error(`request timeout ${input.method} ${input.url}`));
      }, timeoutMs)
      : null;
    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {RegExp} pattern
 * @param {number} [timeoutMs]
 */
export function waitForOutput(child, pattern, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      if (pattern.test(buf)) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(buf);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`Timed out waiting for ${pattern}\n${buf.slice(-2000)}`));
    }, timeoutMs).unref?.();
  });
}

/**
 * @param {{ port: number, dataDir: string, cwd: string }} input
 */
export function spawnIsolatedCretli(input) {
  return spawn(process.execPath, ['server.js'], {
    cwd: input.cwd,
    env: {
      ...process.env,
      PORT: String(input.port),
      USE_HTTPS: '0',
      CRETLI_BIND: '127.0.0.1',
      CRETLI_DATA_DIR: input.dataDir,
      CURSOR_REMOTE_DATA_DIR: input.dataDir,
      CRETLI_FRONT_HMR: '0',
      CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
      CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
      CRETLI_DELEGATION_EMPTY_FAVORITES: process.env.CRETLI_DELEGATION_EMPTY_FAVORITES || 'all',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {import('node:child_process').ChildProcess | null} child
 * @param {NodeJS.Signals} [signal]
 */
export async function stopServer(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode != null) return child?.exitCode ?? 0;
  child.kill(signal);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, 10000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * @param {{ port: number, cookie: string, want: 'ready' | 'degraded' }} input
 */
export async function pollRuntime(input) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 15000) {
    last = await requestJson({
      port: input.port,
      method: 'GET',
      url: '/api/delegations/runtime',
      cookie: input.cookie,
    });
    const state = String(last?.json?.runtime?.lifecycle?.state || '');
    if (input.want === 'ready' && state === 'ready' && last.json?.runtime?.workerRunning) return last;
    if (input.want === 'degraded' && (state === 'degraded' || last.json?.runtime?.degraded === true)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}
