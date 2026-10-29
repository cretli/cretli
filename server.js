/**
 * Cretli server: HTTP + WebSocket (PTY terminal + agent chat).
 * Terminal = shell in the workspace. Chat = agent harnesses / OpenRouter / Cursor SDK
 * in the same workspace. Agent sessions survive a browser close — on client
 * disconnect the PTY is kept and the buffer keeps appending; resume + catch-up
 * restores the view.
 */

// Rename the process as early as this module runs so `/proc/<pid>/comm` (set via
// libuv's prctl(PR_SET_NAME)) no longer reads `node`. ESM evaluates static
// imports before this line, but the title is still set before `listen()` and
// long-lived harness work. This keeps the server out of the earlyoom
// `--prefer ^(node|...)` match, so under memory pressure the killer targets a
// child (webpack, a harness) instead of the server.
process.title = 'cretli';

import { createServerStallWatchdog } from './lib/server-health/server-stall-watchdog.js';
import { addTodo, listTodos } from './lib/persist/todos-store.js';
import { publishNotification } from './lib/notifications/notification-store.ts';
import express from 'express';
import compression from 'compression';
import { guardAsyncRoutes } from './lib/http-async-guard.js';
import { resolveServerTransport, exitOnTlsFailure } from './lib/server-tls.js';
import { registerTlsSettingsRoutes } from './lib/routes/tls-settings-routes.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';
import { findWorkspaceFile } from './lib/workspace.js';
import { closeChatHistoryService, listChatHistoryHeadSeqs, openChatHistoryService } from './lib/persist/chat-history-service.js';
import { runOfflineRestoreStartupRecovery } from './lib/backup/offline/startup-recovery.js';
import { createRestoreGate } from './lib/backup/offline/restore-gate.js';
import { resolveControlDir } from './lib/backup/offline/control-dir.js';
import { getConversationsBackupService } from './lib/backup/conversations-backup-service.js';
import { getOnlineBackupService } from './lib/backup/online/online-service.js';
import { flushAllBufferedHistory } from './lib/persist/history-room-flusher.js';
import { seedChatHistoryRevisionsFromIndex } from './lib/persist/chat-history-revisions.js';
import { initSdkRoomTransport } from './lib/sdk/cursor-agent-sdk-ws.ts';
import { getServerInstanceId } from './lib/sdk/sdk-instance-id.ts';
import { ensureStickyInstanceCookie } from './lib/sdk/sdk-sticky-session.ts';
import { resolveAgentCommand, buildAgentSpawnEnv } from './lib/agent-cli.js';
import { loadSettings } from './lib/persist/settings.js';
import { flushCoalescedWrites, writeJsonAtomic, writeJsonCoalesced } from './lib/persist/atomic-write.js';

