#!/usr/bin/env node
/**
 * One-time OFFLINE safety snapshot of a local Cretli installation (Linux only).
 *
 * This is an operator tool for a single installation, NOT the product portable
 * export/restore. The archive it produces is PRIVATE and UNENCRYPTED: it may hold
 * conversation text and configuration secrets. Never upload or share it.
 *
 * Default action is `plan` (preflight): no signals are sent and no data contents
 * are read. `--apply` stops the exact server process gracefully (the server only ever
 * receives SIGTERM; only the helper's own bounded workers are SIGKILLed on timeout), copies the data root into a private staging area (SQLite via the
 * native backup API), validates it, builds a tar.gz, verifies it in an isolated
 * extraction, publishes atomically, and restarts the server in a `finally`.
 *
 * Excluded by design (never walked or copied): native provider homes, runtime
 * homes, managed venvs, scratch, SDK stores, agent transcripts, npm caches, auth/TLS material, push keys,
 * runtime lock/SHM/socket/pid files, and the project's `.env`.
 * See docs/storage-pre-cutover-runbook.md.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT = 'cretli-offline-snapshot/1';
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * Top-level data-root names that are never walked or copied. Exact names only (no
 * prefix/regex), so user-state names that merely start the same way stay in scope.
 * Each native home / venv / cache below is a directory the code creates through
 * resolveDataPath() or a documented runtime path (lib/*-home.js, lib/zai, lib/sdk/cursor-share.ts).
 */
const DEFAULT_EXCLUDED_TOP = Object.freeze([
  // Native provider homes, runtime homes and agent stores (separate retention domain).
  'runtime-home', 'sdk-agent-store', 'agent-transcripts', 'claude-home', 'codex-home',
  'opencode-home', 'native-homes', 'cursor-home',
  'claude-api-home', 'codebuddy-home', 'qwen-home', 'dsh-home', 'cursor-share',
  // Managed interpreter environment and scratch space (rebuildable, not application state).
  'zai-sdk-venv', 'tmp', 'scout-test-snapshots',
  // Runtime lock written by the front-end watcher (not a *.lock name).
  'webpack-cli-watch-lock.json',
  // Diagnostic browser-debug logs (lib/routes/client-debug-routes.js): not application state, and
  // the live file can be world-writable.
  'client-debug.log', 'client-debug-prev.log',
  // Caches.
  '.npm', '.npm-cache', 'npm-cache', '.cache', 'node_modules',
  // Auth, sessions, TLS and push material (retained separately, never archived).
  'auth.json', 'sessions.json', 'vapid-keys.json', 'push-subscriptions.json',
  'key.pem', 'cert.pem', 'ssl', 'tls', 'certs',
]);
/** Runtime sidecars skipped at any depth (locks, SQLite SHM, sockets, pid files). */
const RUNTIME_SIDECAR_RE = /(-shm|\.lock|\.sock|\.pid)$/;
const SQLITE_EXT_RE = /\.(sqlite|sqlite3|db)$/;
const SQLITE_SIDECAR_RE = /^(.*\.(?:sqlite|sqlite3|db))-(wal|journal)$/;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SUPERVISOR_COMM_RE =
  /^(systemd|init|pm2|supervise|supervisord|runsv|s6-supervise|containerd-shim|docker-init|tini|dumb-init|forever|nodemon|monit|upstart)/i;
const COPY_CHUNK = 1024 * 1024;
const O_APPEND = 0o2000;
const LOG_FILE_RE = /\.(log|out|err)$/;
/** Opt-in launch profile for the known `npm start` deployment (process.title hides argv). */
const PROFILE_ID = 'cretli-npm-start-v1';
const PROFILE_START_SCRIPT = 'CURSOR_RIPGREP_PATH=./node_modules/.bin/rg bash ./scripts/start-server-node22.sh';
const PROFILE_FILES = Object.freeze({
  entry: 'server.js', launcher: 'scripts/start-server-node22.sh',
  bootEnv: 'lib/register-boot-env.js', packageJson: 'package.json',
});

const DEFAULTS = Object.freeze({
  stopTimeoutMs: 60_000,
  workerTimeoutMs: 3_600_000,
  workerMaxOldSpaceMb: 1024,
  maxJsonBytes: 256 * 1024 * 1024,
  maxJsonlLineBytes: 64 * 1024 * 1024,
  maxFiles: 2_000_000,
  restartVerifyMs: 5_000,
  // Bounded extra watch after STOP_TIMEOUT: SIGTERM was already delivered, so a late exit must still restart.
  lateExitMonitorMs: 120_000,
  // Time for known descendants of the stopped server to disappear before the copy.
  descendantWaitMs: 5_000,
  // Time the detached helper waits to be reparented away from the server's process tree.
  barrierTimeoutMs: 15_000,
});

/** Error carrying only a stable code and non-content detail; never a raw cause message. */
class SnapshotError extends Error {
  /**
   * @param {string} code
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** Reduce any thrown value to a sanitized { code, detail } (no message text, no snippets). */
function sanitizeError(err) {
  if (err instanceof SnapshotError) return { code: err.code, detail: err.detail };
  const sys = err && typeof err.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(err.code) ? err.code : null;
  return { code: 'INTERNAL', detail: sys ? { errno: sys } : {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ args */

const VALUE_FLAGS = new Set([
  'project-root', 'data-root', 'output-root', 'pid', 'node-exe', 'stop-timeout-ms',
  'worker-timeout-ms', 'worker-max-old-space-mb', 'max-json-bytes', 'max-jsonl-line-bytes',
  'max-files', 'restart-mode', 'restart-verify-ms', 'confirm-identity', 'exclude-name',
  'internal-op-id', 'internal-worker', 'config', 'late-exit-monitor-ms', 'descendant-wait-ms',
  'barrier-timeout-ms', 'launch-profile', 'confirm-profile-digest', 'data-owner-uid',
  'stopped-hook', 'confirm-hook-sha256',
]);
const BOOL_FLAGS = new Set([
  'apply', 'detach', 'allow-root-service', 'confirm-stop-all-sessions',
  'confirm-archive-history', 'internal-detached', 'help',
]);

function parseArgs(argv) {
  const out = { excludeNames: [] };
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) throw new SnapshotError('ARG_INVALID', { arg: 'positional' });
    const key = raw.slice(2);
    if (BOOL_FLAGS.has(key)) {
      out[camel(key)] = true;
    } else if (VALUE_FLAGS.has(key)) {
      i += 1;
      if (i >= argv.length) throw new SnapshotError('ARG_INVALID', { arg: key });
      if (key === 'exclude-name') out.excludeNames.push(argv[i]);
      else out[camel(key)] = argv[i];
    } else {
      throw new SnapshotError('ARG_INVALID', { arg: key });
    }
  }
  return out;
}

function intOpt(value, fallback, name, min = 1) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new SnapshotError('ARG_INVALID', { arg: name });
  return n;
}

function normalizeOptions(args) {
  if (args.help) return { help: true };
  for (const k of ['projectRoot', 'dataRoot', 'outputRoot', 'pid']) {
    if (!args[k]) throw new SnapshotError('ARG_MISSING', { arg: k });
  }
  const pid = Number(args.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new SnapshotError('ARG_INVALID', { arg: 'pid' });
  const restartMode = args.restartMode ?? 'self';
  if (!['self', 'supervisor'].includes(restartMode)) throw new SnapshotError('ARG_INVALID', { arg: 'restart-mode' });
  if (args.launchProfile !== undefined && args.launchProfile !== PROFILE_ID) {
    throw new SnapshotError('ARG_INVALID', { arg: 'launch-profile' });
  }
  for (const n of args.excludeNames) {
    if (!n || n.includes('/') || n === '.' || n === '..') throw new SnapshotError('ARG_INVALID', { arg: 'exclude-name' });
  }
  return {
    ...args,
    pid,
    restartMode,
    projectRoot: path.resolve(args.projectRoot),
    dataRoot: path.resolve(args.dataRoot),
    outputRoot: path.resolve(args.outputRoot),
    stopTimeoutMs: intOpt(args.stopTimeoutMs, DEFAULTS.stopTimeoutMs, 'stop-timeout-ms'),
    workerTimeoutMs: intOpt(args.workerTimeoutMs, DEFAULTS.workerTimeoutMs, 'worker-timeout-ms'),
    workerMaxOldSpaceMb: intOpt(args.workerMaxOldSpaceMb, DEFAULTS.workerMaxOldSpaceMb, 'worker-max-old-space-mb', 64),
    maxJsonBytes: intOpt(args.maxJsonBytes, DEFAULTS.maxJsonBytes, 'max-json-bytes'),
    maxJsonlLineBytes: intOpt(args.maxJsonlLineBytes, DEFAULTS.maxJsonlLineBytes, 'max-jsonl-line-bytes'),
    maxFiles: intOpt(args.maxFiles, DEFAULTS.maxFiles, 'max-files'),
    restartVerifyMs: intOpt(args.restartVerifyMs, DEFAULTS.restartVerifyMs, 'restart-verify-ms', 0),
    lateExitMonitorMs: intOpt(args.lateExitMonitorMs, DEFAULTS.lateExitMonitorMs, 'late-exit-monitor-ms', 0),
    descendantWaitMs: intOpt(args.descendantWaitMs, DEFAULTS.descendantWaitMs, 'descendant-wait-ms', 0),
    profileRestartWaitMs: 60_000,
    barrierTimeoutMs: intOpt(args.barrierTimeoutMs, DEFAULTS.barrierTimeoutMs, 'barrier-timeout-ms', 0),
    dataOwnerUid: args.dataOwnerUid === undefined ? null : intOpt(args.dataOwnerUid, null, 'data-owner-uid', 0),
    stoppedHook: args.stoppedHook === undefined ? null : path.resolve(args.stoppedHook),
    excludedNames: new Set([...DEFAULT_EXCLUDED_TOP, ...args.excludeNames]),
  };
}

/* ------------------------------------------------------------- /proc view */

/** Parse /proc/<pid>/stat; null when the process is gone. */
function readStat(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = text.lastIndexOf(')');
  const rest = text.slice(close + 2).split(' ');
  return {
    pid,
    comm: text.slice(text.indexOf('(') + 1, close),
    state: rest[0],
    ppid: Number(rest[1]),
    startTicks: rest[19],
  };
}

function readUids(pid) {
  try {
    const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? { real: Number(m[1]), effective: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

function listPids() {
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
}

function isGone(pid, startTicks) {
  const st = readStat(pid);
  return !st || st.state === 'Z' || st.state === 'X' || (startTicks !== undefined && st.startTicks !== startTicks);
}

/** pids of `rootPid` and everything below it. */
function descendantsOf(rootPid) {
  const children = new Map();
  for (const pid of listPids()) {
    const st = readStat(pid);
    if (!st) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(pid);
  }
  const out = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.pop()) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}

function ancestorsOf(pid) {
  const out = [];
  let cur = readStat(pid);
  while (cur && cur.ppid > 0 && out.length < 64) {
    out.push(cur.ppid);
    cur = readStat(cur.ppid);
  }
  return out;
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Identity of a process: start time, real cwd, exe, argv and the project entry.
 * Never reads the environment (see captureEnvelope for the apply-only capture).
 */
function captureIdentity(pid, projectReal, entryReal) {
  const st = readStat(pid);
  if (!st) return null;
  const uids = readUids(pid);
  let cwd = null;
  let exe = null;
  let argv = [];
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    exe = fs.readlinkSync(`/proc/${pid}/exe`);
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x, i, a) => i < a.length - 1 || x);
  } catch {
    // unreadable (other uid): fields stay null and the guards below refuse
  }
  const cwdReal = cwd ? realOrNull(cwd) : null;
  let entryMatch = false;
  if (cwdReal) {
    entryMatch = argv.slice(1).some((a) => !a.startsWith('-') && realOrNull(path.resolve(cwdReal, a)) === entryReal);
  }
  return {
    pid,
    state: st.state,
    ppid: st.ppid,
    parentComm: readStat(st.ppid)?.comm ?? null,
    startTicks: st.startTicks,
    uid: uids?.real ?? null,
    euid: uids?.effective ?? null,
    cwd: cwdReal,
    exe,
    cwdMatches: cwdReal === projectReal,
    entryMatches: entryMatch,
    comm: st.comm,
    argc: argv.length,
    // argv after dropping trailing empties; a process-title rewrite leaves just the title here.
    argvTokens: argv.filter((x) => x !== ''),
    argvHash: createHash('sha256').update(argv.join('\0')).digest('hex'),
  };
}

/** Realpath of a process's exe, or null (unreadable / deleted). */
function exeRealOf(id) {
  return id.exe && !id.exe.endsWith(' (deleted)') ? realOrNull(id.exe) : null;
}

/**
 * Whether `id` is a Cretli server for this project. Generic mode needs the entry in argv.
 * Profile mode accepts the opaque title-rewritten process (same cwd, same node exe, comm
 * `cretli`); it never replaces the cwd check.
 */
function looksLikeServer(id, profile) {
  if (!id || !id.cwdMatches || id.state === 'Z') return false;
  if (id.entryMatches) return true;
  return !!profile && id.comm === 'cretli' && exeRealOf(id) === profile.nodeReal;
}

function fingerprintOf(id, entryReal, extras = null) {
  return createHash('sha256')
    .update(JSON.stringify([id.pid, id.startTicks, id.uid, id.cwd, id.exe, entryReal, id.argc, extras]))
    .digest('hex')
    .slice(0, 16);
}

/** Other processes that look like a Cretli server for this project. */
function findServerProcesses(projectReal, entryReal, excludePids, profile = null) {
  const found = [];
  for (const pid of listPids()) {
    if (excludePids.has(pid)) continue;
    const id = captureIdentity(pid, projectReal, entryReal);
    if (looksLikeServer(id, profile)) found.push(id);
  }
  return found;
}

/* ----------------------------------------------- sockets and loopback health */

/** Inodes of the sockets a process holds (metadata only). */
function socketInodes(pid) {
  const out = new Set();
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return out;
  }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) out.add(m[1]);
    } catch {
      // fd closed meanwhile
    }
  }
  return out;
}

