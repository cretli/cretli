import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCdpProxy } from './cdp-proxy.js';
import { createRunHistory } from './run-history.js';
import { createRunConsentRegistry } from './run-consent.js';
import { getDevicesService } from './service.js';
import { broadcastDeviceRunConsentChanged } from '../chat-list-updates.js';

const fail = (error, status = 400) => ({ ok: false, error, status });

/** Read the entry once. No path is reopened after consent. */
export async function prepareScript(input, workspace) {
  if (!workspace || input.script !== undefined || input.scriptText !== undefined || typeof input.scriptPath !== 'string') throw new Error('invalid-script');
  if (path.isAbsolute(input.scriptPath) || input.scriptPath.split(/[\\/]/).includes('..')) throw new Error('script-outside-workspace');
  const root = await fs.realpath(workspace);
  const scriptPath = await fs.realpath(path.resolve(root, input.scriptPath));
  const relative = path.relative(root, scriptPath);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('script-outside-workspace');
  const ext = path.extname(scriptPath);
  if (!['.mjs', '.cjs'].includes(ext)) throw new Error('invalid-script');
  if (!Array.isArray(input.args || []) || (input.args || []).some((a) => typeof a !== 'string') || (input.args || []).length > 100) throw new Error('invalid-args');
  const handle = await fs.open(scriptPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('invalid-script');
    if (stat.size > 1024 * 1024) throw new Error('script-too-large');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length > 1024 * 1024) throw new Error('script-too-large');
  return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex'), scriptPath, ext, args: input.args || [], workspace: root };
}

/** Bounded stdout must be one JSON object: { metrics, screenshots?: base64PNG[] }. */
export function executeScript(prepared, proxy, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [...(prepared.ext === '.mjs' ? ['--input-type=module'] : []), '-', ...prepared.args];
    const env = {
      PATH: process.env.PATH || '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      CRETLI_DEVICE_CDP_URL: proxy.url,
      CRETLI_DEVICE_SYSTEM_INFO: JSON.stringify(proxy.hardware),
      CRETLI_DEVICE_SCRIPT_DIR: path.dirname(prepared.scriptPath),
      CRETLI_DEVICE_SCRIPT: prepared.scriptPath,
    };
    const child = (options.spawn || spawn)(process.execPath, args, { cwd: path.dirname(prepared.scriptPath), shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', length = 0, failure;
    const timer = setTimeout(() => { failure = 'script-timeout'; child.kill('SIGKILL'); }, options.timeoutMs || 60_000);
    const collect = (bytes, output) => {
      length += Buffer.byteLength(bytes);
      if (length > (options.outputCap || 8 * 1024 * 1024)) { failure = 'output-limit'; child.kill('SIGKILL'); }
      else if (output) stdout += bytes;
    };
    child.stdout.on('data', (b) => collect(b, true));
    child.stderr.on('data', (b) => collect(b, false));
    child.stdin.on('error', () => {});
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) return reject(new Error(failure || 'script-error'));
      try {
        const output = JSON.parse(stdout);
        if (!output.metrics || typeof output.metrics !== 'object' || Array.isArray(output.metrics)) throw new Error('invalid-metrics');
        resolve(output);
      } catch { reject(new Error('invalid-output')); }
    });
    child.stdin.end(prepared.bytes);
  });
}

export function createDeviceRunsService(options = {}) {
  const devices = options.devices || getDevicesService();
  const history = options.history || createRunHistory();
  const consent = options.consent || createRunConsentRegistry();
  const active = new Map(), completions = new Map();
  const prepare = (input, workspace) => prepareScript(input, workspace);
  /** @param {string} id @param {any} input @param {{workspace?: string, chatId?: string, prepared?: any}} [scope] */
  async function start(id, input, { workspace, chatId = '', prepared: supplied } = {}) {
    let prepared;
    try { prepared = supplied || await prepare(input, workspace); } catch (e) { return fail(e.message); }
    const device = devices.list({ workspace }).devices.find((d) => d.id === id);
    if (!device) return fail('device-not-found', 404);
    const key = JSON.stringify([id, prepared.hash, prepared.args, prepared.workspace, chatId]);
    if (active.has(key)) return { ok: true, run: active.get(key), completion: completions.get(active.get(key).id) };
    const run = { id: crypto.randomUUID(), deviceId: id, deviceName: device.name, workspace, scriptPath: prepared.scriptPath,
      hash: prepared.hash, args: prepared.args, startedAt: new Date().toISOString(), finishedAt: null, status: 'awaiting-consent', metrics: null, screenshots: [], hardware: null };
    const finish = (error) => {
      run.status = error ? 'failed' : 'success'; run.error = error || null; run.finishedAt = new Date().toISOString();
      history.put(run); active.delete(key); return run;
    };
    if (['macos', 'windows'].includes(device.platform) && !device.separateProfile) {
      finish('profile-not-separate'); return { ok: false, error: run.error, run, status: 400 };
    }
    const status = await devices.status(id, { workspace, passive: true });
    if (!status.ok || status.status !== 'reachable') {
      finish('device-' + (status.status || 'unreachable')); return { ok: false, error: run.error, run, status: 409 };
    }
    // Recheck after the asynchronous passive probe to coalesce concurrent starts.
    if (active.has(key)) return { ok: true, run: active.get(key), completion: completions.get(active.get(key).id) };
    const card = consent.request({ deviceId: id, deviceName: device.name, hash: prepared.hash, scriptPath: prepared.scriptPath, chatId });
    run.consentId = card.id || null;
    history.put(run); active.set(key, run);
    const completion = (async () => {
      let proxy;
      try {
        const outcome = await card.outcome;
        if (outcome !== 'once') return finish(outcome === 'timeout' ? 'consent-timeout' : 'consent-denied');
        const current = await devices.status(id, { workspace, passive: true });
        if (!current.ok || current.status !== 'reachable') return finish('device-' + (current.status || 'unreachable'));
        run.status = 'running'; history.put(run);
        proxy = await (options.createProxy || createCdpProxy)(device, options.proxyOptions || {});
        run.hardware = proxy.hardware;
        const output = await executeScript(prepared, proxy, { spawn: options.spawn, timeoutMs: options.timeoutMs, outputCap: options.outputCap });
        run.metrics = output.metrics;
        run.screenshots = history.writeScreenshots(run.id, output.screenshots);
        return finish();
      } catch (e) { run.metrics = null; return finish(e.message || 'run-failed'); }
      finally { await proxy?.close(); completions.delete(run.id); }
    })();
    completions.set(run.id, completion);
    return { ok: true, run, completion };
  }
  return { start, prepare, history, consent,
    async all(input, scope) {
      const prepared = await prepare(input, scope.workspace);
      const runs = [];
      for (const d of devices.list({ workspace: scope.workspace }).devices) {
        const result = await start(d.id, input, { ...scope, prepared });
        if (result.completion) await result.completion;
        runs.push(result.run || result);
      }
      return { ok: true, runs };
    },
  };
}

let shared;
export function getDeviceRunsService() {
  if (!shared) shared = createDeviceRunsService({ consent: createRunConsentRegistry({ onChange: broadcastDeviceRunConsentChanged }) });
  return shared;
}