// The exit event is synchronous and also runs for direct process.exit() calls
// during early boot, before the graceful shutdown handlers are registered.
process.on('exit', () => {
  try {
    flushCoalescedWrites();
  } catch (err) {
    console.error('[cretli] coalesced write exit flush failed:', err?.message || err);
  }
});
if (process.env.CRETLI_TEST_CHAT_RUN_ADAPTER === '1' && process.env.CRETLI_TEST_COALESCED_SHUTDOWN_FILE) {
  writeJsonCoalesced(process.env.CRETLI_TEST_COALESCED_SHUTDOWN_FILE, { source: 'shutdown-test' }, 'utf8', {
    maxDelayMs: 10000,
  });
}
import {
  isApiRequestPath,
  isAuthConfigured,
  isLanExposed,
  requireAuth,
  verifyAgentCallback,
} from './lib/auth.js';
import {
  applyWidgetCorsResponse,
  handleWidgetCorsPreflight,
} from './lib/widget/widget-cors.ts';
import { widgetChatAccessScope, widgetChatListScope } from './lib/widget/widget-chat-scope.ts';
import {
  applyWidgetFrameHeaders,
  installWidgetApiGate,
  installWidgetSecurityHeaders,
} from './lib/widget/widget-http.ts';
import { registerWidgetAuthorizePages } from './lib/widget/widget-auth-page.ts';
import { registerPublicPages } from './lib/public-pages.js';
import { createVersionedHtmlSender } from './lib/versioned-html.js';
import { createWorkspaceContext, isTaskRunInScope } from './lib/workspace-context.js';
import { createClientDebugLog } from './lib/client-debug-log.js';
import { buildInteractivePtyEnv as buildPtyEnv } from './lib/pty-env.js';
import { registerAppRoutes, registerDevAndUpdateRoutes } from './lib/register-app-routes.js';
import { markDeferredBootFailed, bootDelegationRuntime, shutdownDelegationRuntime, installDelegationTestAdapters, beginDelegationShutdown, recordShutdownIntent, flushChatStateForShutdown } from './lib/delegation-runtime-boot.js';
import { settleDelegationHistoryTasks } from './lib/delegation-service.js';
import { resolveShutdownIntentReason } from './lib/recovery/recovery-shutdown.ts';
import { beginServerShutdown, resolveRestartScheduled } from './lib/update-gate.js';
import { createFatalProcessEventHandler } from './lib/process-fatal.js';
import {
  beginChildProcessShutdown,
  finishChildProcessShutdown,
  installChildProcessSpawnTracking,
  reconcileChildProcessRegistry,
  registerServerDescendants,
  startChildProcessDiscovery,
} from './lib/child-process-registry.js';
import { setDelegationLifecycleState } from './lib/delegation-lifecycle.js';
import { logServerReady, bootPhase, bootListenTotal } from './lib/boot-log.js';
import { isHttpTimingEnabled } from './lib/routes/settings-routes.js';
import {
  broadcastToClients,
  flushPtyOutput,
  queuePtyOutput,
  TASK_RUN_BUFFER_MAX,
} from './lib/pty-broadcast.js';
import { attachWebSocketHandlers } from './lib/ws/ws-router.ts';
import { readCretliPublicOrigin } from './lib/ws/ws-origin.ts';
import { getLanHost } from './lib/lan-host.js';
import { installServerLogCapture } from './lib/ws/server-log-ws.ts';
import { installFrontBuildWatcher } from './lib/ws/front-build-ws.ts';
import { readEnvAlias } from './lib/env-alias.js';
import { assertLanSetupGuard, listenOnHosts, readSetupToken, resolveBindHost, resolveBindHosts } from './lib/bind-host.js';
import { resolveDataPath, resolveProjectPath } from './lib/runtime-paths.js';
import { resolveFrontAssetVersion } from './lib/front-asset-version.js';
import { setModelScoreRows } from './lib/model-catalog-meta.js';
import { loadModelScoreRows } from './lib/model-score-heuristics-fs.js';
import { detectBrowserRuntime } from './lib/browser/runtime-detect.js';
import { buildBrowserRuntimeEnv, normalizeExternalMaxSessions, readCalmPaceModeSetting } from './lib/browser/cdp-config.js';
import { BrowserSessionManager } from './lib/browser/session-manager.js';
import { assertBrowserSingleInstance } from './lib/browser/multi-instance.js';
import { createRespawnController, resolveLifecycleLimits } from './lib/browser/lifecycle.js';
import { purgeBrowserScreenshotRoot } from './lib/browser/screenshot-file.js';
import { addAllowedOrigin, resolveBrowserPolicy } from './lib/browser/policy-store.js';
import { createNavigationConsentRegistry } from './lib/browser/navigation-consent.js';
import { notifyBrowserNavigationConsent } from './lib/agent-needs-input-push.js';
import { setBrowserConsentPending } from './lib/agent-presence-hooks.js';
import { broadcastBrowserConsentChanged } from './lib/chat-list-updates.js';
import { configureBrowserAgentRuntime } from './lib/browser/agent-tools.js';
import { configureChatMedia } from './lib/chat-media.js';
import { createServerDiagnostics } from './lib/server-diagnostics.js';
import { createHttpTimingLog, isHttpTimingExcludedPath, resolveHttpTimingMinMs } from './lib/http-timing-log.js';
import { resolvePositiveIntEnv, startLogCapTimer } from './lib/log-rotate.js';
import { warnLargeDataFiles } from './lib/data-dir-size-warning.js';
import { buildShutdownOriginSnapshot } from './lib/shutdown-origin.js';
import { loadOptionalHarnessPlugins } from './lib/agent-harness/optional-harness-plugins.ts';
import { listProcessLifecycleProviders } from './lib/agent-harness/builtin-harness-providers.ts';
import {
  beginProcessLifecycleStop,
  finishProcessLifecycleStop,
  startProcessLifecycles,
} from './lib/agent-harness/process-lifecycle-runner.ts';
import { publishMemoryMonitorAlerts } from './lib/notifications/memory-monitor-producer.ts';
import { mcpResourceObserver } from './lib/memory-monitor.js';
import { startHarnessRecoveryNotifications } from './lib/notifications/harness-recovery-producer.ts';
import { getProcessStartTime } from './lib/delegation-owner-lock.js';
import { bootOomDiagnostics, recordCleanShutdown, shouldRecordCleanShutdown } from './lib/oom-diagnostics.js';
import { configureExecutorLaunchGate, isExecutorLaunchGateEnabled } from './lib/executor-launch-gate.js';
import { startServerCodeFreshnessWorker } from './lib/server-code-freshness-worker.js';

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
const BIND_HOSTS = resolveBindHosts();
const DEFAULT_WORKSPACE_FILE = process.env.WORKSPACE_FILE || findWorkspaceFile();
const AGENT_CMD = resolveAgentCommand(process.env.CURSOR_AGENT_CMD || 'agent');
const AGENT_MODEL = process.env.CURSOR_AGENT_MODEL ?? 'auto';
const AGENT_CALLBACK_TOKEN = process.env.AGENT_CALLBACK_TOKEN || '';
const SERVER_INSTANCE_TOKEN = randomUUID();
const SERVER_STARTED_AT = Date.now();
// Linux starttime jiffies: the external monitor uses pid + this value to tell
// the recorded server from a recycled PID.
const SERVER_PROCESS_STARTED_AT = getProcessStartTime(process.pid);
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

