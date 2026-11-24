/**
 * Operator chats: long-running `claude remote-control` processes, one per
 * workspace folder, so a Claude Code session with the Cretli MCP tools can be
 * driven from the Claude mobile app or claude.ai/code.
 *
 * Each entry (data/remote-control-sessions.json) names a folder, the MCP mode
 * of its managed connection (lib/mcp/mcp-external-connect.js) and whether it
 * starts with the server. The process runs as an ordinary task run (PTY,
 * output buffer, /ws-task attach) through the apps task launcher; Cretli reads
 * its output to answer the CLI's first-run questions and to pick up the
 * session URL and the "Connected" state. Task runs end with the server, so
 * entries marked `autoStart` are started again after boot.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { createTaskLauncher, killTaskRun } from '../apps/task-launcher.js';
import { EXTERNAL_MCP_MODES } from '../mcp/mcp-external-clients.js';
import { addClaudeHealHook, removeClaudeHealHook } from '../mcp/mcp-external-install.js';
import { activeManagedConnection, connectExternalMcpClient, ensureServerApproval, releaseClientPermission, resolveLocalBridgeEndpoint } from '../mcp/mcp-external-connect.js';
import { effectiveGrant } from '../mcp/claude-permission-profiles.js';
import { resolveClaudeSubscriptionConfigDir } from '../claude/claude-subscription.ts';

const OUTPUT_TAIL_MAX = 4000;
/** Delay before a self-heal restart, so the session's own request gets its answer first. */
const HEAL_RESTART_DELAY_MS = 3000;
/** At most one self-heal restart per chat in this window (a session stuck in a heal loop). */
const HEAL_MIN_INTERVAL_MS = 60 * 1000;
const NAME_MAX = 48;
const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
/**
 * Variables of a surrounding Claude Code session that must not leak into a
 * separate top-level session, plus API-key auth: Remote Control needs the
 * claude.ai login and an API key would take precedence over it.
 */
const NESTED_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)$/;

export class RemoteControlError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'RemoteControlError';
    this.status = status;
  }
}

/**
 * @typedef {{ id: string, folder: string, name: string, mode: string, autoStart: boolean, createdAt: string, healHook?: string }} RcEntry
 * @typedef {{ runId: string, pid: number, status: 'starting' | 'connected' | 'exited', url: string,
 *   startedAt: string, exitedAt: string | null, tail: string, answered: Set<string> }} RcRuntime
 */

/** @type {{ taskRuns: Map<string, any>, launchTask: ReturnType<typeof createTaskLauncher>, port: number | string, useHttps: boolean, resolveCli: () => string, resolveConfigDir: () => string } | null} */
let deps = null;
/** @type {Map<string, RcRuntime>} */
const runtime = new Map();
/** Last self-heal restart per entry id (ms). */
const lastHeal = new Map();

function storePath() {
  return resolveDataPath('remote-control-sessions.json');
}

/** @returns {RcEntry[]} */
function readEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

/** @param {RcEntry[]} sessions */
function writeEntries(sessions) {
  writeJsonAtomic(storePath(), { version: 1, sessions });
}

/**
 * First `claude` on PATH or in ~/.local/bin (the native installer's place;
 * a systemd service often lacks it on PATH). `CRETLI_CLAUDE_CLI` overrides.
 */
export function resolveClaudeCli() {
  const override = String(process.env.CRETLI_CLAUDE_CLI || '').trim();
  if (override) return override;
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return '';
}

/**
 * @param {{ taskRuns: Map<string, any>, buildInteractivePtyEnv: (o?: Record<string, string>) => NodeJS.ProcessEnv,
 *   randomSessionId: () => string, port: number | string, useHttps: boolean,
 *   launchTask?: ReturnType<typeof createTaskLauncher>, resolveCli?: () => string, resolveConfigDir?: () => string }} input
 *   `resolveConfigDir` finds the Claude config dir with a claude.ai login (the one Cretli's Claude harness uses).
 */
