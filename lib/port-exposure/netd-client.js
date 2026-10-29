/**
 * Adapter between the port exposure backends and the Windows helper (cretli-netd).
 *
 * It calls the unprivileged client `cretli-netctl.ps1` through WSL interop and
 * maps the backend executor contract (see backends.js) onto the helper's closed
 * list of operations. Every failure (timeout, missing helper, busy pipe, an
 * untrusted server, no signed-in user, a validation error) is returned as
 * `{ ok: false, error: <code> }`; the backends then fall back to `manual` and show
 * the commands instead.
 */

import { execFile } from 'node:child_process';
import { OPS, PORT_OPS } from './netd-protocol.js';

export const DEFAULT_CLIENT_PATH = 'C:\\ProgramData\\Cretli\\netd\\cretli-netctl.ps1';
// Slightly above the client's own 5 s connect + 30 s response budget.
export const DEFAULT_TIMEOUT_MS = 45_000;
const STATUS_TTL_MS = 30_000;
const EXPOSE_DEDUPE_MS = 10_000;

/**
 * @typedef {(file: string, args: string[], options: { timeout: number, windowsHide: boolean, maxBuffer: number }) => Promise<{ stdout: string, stderr?: string, code?: number|string|null, timedOut?: boolean }>} RunProcess
 */

/** @type {RunProcess} */
export function runProcess(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const err = /** @type {any} */ (error);
      resolve({
        stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (err.code ?? 1) : 0,
        timedOut: Boolean(err && (err.killed || err.code === 'ETIMEDOUT')),
      });
    });
  });
}

/**
 * @param {{ run?: RunProcess, powershell?: string, clientPath?: string, timeoutMs?: number, now?: () => number }} [options]
 */
export function createNetdClient(options = {}) {
  const run = options.run || runProcess;
  const powershell = options.powershell || 'powershell.exe';
  const clientPath = options.clientPath || process.env.CRETLI_NETD_CLIENT_PATH || DEFAULT_CLIENT_PATH;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = options.now || Date.now;

  /**
   * One helper call. Resolves to `{ ok, data }` or `{ ok: false, code }`; never rejects.
   * @param {string} op
   * @param {number} [port]
   */
  async function call(op, port) {
    if (!OPS.includes(op)) return { ok: false, code: 'validation' };
    const needsPort = PORT_OPS.includes(op);
    if (needsPort !== (port !== undefined)) return { ok: false, code: 'validation' };
    if (needsPort && (!Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65535)) return { ok: false, code: 'validation' };
    const args = ['-NoProfile', '-NonInteractive', '-File', clientPath, '-Op', op];
    if (needsPort) args.push('-Port', String(port));
    let result;
    try { result = await run(powershell, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }); }
    catch (error) {
      const code = /** @type {any} */ (error)?.code;
      return { ok: false, code: code === 'ENOENT' ? 'helper_missing' : 'helper_unavailable' };
    }
    if (result.timedOut) return { ok: false, code: 'timeout' };
    if (result.code === 'ENOENT') return { ok: false, code: 'helper_missing' };
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    let reply = null;
    try { reply = line ? JSON.parse(line) : null; } catch { reply = null; }
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
      // powershell.exe printed an error for a missing script instead of our JSON line.
      return { ok: false, code: /cannot be loaded|does not exist|not recognized|cannot find/i.test(`${result.stdout}${result.stderr || ''}`) ? 'helper_missing' : 'bad_response' };
    }
    return reply.ok ? { ok: true, data: reply.data ?? {} } : { ok: false, code: String(reply.code || 'helper_error') };
  }

  /** @type {Map<number, number>} */
  const recentExpose = new Map();

  /**
   * Backend executor. The helper's `expose` configures everything for a port
   * (portproxy and firewall in NAT, the Hyper-V rule in mirrored mode) from the
   * port alone, so the per-step ops of the backends collapse onto it.
   */
  const executor = {
    async run({ op, port }) {
      let result;
      if (op === 'portproxy-add' || op === 'firewall-add') {
        const last = recentExpose.get(port);
        if (op === 'firewall-add' && last !== undefined && now() - last < EXPOSE_DEDUPE_MS) return { ok: true };
        result = await call('expose', port);
        if (result.ok) recentExpose.set(port, now());
      } else if (op === 'firewall-delete') {
        recentExpose.delete(port);
        result = await call('close', port);
        // A rule that is not in the helper state is already gone.
        if (!result.ok && result.code === 'not_in_state') return { ok: true };
      } else if (op === 'portproxy-delete') return { ok: true }; // Removed together with the firewall rule by `close`.
      else return { ok: false, error: 'validation' };
      return result.ok ? { ok: true } : { ok: false, error: result.code };
    },
    async listRules() {
      const result = await call('list');
      if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
      const data = result.data || {};
      return { portproxy: Array.isArray(data.portproxy) ? data.portproxy : [], firewall: Array.isArray(data.firewall) ? data.firewall : [] };
    },
  };

  let statusCache = null;
  let statusExpires = 0;

  /**
   * Helper state for GET /api/net-env. `installed` is true once the client script
   * answered at all; `state` is `ready` or the failure code (the fallback reason).
   */
  async function status({ refresh = false } = {}) {
    if (!refresh && statusCache && now() < statusExpires) return statusCache;
    const result = await call('status');
    statusCache = result.ok
      ? { state: 'ready', installed: true, version: result.data.version ?? null, mode: result.data.mode ?? null, rules: result.data.rules ?? null }
      : { state: result.code, installed: !['helper_missing', 'helper_unavailable'].includes(result.code), version: null, mode: null, rules: null };
    statusExpires = now() + STATUS_TTL_MS;
    return statusCache;
  }

  return { call, executor, status };
}

/** @type {ReturnType<typeof createNetdClient> | null} */
let defaultClient = null;

/** Process-wide client shared by the exposure runtime and GET /api/net-env. */
export function getDefaultNetdClient() {
  if (!defaultClient) defaultClient = createNetdClient();
  return defaultClient;
}

/** True on WSL2, the only place the helper applies. */
export function isWslHost(platform = process.platform, release = '') {
  return platform === 'linux' && /microsoft.*wsl2|wsl2.*microsoft/i.test(release);
}
