/**
 * Cretli server: HTTP + WebSocket (PTY terminal + agent chat).
 * Terminal = shell in the workspace. Chat = OpenCode / OpenRouter / Cursor SDK
 * in the same workspace. Agent sessions survive a browser close — on client
 * disconnect the PTY is kept and the buffer keeps appending; resume + catch-up
 * restores the view.
 */

// Rename the process as early as this module runs so `/proc/<pid>/comm` (set via
// libuv's prctl(PR_SET_NAME)) no longer reads `node`. ESM evaluates static
// imports before this line, but the title is still set before `listen()` and
// long-lived harness work. This keeps the server out of the earlyoom
// `--prefer ^(node|...)` match, so under memory pressure the killer targets a
// child (OpenCode, webpack, a harness) instead of the server.
process.title = 'cretli';

import express from 'express';
import compression from 'compression';
import { resolveServerTransport, exitOnTlsFailure } from './lib/server-tls.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';
import { findWorkspaceFile } from './lib/workspace.js';
import { listChatHistoryHeadSeqs } from './lib/persist/chat-history-persist.js';
import { seedChatHistoryRevisionsFromIndex } from './lib/persist/chat-history-revisions.js';
import { initSdkRoomTransport } from './lib/sdk/cursor-agent-sdk-ws.js';
import { getServerInstanceId } from './lib/sdk/sdk-instance-id.js';
import { ensureStickyInstanceCookie } from './lib/sdk/sdk-sticky-session.js';
import { resolveAgentCommand, buildAgentSpawnEnv } from './lib/agent-cli.js';
import { loadSettings } from './lib/persist/settings.js';
import { writeJsonAtomic } from './lib/persist/atomic-write.js';
import {
  isAuthConfigured,
  isLanExposed,
  requireAuth,
  verifyAgentCallback,
} from './lib/auth.js';
import {
  applyWidgetCorsResponse,
  handleWidgetCorsPreflight,
} from './lib/widget/widget-cors.js';
import { widgetChatAccessScope, widgetChatListScope } from './lib/widget/widget-chat-scope.js';
import {
  applyWidgetFrameHeaders,
  installWidgetApiGate,
  installWidgetSecurityHeaders,
} from './lib/widget/widget-http.js';
import { registerWidgetAuthorizePages } from './lib/widget/widget-auth-page.js';
import { registerPublicPages } from './lib/public-pages.js';
import { createVersionedHtmlSender } from './lib/versioned-html.js';
import { createWorkspaceContext, isTaskRunInScope } from './lib/workspace-context.js';
import { createClientDebugLog } from './lib/client-debug-log.js';
import { installFrontHmrMiddleware } from './lib/front-hmr.js';
import { resolveFrontHmrEnabled, resolveFrontHmrEnabledFromSettings } from './lib/front-hmr-mode.js';
import { buildInteractivePtyEnv as buildPtyEnv } from './lib/pty-env.js';
import { registerAppRoutes, registerDevAndUpdateRoutes } from './lib/register-app-routes.js';
import { bootDelegationRuntime, shutdownDelegationRuntime, installDelegationTestAdapters, beginDelegationShutdown } from './lib/delegation-runtime-boot.js';
import { beginServerShutdown } from './lib/update-gate.js';
import { createFatalProcessEventHandler } from './lib/process-fatal.js';
import {
  beginChildProcessShutdown,
  finishChildProcessShutdown,
  installChildProcessSpawnTracking,
  reconcileChildProcessRegistry,
  registerServerDescendants,
  startChildProcessDiscovery,
} from './lib/child-process-registry.js';
import { logServerReady } from './lib/boot-log.js';
import { isHttpTimingEnabled } from './lib/routes/settings-routes.js';
import {
  broadcastToClients,
  flushPtyOutput,
  queuePtyOutput,
  TASK_RUN_BUFFER_MAX,
} from './lib/pty-broadcast.js';
import { attachWebSocketHandlers } from './lib/ws/ws-router.js';
import { readCretliPublicOrigin } from './lib/ws/ws-origin.js';
import { getLanHost } from './lib/lan-host.js';
import { installServerLogCapture } from './lib/ws/server-log-ws.js';
import { installFrontBuildWatcher } from './lib/ws/front-build-ws.js';
import { runAgentsScheduler, AGENTS_SCHEDULER_INTERVAL_MS } from './lib/ws/agent-run-ws-handler.js';
import { readEnvAlias } from './lib/env-alias.js';
import { assertLanSetupGuard, readSetupToken, resolveBindHost } from './lib/bind-host.js';
import { resolveDataPath, resolveProjectPath } from './lib/runtime-paths.js';
import { resolveFrontAssetVersion } from './lib/front-asset-version.js';
import { setModelScoreRows } from './lib/model-catalog-meta.js';
import { loadModelScoreRows } from './lib/model-score-heuristics-fs.js';
import { detectBrowserRuntime } from './lib/browser/runtime-detect.js';
import { BrowserSessionManager } from './lib/browser/session-manager.js';
import { assertBrowserSingleInstance } from './lib/browser/multi-instance.js';
import { createRespawnController, resolveLifecycleLimits } from './lib/browser/lifecycle.js';
import { purgeBrowserScreenshotRoot } from './lib/browser/screenshot-file.js';
import { getWorkspacePolicy } from './lib/browser/policy-store.js';
import { configureBrowserAgentRuntime } from './lib/browser/agent-tools.js';
import { createServerDiagnostics } from './lib/server-diagnostics.js';
import { publishMemoryMonitorAlerts } from './lib/notifications/memory-monitor-producer.js';

