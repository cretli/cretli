/**
 * In-place Cretli update: inspect git SHAs and run scripts/self-update.sh.
 * The client never sends a command or path — only check / apply.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { resolveDataPath, resolveProjectPath } from './runtime-paths.js';
import { canRestartServer } from './server-restart-policy.js';

const DEFAULT_REMOTE = 'origin';
const DEFAULT_BRANCH = 'master';
const STATUS_FILE_NAME = 'update-status.json';
const LOG_TAIL_MAX = 40;
const PHASE_PREFIX = '::phase::';
const SCRIPT_RELATIVE = ['scripts', 'self-update.sh'];
const FETCH_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 15000;

/** @type {import('node:child_process').ChildProcess|null} */
let updateChild = null;

/**
 * @typedef {Object} UpdateRef
 * @property {string} remote
 * @property {string} branch
 * @property {string} ref
 */

/**
 * @typedef {Object} UpdateApplyGate
 * @property {boolean} allowed
 * @property {number} status
 * @property {string} [errorKey]
 */

/**
 * @typedef {Object} UpdateStatusPayload
 * @property {boolean} ok
 * @property {string} version
 * @property {boolean} isRepo
 * @property {string} localSha
 * @property {string} remoteSha
 * @property {boolean} behind
 * @property {boolean} busy
 * @property {string} phase
 * @property {string[]} logTail
 * @property {string} error
 * @property {boolean} canApply
 * @property {boolean} canRestart
 * @property {string} fetchError
 */

/**
 * @returns {string}
 */
function resolveStatusFilePath() {
  return resolveDataPath(STATUS_FILE_NAME);
}

/**
 * @param {unknown} sha
 * @returns {string}
 */
export function shortSha(sha) {
  const raw = typeof sha === 'string' ? sha.trim() : '';
  if (!raw) return '';
  return raw.slice(0, 7);
}

/**
 * @param {string[]} lines
 * @param {string} line
 * @param {number} [max]
 * @returns {string[]}
 */
export function appendLogLine(lines, line, max = LOG_TAIL_MAX) {
  const next = Array.isArray(lines) ? lines.slice() : [];
  const text = typeof line === 'string' ? line.trimEnd() : '';
  if (!text) return next;
  next.push(text);
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

/**
 * @param {string} remote
 * @returns {boolean}
 */
function isSafeRemoteName(remote) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote);
}

/**
 * @param {string} branch
 * @returns {boolean}
 */
function isSafeBranchName(branch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
  if (branch.includes('..')) return false;
  return !branch.startsWith('/') && !branch.endsWith('/');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UpdateRef}
 */
export function resolveUpdateRef(env = process.env) {
  const fallback = `${DEFAULT_REMOTE}/${DEFAULT_BRANCH}`;
  const raw = String(env?.CRETLI_UPDATE_REF || fallback).trim();
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    return { remote: DEFAULT_REMOTE, branch: DEFAULT_BRANCH, ref: fallback };
  }
  const remote = raw.slice(0, slash);
  const branch = raw.slice(slash + 1);
  if (!isSafeRemoteName(remote) || !isSafeBranchName(branch)) {
    return { remote: DEFAULT_REMOTE, branch: DEFAULT_BRANCH, ref: fallback };
  }
  return { remote, branch, ref: `${remote}/${branch}` };
}

/**
 * @param {{ isRepo?: boolean, busy?: boolean }} input
 * @returns {UpdateApplyGate}
 */
export function resolveUpdateApplyGate(input) {
  if (!input?.isRepo) {
    return { allowed: false, status: 400, errorKey: 'update.noRepo' };
  }
  if (input.busy) {
    return { allowed: false, status: 409, errorKey: 'update.busy' };
  }
  return { allowed: true, status: 202 };
}

/**
 * @param {object} input
 * @returns {UpdateStatusPayload}
 */