/**
 * Listening TCP sockets owned by `pid`: [{ port, bind }] where bind is `loopback`, `any` or `other`.
 * Reads /proc/net/tcp{,6} rows (state 0A) and matches inodes against the process's own fds.
 */
function listeningSockets(pid) {
  const inodes = socketInodes(pid);
  const found = new Map();
  if (!inodes.size) return [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A' || !inodes.has(f[9])) continue;
      const [addr, portHex] = f[1].split(':');
      const port = parseInt(portHex, 16);
      const zeros = /^0+$/.test(addr);
      const bind = zeros ? 'any' : (addr === '0100007F' || addr === '00000000000000000000000001000000') ? 'loopback' : 'other';
      found.set(port, bind);
    }
  }
  return [...found].map(([port, bind]) => ({ port, bind })).sort((a, b) => a.port - b.port);
}

/** One credential-free GET /api/health on loopback. */
function healthOnce(scheme, port, timeoutMs) {
  const mod = scheme === 'https' ? https : http;
  return new Promise((resolve) => {
    const req = mod.request({
      host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: timeoutMs,
      // Loopback only; nothing secret is sent, so an untrusted local certificate is acceptable.
      ...(scheme === 'https' ? { rejectUnauthorized: false } : {}), agent: false, headers: { accept: 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 65536) body += d; });
      res.on('end', () => {
        let ok = false;
        try {
          ok = res.statusCode === 200 && JSON.parse(body)?.ok === true;
        } catch {
          // not JSON
        }
        resolve(ok);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Health on the first probeable listener; returns the scheme that answered or null. */
async function probeHealth(sockets, timeoutMs = 2000) {
  for (const s of sockets.filter((x) => x.bind !== 'other')) {
    for (const scheme of ['https', 'http']) {
      if (await healthOnce(scheme, s.port, timeoutMs)) return { scheme, port: s.port };
    }
  }
  return null;
}

/** dev:ino ids of the regular files a process holds as stdout/stderr (the server's own log fds). */
function stdioFileIds(pid) {
  const ids = new Set();
  for (const fd of [1, 2]) {
    try {
      const st = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
      if (st.isFile()) ids.add(`${st.dev}:${st.ino}`);
    } catch {
      // closed or unreadable
    }
  }
  return ids;
}

/**
 * Ancestor policy for inherited log descriptors: wrappers such as `npm start` / `sh` may hold
 * the very same append-only log fd the server writes to. Anything else they hold below the
 * data root (canonical JSON, SQLite, non-append, a different file) stays an unknown writer.
 * `pids` maps ancestor pid to its start ticks so a recycled pid never inherits the allowance.
 */
function buildAncestorPolicy(serverPid) {
  const pids = new Map();
  for (const p of ancestorsOf(serverPid)) {
    const st = readStat(p);
    if (st) pids.set(p, st.startTicks);
  }
  return { pids, logIds: stdioFileIds(serverPid) };
}

/** Verdict for one writable fd of an allowed-ancestor process: null when acceptable, else a class. */
function ancestorFdClass(pid, fd, flags, policy) {
  if ((flags & O_APPEND) === 0) return 'ancestor-not-append';
  let st;
  try {
    st = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
  } catch {
    return 'ancestor-unreadable';
  }
  if (!st.isFile()) return 'ancestor-not-regular';
  const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/, '');
  const base = path.basename(target);
  if (SQLITE_EXT_RE.test(base) || SQLITE_SIDECAR_RE.test(base)) return 'ancestor-sqlite';
  if (!LOG_FILE_RE.test(base)) return 'ancestor-canonical-data';
  return policy.logIds.has(`${st.dev}:${st.ino}`) ? null : 'ancestor-foreign-log';
}

/**
 * Processes (outside `allowed`) holding a writable fd below the data root.
 * Processes of other uids whose fds cannot be read are counted as unverifiable.
 * A process listed in `policy.pids` (ancestor wrapper) is accepted only when every writable
 * fd it holds there is the server's own append-only log; otherwise it is reported with a class.
 */
function scanWriters(dataReal, excludedNames, allowed, policy = null) {
  const writers = [];
  let unverifiable = 0;
  let scanFailed = 0;
  let inheritedLogFds = 0;
  const myUid = process.getuid();
  for (const pid of listPids()) {
    if (allowed.has(pid) || pid === process.pid) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ESRCH') continue;
      // `tolerate-unreadable-fds` (test-only fault hook): hosted CI runners hold
      // unreadable same-uid processes that no test fixture controls.
      if (readUids(pid)?.real !== myUid || fault('tolerate-unreadable-fds')) unverifiable += 1;
      else scanFailed += 1;
      continue;
    }
    const isAncestor = !!policy && policy.pids.has(pid) && readStat(pid)?.startTicks === policy.pids.get(pid);
    let badClass = null;
    let okFds = 0;
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/, '');
      } catch {
        continue;
      }
      if (!target.startsWith(dataReal + path.sep)) continue;
      const top = target.slice(dataReal.length + 1).split(path.sep)[0];
      if (excludedNames.has(top)) continue;
      let flags = 0;
      try {
        flags = parseInt(/flags:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))?.[1] ?? '0', 8);
      } catch {
        continue;
      }
      if ((flags & 3) === 0) continue;
      const cls = isAncestor ? ancestorFdClass(pid, fd, flags, policy) : 'unrelated';
      if (cls) {
        badClass = cls;
        break;
      }
      okFds += 1;
    }
    if (badClass) writers.push({ pid, comm: readStat(pid)?.comm ?? '?', class: badClass });
    else inheritedLogFds += okFds;
  }
  return { writers, unverifiable, scanFailed, inheritedLogFds };
}

/* ------------------------------------------------------- source inventory */

function isRuntimeSidecar(name) {
  return RUNTIME_SIDECAR_RE.test(name);
}

/**
 * Metadata-only walk of the data root. Excluded names are never entered. Returns
 * entries plus problems; contents are not read.
 */
function walkSource(dataReal, excludedNames, maxFiles, owners = null) {
  const entries = [];
  const problems = [];
  const excludedPresent = [];
  let files = 0;
  let bytes = 0;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(path.join(dataReal, relDir), { withFileTypes: true });
    } catch {
      problems.push({ code: 'SOURCE_UNREADABLE', path: relDir || '.' });
      continue;
    }
    for (const d of dirents) {
      const rel = relDir ? path.posix.join(relDir, d.name) : d.name;
      if ((!relDir && excludedNames.has(d.name)) || isRuntimeSidecar(d.name)) {
        if (!relDir) excludedPresent.push(d.name);
        continue;
      }
      let st;
      try {
        st = fs.lstatSync(path.join(dataReal, rel), { bigint: true });
      } catch {
        problems.push({ code: 'SOURCE_UNREADABLE', path: rel });
        continue;
      }
      if (!st.isSymbolicLink() && owners) {
        // Metadata guards only: no chmod/chown; an unexpected owner or write bit is refused.
        if (!owners.uids.has(Number(st.uid))) problems.push({ code: 'SOURCE_UNEXPECTED_OWNER', path: rel });
        const m = Number(st.mode);
        if ((m & 0o002) !== 0 || (owners.strictGroup && (m & 0o020) !== 0)) problems.push({ code: 'SOURCE_WRITABLE_BY_OTHERS', path: rel });
      }
      if (st.isSymbolicLink()) {
        problems.push({ code: 'SYMLINK_IN_SOURCE', path: rel });
      } else if (st.isDirectory()) {
        entries.push({ rel, type: 'dir' });
        stack.push(rel);
      } else if (st.isFile()) {
        files += 1;
        if (files > maxFiles) {
          problems.push({ code: 'TOO_MANY_FILES', path: '.' });
          return { entries, problems, excludedPresent, files, bytes };
        }
        bytes += Number(st.size);
        entries.push({
          rel, type: 'file', size: st.size.toString(), mtimeNs: st.mtimeNs.toString(),
          ino: st.ino.toString(), dev: st.dev.toString(),
        });
      } else {
        problems.push({ code: 'SOURCE_UNSUPPORTED_TYPE', path: rel });
      }
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  // Classify SQLite databases and attach their -wal/-journal sidecars.
  const byRel = new Map(entries.map((e) => [e.rel, e]));
  for (const e of entries) {
    if (e.type !== 'file') continue;
    const sc = SQLITE_SIDECAR_RE.exec(e.rel);
    if (sc) {
      const main = byRel.get(sc[1]);
      if (main) {
        e.type = 'sqlite-sidecar';
        e.of = sc[1];
      } else {
        problems.push({ code: 'ORPHAN_SQLITE_SIDECAR', path: e.rel });
      }
    } else if (SQLITE_EXT_RE.test(e.rel)) {
      e.type = 'sqlite';
    }
  }
  return { entries, problems, excludedPresent, files, bytes };
}

