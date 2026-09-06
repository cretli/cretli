/**
 * Cretli server: HTTP + WebSocket (PTY terminal + agent chat).
 * Terminal = shell in the workspace. Chat = OpenCode / OpenRouter / Cursor SDK
 * in the same workspace. Agent sessions survive a browser close — on client
 * disconnect the PTY is kept and the buffer keeps appending; resume + catch-up
 * restores the view.
 */

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
import { buildInteractivePtyEnv as buildPtyEnv } from './lib/pty-env.js';
import { registerAppRoutes, registerDevAndUpdateRoutes } from './lib/register-app-routes.js';
import { reconcileDelegationsOnBoot } from './lib/delegation-service.js';
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
import { installServerLogCapture } from './lib/ws/server-log-ws.js';
import { installFrontBuildWatcher } from './lib/ws/front-build-ws.js';
import { runAgentsScheduler, AGENTS_SCHEDULER_INTERVAL_MS } from './lib/ws/agent-run-ws-handler.js';
import { readEnvAlias } from './lib/env-alias.js';
import { assertLanSetupGuard, readSetupToken, resolveBindHost } from './lib/bind-host.js';
import { resolveDataPath, resolveProjectPath } from './lib/runtime-paths.js';
import { resolveFrontAssetVersion } from './lib/front-asset-version.js';

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
let serverRestartScheduled = false;
const FRONT_HMR_ENV_RAW = readEnvAlias({
  current: 'CRETLI_FRONT_HMR',
  legacy: 'CURSOR_REMOTE_FRONT_HMR',
});
const FRONT_HMR_FORCED_BY_ENV = typeof FRONT_HMR_ENV_RAW !== 'undefined' && FRONT_HMR_ENV_RAW !== '';
function resolveFrontHmrEnabledFromSettings(settings) {
  if (settings && typeof settings.frontHmrEnabled === 'boolean') return settings.frontHmrEnabled;
  return true;
}
const FRONT_HMR_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  (
    FRONT_HMR_FORCED_BY_ENV
      ? (FRONT_HMR_ENV_RAW !== '0' && FRONT_HMR_ENV_RAW !== 'false')
      : resolveFrontHmrEnabledFromSettings(loadSettings())
  );
const FRONT_HOT_FALLBACK_ENV = readEnvAlias({
  current: 'CRETLI_FRONT_HOT_FALLBACK',
  legacy: 'CURSOR_REMOTE_FRONT_HOT_FALLBACK',
});
const FRONT_HOT_FALLBACK_ENABLED =
  FRONT_HOT_FALLBACK_ENV === '1' || FRONT_HOT_FALLBACK_ENV === 'true';

const app = express();
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const LOGIN_HTML_PATH = path.join(__dirname, 'public', 'login.html');
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
app.use(express.json({ limit: '8mb' }));
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
registerAppRoutes(app, {
  dataDir,
  uploadsDir,
  appendClientDebugLogFile: clientDebugLog.appendClientDebugLogFile,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  serverStartedAt: SERVER_STARTED_AT,
  getFrontAssetVersion: currentFrontAssetVersion,
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
void reconcileDelegationsOnBoot();

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
  publicOrigin: readCretliPublicOrigin(),
};
attachWebSocketHandlers(wss, wsRouterCtx);

const IS_PROD = process.env.NODE_ENV === 'production';
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err?.stack || err?.message || err);
  if (IS_PROD) {
    console.error('[fatal] Terminating process (production) — restart via a process manager.');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason?.stack || reason?.message || reason);
  if (IS_PROD) {
    console.error('[fatal] Terminating process (production).');
    process.exit(1);
  }
});

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
app.use(express.static(path.join(__dirname, 'public')));
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
server.listen(PORT, BIND_HOST, () => {
  installServerLogCapture();
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