export function buildUpdateStatusPayload(input) {
  const isRepo = Boolean(input?.isRepo);
  const busy = Boolean(input?.busy);
  const localSha = shortSha(input?.localSha);
  const remoteSha = shortSha(input?.remoteSha);
  const behind = Boolean(isRepo && localSha && remoteSha && localSha !== remoteSha);
  return {
    ok: true,
    version: typeof input?.version === 'string' ? input.version : '',
    isRepo,
    localSha,
    remoteSha,
    behind,
    busy,
    phase: typeof input?.phase === 'string' && input.phase ? input.phase : (busy ? 'unknown' : 'idle'),
    logTail: Array.isArray(input?.logTail) ? input.logTail.map((line) => String(line)) : [],
    error: typeof input?.error === 'string' ? input.error : '',
    canApply: Boolean(isRepo && !busy),
    canRestart: Boolean(input?.canRestart),
    fetchError: typeof input?.fetchError === 'string' ? input.fetchError : '',
  };
}

/**
 * @returns {boolean}
 */
export function isUpdateProcessRunning() {
  return Boolean(updateChild);
}

/**
 * @returns {{ busy: boolean, phase: string, logTail: string[], error: string, localSha: string, remoteSha: string }}
 */
function createEmptyPersistedStatus() {
  return {
    busy: false,
    phase: 'idle',
    logTail: [],
    error: '',
    localSha: '',
    remoteSha: '',
  };
}

/**
 * @returns {{ busy: boolean, phase: string, logTail: string[], error: string, localSha: string, remoteSha: string }}
 */
function readPersistedStatus() {
  const filePath = resolveStatusFilePath();
  if (!existsSync(filePath)) return createEmptyPersistedStatus();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return createEmptyPersistedStatus();
    return {
      busy: Boolean(parsed.busy),
      phase: typeof parsed.phase === 'string' ? parsed.phase : 'idle',
      logTail: Array.isArray(parsed.logTail) ? parsed.logTail.map((line) => String(line)) : [],
      error: typeof parsed.error === 'string' ? parsed.error : '',
      localSha: typeof parsed.localSha === 'string' ? parsed.localSha : '',
      remoteSha: typeof parsed.remoteSha === 'string' ? parsed.remoteSha : '',
    };
  } catch {
    return createEmptyPersistedStatus();
  }
}

/**
 * @param {object} status
 */
function writePersistedStatus(status) {
  writeJsonAtomic(resolveStatusFilePath(), status);
}

function recoverInterruptedUpdate() {
  const current = readPersistedStatus();
  if (!current.busy) return;
  writePersistedStatus({
    ...current,
    busy: false,
    phase: 'error',
    error: 'interrupted',
  });
}

recoverInterruptedUpdate();

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function readPackageVersion(projectRoot) {
  try {
    const raw = readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

/**
 * @param {string} projectRoot
 * @returns {boolean}
 */
function isGitRepo(projectRoot) {
  const result = runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
  return result.ok && result.stdout === 'true';
}

/**
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {boolean} [params.fetchRemote]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {{ isRepo: boolean, localSha: string, remoteSha: string, fetchError: string }}
 */
export function inspectUpdateRepo({ projectRoot, fetchRemote = false, env = process.env }) {
  if (!projectRoot || !existsSync(projectRoot)) {
    return { isRepo: false, localSha: '', remoteSha: '', fetchError: '' };
  }
  if (!isGitRepo(projectRoot)) {
    return { isRepo: false, localSha: '', remoteSha: '', fetchError: '' };
  }
  const { remote, branch, ref } = resolveUpdateRef(env);
  const local = runGit(['rev-parse', 'HEAD'], projectRoot);
  let fetchError = '';
  if (fetchRemote) {
    const fetched = runGit(['fetch', remote, branch], projectRoot, FETCH_TIMEOUT_MS);
    if (!fetched.ok) fetchError = fetched.stderr || fetched.stdout || 'git fetch failed';
  }
  const remoteRev = runGit(['rev-parse', ref], projectRoot);
  return {
    isRepo: true,
    localSha: local.ok ? local.stdout : '',
    remoteSha: remoteRev.ok ? remoteRev.stdout : '',
    fetchError,
  };
}

/**
 * @param {object} [params]
 * @param {string} [params.projectRoot]
 * @param {boolean} [params.check]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {UpdateStatusPayload}
 */
export function getUpdateStatus({ projectRoot, check = false, env = process.env } = {}) {
  const persisted = readPersistedStatus();
  const busy = isUpdateProcessRunning() || persisted.busy;
  const git = inspectUpdateRepo({
    projectRoot: projectRoot || resolveProjectPath(),
    fetchRemote: Boolean(check) && !busy,
    env,
  });
  return buildUpdateStatusPayload({
    version: readPackageVersion(projectRoot || resolveProjectPath()),
    isRepo: git.isRepo,
    localSha: git.isRepo ? (git.localSha || persisted.localSha) : '',
    remoteSha: git.isRepo ? (git.remoteSha || persisted.remoteSha) : '',
    busy,
    phase: persisted.phase,
    logTail: persisted.logTail,
    error: persisted.error,
    canRestart: canRestartServer(env),
    fetchError: git.fetchError,
  });
}

/**
 * @param {import('node:stream').Readable|null} stream
 * @param {(line: string) => void} onLine
 */
function attachLineReader(stream, onLine) {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trimEnd();
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    const line = buffer.trim();
    if (line) onLine(line);
  });
}