/** Top-level path component reduced to a safe token; the only path text a report may carry. */
function topOf(rel) {
  return String(rel).split(/[\\/]/)[0].replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 40) || '.';
}

/** Collapse per-path problems into { code, detail: { count, examples } } (max 3 sanitized top-level names). */
function summarizeProblems(problems) {
  const byCode = new Map();
  for (const p of problems) {
    const cur = byCode.get(p.code) ?? { count: 0, examples: [] };
    cur.count += 1;
    const t = topOf(p.path ?? '.');
    if (cur.examples.length < 3 && !cur.examples.includes(t)) cur.examples.push(t);
    byCode.set(p.code, cur);
  }
  return [...byCode].map(([code, detail]) => ({ code, detail }));
}

function sameEntry(a, b) {
  return a.type === b.type && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.dev === b.dev;
}

/** Compare two inventories; returns the first differing path or null. */
function diffInventory(before, after) {
  const map = new Map(after.map((e) => [e.rel, e]));
  for (const e of before) {
    const o = map.get(e.rel);
    if (!o || !sameEntry(e, o)) return e.rel;
    map.delete(e.rel);
  }
  return map.size ? [...map.keys()][0] : null;
}

/* ---------------------------------------------------------- fs primitives */

function fsyncPath(p) {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function sha256File(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* -------------------------------------------------------------- operation */

/** Private operation directory: status.json (phases) and ops.log (codes only). */
class Operation {
  constructor(opDir, opId) {
    this.opDir = opDir;
    this.opId = opId;
    this.statusPath = path.join(opDir, 'status.json');
    this.logPath = path.join(opDir, 'ops.log');
    this.status = { format: FORMAT, operationId: opId, state: 'running', phases: [], restart: null, result: null };
  }

  static create(outputReal, opId) {
    const opDir = path.join(outputReal, `cretli-snapshot-${opId}`);
    fs.mkdirSync(opDir, { mode: 0o700 });
    fs.chmodSync(opDir, 0o700);
    const op = new Operation(opDir, opId);
    fs.closeSync(fs.openSync(op.logPath, 'a', 0o600));
    fs.chmodSync(op.logPath, 0o600);
    op.flush();
    return op;
  }

  static adopt(outputReal, opId) {
    const opDir = path.join(outputReal, `cretli-snapshot-${opId}`);
    const st = fs.lstatSync(opDir);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
      throw new SnapshotError('OPDIR_INVALID');
    }
    const op = new Operation(opDir, opId);
    try {
      op.status = JSON.parse(fs.readFileSync(op.statusPath, 'utf8'));
    } catch {
      // keep the fresh status
    }
    return op;
  }

  flush() {
    writeJsonAtomic(this.statusPath, this.status);
  }

  log(line) {
    fs.appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  }

  /** @param {string} name @param {'start'|'ok'|'failed'|'skipped'} state */
  phase(name, state, detail) {
    const entry = { name, state, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
    this.status.phases.push(entry);
    this.log(`phase=${name} state=${state}${detail?.code ? ` code=${detail.code}` : ''}`);
    this.flush();
  }

  finish(state, patch) {
    Object.assign(this.status, patch, { state, finishedAt: new Date().toISOString() });
    this.log(`final state=${state}`);
    this.flush();
  }
}

/* -------------------------------------------------------------- preflight */

function checkDirOwnedPrivate(dir, code, refusals, { requirePrivate }) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    refusals.push({ code });
    return false;
  }
  if (!st.isDirectory() || st.uid !== process.getuid()) {
    refusals.push({ code });
    return false;
  }
  if (requirePrivate && (st.mode & 0o022) !== 0) {
    refusals.push({ code: `${code}_PERMS` });
    return false;
  }
  return true;
}

/**
 * Classify the data root by stat metadata only (no chmod/chown, no content read). A data root
 * owned by another uid is accepted solely when `--data-owner-uid` names exactly that uid, and
 * then it must not be group/world writable. The binding is part of the confirmed fingerprint.
 */
function checkDataRoot(dataReal, opts, refusals) {
  const uid = process.getuid();
  let st;
  try {
    st = fs.statSync(dataReal);
  } catch {
    refusals.push({ code: 'DATA_ROOT_INVALID' });
    return { binding: null, relation: 'unknown', owners: { uids: new Set([uid]), strictGroup: false } };
  }
  const declared = opts.dataOwnerUid;
  let relation = 'same-uid';
  if (st.uid !== uid) relation = declared === st.uid ? 'declared-other-uid' : 'undeclared-other-uid';
  if (!st.isDirectory()) refusals.push({ code: 'DATA_ROOT_INVALID' });
  else if (relation === 'undeclared-other-uid') {
    refusals.push({ code: 'DATA_ROOT_INVALID', detail: { ownerRelation: relation, dataUid: st.uid, helperUid: uid } });
  }
  if (declared !== null && declared !== st.uid) refusals.push({ code: 'DATA_OWNER_MISMATCH', detail: { declared, dataUid: st.uid } });
  const foreign = relation !== 'same-uid';
  if ((st.mode & 0o002) !== 0 || (foreign && (st.mode & 0o020) !== 0)) {
    refusals.push({ code: 'DATA_ROOT_PERMS', detail: { mode: (st.mode & 0o7777).toString(8) } });
  }
  const uids = new Set([uid]);
  if (relation === 'declared-other-uid') uids.add(st.uid);
  return {
    relation,
    binding: { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, dev: String(st.dev), ino: String(st.ino) },
    owners: { uids, strictGroup: foreign },
  };
}

function bindingExtras(dataBinding, opts, profile) {
  return {
    data: dataBinding ? [dataBinding.uid, dataBinding.gid, dataBinding.mode, dataBinding.dev, dataBinding.ino] : null,
    owner: opts.dataOwnerUid, profile: profile?.digest ?? null,
  };
}

/**
 * Opt-in launch profile for the known `npm start` deployment. server.js sets process.title, so
 * /proc/<pid>/cmdline no longer holds the original argv and the generic entry guard cannot
 * match. The profile does not pretend to recover argv: it binds the PID to static, hashed code
 * (entry, launcher, boot-env loader, package.json start script), the node exe, cwd, uid, start
 * time, the title, and a TCP listener owned by that PID answering /api/health on loopback.
 * Everything is reduced to a digest the operator must confirm separately before --apply.
 */
async function buildLaunchProfile(opts, identity, projectReal, owners) {
  const refusals = [];
  const nodeReal = opts.nodeExe ? realOrNull(opts.nodeExe) : null;
  if (!nodeReal) refusals.push({ code: 'PROFILE_NODE_EXE_REQUIRED' });
  const opaque = identity.comm === 'cretli' && !identity.entryMatches
    && identity.argvTokens.length <= 1 && (identity.argvTokens[0] ?? 'cretli') === 'cretli';
  if (!opaque) refusals.push({ code: 'PROFILE_ARGV_NOT_OPAQUE', detail: { comm: identity.comm, argc: identity.argc } });

  const files = {};
  const texts = {};
  for (const [key, rel] of Object.entries(PROFILE_FILES)) {
    const abs = path.join(projectReal, rel);
    const real = realOrNull(abs);
    let st = null;
    try {
      st = real ? fs.lstatSync(real) : null;
    } catch {
      // handled below
    }
    if (!real || !st || !st.isFile() || !isInside(real, projectReal) || real !== path.join(projectReal, rel)) {
      refusals.push({ code: 'PROFILE_CODE_MISSING', detail: { file: key } });
      continue;
    }
    if (!owners.uids.has(st.uid) || (st.mode & 0o022) !== 0) {
      refusals.push({ code: 'PROFILE_CODE_UNTRUSTED', detail: { file: key, uid: st.uid, mode: (st.mode & 0o7777).toString(8) } });
      continue;
    }
    files[key] = { rel, sha256: sha256File(real), bytes: st.size };
    texts[key] = fs.readFileSync(real, 'utf8');
  }
  if (texts.packageJson) {
    let start = null;
    try {
      start = JSON.parse(texts.packageJson)?.scripts?.start;
    } catch {
      // invalid
    }
    if (start !== PROFILE_START_SCRIPT) refusals.push({ code: 'PROFILE_START_SCRIPT_MISMATCH' });
  }
  if (texts.launcher && !(texts.launcher.includes('register-boot-env.js') && /exec node /.test(texts.launcher) && texts.launcher.includes('server.js'))) {
    refusals.push({ code: 'PROFILE_LAUNCHER_UNEXPECTED' });
  }
  if (texts.entry && !/process\.title\s*=\s*'cretli'/.test(texts.entry)) refusals.push({ code: 'PROFILE_ENTRY_TITLE_UNEXPECTED' });

  const sockets = listeningSockets(identity.pid);
  if (!sockets.length) refusals.push({ code: 'PROFILE_NO_LISTENER' });
  const health = sockets.length ? await probeHealth(sockets) : null;
  if (sockets.length && !health) refusals.push({ code: 'PROFILE_HEALTH_FAILED' });

  const descriptor = {
    profile: PROFILE_ID, pid: identity.pid, startTicks: identity.startTicks, uid: identity.uid, title: 'cretli',
    argv: 'opaque', nodeExe: nodeReal, cwd: identity.cwd, files, listeners: sockets,
  };
  const digest = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 32);
  return { refusals, profile: { id: PROFILE_ID, nodeReal, descriptor, digest, health: health ? health.scheme : null } };
}