setModelScoreRows(loadModelScoreRows());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_RUNTIME_HOME = resolveDataPath('runtime-home');
const PROJECT_ROOT = resolveProjectPath();
const OPEN_CODE_INSTANCE_FOLDER = readEnvAlias({
  current: 'CRETLI_OPENCODE_INSTANCE_FOLDER',
  legacy: 'CURSOR_REMOTE_OPENCODE_INSTANCE_FOLDER',
});
if (!OPEN_CODE_INSTANCE_FOLDER) {
  process.env.CRETLI_OPENCODE_INSTANCE_FOLDER = PROJECT_ROOT;
  process.env.CURSOR_REMOTE_OPENCODE_INSTANCE_FOLDER = PROJECT_ROOT;
} else {
  process.env.CRETLI_OPENCODE_INSTANCE_FOLDER = OPEN_CODE_INSTANCE_FOLDER;
  process.env.CURSOR_REMOTE_OPENCODE_INSTANCE_FOLDER = OPEN_CODE_INSTANCE_FOLDER;
}

function normalizeSdkRuntimeEnvironment() {
  const home = String(process.env.HOME || '').trim();
  if (!home || home === '/root') process.env.HOME = LOCAL_RUNTIME_HOME;
  try {
    mkdirSync(process.env.HOME, { recursive: true });
  } catch {
    process.env.HOME = LOCAL_RUNTIME_HOME;
    mkdirSync(process.env.HOME, { recursive: true });
  }
  process.env.AGENT_TRANSCRIPTS = path.join(process.env.HOME, 'agent-transcripts');
  mkdirSync(process.env.AGENT_TRANSCRIPTS, { recursive: true });
}

normalizeSdkRuntimeEnvironment();

const PORT = parseInt(process.env.PORT || '3011', 10);
const BIND_HOST = resolveBindHost();
const DEFAULT_WORKSPACE_FILE = process.env.WORKSPACE_FILE || findWorkspaceFile();
const AGENT_CMD = resolveAgentCommand(process.env.CURSOR_AGENT_CMD || 'agent');
const AGENT_MODEL = process.env.CURSOR_AGENT_MODEL ?? 'auto';
const AGENT_CALLBACK_TOKEN = process.env.AGENT_CALLBACK_TOKEN || '';
const SERVER_INSTANCE_TOKEN = randomUUID();
const SERVER_STARTED_AT = Date.now();
const serverDiagnostics = createServerDiagnostics({
  dataDir: resolveDataPath(),
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  serverStartedAt: SERVER_STARTED_AT,
});
const IS_PROD = process.env.NODE_ENV === 'production';
/**
 * Late-bound shutdown hook. A fatal event during boot (before the async
 * shutdown handler exists) exits directly; once booted, the hook runs the full
 * cleanup, whose first phase is synchronous.
 */