/**
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {() => void} [params.onSuccess]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {UpdateApplyGate & { statusPayload?: UpdateStatusPayload }}
 */
export function startUpdateApply({ projectRoot, onSuccess, env = process.env }) {
  const current = getUpdateStatus({ projectRoot, check: false, env });
  const gate = resolveUpdateApplyGate({ isRepo: current.isRepo, busy: current.busy });
  if (!gate.allowed) return gate;
  const { remote, branch } = resolveUpdateRef(env);
  const scriptPath = resolveProjectPath(...SCRIPT_RELATIVE);
  if (!existsSync(scriptPath)) {
    return { allowed: false, status: 500, errorKey: 'update.noRepo' };
  }
  const persisted = {
    busy: true,
    phase: 'fetch',
    logTail: [],
    error: '',
    localSha: current.localSha,
    remoteSha: current.remoteSha,
  };
  writePersistedStatus(persisted);
  const child = spawn('bash', [scriptPath], {
    cwd: projectRoot,
    env: {
      ...env,
      CRETLI_PROJECT_ROOT: projectRoot,
      CRETLI_UPDATE_REMOTE: remote,
      CRETLI_UPDATE_BRANCH: branch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  updateChild = child;
  const handleLine = (line) => {
    if (line.startsWith(PHASE_PREFIX)) {
      const phase = line.slice(PHASE_PREFIX.length).trim();
      if (phase) persisted.phase = phase;
      persisted.logTail = appendLogLine(persisted.logTail, `phase: ${phase || line}`);
      writePersistedStatus(persisted);
      return;
    }
    persisted.logTail = appendLogLine(persisted.logTail, line);
    writePersistedStatus(persisted);
  };
  attachLineReader(child.stdout, handleLine);
  attachLineReader(child.stderr, handleLine);
  child.once('error', (err) => {
    updateChild = null;
    persisted.busy = false;
    persisted.phase = 'error';
    persisted.error = err?.message || 'spawn failed';
    persisted.logTail = appendLogLine(persisted.logTail, persisted.error);
    writePersistedStatus(persisted);
  });
  child.once('close', (code) => {
    updateChild = null;
    const ok = code === 0;
    persisted.busy = false;
    persisted.phase = ok ? 'done' : 'error';
    persisted.error = ok ? '' : `exit ${code}`;
    if (!ok) persisted.logTail = appendLogLine(persisted.logTail, persisted.error);
    const after = inspectUpdateRepo({ projectRoot, fetchRemote: false, env });
    persisted.localSha = shortSha(after.localSha) || persisted.localSha;
    persisted.remoteSha = shortSha(after.remoteSha) || persisted.remoteSha;
    writePersistedStatus(persisted);
    if (!ok) return;
    if (typeof onSuccess !== 'function') return;
    setTimeout(() => onSuccess(), 800);
  });
  return {
    allowed: true,
    status: 202,
    statusPayload: getUpdateStatus({ projectRoot, check: false, env }),
  };
}