/**
 * Collect every refusal in one pass so `plan` shows all blockers. Sends no
 * signals and reads no file contents or process environment.
 */
/**
 * Load and pin the stopped-window hook: a JSON spec `{ script, scriptSha256, args }` whose own SHA-256 must equal
 * `--confirm-hook-sha256`, naming a regular .mjs file that matches its pinned hash. Only metadata is returned;
 * the hook runs with a minimal environment and its argv is never logged.
 */
function loadHookSpec(opts) {
  try {
    if (!opts.confirmHookSha256) return { refusal: 'CONFIRM_HOOK_SHA256_MISSING' };
    const specBytes = fs.readFileSync(opts.stoppedHook);
    if (createHash('sha256').update(specBytes).digest('hex') !== opts.confirmHookSha256) return { refusal: 'HOOK_SPEC_MISMATCH' };
    const spec = JSON.parse(specBytes.toString('utf8'));
    if (!spec || typeof spec.script !== 'string' || !path.isAbsolute(spec.script) || !spec.script.endsWith('.mjs')) return { refusal: 'HOOK_SPEC_INVALID' };
    if (!Array.isArray(spec.args) || spec.args.length > 64 || spec.args.some((a) => typeof a !== 'string' || a.includes('\0'))) return { refusal: 'HOOK_SPEC_INVALID' };
    const st = fs.lstatSync(spec.script);
    if (!st.isFile() || st.isSymbolicLink()) return { refusal: 'HOOK_SCRIPT_INVALID' };
    if (sha256File(spec.script) !== spec.scriptSha256) return { refusal: 'HOOK_SCRIPT_MISMATCH' };
    return { hook: { script: spec.script, scriptSha256: spec.scriptSha256, args: spec.args, label: String(spec.label ?? 'hook').slice(0, 40) } };
  } catch {
    return { refusal: 'HOOK_SPEC_UNREADABLE' };
  }
}

async function preflight(opts, { apply }) {
  const refusals = [];
  const warnings = [];
  const uid = process.getuid();
  if (process.platform !== 'linux') refusals.push({ code: 'UNSUPPORTED_PLATFORM' });
  if (uid === 0 && !opts.allowRootService) refusals.push({ code: 'ROOT_HELPER_NOT_ALLOWED' });

  const projectReal = realOrNull(opts.projectRoot);
  const dataReal = realOrNull(opts.dataRoot);
  const outputReal = realOrNull(opts.outputRoot);
  const entryReal = projectReal ? realOrNull(path.join(projectReal, 'server.js')) : null;
  if (!projectReal || !entryReal) refusals.push({ code: 'PROJECT_ENTRY_MISSING' });
  let dataCheck = { binding: null, relation: 'unknown', owners: { uids: new Set([uid]), strictGroup: false } };
  if (!dataReal) refusals.push({ code: 'DATA_ROOT_MISSING' });
  else dataCheck = checkDataRoot(dataReal, opts, refusals);
  const outputOk = outputReal && checkDirOwnedPrivate(outputReal, 'OUTPUT_ROOT_INVALID', refusals, { requirePrivate: true });
  if (!outputReal) refusals.push({ code: 'OUTPUT_ROOT_MISSING' });
  if (outputReal && projectReal && (isInside(outputReal, projectReal) || isInside(projectReal, outputReal))) {
    refusals.push({ code: 'OUTPUT_OVERLAPS_PROJECT' });
  }
  if (outputReal && dataReal && (isInside(outputReal, dataReal) || isInside(dataReal, outputReal))) {
    refusals.push({ code: 'OUTPUT_OVERLAPS_DATA' });
  }

  // Target process identity.
  let identity = null;
  let fingerprint = null;
  let profile = null;
  if (projectReal && entryReal) {
    identity = captureIdentity(opts.pid, projectReal, entryReal);
    if (!identity || identity.state === 'Z') {
      refusals.push({ code: 'PID_NOT_FOUND' });
      identity = null;
    } else {
      if (identity.uid !== uid || identity.euid !== uid) refusals.push({ code: 'PID_UID_MISMATCH' });
      if (!identity.cwd) refusals.push({ code: 'PID_UNREADABLE' });
      else if (!identity.cwdMatches) refusals.push({ code: 'PID_CWD_MISMATCH' });
      if (identity.cwd && !identity.entryMatches && !opts.launchProfile) {
        // argv unreadable or rewritten (process.title): say so instead of a bare mismatch.
        refusals.push({ code: 'PID_ENTRY_MISMATCH', detail: { comm: identity.comm, argc: identity.argc, argvOpaque: identity.argvTokens.length <= 1 } });
      }
      const exeReal = exeRealOf(identity);
      const expectNode = opts.nodeExe ? realOrNull(opts.nodeExe) : null;
      if (!exeReal || (expectNode ? exeReal !== expectNode : !/^node(\d|\.|$)/.test(path.basename(exeReal)))) {
        refusals.push({ code: 'PID_EXE_MISMATCH' });
      }
      if (opts.launchProfile) {
        const built = await buildLaunchProfile(opts, identity, projectReal, dataCheck.owners);
        for (const r of built.refusals) refusals.push(r);
        profile = built.profile;
      }
      fingerprint = fingerprintOf(identity, entryReal, bindingExtras(dataCheck.binding, opts, profile));
    }
  }

  // Everything below the server tree may legitimately write before the stop.
  let allowed = new Set([opts.pid]);
  if (identity) {
    allowed = descendantsOf(opts.pid);
    if (ancestorsOf(process.pid).includes(opts.pid) && !opts.detach) {
      refusals.push({ code: 'HELPER_IS_DESCENDANT' });
    }
    const others = findServerProcesses(projectReal, entryReal, new Set([opts.pid, process.pid]), profile);
    if (others.length) refusals.push({ code: 'ANOTHER_SERVER_PRESENT', detail: { count: others.length } });
    const sup = identity.parentComm && SUPERVISOR_COMM_RE.test(identity.parentComm);
    if (sup && opts.restartMode === 'self') {
      refusals.push({ code: 'SUPERVISOR_SUSPECTED', detail: { parentComm: identity.parentComm } });
    }
    if (!sup && opts.restartMode === 'supervisor') {
      warnings.push({ code: 'SUPERVISOR_MODE_WITHOUT_SUPERVISOR_PARENT' });
    }
  }

  // Writers and source inventory.
  let inventory = null;
  let ancestorPolicy = null;
  let inheritedLogFds = 0;
  if (dataReal) {
    ancestorPolicy = identity ? buildAncestorPolicy(opts.pid) : null;
    const scan = scanWriters(dataReal, opts.excludedNames, allowed, ancestorPolicy);
    inheritedLogFds = scan.inheritedLogFds;
    if (scan.writers.length) refusals.push({ code: 'UNKNOWN_WRITER', detail: { writers: scan.writers } });
    if (scan.scanFailed) refusals.push({ code: 'FD_SCAN_FAILED', detail: { processes: scan.scanFailed } });
    if (scan.unverifiable) warnings.push({ code: 'FD_SCAN_UNVERIFIABLE_OTHER_UID', detail: { processes: scan.unverifiable } });
    inventory = walkSource(dataReal, opts.excludedNames, opts.maxFiles, dataCheck.owners);
    for (const r of summarizeProblems(inventory.problems)) refusals.push(r);
  }

  // Free space: stage + archive + verify extraction + SQLite scratch, with margin.
  let requiredBytes = null;
  let freeBytes = null;
  if (inventory && outputOk) {
    requiredBytes = inventory.bytes * 3 + 64 * 1024 * 1024;
    const sf = fs.statfsSync(outputReal);
    freeBytes = Number(sf.bavail) * Number(sf.bsize);
    if (freeBytes < requiredBytes) refusals.push({ code: 'INSUFFICIENT_SPACE', detail: { requiredBytes, freeBytes } });
  }

  // Backup capability floor: node:sqlite backup() needs Node >= 22.18 (matches scripts/run-unit-tests.mjs).
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 18)) refusals.push({ code: 'NODE_RUNTIME_TOO_OLD', detail: { required: '22.18', found: process.versions.node } });
  try {
    const sqlite = await import('node:sqlite');
    if (typeof sqlite.backup !== 'function' || typeof sqlite.DatabaseSync !== 'function') throw new Error('x');
  } catch {
    refusals.push({ code: 'NODE_SQLITE_BACKUP_UNAVAILABLE' });
  }

  let hook = null;
  if (apply) {
    if (!opts.confirmStopAllSessions) refusals.push({ code: 'CONFIRM_STOP_ALL_SESSIONS_MISSING' });
    // A stopped hook replaces the archive step: the caller confirms the pinned hook instead of an archive.
    if (!opts.stoppedHook && !opts.confirmArchiveHistory) refusals.push({ code: 'CONFIRM_ARCHIVE_HISTORY_MISSING' });
    if (opts.stoppedHook) {
      const loaded = loadHookSpec(opts);
      if (loaded.refusal) refusals.push({ code: loaded.refusal });
      else hook = loaded.hook;
    }
    if (!opts.confirmIdentity) refusals.push({ code: 'CONFIRM_IDENTITY_MISSING' });
    else if (fingerprint && opts.confirmIdentity !== fingerprint) refusals.push({ code: 'IDENTITY_FINGERPRINT_MISMATCH' });
    if (opts.launchProfile) {
      if (!opts.confirmProfileDigest) refusals.push({ code: 'CONFIRM_PROFILE_DIGEST_MISSING' });
      else if (profile && opts.confirmProfileDigest !== profile.digest) refusals.push({ code: 'PROFILE_DIGEST_MISMATCH' });
    }
  }

  return {
    refusals, warnings, identity, fingerprint, projectReal, dataReal, outputReal, entryReal, inventory,
    requiredBytes, freeBytes, allowed, profile, dataCheck, ancestorPolicy, inheritedLogFds, hook,
  };
}