let fatalProcessShutdown = () => {
  process.exit(1);
};
const handleFatalProcessEvent = createFatalProcessEventHandler({
  isProd: IS_PROD,
  record: (kind, error) => {
    serverDiagnostics.record(kind, {
      errorName: String(error?.name || (kind === 'unhandled-rejection' ? 'UnhandledRejection' : 'Error')).slice(0, 80),
      message: error?.message || String(error),
    }, { fatal: IS_PROD });
  },
  shutdown: (kind) => {
    fatalProcessShutdown(kind);
  },
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err?.stack || err?.message || err);
  const outcome = handleFatalProcessEvent({ kind: 'uncaught-exception', error: err });
  if (outcome.terminate) {
    console.error('[fatal] Terminating process (production) — restart via a process manager.');
  }
  if (outcome.terminate && !outcome.shutdownCalled) process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason?.stack || reason?.message || reason);
  const outcome = handleFatalProcessEvent({ kind: 'unhandled-rejection', error: reason });
  if (outcome.terminate) {
    console.error('[fatal] Terminating process (production).');
  }
  if (outcome.terminate && !outcome.shutdownCalled) process.exit(1);
});
serverDiagnostics.start();
let serverRestartScheduled = false;
const FRONT_HMR_ENV_RAW = readEnvAlias({
  current: 'CRETLI_FRONT_HMR',
  legacy: 'CURSOR_REMOTE_FRONT_HMR',
});
const FRONT_HMR_FORCED_BY_ENV = FRONT_HMR_ENV_RAW !== '';
// HMR in the server process is opt-in: a truthy env value is the only switch.
// The external `watch:front` CLI watcher is the default dev path, so a plain
// `npm start` must never load webpack into this process. `settings.frontHmrEnabled`
// only feeds the Settings UI and the restart helper (which re-launches the
// server with the explicit env value).
const FRONT_HMR_ENABLED = resolveFrontHmrEnabled({
  nodeEnv: process.env.NODE_ENV,
  envRaw: FRONT_HMR_ENV_RAW,
});
const FRONT_HOT_FALLBACK_ENV = readEnvAlias({
  current: 'CRETLI_FRONT_HOT_FALLBACK',
  legacy: 'CURSOR_REMOTE_FRONT_HOT_FALLBACK',
});
// The dist watcher replaced HMR as the default, so it is on unless explicitly off.
const FRONT_HOT_FALLBACK_ENABLED =
  FRONT_HOT_FALLBACK_ENV !== '0' && FRONT_HOT_FALLBACK_ENV !== 'false';