// Bound a redirected server log when a launcher told us where it is. A plain
// `npm start` in a terminal leaves CRETLI_SERVER_LOG_FILE unset, so this is a
// no-op there.
startLogCapTimer(String(process.env.CRETLI_SERVER_LOG_FILE || '').trim() || undefined, {
  intervalMs: resolvePositiveIntEnv(process.env, 'CRETLI_LOG_CAP_CHECK_MS', 60_000),
  maxBytes: resolvePositiveIntEnv(process.env, 'CRETLI_SERVER_LOG_MAX_BYTES', 10 * 1024 * 1024),
  keep: 3,
});
let serverRestartScheduled = false;
const FRONT_HOT_FALLBACK_ENV = readEnvAlias({
  current: 'CRETLI_FRONT_HOT_FALLBACK',
  legacy: 'CURSOR_REMOTE_FRONT_HOT_FALLBACK',
});
// The dist watcher is on unless explicitly off.
const FRONT_HOT_FALLBACK_ENABLED =
  FRONT_HOT_FALLBACK_ENV !== '0' && FRONT_HOT_FALLBACK_ENV !== 'false';

const app = guardAsyncRoutes(express());
const PUBLIC_DIR = String(process.env.CRETLI_PUBLIC_DIR || '').trim() || path.join(__dirname, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_HTML_PATH = path.join(PUBLIC_DIR, 'login.html');
const dataDir = resolveDataPath();
// Durable per-chat media (browser screenshots); CRETLI_CHAT_MEDIA=0 turns it off.
configureChatMedia({ dataDir, enabled: process.env.CRETLI_CHAT_MEDIA !== '0' });
const restoreControlDir = resolveControlDir(dataDir);
const restoreGate = createRestoreGate(restoreControlDir);
// One startup warning per top-level data file past the size threshold; the same
// list is available from `GET /api/diagnostics/server`.
warnLargeDataFiles(dataDir);
// Publish the durable server identity before anything else can crash, then show
// OOM markers the external monitor wrote while this server was down. The monitor
// reads the same file; a SIGKILLed server leaves it behind on purpose.
let oomBoot = null;
try {
  oomBoot = bootOomDiagnostics({
    dataDir,
    serverPid: process.pid,
    startedAt: SERVER_PROCESS_STARTED_AT,
    instanceToken: SERVER_INSTANCE_TOKEN,
    diagnostics: serverDiagnostics,
  });
  if (oomBoot.hasNewMarker) {
    const last = oomBoot.lastMarker || {};
    console.warn(
      `[cretli] OOM diagnostics: ${oomBoot.markerCount} marker(s) from a previous run;`
      + ` last ${last.target || 'process'} pid ${last.pid ?? 'n/a'}`
      + ` ${last.cause || 'unknown'}/${last.confidence || 'unknown'} from ${last.source || 'none'}`,
    );
  }
} catch (err) {
  console.warn('[cretli] OOM diagnostics boot failed:', err?.message || err);
}
// Pre-flight every managed executor launch. Critical host memory or too little
// headroom refuses the launch before a process is spawned; unknown memory state
// stays non-blocking. `CRETLI_EXECUTOR_MEMORY_GUARD=0` disables it.
try {
  configureExecutorLaunchGate({
    onDecision: (decision) => {
      if (decision.allowed) return;
      try {
        serverDiagnostics.record('executor-launch-denied', {
          level: decision.level,
          reason: decision.reason,
          type: decision.type,
          label: decision.label,
          hostTotalBytes: decision.hostTotalBytes,
          hostAvailableBytes: decision.hostAvailableBytes,
        });
      } catch {
        // The decision is still enforced without a diagnostics write.
      }
      console.warn(
        `[cretli] executor launch denied (${decision.level}): ${decision.reason}`
        + ` [${decision.type || 'executor'}${decision.label ? `: ${decision.label}` : ''}]`,
      );
    },
  });
  if (isExecutorLaunchGateEnabled()) console.log('[cretli] executor memory guard is enabled');
} catch (err) {
  console.warn('[cretli] executor memory guard configuration failed:', err?.message || err);
}
const keyPath = process.env.SSL_KEY_PATH || path.join(dataDir, 'key.pem');
const certPath = process.env.SSL_CERT_PATH || path.join(dataDir, 'cert.pem');
let useHttps = false;
let tlsCertificate;
let server;
try {
  const resolved = resolveServerTransport(app, { keyPath, certPath });
  server = resolved.server;
  useHttps = resolved.useHttps;
  tlsCertificate = resolved.tlsCertificate;
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
const DEV_BUILD_RUN_ID = 'dev-build';
function randomSessionId() {
  return randomBytes(8).toString('hex');
}
function buildInteractivePtyEnv(overrides = {}) {
  return buildPtyEnv({ localRuntimeHome: LOCAL_RUNTIME_HOME, overrides });
}

app.use(compression({
  filter: (req, res) => {
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
// Leveled timing: measure every API request, but only surface slow ones. The
// debug flag switches the slow line to `[http-timing]`; the warn path stays
// active (with a rate budget) when the flag is off.
const httpTimingLog = createHttpTimingLog({ minMs: resolveHttpTimingMinMs(process.env) });
app.use((req, res, next) => {
  const requestPath = String(req?.path || '');
  if (!isApiRequestPath(requestPath) || isHttpTimingExcludedPath(requestPath)) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    httpTimingLog.record({
      method: req.method,
      url: req.originalUrl || req.url || requestPath,
      path: requestPath,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      timingEnabled: isHttpTimingEnabled(),
    });
  });
  next();
});

installWidgetSecurityHeaders(app, { useHttps });
app.use(handleWidgetCorsPreflight);
app.use(requireAuth);
app.use(applyWidgetCorsResponse);
installWidgetApiGate(app);
registerTlsSettingsRoutes(app, { server, certificate: tlsCertificate, keyPath, certPath });

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

// Repo harness plugins (origin builtin-optional) join the provider, backend and
// MCP adapter registries before anything reads them. Opt-in through
// CRETLI_OPTIONAL_HARNESSES; a failing plugin is logged and skipped.
{
  const optionalPlugins = await loadOptionalHarnessPlugins();
  if (optionalPlugins.loaded.length > 0) console.log(`[cretli] optional harness plugins: ${optionalPlugins.loaded.join(', ')}`);
  for (const failure of optionalPlugins.errors) {
    console.warn(`[cretli] optional harness plugin "${failure.dir}" skipped (${failure.code}): ${failure.error}`);
  }
}

/** Providers that own long-lived processes (start, stop, monitor hooks). */
const processLifecycleProviders = listProcessLifecycleProviders();

/**
 * Ports Browser must never reach without an explicit workspace opt-in:
 * Cretli itself plus every port a provider's process lifecycle reports.
 * @returns {number[]}
 */
function readInternalBrowserPorts() {
  const ports = new Set([PORT]);
  for (const { processLifecycle } of processLifecycleProviders) {
    try {
      for (const port of processLifecycle.listInternalPorts?.(dataDir) || []) ports.add(port);
    } catch {
      // a provider without a readable ports file -> Cretli's own port is enough
    }
  }
  return [...ports];
}

const browserRuntime = await detectBrowserRuntime({ env: buildBrowserRuntimeEnv(process.env, loadSettings()) });
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
    const next = await detectBrowserRuntime({ env: buildBrowserRuntimeEnv(process.env, loadSettings()) });
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
// Chat prompt for agent navigations outside the workspace allowlist.
const browserNavigationConsent = createNavigationConsentRegistry({
  persistOrigin: (workspaceKey, origin) => addAllowedOrigin(dataDir, workspaceKey, origin, loadSettings()),
  onChange: ({ chatId }) => {
    setBrowserConsentPending(chatId, browserNavigationConsent.list(chatId).length > 0);
    broadcastBrowserConsentChanged({ chatId });
  },
  onCreate: ({ chatId, id, origin }) => notifyBrowserNavigationConsent({ chatId, requestId: id, origin }),
});
const browserManager = new BrowserSessionManager({
  consent: browserNavigationConsent,
  externalNativeNetwork: loadSettings().browserCdpNativeNetwork === true,
  calmPaceMode: readCalmPaceModeSetting(loadSettings()),
  externalMaxSessions: normalizeExternalMaxSessions(loadSettings().browserCdpMaxSessions),
  driver: browserRuntime.driver,
  driverStatus: browserRuntime,
  dataDir,
  resolvePolicy: (workspaceKey) => resolveBrowserPolicy(dataDir, workspaceKey, loadSettings()),
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
configureBrowserAgentRuntime({ manager: browserManager, consent: browserNavigationConsent });

registerAppRoutes(app, {
  dataDir,
  restoreGate,
  serverDiagnostics,
  uploadsDir,
  browserManager,
  navigationConsent: browserNavigationConsent,
  appendClientDebugLogFile: clientDebugLog.appendClientDebugLogFile,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  serverStartedAt: SERVER_STARTED_AT,
  getFrontAssetVersion: currentFrontAssetVersion,
  // Resolved lazily: provider runtimes are preloaded after routes register.
  getInstanceStats: () => {
    for (const { processLifecycle } of processLifecycleProviders) {
      const stats = processLifecycle.getStats?.();
      if (stats) return stats;
    }
    return null;
  },
  useHttps,
  port: PORT,
  frontHotFallbackEnabled: FRONT_HOT_FALLBACK_ENABLED,
  getConfiguredWorkspaceSelection,
  isSessionSyncEnabled,
  projectRoot: __dirname,
  getCurrentWorkspace,
  getCurrentWorkspaceFile,
  getCurrentCwd,
  agentSessions,
  agentCmd: AGENT_CMD,
  agentModel: AGENT_MODEL,
  workspaceDirForAgent,
  buildAgentSpawnEnv,
  widgetChatListScope,
  getLocalCallbackBaseUrl,
  loadCurrentTasks,
  loadTasksForWorkspace,
  taskRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  buildTaskRunScopeSnapshot,
  isTaskRunInScope,
  randomSessionId,
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
  devBuildRunId: DEV_BUILD_RUN_ID,
  getLastTerminalSessionId: () => lastTerminalSessionId,
  setLastTerminalSessionId: (sessionId) => { lastTerminalSessionId = sessionId; },
  randomSessionId,
  buildInteractivePtyEnv,
  loadCurrentTasks,
  buildTaskRunScopeSnapshot,
  isTaskRunInScope,
  dataDir,
  restoreGate,
  useHttps,
  publicOrigin: cretliPublicOrigin,
  browserManager,
};
attachWebSocketHandlers(wss, wsRouterCtx);

registerDevAndUpdateRoutes(app, {
  taskRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  projectRoot: __dirname,
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
bootPhase('sdk-room-transport');
// An interrupted offline restore must roll forward before any store opens or automatic work starts.
try {
  const restoreRecovery = runOfflineRestoreStartupRecovery();
  if (restoreRecovery.action !== 'none') console.log(`Cretli: offline restore ${restoreRecovery.id} recovery: ${restoreRecovery.action}`);
  if (restoreRecovery.paused) console.warn('Cretli: dataset is in post-restore pause (run `node scripts/cretli-offline-data.mjs resume` after review).');
} catch (err) {
  console.error(`Cretli: offline restore recovery failed (${err?.code || 'error'}): ${err?.message || err}`);
  process.exit(1);
}
bootPhase('offline-restore-recovery');
// The ONE history backend of this process is opened before any caller can read or write history. Legacy files are
// the default; the control marker (and nothing else) selects another backend, and any inconsistency refuses to boot.
// The open (the SQLite store runs an O(size) integrity check in its worker thread) is STARTED here but not awaited:
// the HTTP listener comes up first, and every history caller waits on the in-flight open inside
// `getChatHistoryAdapter()`, so no history request is served before the backend is ready.
const chatHistoryOpen = openChatHistoryService().then(() => {
  bootPhase('chat-history-open');
}, (err) => {
  console.error(`Cretli: cannot open the chat-history backend (${err?.code || 'error'}): ${err?.message || err}`);
  process.exit(1);
});
const lanSetupGuard = assertLanSetupGuard({
  authConfigured: isAuthConfigured(),
  setupToken: readSetupToken(),
  lanExposed: isLanExposed(),
});
if (lanSetupGuard.ok === false) {
  console.error(`Cretli: ${lanSetupGuard.message}`);
  process.exit(1);
}
// Until the deferred boot below has run, the delegation runtime must not admit work (the lifecycle defaults to ready).
const delegationBootPaused = Boolean(/** @type {any} */ (restoreGate).shouldSkipAutomaticWork());
if (!delegationBootPaused) setDelegationLifecycleState('initializing');
let seededRevisionCount = 0;
/**
 * Post-listen boot work that needs the history backend: conversation-import recovery, revision seed, then the
 * delegation runtime (whose own steps yield to the event loop between heavy synchronous stages).
 */
async function runDeferredBoot() {
  await chatHistoryOpen;
  // Roll an interrupted conversation import forward or back; failure must not block boot.
  try {
    await getConversationsBackupService().recover();
  } catch (err) {
    console.error(`Cretli: conversation import recovery failed (${err?.code || 'error'}): ${err?.message || err}`);
  }
  bootPhase('conversation-import-recovery');
  seededRevisionCount = seedChatHistoryRevisionsFromIndex(await listChatHistoryHeadSeqs());
  if (seededRevisionCount > 0) console.log(`  Chat history revisions seeded: ${seededRevisionCount}`);
  bootPhase('chat-history-revision-seed');
  await installDelegationTestAdapters();
  await bootDelegationRuntime({ shouldSkipAutomaticWork: /** @type {any} */ (restoreGate).shouldSkipAutomaticWork });
  bootPhase('delegation-runtime-boot-done');
}
const stallWatchdog = createServerStallWatchdog({
  repoRoot: __dirname,
  dataDir,
  addTodo,
  listTodos,
  publishNotification,
});
let delegationShutdownStarted = false;

/**
 * @param {string} signal
 * @param {{ exitCode?: number }} [options]
 */
async function shutdownDelegationAndExit(signal, options = {}) {
  if (delegationShutdownStarted) return;
  delegationShutdownStarted = true;
  stallWatchdog.stop();
  const forcedExitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  // Captured before any child is signalled, while the sender (kill helper,
  // restart script, process manager) is most likely still alive.
  serverDiagnostics.record('shutdown-origin', { signal, origin: buildShutdownOriginSnapshot() });
  serverDiagnostics.record('shutdown-signal', { signal });

  // Phase 1 — synchronous, never awaited. Refuse new chats/delegations, block
  // new provider processes and SIGTERM every provider process group. This is a
  // deliberate first step: under earlyoom or a restart those runs cannot finish
  // anyway, so freeing their memory and marking them interrupted is worth more
  // than a graceful drain. See docs/TROUBLESHOOTING.md §6.
  beginServerShutdown();
  beginDelegationShutdown();
  // A graceful SIGTERM/SIGINT is not by itself proof of a restart: only the
  // explicit scheduled-restart flag (dev restart / post-update restart) makes it
  // `planned_restart`; any other signal is a `user_stop`. Fatal events write no
  // intent, so the next boot classifies their runs from liveness alone.
  const shutdownIntentReason = resolveShutdownIntentReason({
    signal,
    restartScheduled: resolveRestartScheduled(),
  });
  if (shutdownIntentReason) recordShutdownIntent({ signal, reason: shutdownIntentReason });
  const lifecyclePhaseOne = beginProcessLifecycleStop(processLifecycleProviders, { signal });
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
  await finishProcessLifecycleStop(processLifecycleProviders, lifecyclePhaseOne, {
    signal,
    record: (event, detail) => serverDiagnostics.record(event, detail),
  });
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

  try {
    const { disposeAllConnections } = await import('./lib/mcp/mcp-runtime.js');
    await disposeAllConnections();
  } catch (err) {
    console.error(`[cretli] ${signal}: MCP connection shutdown error: ${err?.message || err}`);
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
  try {
    await flushChatStateForShutdown({ timeoutMs: 3000 });
  } catch (err) {
    console.error(`[cretli] ${signal}: chat state flush error: ${err?.message || err}`);
  }
  let result = { ok: false, timedOut: true };
  try {
    result = await shutdownDelegationRuntime({ timeoutMs: 8000 });
  } catch (err) {
    console.error(`[cretli] ${signal}: delegation shutdown error: ${err?.message || err}`);
  }
  // Last: records still buffered in harness rooms get one bounded commit attempt, then the history backend closes
  // (pending commands that did not commit stay in its durable pending journal and are replayed at the next start).
  let historyFlush = { ok: true, pending: 0 };
  try {
    await settleDelegationHistoryTasks();
    historyFlush = await flushAllBufferedHistory({ timeoutMs: 5000 });
    await closeChatHistoryService();
  } catch (err) {
    console.error(`[cretli] ${signal}: history shutdown error: ${err?.message || err}`);
  }
  if (!historyFlush.ok) console.error(`[cretli] ${signal}: ${historyFlush.pending} history record(s) were not committed before exit`);
  const code = forcedExitCode !== null ? forcedExitCode : (result.ok ? 0 : 1);
  console.error(`[cretli] ${signal}: delegation shutdown ${result.ok ? 'complete' : 'timed out'}`);
  // Prove this process ended through the graceful path. A SIGKILL never reaches
  // this line, so the external monitor will classify the same pid as unexpected.
  // Fatal / server-error exits (forced non-zero code) are unexpected deaths and
  // deliberately leave no clean marker, so the observer still reports them.
  try {
    if (shouldRecordCleanShutdown({ signal, exitCode: forcedExitCode })) recordCleanShutdown({
      dataDir,
      serverPid: process.pid,
      startedAt: SERVER_PROCESS_STARTED_AT,
      signal,
      diagnostics: serverDiagnostics,
    });
  } catch (err) {
    console.warn(`[cretli] ${signal}: clean shutdown marker write failed:`, err?.message || err);
  }
  try {
    const coalesced = flushCoalescedWrites();
    if (coalesced.failed) console.error(`[cretli] ${signal}: ${coalesced.failed} coalesced write(s) failed during shutdown`);
  } catch (err) {
    console.error(`[cretli] ${signal}: coalesced write shutdown flush failed:`, err?.message || err);
  }
  process.exit(code);
}
// Fatal paths that really end the process must run the same cleanup as a
// signal. Dev never reaches this: the fatal handler does not terminate in dev.
fatalProcessShutdown = (kind) => {
  // Best-effort fallback so a wedged async cleanup cannot hang the process
  // forever; phase 1 has already signalled provider processes synchronously.
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
// A SIGKILL/earlyoom never reaches shutdownDelegationAndExit, so any provider
// process owned by the previous Cretli server is an orphan. Each lifecycle hook
// reclaims its own before the first instance of this process exists.
await startProcessLifecycles(processLifecycleProviders);
bootPhase('process-lifecycles');
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
bootPhase('child-process-sweep');
try {
  const { killExternalBuildProcesses, detectStaleDevBundle } = await import('./lib/dev-build.js');
  killExternalBuildProcesses();
  const staleDevBundle = detectStaleDevBundle();
  if (staleDevBundle) console.warn('[cretli] ' + staleDevBundle);
} catch (err) {
  console.warn('[cretli] webpack CLI watch startup sweep failed:', err?.message || err);
}
// Register harness CLI children at spawn time and keep periodic discovery as a
// backstop for SDK subprocesses that bypass our spawn sites.
bootPhase('external-build-sweep');
installChildProcessSpawnTracking();
startChildProcessDiscovery();
// A post-integrate restart leaves the start gate blocked (owned); release it
// once the new process is up. An operator-set block is never touched.
try {
  const { releasePostIntegrateBlockIfOwned } = await import('./lib/workspace-watcher-runtime.js');
  if (releasePostIntegrateBlockIfOwned({ dataDir }).released) console.log('[cretli] released post-integrate start block');
} catch (err) {
  console.warn('[cretli] post-integrate block release failed:', err?.message || err);
}
listenOnHosts(server, {
  hosts: BIND_HOSTS,
  port: PORT,
  onError: (host, err) => {
    console.error(`[cretli] extra bind ${host}:${PORT} failed: ${err?.message || err}`);
    serverDiagnostics.record('server-extra-bind-error', { host, message: err?.message || String(err) });
  },
  onListening: () => {
    bootListenTotal();
    if (!delegationShutdownStarted) stallWatchdog.start();
    setImmediate(() => { void runDeferredBoot().catch((err) => {
      console.error('[cretli] deferred boot failed:', err?.message || err);
      const { code, message } = markDeferredBootFailed(err);
      serverDiagnostics.record('deferred-boot-failed', { code, message });
    }); });
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
    startHarnessRecoveryNotifications({ dataDir });
    refreshMemoryMonitorAlerts();
    const memoryMonitorAlertTimer = setInterval(refreshMemoryMonitorAlerts, 60_000);
    memoryMonitorAlertTimer.unref?.();
    mcpResourceObserver.start();
    // Baseline the backend sources now and re-hash them every period, so a server
    // left running on code that changed on disk says so instead of looking like a
    // logic bug. The timer is unref'd: it never keeps the process alive.
    startServerCodeFreshnessWorker({ rootDir: __dirname, dataDir, instanceToken: SERVER_INSTANCE_TOKEN });
    // Usage telemetry retention + optional alerts run at startup and periodically.
    // Imported lazily so a failure here cannot prevent the server from serving.
    void import('./lib/usage/usage-maintenance.ts')
      .then(({ startUsageMaintenance }) => startUsageMaintenance({ dataDir }))
      .catch((err) => console.warn('[cretli] usage maintenance startup failed:', err?.message || err));
    // Plugin harnesses start their own background jobs (e.g. balance readings) through processLifecycle.start.
    if (FRONT_HOT_FALLBACK_ENABLED) installFrontBuildWatcher(__dirname, SERVER_INSTANCE_TOKEN);
    // Opt-in online backup scheduler (off by default); an external restore pause pauses it as well.
    try { getOnlineBackupService().scheduler.start(); } catch (err) { console.warn('[cretli] online backup scheduler not started:', err?.message || err); }
    logServerReady({
      protocol: useHttps ? 'https' : 'http',
      port: PORT,
      bindHost: BIND_HOST,
      useHttps,
      projectRoot: __dirname,
      seededRevisionCount: 0,
      sdkRoomTransport,
      clientDebugLogPath: clientDebugLog.logPath,
      agentCallbackToken: AGENT_CALLBACK_TOKEN,
      getCurrentWorkspace,
      getCurrentCwd,
    });
  },
});