function planReport(opts, pre) {
  return {
    format: FORMAT,
    mode: 'plan',
    ok: pre.refusals.length === 0,
    signalsSent: false,
    contentsRead: false,
    target: pre.identity && {
      pid: pre.identity.pid, startTicks: pre.identity.startTicks, uid: pre.identity.uid,
      cwd: pre.identity.cwd, exe: pre.identity.exe, parentComm: pre.identity.parentComm,
    },
    fingerprint: pre.fingerprint,
    // Project code (entry, launcher, package.json) may be hashed for the launch profile; data is never read.
    codeHashed: pre.profile ? Object.keys(pre.profile.descriptor.files).length : 0,
    launchProfile: pre.profile && {
      id: pre.profile.id, digest: pre.profile.digest, argvRecovered: false, health: pre.profile.health,
      listeners: pre.profile.descriptor.listeners, files: pre.profile.descriptor.files,
    },
    dataRoot: pre.dataCheck && {
      ownerRelation: pre.dataCheck.relation, helperUid: process.getuid(),
      ...(pre.dataCheck.binding ? { uid: pre.dataCheck.binding.uid, gid: pre.dataCheck.binding.gid, mode: pre.dataCheck.binding.mode.toString(8) } : {}),
    },
    inheritedLogFds: pre.inheritedLogFds,
    restartMode: opts.restartMode,
    source: pre.inventory && {
      files: pre.inventory.files, bytes: pre.inventory.bytes,
      sqliteDatabases: pre.inventory.entries.filter((e) => e.type === 'sqlite').length,
      excludedPresent: pre.inventory.excludedPresent.sort(),
    },
    space: { requiredBytes: pre.requiredBytes, freeBytes: pre.freeBytes },
    refusals: pre.refusals,
    warnings: pre.warnings,
    nextStep: pre.refusals.length
      ? 'Resolve the refusals above, then run plan again.'
      : 'After the user approves stopping ALL sessions and archiving history, run with --apply --detach '
        + `--confirm-stop-all-sessions --confirm-archive-history --confirm-identity ${pre.fingerprint}`
        + `${pre.profile ? ` --confirm-profile-digest ${pre.profile.digest}` : ''}.`,
    privacy: 'Archive will be PRIVATE and UNENCRYPTED; it may contain conversation text and configuration secrets.',
  };
}

/* --------------------------------------------------------- envelope/restart */

/** Capture the original runtime process envelope. Held in memory only; never logged. */
function captureEnvelope(pid, identity) {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (argv[argv.length - 1] === '') argv.pop();
    const env = {};
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    // stdout/stderr: re-open regular files in append mode, otherwise discard.
    const logTargets = [1, 2].map((fd) => {
      try {
        const t = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        return t.startsWith('/') && fs.statSync(t).isFile() ? t : null;
      } catch {
        return null;
      }
    });
    return { exe: fs.readlinkSync(`/proc/${pid}/exe`), argv, env, cwd: identity.cwd, logTargets };
  } catch {
    throw new SnapshotError('ENVELOPE_UNREADABLE');
  }
}

function openLogFd(target) {
  try {
    return target ? fs.openSync(target, 'a') : fs.openSync('/dev/null', 'a');
  } catch {
    return fs.openSync('/dev/null', 'a');
  }
}

/**
 * Restart exactly the stopped instance, once. Never spawns when a matching server
 * already runs (a supervisor respawned it). Spawn alone is not success: the new
 * process must stay alive and keep the project cwd and entry for the grace period.
 */
async function restartServer(ctx) {
  const { opts, pre, envelope } = ctx;
  const profileCtx = pre.profile ? { nodeReal: pre.profile.nodeReal } : null;
  const existing = findServerProcesses(pre.projectReal, pre.entryReal, new Set([process.pid]), profileCtx)
    .filter((p) => p.pid !== opts.pid || p.startTicks !== pre.identity.startTicks);
  if (existing.length) {
    return { outcome: 'already-running', by: 'external-respawn', note: 'a matching server exists; no second instance started' };
  }
  if (opts.restartMode === 'supervisor') {
    const deadline = Date.now() + Math.max(opts.restartVerifyMs, 10_000);
    while (Date.now() < deadline) {
      await sleep(250);
      if (findServerProcesses(pre.projectReal, pre.entryReal, new Set([process.pid]), profileCtx).length) {
        return { outcome: 'already-running', by: 'supervisor', note: 'supervisor respawn observed' };
      }
    }
    return { outcome: 'restart-failed', code: 'SUPERVISOR_DID_NOT_RESPAWN', note: 'restart-mode=supervisor: nothing was spawned by the helper' };
  }
  const out = openLogFd(envelope.logTargets[0]);
  const err = openLogFd(envelope.logTargets[1]);
  let child;
  let spawnError = null;
  try {
    // Profile: the verified launcher command (argv of the original is not recoverable); the
    // launcher re-derives boot flags itself. Generic: the captured exe + argv.
    const [exe, args] = ctx.recipe ? [ctx.recipe.exe, ctx.recipe.argv] : [envelope.exe, envelope.argv.slice(1)];
    child = spawn(exe, args, { cwd: envelope.cwd, env: envelope.env, detached: true, stdio: ['ignore', out, err] });
    child.on('error', (e) => { spawnError = e; });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  child.unref();
  await sleep(50);
  if (spawnError || !child.pid) return { outcome: 'restart-failed', code: 'RESTART_SPAWN_FAILED' };
  const newPid = child.pid;
  const startTicks = readStat(newPid)?.startTicks;
  if (ctx.recipe) return verifyProfileRestart(ctx, newPid, startTicks);
  const deadline = Date.now() + opts.restartVerifyMs;
  do {
    await sleep(100);
    if (isGone(newPid, startTicks)) return { outcome: 'restart-failed', code: 'RESTARTED_PROCESS_EXITED' };
  } while (Date.now() < deadline);
  const id = captureIdentity(newPid, pre.projectReal, pre.entryReal);
  if (!id || !id.cwdMatches || !id.entryMatches) return { outcome: 'restart-failed', code: 'RESTARTED_IDENTITY_MISMATCH' };
  return {
    outcome: 'running-verified', pid: newPid,
    verifiedBy: `alive ${opts.restartVerifyMs}ms with matching cwd and entry`, healthProbe: 'not-performed',
  };
}

/**
 * Profile restart check: the launcher execs node and node renames itself, so poll (bounded)
 * until the same PID is the node exe with the `cretli` title, project cwd, and a listener that
 * answers loopback health. Spawn alone is never success.
 */
async function verifyProfileRestart(ctx, newPid, startTicks) {
  const { opts, pre } = ctx;
  const minAlive = Date.now() + opts.restartVerifyMs;
  const deadline = Date.now() + Math.max(opts.restartVerifyMs, opts.profileRestartWaitMs);
  for (;;) {
    await sleep(100);
    if (isGone(newPid, startTicks)) return { outcome: 'restart-failed', code: 'RESTARTED_PROCESS_EXITED' };
    const id = captureIdentity(newPid, pre.projectReal, pre.entryReal);
    const ready = id && id.cwdMatches && id.comm === 'cretli' && exeRealOf(id) === pre.profile.nodeReal && id.uid === pre.identity.uid;
    if (ready && Date.now() >= minAlive) {
      const health = await probeHealth(listeningSockets(newPid));
      if (health) return { outcome: 'running-verified', pid: newPid, verifiedBy: 'profile: node exe, title, cwd, owned listener', healthProbe: 'ok' };
    }
    if (Date.now() >= deadline) {
      return { outcome: 'restart-failed', code: ready ? 'RESTARTED_HEALTH_FAILED' : 'RESTARTED_IDENTITY_MISMATCH' };
    }
  }
}

/* ---------------------------------------------------------- worker driver */

/** Run a worker phase in a bounded child (heap cap + wall timeout); sanitized result only. */
function runWorker(ctx, phase) {
  const { opts, work } = ctx;
  const cfgPath = path.join(work, 'worker-config.json');
  const resultPath = path.join(work, `${phase}-result.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${opts.workerMaxOldSpaceMb}`, '--no-warnings', SCRIPT_PATH, '--internal-worker', phase, '--config', cfgPath],
      {
        stdio: 'ignore',
        // Minimal environment: the worker never needs the service environment.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', CRETLI_SNAPSHOT_FAULT: process.env.CRETLI_SNAPSHOT_FAULT ?? '' },
      },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.workerTimeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new SnapshotError('WORKER_SPAWN_FAILED', { phase })); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      } catch {
        // no result: crash/OOM/timeout
      }
      if (code === 0 && res?.ok) return resolve(res);
      if (res && !res.ok) return reject(new SnapshotError(res.code ?? 'WORKER_FAILED', res.detail ?? {}));
      return reject(new SnapshotError('WORKER_CRASHED', { phase, exitCode: code, signal }));
    });
  });
}

/* ------------------------------------------------------------------ apply */

async function waitStopped(pid, startTicks, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isGone(pid, startTicks)) return true;
    await sleep(100);
  }
  return isGone(pid, startTicks);
}

/** Wait (bounded) for every recorded descendant to exit; returns those still alive. */
async function waitDescendantsGone(known, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let alive = known.filter((k) => !isGone(k.pid, k.startTicks));
  while (alive.length && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter((k) => !isGone(k.pid, k.startTicks));
  }
  return alive;
}

/**
 * After STOP_TIMEOUT: keep watching the original process for an explicit, bounded time.
 * A late exit restarts the service (no SIGKILL, no duplicate). If it still lives at the
 * limit the outcome is stop-incomplete: the server may be half shut down and needs the
 * operator, so the result must never read as "untouched".
 */
async function monitorLateExit(ctx) {
  const { opts, pre, op } = ctx;
  op.phase('late-exit-monitor', 'start', { limitMs: opts.lateExitMonitorMs });
  const deadline = Date.now() + opts.lateExitMonitorMs;
  while (!isGone(opts.pid, pre.identity.startTicks) && Date.now() < deadline) await sleep(100);
  if (isGone(opts.pid, pre.identity.startTicks)) {
    op.phase('late-exit-monitor', 'ok', { outcome: 'exited-late' });
    await doRestart(ctx);
    return;
  }
  op.status.restart = {
    outcome: 'stop-incomplete', code: 'STOP_INCOMPLETE_MANUAL_RECOVERY', pid: opts.pid,
    note: 'SIGTERM was sent and the process is still alive; sessions may already be interrupted. '
      + 'The helper will not restart or kill it. Check the service and recover it manually; if it exits later it stays down.',
  };
  op.phase('late-exit-monitor', 'failed', { code: 'STOP_INCOMPLETE_MANUAL_RECOVERY' });
}

/**
 * Restart recipe for the launch profile, validated BEFORE the stop: the verified bash launcher
 * run from the project root with the captured initial environment (held in memory only). The
 * launcher resolves `node` from PATH, so PATH must resolve to the exact node exe of the profile.
 */