const app = express();
const PUBLIC_DIR = String(process.env.CRETLI_PUBLIC_DIR || '').trim() || path.join(__dirname, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_HTML_PATH = path.join(PUBLIC_DIR, 'login.html');
const dataDir = resolveDataPath();
const keyPath = process.env.SSL_KEY_PATH || path.join(dataDir, 'key.pem');
const certPath = process.env.SSL_CERT_PATH || path.join(dataDir, 'cert.pem');
let useHttps = false;
let server;
try {
  const resolved = resolveServerTransport(app, { keyPath, certPath });
  server = resolved.server;
  useHttps = resolved.useHttps;
} catch (err) {
  exitOnTlsFailure(err);
}

const workspace = createWorkspaceContext({ defaultWorkspaceFile: DEFAULT_WORKSPACE_FILE });
const {
  getCurrentWorkspaceFile,
  getConfiguredWorkspaceSelection,
  getCurrentWorkspace,
  getCurrentCwd,
  buildTaskRunScopeSnapshot,
  loadCurrentTasks,
  loadTasksForWorkspace,
  workspaceDirForAgent,
} = workspace;

function currentFrontAssetVersion() {
  return resolveFrontAssetVersion({ projectRoot: __dirname, serverStartedAt: SERVER_STARTED_AT });
}
const { sendVersionedHtml } = createVersionedHtmlSender({ getAssetVersion: currentFrontAssetVersion });
function isSessionSyncEnabled() {
  if (process.env.TERMINAL_SESSION_SYNC === '1') return true;
  return loadSettings().sessionSyncEnabled === true;
}

const terminalSessions = new Map();
const agentSessions = new Map();
const taskRuns = new Map();
const agentRuns = new Map();
const DEV_BUILD_RUN_ID = 'dev-build';
let currentAgentRunResumeId = null;
const AGENTS_SCHEDULE_FILE = path.join(dataDir, 'agents-schedule.json');
function loadAgentsSchedule() {
  if (!existsSync(AGENTS_SCHEDULE_FILE)) return { schedules: [] };
  try {
    const data = JSON.parse(readFileSync(AGENTS_SCHEDULE_FILE, 'utf8'));
    return Array.isArray(data.schedules) ? data : { schedules: [] };
  } catch {
    return { schedules: [] };
  }
}
function saveAgentsSchedule(data) {
  writeJsonAtomic(AGENTS_SCHEDULE_FILE, data);
}
function randomSessionId() {
  return randomBytes(8).toString('hex');
}
function buildInteractivePtyEnv(overrides = {}) {
  return buildPtyEnv({ localRuntimeHome: LOCAL_RUNTIME_HOME, overrides });
}

app.use(compression({
  filter: (req, res) => {
    if (String(req.path || '').startsWith('/__webpack_hmr')) return false;
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
// Browser navigation is GET/HEAD and must never need JSON parsing. Chromium
// can expose an empty navigation body as the literal JSON value `null`; trying
// to parse that body makes body-parser reject a normal page navigation with 400.
// Keep JSON parsing for state-changing/API requests only.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return express.json({ limit: '8mb' })(req, res, next);
});
app.use((req, res, next) => {
  ensureStickyInstanceCookie(req, res, getServerInstanceId(), { secure: useHttps });
  next();
});
app.use((req, res, next) => {
  if (!req?.path?.startsWith('/api/') || !isHttpTimingEnabled()) return next();
  const requestId = randomSessionId();
  const startedAt = Date.now();
  console.log('[http-timing] start', requestId, req.method, req.originalUrl || req.url || req.path);
  res.on('finish', () => {
    console.log('[http-timing] end', requestId, res.statusCode, Date.now() - startedAt + 'ms', req.method, req.originalUrl || req.url || req.path);
  });
  next();
});

installWidgetSecurityHeaders(app, { useHttps });
app.use(handleWidgetCorsPreflight);
app.use(requireAuth);
app.use(applyWidgetCorsResponse);
installWidgetApiGate(app);

registerPublicPages(app, {
  indexHtmlPath: INDEX_HTML_PATH,
  loginHtmlPath: LOGIN_HTML_PATH,
  sendVersionedHtml,
});
registerWidgetAuthorizePages(app, { applyWidgetFrameHeaders });

const uploadsDir = path.join(dataDir, 'uploads');
const clientDebugLog = createClientDebugLog(dataDir);
let lastTerminalSessionId = null;
function getLocalCallbackBaseUrl() {
  return `${useHttps ? 'https' : 'http'}://127.0.0.1:${PORT}`;
}

/**
 * Ports Browser must never reach without an explicit workspace opt-in:
 * Cretli itself plus every running OpenCode instance.
 * @returns {number[]}
 */
function readInternalBrowserPorts() {
  const ports = new Set([PORT]);
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, 'opencode-ports.json'), 'utf8'));
    for (const key of Object.keys(raw || {})) {
      const port = Number.parseInt(key, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
  } catch {
    // no OpenCode ports file -> Cretli's own port is enough
  }
  return [...ports];
}

const browserRuntime = await detectBrowserRuntime({ env: process.env });
if (!browserRuntime.available) {
  console.error(`[cretli] Browser module ${browserRuntime.status}: ${browserRuntime.reason}`);
} else if (browserRuntime.sandboxWarning) {
  console.error(`[cretli] Browser module warning: ${browserRuntime.sandboxWarning}`);
}
// Browser must never be able to reach Cretli itself, including through a
// TLS-terminating reverse proxy whose public origin is configured explicitly.
const cretliPublicOrigin = readCretliPublicOrigin();
const lanHost = getLanHost();
const browserSelfOrigins = [
  cretliPublicOrigin,
  lanHost ? `${useHttps ? 'https' : 'http'}://${lanHost}:${PORT}` : '',
  `${useHttps ? 'https' : 'http'}://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `https://localhost:${PORT}`,
].filter(Boolean);
// Respawn/backoff for a crashed Chromium. The P2c controller owns the real
// relaunch, so `schedule()` is the single gate (bounded window + exponential
// backoff). No separate `relaunch` callback is passed to the manager, so
// `handleDriverCrash` cannot relaunch a second time. Limits come from the
// RESPAWN_* env overrides via resolveLifecycleLimits; the controller never
// throws, it only resolves false, so a crash cannot take the server down.
const browserLifecycleLimits = resolveLifecycleLimits(process.env);
const browserRespawnController = createRespawnController({
  maxAttempts: browserLifecycleLimits.respawnMaxAttempts,
  baseDelayMs: browserLifecycleLimits.respawnBaseDelayMs,
  maxDelayMs: browserLifecycleLimits.respawnMaxDelayMs,
  windowMs: browserLifecycleLimits.respawnWindowMs,
  // The real relaunch: re-detect the runtime and swap the manager's driver. A
  // rejection is the controller's `fail` signal and counts against the window.
  launch: async () => {
    const next = await detectBrowserRuntime({ env: process.env });
    if (!next?.available) {
      throw new Error(`Browser runtime unavailable: ${next?.reason || next?.status || 'unknown'}`);
    }
    if (!browserManager.setDriver(next)) {
      throw new Error('Browser runtime re-detected but setDriver rejected it');
    }
    return true;
  },
  onEvent: (event) => {
    try {
      const type = String(event?.type || '');
      if (type !== 'attempt' && type !== 'fail' && type !== 'exhausted') return;
      const attempt = Number.isInteger(event?.attempt) ? ` attempt=${event.attempt}` : '';
      const reason = event?.reason ? ` reason=${event.reason}` : '';
      console.error(`[cretli] Browser respawn ${type}${attempt}${reason}`);
    } catch {
      // Observability must never break the respawn controller.
    }
  },
});
const browserManager = new BrowserSessionManager({
  driver: browserRuntime.driver,
  driverStatus: browserRuntime,
  dataDir,
  resolvePolicy: (workspaceKey) => getWorkspacePolicy(dataDir, workspaceKey),
  blockedPorts: readInternalBrowserPorts(),
  selfOrigins: browserSelfOrigins,
  // Persistent per-workspace cookies/localStorage are opt-in. The secret comes
  // from CRETLI_BROWSER_STORAGE_KEY or dataDir/browser-storage.key; without one
  // the manager reports a key-missing status and never writes plaintext.
  storageState: {
    dataDir,
    secret: process.env.CRETLI_BROWSER_STORAGE_KEY || undefined,
  },
  // HAR archives are an explicit per-session/workspace opt-in. This only wires
  // the data dir; no recorder exists until a session opts in, and every archive
  // is redacted and size-bounded before it is written.
  har: {
    dataDir,
    maxBytes: Number(process.env.CRETLI_BROWSER_HAR_MAX_BYTES) || undefined,
  },
  // A crashed Chromium is re-detected in-process and the driver is swapped
  // without a server restart; the controller above is the only launcher.
  respawn: browserRespawnController,
  multiInstanceGuard: () => assertBrowserSingleInstance(process.env),
});
// Screenshots from a previous process may still hold sensitive page content;
// clear the whole temp root before any new session writes into it.
purgeBrowserScreenshotRoot();
browserManager.startSweep();
// Kill Chromium processes a previous Cretli process left behind (crash/restart).
try {
  await browserManager.startupSweep();
} catch (err) {
  console.error(`[cretli] Browser startup sweep failed: ${err?.message || err}`);
}
// Drop persisted storageState entries past their TTL before serving any session.
browserManager.sweepStorageState();
// Make the browser_* agent tools available to SDK runs for this process. Without
// this the SDK room builder sees no runtime and (fail-closed) exposes no tools.
configureBrowserAgentRuntime({ manager: browserManager });

registerAppRoutes(app, {
  dataDir,
  serverDiagnostics,
  uploadsDir,
  browserManager,
  appendClientDebugLogFile: clientDebugLog.appendClientDebugLogFile,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  serverStartedAt: SERVER_STARTED_AT,
  getFrontAssetVersion: currentFrontAssetVersion,
  // Resolved lazily: the OpenCode manager is imported after routes register.
  getOpenCodeInstanceStats: () => openCodeManager?.getOpenCodeInstanceStats?.() || null,
  useHttps,
  port: PORT,
  frontHmrEnabled: FRONT_HMR_ENABLED,
  frontHmrForcedByEnv: FRONT_HMR_FORCED_BY_ENV,
  frontHotFallbackEnabled: FRONT_HOT_FALLBACK_ENABLED,
  getConfiguredWorkspaceSelection,
  isSessionSyncEnabled,
  resolveFrontHmrEnabledFromSettings,
  projectRoot: __dirname,
  getCurrentWorkspace,
  getCurrentWorkspaceFile,
  getCurrentCwd,
  agentSessions,
  getCurrentAgentRunResumeId: () => currentAgentRunResumeId,
  setCurrentAgentRunResumeId: (id) => { currentAgentRunResumeId = id; },
  agentCmd: AGENT_CMD,
  agentModel: AGENT_MODEL,
  workspaceDirForAgent,
  buildAgentSpawnEnv,
  widgetChatListScope,
  getLocalCallbackBaseUrl,
  loadCurrentTasks,
  loadTasksForWorkspace,
  taskRuns,
  agentRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  buildTaskRunScopeSnapshot,
  isTaskRunInScope,
  randomSessionId,
  loadAgentsSchedule,
  saveAgentsSchedule,
  verifyAgentCallback,
  terminalSessions,
  getLastTerminalSessionId: () => lastTerminalSessionId,
  setLastTerminalSessionId: (sessionId) => { lastTerminalSessionId = sessionId; },
});

const wss = new WebSocketServer({ server });
const wsRouterCtx = {
  frontHotFallbackEnabled: FRONT_HOT_FALLBACK_ENABLED,
  widgetChatAccessScope,
  workspaceDirForAgent,
  agentCmd: AGENT_CMD,
  agentModel: AGENT_MODEL,
  getCurrentCwd,
  getCurrentWorkspaceFile,
  isSessionSyncEnabled,
  terminalSessions,
  agentSessions,
  taskRuns,
  agentRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  getCurrentAgentRunResumeId: () => currentAgentRunResumeId,
  setCurrentAgentRunResumeId: (id) => { currentAgentRunResumeId = id; },
  getLastTerminalSessionId: () => lastTerminalSessionId,
  setLastTerminalSessionId: (sessionId) => { lastTerminalSessionId = sessionId; },
  randomSessionId,
  buildInteractivePtyEnv,
  loadCurrentTasks,
  buildTaskRunScopeSnapshot,
  isTaskRunInScope,
  loadAgentsSchedule,
  dataDir,
  useHttps,
  publicOrigin: cretliPublicOrigin,
  browserManager,
};
attachWebSocketHandlers(wss, wsRouterCtx);

await installFrontHmrMiddleware({ app, projectRoot: __dirname, enabled: FRONT_HMR_ENABLED });
registerDevAndUpdateRoutes(app, {
  taskRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  projectRoot: __dirname,
  frontHmrForcedByEnv: FRONT_HMR_FORCED_BY_ENV,
  frontHmrEnabled: FRONT_HMR_ENABLED,
  resolveFrontHmrEnabledFromSettings,
  getServerRestartScheduled: () => serverRestartScheduled,
  setServerRestartScheduled: (scheduled) => { serverRestartScheduled = scheduled; },
  devBuildRunContext: {
    taskRuns,
    devBuildRunId: DEV_BUILD_RUN_ID,
    getCurrentCwd,
    getCurrentWorkspace,
    projectRoot: __dirname,
    buildInteractivePtyEnv,
    queuePtyOutput,
    flushPtyOutput,
    broadcastToClients,
    taskRunBufferMax: TASK_RUN_BUFFER_MAX,
  },
});
app.use('/dist/app', (req, res, next) => {
  if (/\.(?:css|js)$/.test(String(req.path || ''))) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(PUBLIC_DIR));
const sdkRoomTransport = await initSdkRoomTransport();
const seededRevisionCount = seedChatHistoryRevisionsFromIndex(listChatHistoryHeadSeqs());
const lanSetupGuard = assertLanSetupGuard({
  authConfigured: isAuthConfigured(),
  setupToken: readSetupToken(),
  lanExposed: isLanExposed(),
});
if (!lanSetupGuard.ok) {
  console.error(`Cretli: ${lanSetupGuard.message}`);
  process.exit(1);
}
await installDelegationTestAdapters();
void bootDelegationRuntime();
let delegationShutdownStarted = false;
/**
 * OpenCode manager module, preloaded next to the startup sweep so the first
 * shutdown phase can call `beginOpenCodeShutdown()` synchronously. Null only
 * during early boot, when no OpenCode instance can exist yet.
 *
 * @type {typeof import('./lib/opencode/opencode-server-manager.js') | null}
 */
let openCodeManager = null;

/**
 * @param {string} signal
 * @param {{ exitCode?: number }} [options]
 */
async function shutdownDelegationAndExit(signal, options = {}) {
  if (delegationShutdownStarted) return;
  delegationShutdownStarted = true;
  const forcedExitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  serverDiagnostics.record('shutdown-signal', { signal });

  // Phase 1 — synchronous, never awaited. Refuse new chats/delegations, block
  // new OpenCode instances and SIGTERM every OpenCode process group. This is a
  // deliberate first step: under earlyoom or a restart those runs cannot finish
  // anyway, so freeing their memory and marking them interrupted is worth more
  // than a graceful drain. See docs/TROUBLESHOOTING.md §6.
  beginServerShutdown();
  beginDelegationShutdown();
  let openCodePhaseOne = null;
  try {
    openCodePhaseOne = openCodeManager?.beginOpenCodeShutdown?.() || null;
  } catch (err) {
    console.error(`[cretli] ${signal}: OpenCode phase-1 signal error: ${err?.message || err}`);
  }
  // Phase 1 for every other owned child: adopt SDK-managed harness CLI
  // descendants first, then SIGTERM the whole registry synchronously. The
  // detached restart helper is excluded by the registry.
  let childPhaseOne = null;
  try {
    registerServerDescendants();
  } catch (err) {
    console.error(`[cretli] ${signal}: child-process descendant discovery error: ${err?.message || err}`);
  }
  try {
    childPhaseOne = beginChildProcessShutdown();
  } catch (err) {
    console.error(`[cretli] ${signal}: child-process phase-1 signal error: ${err?.message || err}`);
  }

  // Phase 2 — bounded wait, SIGKILL escalation and state persistence. Only
  // after this do the slow browser and delegation teardowns run.
  let openCodeResult = null;
  try {
    openCodeResult = openCodeManager?.finishOpenCodeShutdown
      ? await openCodeManager.finishOpenCodeShutdown()
      : null;
  } catch (err) {
    console.error(`[cretli] ${signal}: OpenCode shutdown phase error: ${err?.message || err}`);
  }
  serverDiagnostics.record('shutdown-opencode', {
    signal,
    ...(openCodePhaseOne || {}),
    ...(openCodeResult || {}),
  });
  if (openCodeResult && !openCodeResult.ok) {
    console.error(`[cretli] ${signal}: OpenCode shutdown incomplete; ${openCodeResult.remaining.length} process(es) survived SIGKILL`);
  }
  let childResult = null;
  try {
    childResult = await finishChildProcessShutdown();
  } catch (err) {
    console.error(`[cretli] ${signal}: child-process shutdown phase error: ${err?.message || err}`);
  }
  serverDiagnostics.record('shutdown-child-processes', {
    signal,
    ...(childPhaseOne || {}),
    ...(childResult || {}),
  });
  if (childResult && !childResult.ok) {
    console.error(`[cretli] ${signal}: child-process shutdown incomplete; ${childResult.remaining.length} process(es) survived SIGKILL`);
  }

  // Browser sessions are ephemeral: close Chromium before exiting.
  try {
    browserManager.stopSweep();
    await browserManager.closeAll(`shutdown:${signal}`);
    // Sweep any Chromium that outlived its closed session.
    await browserManager.startupSweep();
  } catch (err) {
    console.error(`[cretli] ${signal}: browser shutdown error: ${err?.message || err}`);
  }
  let result = { ok: false, timedOut: true };
  try {
    result = await shutdownDelegationRuntime({ timeoutMs: 8000 });
  } catch (err) {
    console.error(`[cretli] ${signal}: delegation shutdown error: ${err?.message || err}`);
  }
  const code = forcedExitCode !== null ? forcedExitCode : (result.ok ? 0 : 1);
  console.error(`[cretli] ${signal}: delegation shutdown ${result.ok ? 'complete' : 'timed out'}`);
  process.exit(code);
}
// Fatal paths that really end the process must run the same cleanup as a
// signal. Dev never reaches this: the fatal handler does not terminate in dev.
fatalProcessShutdown = (kind) => {
  // Best-effort fallback so a wedged async cleanup cannot hang the process
  // forever; phase 1 has already signalled OpenCode synchronously.
  const fallbackTimer = setTimeout(() => process.exit(1), 15000);
  if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
  void shutdownDelegationAndExit(kind, { exitCode: 1 });
};
process.on('SIGTERM', () => {
  void shutdownDelegationAndExit('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdownDelegationAndExit('SIGINT');
});
server.on('error', (err) => {
  console.error('[fatal] HTTP server error:', err?.stack || err?.message || err);
  serverDiagnostics.record('server-error', {
    errorName: String(err?.name || 'Error').slice(0, 80),
    message: err?.message || String(err),
  }, { fatal: !server.listening });
  if (!server.listening) void shutdownDelegationAndExit('server-error', { exitCode: 1 });
});
// A SIGKILL/earlyoom never reaches shutdownDelegationAndExit, so any OpenCode
// process owned by the previous Cretli server is an orphan. Reclaim them from
// the ownership registry before the first instance of this process exists.
try {
  openCodeManager = await import('./lib/opencode/opencode-server-manager.js');
  const sweep = await openCodeManager.reconcileOpenCodePortRegistry();
  const summary = [
    sweep.killed.length ? `stopped ${sweep.killed.length}` : '',
    sweep.removed.length ? `removed ${sweep.removed.length}` : '',
    sweep.kept.length ? `kept ${sweep.kept.length}` : '',
  ].filter(Boolean).join(', ');
  if (summary) console.log(`[cretli] OpenCode startup sweep: ${summary}`);
} catch (err) {
  console.warn('[cretli] OpenCode startup sweep failed:', err?.message || err);
}
// Same reclaim for the other owned children (PTY, MCP stdio, review-verify,
// harness CLI). A graceful shutdown already stopped them; this is the SIGKILL /
// earlyoom path. The detached restart helper is never signalled.
try {
  const childSweep = await reconcileChildProcessRegistry();
  const childSummary = [
    childSweep.killed.length ? `stopped ${childSweep.killed.length}` : '',
    childSweep.removed.length ? `removed ${childSweep.removed.length}` : '',
    childSweep.kept.length ? `kept ${childSweep.kept.length}` : '',
  ].filter(Boolean).join(', ');
  if (childSummary) console.log(`[cretli] child-process startup sweep: ${childSummary}`);
} catch (err) {
  console.warn('[cretli] child-process startup sweep failed:', err?.message || err);
}
try {
  const { killExternalBuildProcesses } = await import('./lib/dev-build.js');
  killExternalBuildProcesses();
} catch (err) {
  console.warn('[cretli] webpack CLI watch startup sweep failed:', err?.message || err);
}
// Register harness CLI children at spawn time and keep periodic discovery as a
// backstop for SDK subprocesses that bypass our spawn sites.
installChildProcessSpawnTracking();
startChildProcessDiscovery();
server.listen(PORT, BIND_HOST, () => {
  serverDiagnostics.record('server-listen');
  installServerLogCapture();
  // Surface memory/orphan alarms the machine-level monitor wrote while this
  // server was down, then keep polling so alarms written while it is up show up
  // without a restart. The notification store dedupes by fingerprint.
  const refreshMemoryMonitorAlerts = () => {
    void publishMemoryMonitorAlerts({ dataDir })
      .then((summary) => {
        if (summary.published > 0) {
          console.log(`[cretli] memory monitor: published ${summary.published} alert(s) to the notification centre`);
        }
      })
      .catch((err) => console.warn('[cretli] memory monitor alert publish failed:', err?.message || err));
  };
  refreshMemoryMonitorAlerts();
  const memoryMonitorAlertTimer = setInterval(refreshMemoryMonitorAlerts, 60_000);
  memoryMonitorAlertTimer.unref?.();
  if (FRONT_HOT_FALLBACK_ENABLED) installFrontBuildWatcher(__dirname, SERVER_INSTANCE_TOKEN);
  setInterval(() => runAgentsScheduler(wsRouterCtx), AGENTS_SCHEDULER_INTERVAL_MS);
  logServerReady({
    protocol: useHttps ? 'https' : 'http',
    port: PORT,
    bindHost: BIND_HOST,
    useHttps,
    projectRoot: __dirname,
    frontHmrEnabled: FRONT_HMR_ENABLED,
    seededRevisionCount,
    sdkRoomTransport,
    clientDebugLogPath: clientDebugLog.logPath,
    agentCallbackToken: AGENT_CALLBACK_TOKEN,
    getCurrentWorkspace,
    getCurrentCwd,
  });
});