export function configureRemoteControl(input) {
  /** @param {Record<string, string>} [overrides] */
  const buildEnv = (overrides = {}) => {
    const env = { ...input.buildInteractivePtyEnv({}) };
    for (const key of Object.keys(env)) if (NESTED_SESSION_ENV.test(key)) delete env[key];
    return { ...env, ...overrides };
  };
  deps = {
    taskRuns: input.taskRuns,
    launchTask: input.launchTask || createTaskLauncher({
      taskRuns: input.taskRuns,
      buildInteractivePtyEnv: buildEnv,
      randomSessionId: input.randomSessionId,
    }),
    port: input.port,
    useHttps: input.useHttps,
    resolveCli: input.resolveCli || resolveClaudeCli,
    resolveConfigDir: input.resolveConfigDir || resolveClaudeSubscriptionConfigDir,
  };
}

function requireDeps() {
  if (!deps) throw new RemoteControlError('Remote Control is not configured', 503);
  return deps;
}

/** @param {string} text */
function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

/**
 * React to new output: answer first-run questions once, record the session
 * URL and the connected state.
 *
 * @param {RcRuntime} state
 * @param {any} pty
 * @param {string} chunk
 */
function onOutput(state, pty, chunk) {
  const url = chunk.match(SESSION_URL_RE)?.[0];
  if (url) state.url = url;
  state.tail = `${state.tail}${stripAnsi(chunk)}`.slice(-OUTPUT_TAIL_MAX);
  const recent = state.tail.slice(-400);
  const answer = (/** @type {string} */ key, /** @type {string} */ keys) => {
    if (state.answered.has(key)) return;
    state.answered.add(key);
    try { pty.write(keys); } catch { /* exited */ }
  };
  if (/Enable Remote Control\?\s*\(y\/n\)\s*$/i.test(recent)) answer('enable', 'y\r');
  // Choosing the folder for an operator chat is the trust decision the CLI asks for.
  if (/Trust [^\n]*\?\s*\[y\/N\]\s*$/i.test(recent)) answer('trust', 'y\r');
  if (/Choose \[1\/2\][^\n]*:\s*$/i.test(recent)) answer('spawn', '1\r');
  const plain = stripAnsi(chunk);
  if (/Disconnected|Reconnecting/i.test(plain)) state.status = 'starting';
  else if (/Connected/.test(plain)) state.status = 'connected';
}

/**
 * @param {RcEntry} entry
 * @returns {RcRuntime | null}
 */
function liveRuntime(entry) {
  const state = runtime.get(entry.id);
  if (!state || state.status === 'exited') return null;
  // A run killed from elsewhere (Tasks panel) without an exit callback.
  if (deps && !deps.taskRuns.has(state.runId)) {
    state.status = 'exited';
    state.exitedAt = state.exitedAt || new Date().toISOString();
    return null;
  }
  return state;
}

