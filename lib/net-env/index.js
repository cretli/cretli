import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import os from 'node:os';
import { isIP } from 'node:net';
import { parseSs, parsePortproxy, parseWslConfig, parseNetworkingMode } from './parsers.js';
import { classifyIssues } from './issues.js';

export function execute(file, args, { timeout }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// /proc ownership may be hidden by kernel policy. Leave unknown owners null.
export async function resolveProcOwners(listeners, fs = { readFile, readdir, readlink }) {
  const missing = listeners.filter((l) => !l.pid);
  if (!missing.length) return;
  const inodes = new Map();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of (await fs.readFile(file, 'utf8')).trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== '0A') continue;
        const [hexAddress, hexPort] = fields[1].split(':');
        // Match exact endpoints; /proc encodes each address word in host byte order.
        const bytes = hexAddress.match(/../g);
        const decoded = os.endianness() === 'LE'
          ? bytes.reduce((out, _, i) => i % 4 === 0 ? [...out, ...bytes.slice(i, i + 4).reverse()] : out, []) : bytes;
        const address = decoded.length === 4 ? decoded.map((x) => parseInt(x, 16)).join('.')
          : new URL(`http://[${decoded.join('').match(/.{4}/g).join(':')}]`).hostname.slice(1, -1);
        const matches = missing.filter((l) => l.port === parseInt(hexPort, 16) && l.address === address);
        if (matches.length) inodes.set(fields[9], matches);
      }
    } catch { /* Missing /proc files are expected on non-Linux hosts. */ }
  }
  if (!inodes.size) return;
  let steps = 0;
  // Yield to the event loop regularly: a host with thousands of descriptors would otherwise
  // keep the main thread busy with promise continuations for seconds.
  const tick = async () => { if (++steps % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve)); };
  for (const pid of (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
    try {
      for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        await tick();
        const inode = (await fs.readlink(`/proc/${pid}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/)?.[1];
        if (!inodes.has(inode)) continue;
        const command = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        for (const l of inodes.get(inode)) { l.pid = Number(pid); l.command = command; }
      }
    } catch { /* Processes can exit or deny access during a snapshot. */ }
  }
}

const YIELD_EVERY = 64;
const UNOWNED_LISTENER_TTL_MS = 5 * 60_000;

/**
 * Wraps the /proc owner walk. A listener with no visible owner (a kernel or DNS relay socket)
 * stays unresolved on every attempt, and one such port would otherwise cost a walk over every
 * file descriptor of every process on each snapshot, so it is remembered for a while.
 *
 * @param {typeof resolveProcOwners} [resolve]
 * @param {{ ttl?: number, now?: () => number }} [options]
 * @returns {(listeners: any[]) => Promise<void>}
 */
export function createCachedProcOwners(resolve = resolveProcOwners, { ttl = UNOWNED_LISTENER_TTL_MS, now = Date.now } = {}) {
  /** @type {Map<string, number>} */
  const unowned = new Map();
  const key = (l) => `${l.address}:${l.port}`;
  return async (listeners) => {
    const at = now();
    const pending = listeners.filter((l) => !l.pid && !(unowned.get(key(l)) > at));
    if (!pending.length) return;
    await resolve(pending);
    for (const l of pending) {
      if (l.pid) unowned.delete(key(l));
      else unowned.set(key(l), at + ttl);
    }
  };
}

/** Shared by the network report and the apps monitor, which see the same listeners. */
export const cachedProcOwners = createCachedProcOwners();

export function createNetEnvService({ executor = execute, platform = process.platform, release = os.release(),
  read = readFile, procOwners = cachedProcOwners, timeout = 1500, ttl = 15000,
  now = Date.now, getHost = () => null, getBind = /** @returns {string} */ () => '127.0.0.1', getLanExposed = /** @returns {boolean} */ () => false,
  getHelper = null } = {}) {
  let cache;
  let expires = 0;
  let pending;
  /** The Windows profile never moves during a run, so its two interop calls are made once. */
  let wslConfigPath = null;
  async function collect() {
    const reasons = [];
    const availability = { listeners: false, portproxy: false, wslAddresses: false, wslConfig: false, interop: false };
    async function run(source, file, args) {
      let timer;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => executor(file, args, { timeout })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), timeout); }),
        ]);
        return String(value?.stdout ?? value);
      } catch (error) {
        reasons.push({ source, code: String(error.code || 'UNAVAILABLE'), description: `${source} could not be read.` });
        return null;
      } finally { clearTimeout(timer); }
    }
    const isWsl = platform === 'linux' && /microsoft.*wsl2|wsl2.*microsoft/i.test(release);
    const hostPlatform = isWsl ? 'wsl2' : ({ linux: 'linux', win32: 'windows', darwin: 'macos' }[platform] || 'unknown');
    let listeners = [];
    let networkingMode = null;
    let portproxy = [];
    let wslAddresses = [];
    let wslConfig = null;
    if (platform === 'linux') {
      const ss = await run('listeners', 'ss', ['-ltnpH']);
      availability.listeners = ss !== null;
      listeners = parseSs(ss || '');
      try { await procOwners(listeners); } catch { reasons.push({ source: 'processOwners', code: 'UNAVAILABLE', description: 'Process ownership is partially unavailable.' }); }
    } else reasons.push({ source: 'listeners', code: 'UNSUPPORTED', description: 'Listener collection currently requires Linux ss.' });
    if (isWsl) {
      // netsh doubles as the interop probe: a separate powershell.exe start only added latency.
      const [mode, addresses, rules] = await Promise.all([
        run('networkingMode', 'wslinfo', ['--networking-mode']),
        run('wslAddresses', 'hostname', ['-I']),
        run('interop', 'netsh.exe', ['interface', 'portproxy', 'show', 'all']),
      ]);
      networkingMode = parseNetworkingMode(mode || '');
      if (mode !== null && !networkingMode) reasons.push({ source: 'networkingMode', code: 'UNKNOWN_MODE', description: 'WSL networking mode was not recognized.' });
      wslAddresses = (addresses || '').trim().split(/\s+/).filter((x) => isIP(x));
      availability.wslAddresses = addresses !== null && wslAddresses.length > 0;
      availability.interop = rules !== null;
      if (availability.interop) {
        availability.portproxy = true;
        portproxy = parsePortproxy(rules || '');
        if (!wslConfigPath) {
          const profile = await run('wslConfigPath', 'cmd.exe', ['/d', '/c', 'echo %USERPROFILE%']);
          if (profile && !profile.includes('%USERPROFILE%')) {
            wslConfigPath = (await run('wslConfigPath', 'wslpath', ['-u', `${profile.trim()}\\.wslconfig`]))?.trim() || null;
          } else if (profile !== null) reasons.push({ source: 'wslConfigPath', code: 'UNAVAILABLE', description: 'Windows profile path is unavailable.' });
        }
        if (wslConfigPath) {
          try { wslConfig = parseWslConfig(await read(wslConfigPath, 'utf8')); availability.wslConfig = true; }
          catch (error) { reasons.push({ source: 'wslConfig', code: String(error.code || 'UNAVAILABLE'), description: 'The optional .wslconfig file could not be read.' }); }
        }
      }
    }
    const report = { schemaVersion: 1, collectedAt: new Date(now()).toISOString(), platform: hostPlatform,
      partial: reasons.length > 0, reasons, availability, networkingMode, wslAddresses, wslConfig, listeners, portproxy,
      cretli: { lanHost: getHost(), bind: getBind(), lanExposed: getLanExposed() }, issues: [] };
    report.issues = classifyIssues(report);
    // Optional Windows helper status (stage 4); absent unless a provider is wired and this is WSL2.
    if (getHelper && isWsl) {
      try { report.helper = await getHelper(); } catch { report.helper = { state: 'unavailable', installed: false, version: null, mode: null, rules: null }; }
    }
    return report;
  }
  function start() {
    pending = collect().then((report) => { cache = report; expires = now() + ttl; return report; }).finally(() => { pending = null; });
    return pending;
  }
  return {
    /**
     * @param {{ refresh?: boolean, stale?: boolean }} [opts] `stale` answers from the last report at
     *   once and renews it in the background, for callers that paint and may repaint later.
     */
    async getReport({ refresh = false, stale = false } = {}) {
      if (stale && cache) {
        if (now() >= expires && !pending) start().catch(() => {});
        return cache;
      }
      if (pending) return pending;
      if (!refresh && cache && now() < expires) return cache;
      return start();
    },
    /** Last report without waiting; starts a collection when there is none. Never rejects. */
    peek() {
      if (!cache && !pending) start().catch(() => {});
      return cache || null;
    },
  };
}