function buildProfileRecipe(pre, envelope) {
  const bash = realOrNull('/bin/bash') ?? realOrNull('/usr/bin/bash');
  const launcher = realOrNull(path.join(pre.projectReal, PROFILE_FILES.launcher));
  let nodeOnPath = null;
  for (const dir of String(envelope.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const cand = realOrNull(path.join(dir, 'node'));
    if (cand) {
      nodeOnPath = cand;
      break;
    }
  }
  if (!bash || !launcher) throw new SnapshotError('PROFILE_RESTART_RECIPE_INVALID', { reason: 'launcher-or-shell-missing' });
  if (nodeOnPath !== pre.profile.nodeReal) throw new SnapshotError('PROFILE_RESTART_RECIPE_INVALID', { reason: 'node-on-path-differs' });
  return { exe: bash, argv: [launcher] };
}

async function runApply(opts, pre) {
  const opId = opts.internalOpId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
  const op = opts.internalOpId ? Operation.adopt(pre.outputReal, opId) : Operation.create(pre.outputReal, opId);
  const work = path.join(op.opDir, 'work');
  const ctx = { opts, pre, op, work, envelope: null, recipe: null, policy: null, stopped: false, restarted: false };
  let failure = null;
  let published = null;
  try {
    fs.mkdirSync(work, { mode: 0o700 });
    op.phase('preflight', 'ok');
    ctx.envelope = captureEnvelope(opts.pid, pre.identity);
    if (pre.profile) ctx.recipe = buildProfileRecipe(pre, ctx.envelope);
    op.phase('envelope-captured', 'ok');

    // Recheck identity and writers immediately before the signal.
    const again = captureIdentity(opts.pid, pre.projectReal, pre.entryReal);
    if (!again || again.startTicks !== pre.identity.startTicks || again.cwd !== pre.identity.cwd
      || again.exe !== pre.identity.exe || again.argvHash !== pre.identity.argvHash
      || !looksLikeServer(again, pre.profile ? { nodeReal: pre.profile.nodeReal } : null)) {
      throw new SnapshotError('IDENTITY_CHANGED_BEFORE_STOP');
    }
    // Data-root binding and launch profile (static code hashes, listener, health) must be unchanged.
    const dataNow = checkDataRoot(pre.dataReal, opts, []);
    let profileNow = null;
    if (pre.profile) {
      const rebuilt = await buildLaunchProfile(opts, again, pre.projectReal, pre.dataCheck.owners);
      if (rebuilt.refusals.length || rebuilt.profile.digest !== pre.profile.digest) throw new SnapshotError('PROFILE_CHANGED_BEFORE_STOP');
      profileNow = rebuilt.profile;
    }
    if (fingerprintOf(again, pre.entryReal, bindingExtras(dataNow.binding, opts, profileNow)) !== pre.fingerprint) {
      throw new SnapshotError('IDENTITY_CHANGED_BEFORE_STOP');
    }
    const tree = descendantsOf(opts.pid);
    ctx.policy = buildAncestorPolicy(opts.pid);
    const w0 = scanWriters(pre.dataReal, opts.excludedNames, tree, ctx.policy);
    if (w0.writers.length) throw new SnapshotError('UNKNOWN_WRITER', { writers: w0.writers });
    if (w0.scanFailed) throw new SnapshotError('FD_SCAN_FAILED', { processes: w0.scanFailed });
    // Hard barrier: the helper must not be in the server's process tree, or the server's
    // per-PID tree kill would take the helper down with it.
    if (ancestorsOf(process.pid).includes(opts.pid)) throw new SnapshotError('HELPER_IS_DESCENDANT');
    // Identities of every known descendant; they must be gone before the copy (F3).
    const known = [...tree].filter((p) => p !== opts.pid)
      .map((p) => ({ pid: p, startTicks: readStat(p)?.startTicks, comm: readStat(p)?.comm ?? '?' }))
      .filter((k) => k.startTicks !== undefined);
    op.phase('identity-recheck', 'ok', { knownDescendants: known.length });

    op.phase('stop', 'start');
    ctx.stopped = true;
    process.kill(opts.pid, 'SIGTERM');
    if (!(await waitStopped(opts.pid, pre.identity.startTicks, opts.stopTimeoutMs))) {
      // SIGTERM already started an irreversible shutdown; the finally block keeps watching.
      throw new SnapshotError('STOP_TIMEOUT', { timeoutMs: opts.stopTimeoutMs, forceKill: false });
    }
    op.phase('stop', 'ok');

    const survivors = await waitDescendantsGone(known, opts.descendantWaitMs);
    const w1 = scanWriters(pre.dataReal, opts.excludedNames, new Set(), ctx.policy);
    if (w1.writers.length || w1.scanFailed) {
      throw new SnapshotError('UNKNOWN_WRITER_AFTER_STOP', { writers: w1.writers, scanFailed: w1.scanFailed });
    }
    if (survivors.length) {
      throw new SnapshotError('KNOWN_DESCENDANT_SURVIVED', { processes: survivors.map((k) => ({ pid: k.pid, comm: k.comm })) });
    }
    const inv = walkSource(pre.dataReal, opts.excludedNames, opts.maxFiles, pre.dataCheck.owners);
    if (inv.problems.length) throw new SnapshotError(inv.problems[0].code, { path: topOf(inv.problems[0].path) });
    op.phase('source-inventory', 'ok', { files: inv.files, bytes: inv.bytes });

    if (pre.hook) {
      // Quiesced-window mode: run the pinned hook instead of copying. Its failure restarts the service through the
      // normal finally path; the hook itself must leave the code and data in a restartable state on failure.
      op.phase('stopped-hook', 'start', { label: pre.hook.label });
      try {
        published = await runStoppedHook(ctx);
      } catch (hookErr) {
        const proof = readHookProof(ctx);
        if (!proof.safe) ctx.unsafe = true;
        else op.status.hookProof = proof.outcome;
        throw hookErr;
      }
      op.phase('stopped-hook', 'ok', { label: pre.hook.label });
      await doRestart(ctx);
      op.phase('publish', 'ok');
    } else {
      fs.writeFileSync(path.join(work, 'inventory.json'), JSON.stringify(inv.entries), { mode: 0o600 });
      fs.writeFileSync(path.join(work, 'worker-config.json'), JSON.stringify({
        dataRoot: pre.dataReal, work, opId, inventoryPath: path.join(work, 'inventory.json'),
        excludedNames: [...opts.excludedNames], maxJsonBytes: opts.maxJsonBytes,
        maxJsonlLineBytes: opts.maxJsonlLineBytes, nodeVersion: process.version,
      }), { mode: 0o600 });

      op.phase('stage-copy', 'start');
      await runWorker(ctx, 'stage');
      op.phase('stage-copy', 'ok');

      const after = walkSource(pre.dataReal, opts.excludedNames, opts.maxFiles, pre.dataCheck.owners);
      const changed = after.problems[0]?.path ?? diffInventory(inv.entries, after.entries);
      if (changed) throw new SnapshotError('SOURCE_CHANGED', { path: changed });
      const w2 = scanWriters(pre.dataReal, opts.excludedNames, new Set(), ctx.policy);
      if (w2.writers.length || w2.scanFailed) {
        throw new SnapshotError('UNKNOWN_WRITER_AFTER_COPY', { writers: w2.writers, scanFailed: w2.scanFailed });
      }
      op.phase('source-recheck', 'ok');

      // The source is no longer needed: bring the service back before validation/packaging.
      await doRestart(ctx);

      op.phase('validate-package-verify', 'start');
      const fin = await runWorker(ctx, 'finalize');
      op.phase('validate-package-verify', 'ok');

      published = await publish(ctx, fin);
      op.phase('publish', 'ok');
    }
  } catch (err) {
    failure = sanitizeError(err);
    op.phase('failed', 'failed', failure);
  } finally {
    if (ctx.unsafe) {
      // Fail closed: no automatic restart of possibly half-applied code. The operator recovers outside Cretli.
      ctx.restarted = true;
      op.status.restart = { outcome: 'not-attempted-unsafe' };
      op.status.recovery = unsafeRecoveryNote(ctx);
      op.phase('restart', 'skipped', { code: 'STOPPED_UNSAFE' });
    } else if (ctx.stopped && !ctx.restarted) {
      if (!isGone(opts.pid, pre.identity.startTicks)) {
        // SIGTERM was delivered and shutdown may be under way: never call this "untouched".
        await monitorLateExit(ctx);
      } else {
        await doRestart(ctx);
      }
    }
    // Keep staging for diagnostics on failure; remove it on success.
    if (!failure) fs.rmSync(work, { recursive: true, force: true });
    const restart = op.status.restart;
    const restartOk = !restart || ['running-verified', 'already-running', 'not-needed'].includes(restart.outcome);
    const ok = !failure && !!published;
    op.finish(ctx.unsafe ? 'stopped-unsafe' : ok ? (restartOk ? 'published' : 'published-restart-failed') : 'failed', {
      result: ok ? published : null, error: failure,
    });
  }
  const st = op.status;
  return {
    format: FORMAT, mode: 'apply', ok: st.state === 'published', state: st.state, operationId: opId,
    operationDir: op.opDir, archive: st.result, restart: st.restart, error: st.error ?? null,
    recovery: st.recovery,
    diagnostics: failure ? 'staging retained privately in the operation dir (work/); no archive was published' : undefined,
    privacy: 'PRIVATE and UNENCRYPTED snapshot; may contain conversation text and secrets; do not upload or share.',
  };
}

/**
 * Run the pinned stopped-window hook as a bounded child (the helper's own child, SIGKILLed on timeout) with a minimal
 * environment. stdout (codes/counts only by contract) is kept privately in the operation directory.
 */
function runStoppedHook(ctx) {
  const { opts, pre, op } = ctx;
  if (sha256File(pre.hook.script) !== pre.hook.scriptSha256) return Promise.reject(new SnapshotError('HOOK_SCRIPT_MISMATCH'));
  const outPath = path.join(op.opDir, 'hook.out');
  const proofPath = path.join(op.opDir, 'hook-proof.json');
  // A proof from an earlier run or attempt must never authorize this one: remove it and bind a fresh nonce.
  fs.rmSync(proofPath, { force: true });
  const attempt = randomBytes(16).toString('hex');
  ctx.hookProof = { path: proofPath, attempt };
  const fd = fs.openSync(outPath, 'a', 0o600);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', pre.hook.script, ...pre.hook.args], {
      stdio: ['ignore', fd, fd], cwd: path.dirname(pre.hook.script),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C',
        CRETLI_HOOK_PROOF_PATH: proofPath, CRETLI_HOOK_ATTEMPT: attempt, CRETLI_HOOK_OP_ID: op.opId,
      },
    });
    fs.closeSync(fd);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.workerTimeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new SnapshotError('HOOK_SPAWN_FAILED')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ hook: pre.hook.label, exitCode: 0, output: path.basename(outPath) });
      return reject(new SnapshotError('HOOK_FAILED', { exitCode: code, signal, output: path.basename(outPath) }));
    });
  });
}

/**
 * Fail-closed decision after a failed stopped-window hook: the service may be restarted only when the hook left a
 * durable proof, bound to THIS operation and attempt, that code and data are in a consistent state. Anything else
 * (no file, unreadable, wrong nonce/op, unknown outcome) is treated as unsafe.
 *
 * @returns {{ safe: boolean, outcome?: string }}
 */