/** @param {RcEntry} entry */
function spawnEntry(entry) {
  const d = requireDeps();
  if (liveRuntime(entry)) return;
  const cli = d.resolveCli();
  if (!cli) throw new RemoteControlError('Claude Code CLI not found (install it or set CRETLI_CLAUDE_CLI)', 409);
  if (!fs.existsSync(entry.folder)) throw new RemoteControlError(`Folder does not exist: ${entry.folder}`, 409);
  const configDir = d.resolveConfigDir();
  if (!configDir) {
    throw new RemoteControlError('No claude.ai login found: sign in to Claude in Settings → Harness → Claude (or run `claude auth login`)', 409);
  }
  // A headless session never asks to approve the folder's `.mcp.json` servers and would start
  // without Cretli; approving here also repairs folders connected before approvals were written.
  ensureHealHook(entry);
  const connection = activeManagedConnection('claude', entry.folder);
  if (connection) {
    const approval = ensureServerApproval(connection.id, entry.folder, [connection]);
    if (approval.error) console.error(`[remote-control] ${entry.name}: ${approval.error}`);
  }
  /** @type {RcRuntime} */
  const state = {
    runId: '',
    pid: 0,
    status: 'starting',
    url: '',
    startedAt: new Date().toISOString(),
    exitedAt: null,
    tail: '',
    answered: new Set(),
  };
  runtime.set(entry.id, state);
  try {
    const { runId, pid } = d.launchTask({
      label: `Remote Control: ${entry.name}`,
      type: 'process',
      command: cli,
      args: ['remote-control', '--name', entry.name, '--spawn=same-dir'],
      cwd: entry.folder,
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir: entry.folder,
    }, {
      onExit: () => {
        state.status = 'exited';
        state.exitedAt = new Date().toISOString();
      },
    });
    state.runId = runId;
    state.pid = pid;
    const run = d.taskRuns.get(runId);
    run?.pty?.onData?.((/** @type {string} */ chunk) => onOutput(state, run.pty, chunk));
  } catch (err) {
    state.status = 'exited';
    state.exitedAt = new Date().toISOString();
    state.tail = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** @param {RcEntry} entry */
function toView(entry) {
  const state = runtime.get(entry.id);
  const live = liveRuntime(entry);
  const mcp = activeManagedConnection('claude', entry.folder);
  const permissionProfile = effectiveGrant(mcp).profile;
  return {
    ...entry,
    status: live ? live.status : 'stopped',
    url: live?.url || '',
    runId: live?.runId || '',
    startedAt: live?.startedAt || null,
    exitedAt: !live && state ? state.exitedAt : null,
    // Last output lines of a run that ended, to explain why.
    lastOutput: !live && state ? state.tail.trim().split('\n').slice(-6).join('\n') : '',
    mcpConnected: Boolean(mcp && !mcp.revokedAt && Date.parse(mcp.expiresAt) > Date.now()),
    mcpMode: mcp?.mode || '',
    toolsAllowed: permissionProfile !== 'prompt',
    permissionProfile,
  };
}

export function listRemoteControlSessions() {
  return readEntries().map(toView);
}

/**
 * Name shown in claude.ai: the folder name, made unique among entries.
 *
 * @param {string} folder
 * @param {RcEntry[]} entries
 */
function uniqueName(folder, entries) {
  const base = (path.basename(folder).replace(/[^\w.-]+/g, '-') || 'cretli').slice(0, NAME_MAX);
  const taken = new Set(entries.map((entry) => entry.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Create (or reuse) the operator chat of a folder: connect the Cretli MCP for
 * Claude Code in the chosen mode, then start the process.
 *
 * @param {{ folder: unknown, mode?: unknown, autoStart?: unknown, allowTools?: unknown, permissionProfile?: unknown }} input
 *   `permissionProfile` (`prompt` | `cretli_tools` | `edits_bash_guarded`) is written to `.claude/settings.local.json`;
 *   the older `allowTools` boolean maps to `cretli_tools` / `prompt` and loses to `permissionProfile`.
 */
export function createRemoteControlSession(input) {
  const d = requireDeps();
  const folderInput = typeof input?.folder === 'string' ? input.folder.trim() : '';
  if (!folderInput || !path.isAbsolute(folderInput)) throw new RemoteControlError('folder must be an absolute path');
  const folder = path.resolve(folderInput);
  const mode = input?.mode === undefined ? 'operator' : String(input.mode);
  if (!EXTERNAL_MCP_MODES.includes(/** @type {any} */ (mode))) {
    throw new RemoteControlError(`mode must be one of: ${EXTERNAL_MCP_MODES.join(', ')}`);
  }
  const connection = connectExternalMcpClient({
    target: 'claude',
    folder,
    mode,
    endpoint: resolveLocalBridgeEndpoint({ secure: d.useHttps, port: d.port }),
    allowTools: typeof input?.allowTools === 'boolean' ? input.allowTools : undefined,
    permissionProfile: input?.permissionProfile,
  });
  const entries = readEntries();
  let entry = entries.find((row) => row.folder === folder);
  if (entry) {
    entry.mode = mode;
    if (input?.autoStart !== undefined) entry.autoStart = input.autoStart === true;
  } else {
    entry = {
      id: randomUUID(),
      folder,
      name: uniqueName(folder, entries),
      mode,
      autoStart: input?.autoStart !== false,
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
  }
  writeEntries(entries);
  // A running process keeps its MCP servers until it restarts; restart it so the new connection applies.
  stopEntry(entry);
  spawnEntry(entry);
  return { ...toView(entry), toolPermission: connection.toolPermission, permissionGrant: connection.permissionGrant };
}

/** @param {string} id */
function findEntry(id) {
  const entry = readEntries().find((row) => row.id === id);
  if (!entry) throw new RemoteControlError('Remote Control session not found', 404);
  return entry;
}

/** @param {RcEntry} entry */
function stopEntry(entry) {
  const state = liveRuntime(entry);
  if (!state || !deps) return false;
  killTaskRun(deps.taskRuns, state.runId);
  state.status = 'exited';
  state.exitedAt = new Date().toISOString();
  return true;
}

/** @param {string} id */
export function startRemoteControlSession(id) {
  const entry = findEntry(id);
  spawnEntry(entry);
  return toView(entry);
}

/** @param {string} id */
export function stopRemoteControlSession(id) {
  const entry = findEntry(id);
  stopEntry(entry);
  return toView(entry);
}

/**
 * @param {string} id
 * @param {{ autoStart?: unknown }} patch
 */
export function updateRemoteControlSession(id, patch) {
  const entries = readEntries();
  const entry = entries.find((row) => row.id === id);
  if (!entry) throw new RemoteControlError('Remote Control session not found', 404);
  if (patch?.autoStart !== undefined) entry.autoStart = patch.autoStart === true;
  writeEntries(entries);
  return toView(entry);
}

/** Stops the process and forgets the entry; the folder's MCP connection stays. */
export function deleteRemoteControlSession(/** @type {string} */ id) {
  const entries = readEntries();
  const entry = entries.find((row) => row.id === id);
  if (!entry) throw new RemoteControlError('Remote Control session not found', 404);
  stopEntry(entry);
  runtime.delete(id);
  lastHeal.delete(id);
  writeEntries(entries.filter((row) => row.id !== id));
  if (entry.healHook === 'added') removeClaudeHealHook(entry.folder);
  // The folder keeps its MCP connection, but the rules Cretli added go with the chat
  // (kept while another live connection of the profile still needs them).
  const connection = activeManagedConnection('claude', entry.folder);
  if (connection) releaseClientPermission(connection);
}

/**
 * Put the SessionStart hook that points a session at scripts/cretli-mcp-heal.mjs
 * into the folder's Claude Code settings, once; record when Cretli added it so
 * Remove takes back only its own hook. Problems are logged, never thrown.
 *
 * @param {RcEntry & { healHook?: string }} entry
 */
function ensureHealHook(entry) {
  try {
    const { added } = addClaudeHealHook(entry.folder);
    if (!added) return;
    const entries = readEntries();
    const row = /** @type {RcEntry & { healHook?: string }} */ (entries.find((item) => item.id === entry.id));
    if (!row) return;
    row.healHook = 'added';
    entry.healHook = 'added';
    writeEntries(entries);
  } catch (err) {
    console.error(`[remote-control] ${entry.name}: heal hook not added: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Self-heal for a session that lost its Cretli tools: re-approve the folder's
 * `cretli` server and restart its operator chat shortly after answering, so
 * Remote Control resumes the conversation with the tools loaded.
 *
 * @param {string} folder the managed connection's folder
 * @param {{ now?: number }} [options]
 * @returns {{ name: string, restartInMs: number }}
 */
export function healRemoteControlSession(folder, { now = Date.now() } = {}) {
  requireDeps();
  const entry = readEntries().find((row) => row.folder === path.resolve(folder));
  if (!entry) throw new RemoteControlError('This folder has no Cretli operator chat; restart the Claude Code session yourself', 404);
  const last = lastHeal.get(entry.id);
  if (last !== undefined && now - last < HEAL_MIN_INTERVAL_MS) {
    throw new RemoteControlError('The operator chat was restarted less than a minute ago; wait for it to resume', 429);
  }
  lastHeal.set(entry.id, now);
  const connection = activeManagedConnection('claude', entry.folder);
  if (connection) {
    const approval = ensureServerApproval(connection.id, entry.folder, [connection]);
    if (approval.error) throw new RemoteControlError(approval.error, 409);
  }
  setTimeout(() => {
    try {
      stopEntry(entry);
      spawnEntry(entry);
    } catch (err) {
      console.error(`[remote-control] heal restart of ${entry.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }, HEAL_RESTART_DELAY_MS).unref();
  return { name: entry.name, restartInMs: HEAL_RESTART_DELAY_MS };
}

/** Start every `autoStart` entry; failures are logged and kept per entry. */
export function startRemoteControlAutostart() {
  for (const entry of readEntries()) {
    if (!entry.autoStart) continue;
    try {
      spawnEntry(entry);
    } catch (err) {
      console.error(`[remote-control] autostart of ${entry.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Test helper: forget runtime state and configuration. */
export function resetRemoteControlForTests() {
  runtime.clear();
  lastHeal.clear();
  deps = null;
}