function readHookProof(ctx) {
  const proof = ctx.hookProof;
  if (!proof) return { safe: false };
  try {
    const st = fs.lstatSync(proof.path);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0 || st.size > 4096) return { safe: false };
    const body = JSON.parse(fs.readFileSync(proof.path, 'utf8'));
    if (body?.schema !== 'cretli-hook-proof-v1' || body.attempt !== proof.attempt || body.helperOpId !== ctx.op.opId) return { safe: false };
    return ['safe-legacy', 'safe-new'].includes(body.outcome) ? { safe: true, outcome: body.outcome } : { safe: false };
  } catch {
    return { safe: false };
  }
}

/** Recovery text recorded in status.json when the helper deliberately leaves the service stopped. */
function unsafeRecoveryNote(ctx) {
  return {
    state: 'stopped-unsafe',
    why: 'The stopped-window hook failed without a durable proof of a consistent state; the helper did NOT restart the service.',
    recover: [
      `1. Read ${path.join(ctx.op.opDir, 'hook.out')} and the cutover operation directory (cutover-status.json, cutover-result.json).`,
      '2. Run the cutover tool `recover` mode (marker absent: reverts code and moves the new store aside; marker present: it changes nothing and reports) outside Cretli while the service is stopped.',
      '3. If the marker is present and the new code is complete, fix forward and start the service; if the ACK-free precondition holds use `rollback-precutover`. Never restore an old backup over post-cutover writes.',
      '4. Start the service manually with its usual launcher only after code and data are consistent.',
    ],
  };
}

async function doRestart(ctx) {
  if (ctx.restarted) return;
  ctx.restarted = true;
  const { op } = ctx;
  op.phase('restart', 'start');
  let res;
  try {
    res = await restartServer(ctx);
  } catch (err) {
    res = { outcome: 'restart-failed', ...sanitizeError(err) };
  }
  op.status.restart = res;
  op.phase('restart', res.outcome === 'restart-failed' ? 'failed' : 'ok', { outcome: res.outcome, ...(res.code ? { code: res.code } : {}) });
}

/** Move the verified artifacts out of work/ atomically; the archive is renamed last. */
async function publish(ctx, fin) {
  const { op, work } = ctx;
  const base = `cretli-snapshot-${op.opId}`;
  const archive = path.join(op.opDir, `${base}.tar.gz`);
  const manifest = path.join(op.opDir, `${base}.manifest.json`);
  const sums = path.join(op.opDir, `${base}.tar.gz.sha256`);
  fs.copyFileSync(path.join(work, 'stage', 'MANIFEST.json'), manifest);
  fs.chmodSync(manifest, 0o600);
  fsyncPath(manifest);
  fs.writeFileSync(sums, `${fin.archiveSha256}  ${base}.tar.gz\n`, { mode: 0o600 });
  fsyncPath(sums);
  fs.chmodSync(path.join(work, 'archive.partial'), 0o600);
  fsyncPath(path.join(work, 'archive.partial'));
  fs.renameSync(path.join(work, 'archive.partial'), archive);
  fsyncPath(op.opDir);
  return { archive: path.basename(archive), bytes: fin.archiveBytes, sha256: fin.archiveSha256, files: fin.files, manifest: path.basename(manifest) };
}

/* ----------------------------------------------------------------- detach */

/** Launch a session-independent helper so it survives the planned stop of its parent. */
async function detachLaunch(opts, pre) {
  const opId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
  const op = Operation.create(pre.outputReal, opId);
  op.phase('detach', 'start');
  const logFd = fs.openSync(op.logPath, 'a', 0o600);
  const args = [SCRIPT_PATH, '--apply', '--internal-detached', '--internal-op-id', opId];
  const pass = {
    'project-root': opts.projectRoot, 'data-root': opts.dataRoot, 'output-root': opts.outputRoot, pid: String(opts.pid),
    'restart-mode': opts.restartMode, 'confirm-identity': opts.confirmIdentity, 'stop-timeout-ms': String(opts.stopTimeoutMs),
    'worker-timeout-ms': String(opts.workerTimeoutMs), 'worker-max-old-space-mb': String(opts.workerMaxOldSpaceMb),
    'max-json-bytes': String(opts.maxJsonBytes), 'max-jsonl-line-bytes': String(opts.maxJsonlLineBytes),
    'max-files': String(opts.maxFiles), 'restart-verify-ms': String(opts.restartVerifyMs),
    'late-exit-monitor-ms': String(opts.lateExitMonitorMs), 'descendant-wait-ms': String(opts.descendantWaitMs),
    'barrier-timeout-ms': String(opts.barrierTimeoutMs),
  };
  if (opts.nodeExe) pass['node-exe'] = opts.nodeExe;
  if (opts.launchProfile) pass['launch-profile'] = opts.launchProfile;
  if (opts.confirmProfileDigest) pass['confirm-profile-digest'] = opts.confirmProfileDigest;
  if (opts.dataOwnerUid !== null) pass['data-owner-uid'] = String(opts.dataOwnerUid);
  if (opts.stoppedHook) {
    pass['stopped-hook'] = opts.stoppedHook;
    pass['confirm-hook-sha256'] = opts.confirmHookSha256;
  }
  for (const [k, v] of Object.entries(pass)) args.push(`--${k}`, v);
  for (const n of opts.excludeNames) args.push('--exclude-name', n);
  for (const f of ['confirm-stop-all-sessions', 'confirm-archive-history', 'allow-root-service']) {
    if (opts[f.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]) args.push(`--${f}`);
  }
  // The detached helper scans writers too: forward only the scan-tolerance test hook.
  const helperEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (fault('tolerate-unreadable-fds')) helperEnv.CRETLI_SNAPSHOT_FAULT = 'tolerate-unreadable-fds';
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], env: helperEnv });
  fs.closeSync(logFd);
  child.unref();
  await sleep(300);
  if (fault('launcher-linger')) await sleep(3000); // test-only: keep the launcher in the server tree
  // After the spawn only the helper writes status.json; the launcher just reports.
  if (isGone(child.pid)) {
    // Re-read: the helper owns status.json and may already have recorded its own outcome.
    const cur = Operation.adopt(pre.outputReal, opId);
    if (cur.status.state === 'running') {
      cur.phase('detach', 'failed', { code: 'HELPER_EXITED_EARLY' });
      cur.finish('failed', { error: { code: 'HELPER_EXITED_EARLY', detail: {} } });
    }
  }
  return {
    format: FORMAT, mode: 'apply-detached', ok: !isGone(child.pid), operationId: opId, operationDir: op.opDir,
    helperPid: child.pid, follow: `poll ${path.join(op.opDir, 'status.json')} (state: running → published|failed|published-restart-failed)`,
  };
}

/* ----------------------------------------------------------------- worker */

/** Test-only fault injection (CRETLI_SNAPSHOT_FAULT); never set during a real operation. */
function fault(name) {
  return (process.env.CRETLI_SNAPSHOT_FAULT ?? '').split(',').includes(name);
}

function copyFileGuarded(srcAbs, dstAbs, expected) {
  const fd = fs.openSync(srcAbs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.size.toString() !== expected.size || st.ino.toString() !== expected.ino
      || st.dev.toString() !== expected.dev || st.mtimeNs.toString() !== expected.mtimeNs) {
      throw new SnapshotError('SOURCE_CHANGED', { path: expected.rel });
    }
    const out = fs.openSync(dstAbs, 'wx', 0o600);
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK);
      let total = 0n;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        fs.writeSync(out, buf, 0, n);
        total += BigInt(n);
      }
      if (total.toString() !== expected.size) throw new SnapshotError('SOURCE_CHANGED', { path: expected.rel });
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'ENOENT') throw new SnapshotError('SOURCE_CHANGED', { path: expected.rel });
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new SnapshotError('SOURCE_UNREADABLE', { path: expected.rel });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

async function workerStage(cfg) {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const entries = JSON.parse(fs.readFileSync(cfg.inventoryPath, 'utf8'));
  const stage = path.join(cfg.work, 'stage', 'data');
  const scratchRoot = path.join(cfg.work, 'scratch');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.mkdirSync(scratchRoot, { mode: 0o700 });
  const sidecars = new Map();
  for (const e of entries) if (e.type === 'sqlite-sidecar') (sidecars.get(e.of) ?? sidecars.set(e.of, []).get(e.of)).push(e);
  for (const e of entries.filter((x) => x.type === 'dir')) fs.mkdirSync(path.join(stage, e.rel), { mode: 0o700 });
  if (fault('mutate-source')) {
    const victim = entries.find((x) => x.type === 'file');
    if (victim) fs.appendFileSync(path.join(cfg.dataRoot, victim.rel), 'x');
  }
  if (fault('crash-stage')) process.kill(process.pid, 'SIGKILL');
  let n = 0;
  for (const e of entries) {
    const src = path.join(cfg.dataRoot, e.rel);
    if (e.type === 'file') {
      copyFileGuarded(src, path.join(stage, e.rel), e);
    } else if (e.type === 'sqlite' && e.size === '0') {
      copyFileGuarded(src, path.join(stage, e.rel), e);
    } else if (e.type === 'sqlite') {
      if (!readHeaderSafe(src, e.rel).equals(SQLITE_MAGIC)) throw new SnapshotError('SQLITE_HEADER_INVALID', { path: e.rel });
      // Copy main + WAL/journal into a private scratch with writers already gone, then use
      // the SQLite backup API from the scratch copy: the source files are never opened
      // read-write and the WAL content is included in the result.
      const dir = path.join(scratchRoot, String((n += 1)));
      fs.mkdirSync(dir, { mode: 0o700 });
      const scratch = path.join(dir, 'db');
      copyFileGuarded(src, scratch, e);
      for (const sc of sidecars.get(e.rel) ?? []) copyFileGuarded(path.join(cfg.dataRoot, sc.rel), `${scratch}-${sc.rel.endsWith('-wal') ? 'wal' : 'journal'}`, sc);
      const db = new DatabaseSync(scratch);
      try {
        await backup(db, path.join(stage, e.rel));
        fs.chmodSync(path.join(stage, e.rel), 0o600);
      } catch {
        throw new SnapshotError('SQLITE_BACKUP_FAILED', { path: e.rel });
      } finally {
        db.close();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  return { ok: true, copied: entries.length };
}

function readHeaderSafe(file, rel) {
  try {
    return readHeader(file);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new SnapshotError('SOURCE_UNREADABLE', { path: rel });
    throw err;
  }
}

/** All regular files below dir (relative, posix), rejecting symlinks/special files. */
function listTree(dir) {
  const files = [];
  const dirs = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.posix.join(rel, d.name) : d.name;
      if (d.isDirectory()) {
        dirs.push(r);
        stack.push(r);
      } else if (d.isFile()) {
        files.push(r);
      } else {
        throw new SnapshotError('STAGE_UNSUPPORTED_ENTRY', { path: r });
      }
    }
  }
  return { files: files.sort(), dirs: dirs.sort() };
}

/** Strict JSON validation with sanitized errors (never the parser message or content). */
function validateJsonFile(file, rel, cfg) {
  const size = fs.statSync(file).size;
  if (size > cfg.maxJsonBytes) throw new SnapshotError('JSON_TOO_LARGE', { path: rel });
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
  } catch {
    throw new SnapshotError('JSON_INVALID', { path: rel });
  }
}

/** Streaming JSONL validation: bounded line size, one JSON value per line, no blank lines. */
function validateJsonlFile(file, rel, cfg) {
  const fd = fs.openSync(file, 'r');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    let pending = Buffer.alloc(0);
    let line = 0;
    const check = (bytes) => {
      line += 1;
      if (bytes.length === 0) throw new SnapshotError('JSONL_BLANK_LINE', { path: rel, line });
      try {
        JSON.parse(decoder.decode(bytes));
      } catch {
        throw new SnapshotError('JSONL_INVALID', { path: rel, line });
      }
    };
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (!read) break;
      let chunk = Buffer.concat([pending, buf.subarray(0, read)]);
      let nl;
      while ((nl = chunk.indexOf(0x0a)) !== -1) {
        check(chunk.subarray(0, nl));
        chunk = chunk.subarray(nl + 1);
      }
      if (chunk.length > cfg.maxJsonlLineBytes) throw new SnapshotError('JSONL_LINE_TOO_LARGE', { path: rel, line: line + 1 });
      pending = Buffer.from(chunk);
    }
    if (pending.length) check(pending); // final line without trailing newline
  } finally {
    fs.closeSync(fd);
  }
}

function validateSqlite(DatabaseSync, file, rel, { normalize }) {
  let db;
  try {
    db = new DatabaseSync(file);
    if (normalize) db.exec('PRAGMA journal_mode=DELETE');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new SnapshotError('SQLITE_INTEGRITY_FAILED', { path: rel });
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) throw new SnapshotError('SQLITE_FOREIGN_KEY_VIOLATION', { path: rel, violations: fk.length });
    return {
      tables: db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c,
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      sqliteVersion: db.prepare('SELECT sqlite_version() AS v').get().v,
    };
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError('SQLITE_OPEN_FAILED', { path: rel });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function validateTree(DatabaseSync, root, cfg, { normalize }) {
  const { files } = listTree(root);
  const dbs = {};
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (SQLITE_EXT_RE.test(rel)) {
      if (fs.statSync(abs).size > 0) dbs[rel] = validateSqlite(DatabaseSync, abs, rel, { normalize });
    } else if (SQLITE_SIDECAR_RE.test(rel) || /-shm$/.test(rel)) {
      throw new SnapshotError('STAGE_SIDECAR_PRESENT', { path: rel });
    } else if (rel.endsWith('.jsonl') || rel.endsWith('.ndjson')) {
      validateJsonlFile(abs, rel, cfg);
    } else if (rel.endsWith('.json')) {
      validateJsonFile(abs, rel, cfg);
    }
  }
  return dbs;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: 'ignore', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    c.on('error', () => reject(new SnapshotError('TAR_UNAVAILABLE')));
    c.on('close', (code) => (code === 0 ? resolve() : reject(new SnapshotError('TAR_FAILED', { exitCode: code }))));
  });
}

/** Reject archive members that are not plain files/dirs or that escape the root. */
function auditTarListing(archive) {
  return new Promise((resolve, reject) => {
    const c = spawn('tar', ['-tvzf', archive], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    let buf = '';
    let bad = false;
    const scan = (line) => {
      if (!line) return;
      const type = line[0];
      const name = line.replace(/^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+/, '');
      if ((type !== '-' && type !== 'd') || name.startsWith('/') || name.split('/').includes('..') || / -> /.test(name)) bad = true;
    };
    c.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(scan);
    });
    c.on('error', () => reject(new SnapshotError('TAR_UNAVAILABLE')));
    c.on('close', (code) => {
      scan(buf);
      if (code !== 0) reject(new SnapshotError('TAR_FAILED', { exitCode: code }));
      else if (bad) reject(new SnapshotError('ARCHIVE_UNSAFE_MEMBER'));
      else resolve();
    });
  });
}

function hashTree(root) {
  const { files } = listTree(root);
  return files.map((rel) => ({ path: rel, size: fs.statSync(path.join(root, rel)).size, sha256: sha256File(path.join(root, rel)) }));
}

async function workerFinalize(cfg) {
  const { DatabaseSync } = await import('node:sqlite');
  if (fault('crash-finalize')) process.kill(process.pid, 'SIGKILL');
  const stageRoot = path.join(cfg.work, 'stage');
  const dataDir = path.join(stageRoot, 'data');
  // 1. Validate staged copy (databases normalised to a single self-contained file).
  const dbs = validateTree(DatabaseSync, dataDir, cfg, { normalize: true });
  // 2. Manifest from the final staged bytes.
  const files = hashTree(dataDir);
  const manifest = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    operationId: cfg.opId,
    nodeVersion: cfg.nodeVersion,
    classification: 'PRIVATE, UNENCRYPTED local safety snapshot; may contain conversation text and secrets. Not a portable or credential-free export.',
    excludedTopLevelNames: [...cfg.excludedNames].sort(),
    excludedPatterns: ['*-shm', '*.lock', '*.sock', '*.pid'],
    notCopied: ['project .env', 'native provider homes', 'runtime-home', 'sdk-agent-store', 'agent-transcripts', 'auth/session/TLS/push keys'],
    sqlite: dbs,
    totals: { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) },
    files,
  };
  fs.writeFileSync(path.join(stageRoot, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  // 3. Archive, audit, extract in isolation, re-verify bytes and content.
  const partial = path.join(cfg.work, 'archive.partial');
  await run('tar', ['-czf', partial, '--numeric-owner', '--sort=name', '-C', stageRoot, 'MANIFEST.json', 'data'], cfg.work);
  await auditTarListing(partial);
  const verifyDir = path.join(cfg.work, 'verify');
  fs.mkdirSync(verifyDir, { mode: 0o700 });
  await run('tar', ['-xzf', partial, '-C', verifyDir, '--no-same-owner', '--no-same-permissions'], cfg.work);
  const extracted = JSON.parse(fs.readFileSync(path.join(verifyDir, 'MANIFEST.json'), 'utf8'));
  const actual = hashTree(path.join(verifyDir, 'data'));
  if (JSON.stringify(actual) !== JSON.stringify(extracted.files)) throw new SnapshotError('ARCHIVE_VERIFY_MISMATCH');
  validateTree(DatabaseSync, path.join(verifyDir, 'data'), cfg, { normalize: false });
  const fdA = fs.openSync(partial, 'r');
  try { fs.fsyncSync(fdA); } finally { fs.closeSync(fdA); }
  return { ok: true, archiveSha256: sha256File(partial), archiveBytes: fs.statSync(partial).size, files: files.length };
}

async function workerMain(phase, cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const resultPath = path.join(cfg.work, `${phase}-result.json`);
  let result;
  try {
    result = phase === 'stage' ? await workerStage(cfg) : phase === 'finalize' ? await workerFinalize(cfg) : null;
    if (!result) throw new SnapshotError('ARG_INVALID', { arg: 'internal-worker' });
  } catch (err) {
    result = { ok: false, ...sanitizeError(err) };
  }
  fs.writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
  process.exit(result.ok ? 0 : 1);
}

/* ------------------------------------------------------------------- main */

const HELP = `Usage: cretli-offline-snapshot.mjs --project-root DIR --data-root DIR --output-root DIR --pid PID [options]

Default: plan/preflight (no signals, no content reads). Add --apply only after the user
approved stopping ALL sessions and archiving history. See docs/storage-pre-cutover-runbook.md.

  --apply --detach --confirm-stop-all-sessions --confirm-archive-history --confirm-identity FP
  --restart-mode self|supervisor   --allow-root-service   --exclude-name NAME
  --late-exit-monitor-ms N  --descendant-wait-ms N  --barrier-timeout-ms N
  --stop-timeout-ms N  --worker-timeout-ms N  --worker-max-old-space-mb N  --restart-verify-ms N
  --max-json-bytes N  --max-jsonl-line-bytes N  --max-files N  --node-exe PATH
  --launch-profile cretli-npm-start-v1 --node-exe PATH --confirm-profile-digest D
      opt-in profile for the title-rewritten \`npm start\` deployment (argv is NOT recovered)
  --data-owner-uid UID   declare the expected owner of a data root owned by another uid
  --stopped-hook SPEC.json --confirm-hook-sha256 SHA   run a pinned script in the quiesced window instead of
      copying (replaces --confirm-archive-history); see docs/storage-pre-cutover-runbook.md
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--internal-worker') {
    const a = parseArgs(argv);
    return workerMain(a.internalWorker, a.config);
  }
  let opts;
  try {
    opts = normalizeOptions(parseArgs(argv));
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ format: FORMAT, ok: false, error: sanitizeError(err) })}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const apply = !!opts.apply;
  if (opts.internalDetached) {
    // Hard barrier: the launcher must exit so this helper is reparented out of the server's
    // process tree before anything is captured or signalled. A PGID change is not enough
    // (the server kills trees by walking parent links), and a fixed sleep proves nothing.
    const deadline = Date.now() + opts.barrierTimeoutMs;
    while (ancestorsOf(process.pid).includes(opts.pid) && Date.now() < deadline) await sleep(50);
    if (ancestorsOf(process.pid).includes(opts.pid)) {
      const error = sanitizeError(new SnapshotError('DETACH_BARRIER_FAILED', { timeoutMs: opts.barrierTimeoutMs, signalsSent: false }));
      try {
        const outReal = realOrNull(opts.outputRoot);
        const op = Operation.adopt(outReal, opts.internalOpId);
        op.phase('detach', 'failed', error);
        op.finish('failed', { error });
      } catch {
        // status unavailable: the stdout report below lands in ops.log
      }
      process.stdout.write(`${JSON.stringify({ format: FORMAT, mode: 'apply', ok: false, signalsSent: false, refusals: [error] })}\n`);
      process.exit(2);
    }
  }
  const pre = await preflight(opts, { apply });
  let report;
  if (!apply) {
    report = planReport(opts, pre);
  } else if (pre.refusals.length) {
    report = { format: FORMAT, mode: 'apply', ok: false, signalsSent: false, refusals: pre.refusals, warnings: pre.warnings };
  } else if (opts.detach) {
    report = await detachLaunch(opts, pre);
  } else {
    report = await runApply(opts, pre);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : (report.refusals || (report.mode === 'plan') ? 2 : 1));
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ format: FORMAT, ok: false, error: sanitizeError(err) })}\n`);
  process.exit(1);
});
