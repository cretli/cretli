/**
 * Cretli server: HTTP + WebSocket (PTY terminal + agent chat).
 * Terminal = shell in the workspace. Chat = OpenCode / OpenRouter / Cursor SDK
 * in the same workspace. Agent sessions survive a browser close — on client
 * disconnect the PTY is kept and the buffer keeps appending; resume + catch-up
 * restores the view.
 */

import express from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import { randomUUID, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { loadWorkspace, findWorkspaceFile, expandUserPath } from './lib/workspace.js';
import { isFolderWorkspaceId } from './lib/persist/workspace-registry.js';
import { mergeFoldersForClient, resolveWorkspaceCwd } from './lib/workspace-folders.js';
import { loadChats } from './lib/persist/chats-persist.js';
import { listChatHistoryHeadSeqs } from './lib/persist/chat-history-persist.js';
import { seedChatHistoryRevisionsFromIndex } from './lib/persist/chat-history-revisions.js';
import { initSdkRoomTransport } from './lib/sdk/cursor-agent-sdk-ws.js';
import { getServerInstanceId } from './lib/sdk/sdk-instance-id.js';
import { getSdkRoomRegistryMode } from './lib/sdk/sdk-room-registry.js';
import { ensureStickyInstanceCookie } from './lib/sdk/sdk-sticky-session.js';
import { hasOpenCodeCredentials } from './lib/opencode/opencode-api-key.js';
import { resolveAgentCommand, buildAgentSpawnEnv } from './lib/agent-cli.js';
import { loadSettings } from './lib/persist/settings.js';
import { writeJsonAtomic } from './lib/persist/atomic-write.js';
import { loadTasks } from './lib/tasks.js';
import {
  isAuthConfigured,
  isAuthenticated,
  requireAuth,
  isLanExposed,
  verifyAgentCallback,
} from './lib/auth.js';
import { isSpaShellPath } from './lib/spa-routes.js';
import {
  applyWidgetCorsResponse,
  handleWidgetCorsPreflight,
} from './lib/widget/widget-cors.js';
import {
  createWidgetAccessToken,
  getWidgetInstallation,
} from './lib/widget/widget-installations.js';
import {
  widgetChatAccessScope,
  widgetChatListScope,
} from './lib/widget/widget-chat-scope.js';
import { registerClientInstancesRoutes } from './lib/routes/client-instances-routes.js';
import { registerHealthRoutes } from './lib/routes/health-routes.js';
import { registerPushRoutes } from './lib/routes/push-routes.js';
import { registerWidgetInstallationsRoutes } from './lib/routes/widget-installations-routes.js';
import { registerAuthRoutes } from './lib/routes/auth-routes.js';
import { registerLanRoutes } from './lib/routes/lan-routes.js';
import { registerSettingsRoutes, registerWorkspaceRoutes, isHttpTimingEnabled } from './lib/routes/settings-routes.js';
import { registerChatsRoutes } from './lib/routes/chats-routes.js';
import { registerFilesRoutes } from './lib/routes/files-routes.js';
import { registerFsBrowseRoutes } from './lib/routes/fs-browse-routes.js';
import { registerGitRoutes } from './lib/routes/git-routes.js';
import { registerTodosRoutes } from './lib/routes/todos-routes.js';
import { registerChatAgentRoutes } from './lib/routes/chat-agent-routes.js';
import { registerUploadsRoutes } from './lib/routes/uploads-routes.js';
import { registerVoiceRoutes } from './lib/routes/voice-routes.js';
import { registerUsageRoutes } from './lib/routes/usage-routes.js';
import { registerCursorContextRoutes } from './lib/routes/cursor-context-routes.js';
import { registerAgentSdkRoutes } from './lib/routes/agent-sdk-routes.js';
import { registerOpenRouterRoutes } from './lib/routes/openrouter-routes.js';
import { registerOpenCodeRoutes } from './lib/routes/opencode-routes.js';
import { registerCodeBuddyRoutes } from './lib/routes/codebuddy-routes.js';
import { registerDeepSeekRoutes } from './lib/routes/deepseek-routes.js';
import { registerCodexRoutes } from './lib/routes/codex-routes.js';
import { registerQwenRoutes } from './lib/routes/qwen-routes.js';
import { registerTasksAgentsRoutes } from './lib/routes/tasks-agents-routes.js';
import { registerDevActionsRoutes, scheduleServerRestart } from './lib/routes/dev-actions-routes.js';
import { registerUpdateRoutes } from './lib/routes/update-routes.js';
import { registerTerminalRoutes } from './lib/routes/terminal-routes.js';
import { registerClientDebugRoutes } from './lib/routes/client-debug-routes.js';
import {
  broadcastToClients,
  flushPtyOutput,
  queuePtyOutput,
  TASK_RUN_BUFFER_MAX,
} from './lib/pty-broadcast.js';
import { attachWebSocketHandlers } from './lib/ws/ws-router.js';
import { installServerLogCapture } from './lib/ws/server-log-ws.js';
import { installFrontBuildWatcher } from './lib/ws/front-build-ws.js';
import { runAgentsScheduler, AGENTS_SCHEDULER_INTERVAL_MS } from './lib/ws/agent-run-ws-handler.js';
import { readEnvAlias } from './lib/env-alias.js';
import { assertLanSetupGuard, readSetupToken, resolveBindHost } from './lib/bind-host.js';
import { resolveDataPath, resolveProjectPath } from './lib/runtime-paths.js';
import { msg } from './lib/messages.js';
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
  if (!home || home === '/root') {
    process.env.HOME = LOCAL_RUNTIME_HOME;
  }
  try {
    mkdirSync(process.env.HOME, { recursive: true });
  } catch {
    process.env.HOME = LOCAL_RUNTIME_HOME;
    mkdirSync(process.env.HOME, { recursive: true });
  }
  const transcriptsDir = path.join(process.env.HOME, 'agent-transcripts');
  process.env.AGENT_TRANSCRIPTS = transcriptsDir;
  mkdirSync(transcriptsDir, { recursive: true });
}

normalizeSdkRuntimeEnvironment();

const PORT = parseInt(process.env.PORT || '3011', 10);
/** Bind host. Defaults to 127.0.0.1; LAN is opt-in via CRETLI_BIND=0.0.0.0. */
const BIND_HOST = resolveBindHost();
const DEFAULT_WORKSPACE_FILE = process.env.WORKSPACE_FILE || findWorkspaceFile();
const AGENT_CMD = resolveAgentCommand(process.env.CURSOR_AGENT_CMD || 'agent');
/** Default agent model (CLI id, e.g. auto). Empty = do not pass --model. */
const AGENT_MODEL = process.env.CURSOR_AGENT_MODEL ?? 'auto';
/** Optional token for agent callbacks (chat title, summary, Todo). */
const AGENT_CALLBACK_TOKEN = process.env.AGENT_CALLBACK_TOKEN || '';
/** Unique server instance token (changes after a process restart). */
const SERVER_INSTANCE_TOKEN = randomUUID();
const SERVER_STARTED_AT = Date.now();
let serverRestartScheduled = false;
const require = createRequire(import.meta.url);
const FRONT_HMR_ENV_RAW = readEnvAlias({
  current: 'CRETLI_FRONT_HMR',
  legacy: 'CURSOR_REMOTE_FRONT_HMR',
});
const FRONT_HMR_FORCED_BY_ENV = typeof FRONT_HMR_ENV_RAW !== 'undefined' && FRONT_HMR_ENV_RAW !== '';
function resolveFrontHmrEnabledFromSettings(settings) {
  if (settings && typeof settings.frontHmrEnabled === 'boolean') return settings.frontHmrEnabled;
  return true;
}
const FRONT_HMR_CONFIG_ENABLED = resolveFrontHmrEnabledFromSettings(loadSettings());
const FRONT_HMR_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  (
    FRONT_HMR_FORCED_BY_ENV
      ? (FRONT_HMR_ENV_RAW !== '0' && FRONT_HMR_ENV_RAW !== 'false')
      : FRONT_HMR_CONFIG_ENABLED
  );
const FRONT_HOT_FALLBACK_ENV = readEnvAlias({
  current: 'CRETLI_FRONT_HOT_FALLBACK',
  legacy: 'CURSOR_REMOTE_FRONT_HOT_FALLBACK',
});
const FRONT_HOT_FALLBACK_ENABLED =
  FRONT_HOT_FALLBACK_ENV === '1' ||
  FRONT_HOT_FALLBACK_ENV === 'true';

const app = express();
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const LOGIN_HTML_PATH = path.join(__dirname, 'public', 'login.html');
const FRONT_ASSET_VERSION_TOKEN = '__CR_ASSET_VERSION__';
const dataDir = resolveDataPath();
const keyPath = process.env.SSL_KEY_PATH || path.join(dataDir, 'key.pem');
const certPath = process.env.SSL_CERT_PATH || path.join(dataDir, 'cert.pem');
let useHttps = false;
let server;
if (process.env.USE_HTTPS === '1' || process.env.USE_HTTPS === 'true') {
  try {
    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    server = createHttpsServer(
      {
        key,
        cert,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
      },
      app
    );
    useHttps = true;
  } catch (err) {
    console.warn('HTTPS enabled but missing key/cert:', err.message, '— falling back to HTTP.');
    server = createServer(app);
  }
} else {
  server = createServer(app);
}

/** Path to the currently selected .code-workspace file (settings or default). */
function getCurrentWorkspaceFile() {
  const settings = loadSettings();
  const file = settings.workspaceFile && settings.workspaceFile.trim()
    ? settings.workspaceFile.trim()
    : DEFAULT_WORKSPACE_FILE;
  return file || null;
}

/** Fast read of the workspace choice from config (no on-disk path validation). */
function getConfiguredWorkspaceSelection(settings = null) {
  const cfg = settings || loadSettings();
  const workspaceFile = cfg.workspaceFile && String(cfg.workspaceFile).trim()
    ? String(cfg.workspaceFile).trim()
    : (DEFAULT_WORKSPACE_FILE || '');
  const workspaceFolder = cfg.workspaceFolder && String(cfg.workspaceFolder).trim()
    ? String(cfg.workspaceFolder).trim()
    : '';
  return {
    workspaceFile,
    workspaceFolder,
  };
}


/** Loaded workspace (dirs, folders) for the current selection. */
function getCurrentWorkspace() {
  const file = getCurrentWorkspaceFile();
  if (!file) return null;
  if (isFolderWorkspaceId(file)) {
    const settings = loadSettings();
    const sidebar = settings.workspaceSidebarConfig?.[file];
    const folders = mergeFoldersForClient({
      fileFolders: [],
      overlayFolders: sidebar?.folders,
    }).filter((folder) => folder.enabled);
    if (folders.length === 0) return null;
    return {
      workspaceDir: folders[0].resolvedPath,
      workspaceFilePath: file,
      folders: folders.map((folder) => ({
        name: folder.name,
        path: folder.path,
        resolvedPath: folder.resolvedPath,
      })),
    };
  }
  return loadWorkspace(file) || null;
}

/** Selected folder in the workspace (from settings). Null = use workspaceDir.
 * Accepts a full path or a workspace folder name — then looks up folders by name/resolvedPath. */
function getCurrentWorkspaceFolder() {
  const settings = loadSettings();
  const folder = settings.workspaceFolder && settings.workspaceFolder.trim();
  if (!folder) return null;
  let resolved = path.resolve(expandUserPath(folder));
  if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
  const w = getCurrentWorkspace();
  if (w) {
    const byName = (w.folders || []).find(
      (f) => f.name === folder || (f.resolvedPath && path.basename(f.resolvedPath) === folder)
    );
    if (byName?.resolvedPath && existsSync(byName.resolvedPath)) return byName.resolvedPath;
    const fromRel = path.join(w.workspaceDir, folder);
    if (existsSync(fromRel) && statSync(fromRel).isDirectory()) return fromRel;
  }
  return null;
}

/** CWD for the terminal/tasks: selected folder or workspace directory. */
function getCurrentCwd() {
  const folder = getCurrentWorkspaceFolder();
  if (folder) return folder;
  const w = getCurrentWorkspace();
  return w ? w.workspaceDir : process.cwd();
}

function currentFrontAssetVersion() {
  return resolveFrontAssetVersion({
    projectRoot: __dirname,
    serverStartedAt: SERVER_STARTED_AT,
  });
}

function readVersionedHtmlTemplate(filePath) {
  const html = readFileSync(filePath, 'utf8');
  return html.replaceAll(FRONT_ASSET_VERSION_TOKEN, currentFrontAssetVersion());
}

function sendVersionedHtml(res, filePath) {
  try {
    const html = readVersionedHtmlTemplate(filePath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch {
    return res.sendFile(filePath);
  }
}

function normalizeWorkspaceScopePath(pathValue) {
  const raw = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!raw) return '';
  return path.resolve(raw);
}

function buildTaskRunScopeSnapshot() {
  return {
    workspaceFile: normalizeWorkspaceScopePath(getCurrentWorkspaceFile() || ''),
    cwd: normalizeWorkspaceScopePath(getCurrentCwd()),
  };
}

function isTaskRunInScope(run, scope) {
  if (!run || !scope) return false;
  const runWorkspaceFile = normalizeWorkspaceScopePath(run.workspaceFile || '');
  const runCwd = normalizeWorkspaceScopePath(run.cwd || '');
  if (runWorkspaceFile !== scope.workspaceFile) return false;
  if (runCwd !== scope.cwd) return false;
  return true;
}

function loadCurrentTasks() {
  const workspace = getCurrentWorkspace();
  const settings = loadSettings();
  const workspaceFile = getCurrentWorkspaceFile();
  const preferredFolder = workspaceFile
    ? settings.workspaceSidebarConfig?.[workspaceFile]?.folder
    : '';
  const directories = [
    getCurrentCwd(),
    preferredFolder,
    workspace?.workspaceDir,
    ...(workspace?.folders || []).map((folder) => folder.resolvedPath),
  ];
  const checked = new Set();

  for (const directory of directories) {
    if (!directory) continue;
    const resolved = path.resolve(directory);
    if (checked.has(resolved)) continue;
    checked.add(resolved);
    const data = loadTasks(resolved);
    if (data) return data;
  }

  return null;
}


/** Whether terminal session sync is on (many clients = one terminal). Off by default — each client has its own terminal (phone-first). */
function isSessionSyncEnabled() {
  if (process.env.TERMINAL_SESSION_SYNC === '1') return true;
  const settings = loadSettings();
  return settings.sessionSyncEnabled === true;
}

/** Shared sessions: multiple browsers (phone + PC) see the same live terminal/agent. */
const terminalSessions = new Map(); // sessionId -> { pty, clients, buffer? }
const agentSessions = new Map();    // resumeId -> { pty, clients, buffer? }
const taskRuns = new Map();          // runId -> { pty, clients, buffer, taskLabel }
const agentRuns = new Map();         // runId -> { pty, clients, buffer, agentName } – stary flow (harmonogram)
/** Fixed runId for dev build started from developer actions (output in modal). */
const DEV_BUILD_RUN_ID = 'dev-build';
/** Single "agent run" session (like a task): create-chat + /ws-agent, inject agent file content. */
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

/** Env for an interactive PTY: force colors and strip colorless/headless flags. */
function buildInteractivePtyEnv(overrides = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    FORCE_COLOR: '1',
    ...overrides,
  };
  delete env.NO_COLOR;
  delete env.CI;
  delete env.CURSOR_HEADLESS;
  const homeDir = String(env.HOME || LOCAL_RUNTIME_HOME).trim() || LOCAL_RUNTIME_HOME;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  if (homeDir === LOCAL_RUNTIME_HOME || homeDir.startsWith(`${LOCAL_RUNTIME_HOME}/`)) {
    env.PM2_HOME = path.join(LOCAL_RUNTIME_HOME, `.pm2-uid-${uid}`);
  }
  return env;
}

/** Cursor CLI accepts only a directory in --workspace, not a .code-workspace file. */
function workspaceDirForAgent(workspacePath) {
  if (!workspacePath) return getCurrentCwd();
  const settings = loadSettings();
  return resolveWorkspaceCwd({
    workspaceId: workspacePath,
    workspaceFolder: settings.workspaceFolder,
    registry: settings.workspaces,
    sidebarConfig: settings.workspaceSidebarConfig,
    fallbackCwd: path.extname(workspacePath) === '.code-workspace'
      ? path.dirname(workspacePath)
      : workspacePath,
  });
}

app.use(
  compression({
    filter: (req, res) => {
      // Event streams (webpack HMR) break when buffered by the compressor.
      if (String(req.path || '').startsWith('/__webpack_hmr')) return false;
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  })
);
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  ensureStickyInstanceCookie(req, res, getServerInstanceId(), { secure: useHttps });
  next();
});
app.use((req, res, next) => {
  if (!req || !res) return next();
  if (!req.path || !req.path.startsWith('/api/')) return next();
  if (!isHttpTimingEnabled()) return next();
  const requestId = randomSessionId();
  const startedAt = Date.now();
  console.log('[http-timing] start', requestId, req.method, req.originalUrl || req.url || req.path);
  res.on('finish', () => {
    const elapsedMs = Date.now() - startedAt;
    console.log('[http-timing] end', requestId, res.statusCode, elapsedMs + 'ms', req.method, req.originalUrl || req.url || req.path);
  });
  next();
});

function widgetInstallationIdFromPath(reqPath) {
  const match = String(reqPath || '').match(/^\/embed\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function widgetInstallationIdFromWidgetAuthPath(reqPath) {
  const match = String(reqPath || '').match(/^\/widget-authorize\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function widgetInstallationIdFromNext(nextValue) {
  if (typeof nextValue !== 'string' || !nextValue.trim()) return null;
  const match = nextValue.match(/\/widget-authorize\/([^/?&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function widgetFrameAncestors(installation) {
  const origins = Array.isArray(installation?.allowedOrigins)
    ? installation.allowedOrigins
    : [];
  return ["'self'", ...origins].join(' ');
}

function resolveWidgetFrameAncestors(installationId) {
  if (!installationId) return null;
  try {
    const installation = getWidgetInstallation(installationId);
    return widgetFrameAncestors(installation);
  } catch {
    return null;
  }
}

function applyWidgetFrameHeaders(res, installationId) {
  const frameAncestors = resolveWidgetFrameAncestors(installationId);
  if (!frameAncestors) return false;
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.removeHeader('X-Frame-Options');
  return true;
}

function resolveWidgetInstallationIdFromRequest(req) {
  if (typeof req.params?.installationId === 'string' && req.params.installationId.trim()) {
    return req.params.installationId.trim();
  }
  return widgetInstallationIdFromPath(req.path)
    || widgetInstallationIdFromWidgetAuthPath(req.path)
    || widgetInstallationIdFromNext(req.query?.next);
}

/** Security headers; embed restricts frame-ancestors to the installation. */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const installationId = resolveWidgetInstallationIdFromRequest(req);
  const frameAncestors = resolveWidgetFrameAncestors(installationId);
  if (frameAncestors) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  } else if (installationId) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (String(req.path || '').startsWith('/widget-authorize/')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    }
  }
  if (useHttps) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

app.use(handleWidgetCorsPreflight);

/** Access gate: /api/* (with exceptions) and the shell HTML require a session. */
app.use(requireAuth);
app.use(applyWidgetCorsResponse);

app.use((req, res, next) => {
  const access = req.widgetAccess;
  if (!access) return next();
  const reqPath = String(req.path || '');
  if (reqPath === '/api/chats' && ['GET', 'POST'].includes(req.method)) return next();
  if (reqPath === '/api/agent-sdk' && req.method === 'GET') return next();
  if (reqPath === '/api/openrouter/status' && req.method === 'GET') return next();
  if (reqPath === '/api/openrouter/models' && req.method === 'GET') return next();
  if (reqPath === '/api/opencode/status' && req.method === 'GET') return next();
  if (reqPath === '/api/opencode/models' && req.method === 'GET') return next();
  if (reqPath === '/api/settings' && req.method === 'GET') return next();
  if (reqPath === '/api/workspaces' && req.method === 'GET') return next();
  if (reqPath === '/api/cursor-context' && req.method === 'GET') return next();
  if (reqPath === '/api/upload-screenshot' && req.method === 'POST') return next();
  if (/^\/api\/uploads\/[^/]+$/.test(reqPath) && req.method === 'GET') return next();

  const chatMatch = reqPath.match(/^\/api\/chats\/([^/]+)(?:\/.*)?$/);
  if (!chatMatch) {
    return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
  }
  let chatId = '';
  try {
    chatId = decodeURIComponent(chatMatch[1]);
  } catch {
    return res.status(400).json({ ok: false, error: msg(req, 'widget.invalidChatId') });
  }
  const chat = loadChats().find((entry) => entry.id === chatId);
  if (!widgetChatAccessScope(chat, access)) {
    return res.status(403).json({ ok: false, error: msg(req, 'widget.chatOutOfScope') });
  }
  return next();
});

app.get('/embed/:installationId', (req, res) => {
  try {
    const installation = getWidgetInstallation(req.params.installationId);
    if (!installation.enabled) throw new Error('Widget installation unavailable');
    return sendVersionedHtml(res, INDEX_HTML_PATH);
  } catch {
    return res.status(404).send('Widget installation unavailable');
  }
});

app.get(['/', '/index.html'], (_req, res) => {
  return sendVersionedHtml(res, INDEX_HTML_PATH);
});
app.get(['/:panel', '/:panel/:settingsTab'], (req, res, next) => {
  if (!isSpaShellPath(req.path)) return next();
  return sendVersionedHtml(res, INDEX_HTML_PATH);
});

function parseWidgetAuthParams(query = {}, body = {}) {
  const origin = typeof query.origin === 'string'
    ? query.origin.trim()
    : typeof body.origin === 'string'
      ? body.origin.trim()
      : '';
  const pageSessionId = typeof query.pageSessionId === 'string'
    ? query.pageSessionId.trim()
    : typeof body.pageSessionId === 'string'
      ? body.pageSessionId.trim()
      : '';
  if (!pageSessionId || pageSessionId.length > 128) return null;
  return { origin, pageSessionId };
}

function buildWidgetAuthorizationPayload(installationId, { origin, pageSessionId }) {
  const installation = getWidgetInstallation(installationId);
  const accessToken = createWidgetAccessToken({
    installationId: installation.id,
    origin,
    pageSessionId,
  });
  return {
    type: 'cretli-widget-authorized',
    installation,
    accessToken,
    pageSessionId,
  };
}

function isWidgetAuthRequest(req) {
  return req.query?.widgetAuth === '1'
    || req.body?.widgetAuth === true
    || req.body?.widgetAuth === '1';
}

app.get('/api/widget-authorize/:installationId', (req, res) => {
  const params = parseWidgetAuthParams(req.query || {});
  if (!params) {
    return res.status(400).json({ ok: false, error: 'Invalid page session' });
  }
  try {
    const widgetAuth = buildWidgetAuthorizationPayload(req.params.installationId, params);
    return res.json({ ok: true, widgetAuth });
  } catch (error) {
    return res.status(403).json({ ok: false, error: String(error?.message || 'Widget authorization failed') });
  }
});

app.get('/widget-authorize/:installationId', (req, res) => {
  applyWidgetFrameHeaders(res, req.params.installationId);
  const params = parseWidgetAuthParams(req.query || {});
  if (!isAuthConfigured() || !isAuthenticated(req)) {
    const next = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(`/login?next=${next}&widgetAuth=1`);
  }
  if (!params) {
    return res.status(400).send('Invalid page session');
  }
  try {
    const payload = JSON.stringify(
      buildWidgetAuthorizationPayload(req.params.installationId, params),
    ).replaceAll('<', '\\u003c');
    const targetOrigin = JSON.stringify(params.origin).replaceAll('<', '\\u003c');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(`<!doctype html><meta charset="utf-8"><title>Cretli</title><script>
(function () {
  var payload = ${payload};
  var targetOrigin = ${targetOrigin};
  var target = null;
  if (window.opener && window.opener !== window) target = window.opener;
  else if (window.parent && window.parent !== window) target = window.parent;
  if (target) target.postMessage(payload, targetOrigin);
  try { window.close(); } catch (_) {}
})();
</script><p>Authorization complete. You can close this window.</p>`);
  } catch (error) {
    return res.status(403).send(String(error?.message || 'Widget authorization failed'));
  }
});

/** Login/setup page (standalone, no SPA bundle). */
app.get('/login', (req, res) => {
  applyWidgetFrameHeaders(res, resolveWidgetInstallationIdFromRequest(req));
  return sendVersionedHtml(res, LOGIN_HTML_PATH);
});

app.get('/favicon.ico', (_req, res) => {
  res.redirect(301, '/icon.svg');
});

let hmrCompiler = null;
async function installFrontHmrMiddleware() {
  if (!FRONT_HMR_ENABLED) return;
  const webpackConfigPath = path.join(__dirname, 'app_front', 'webpack.dev.js');
  if (!existsSync(webpackConfigPath)) {
    console.warn('[front-hmr] missing webpack.dev.js config');
    return;
  }
  try {
    const prevFrontHmrEnvCurrent = process.env.CRETLI_FRONT_HMR;
    const prevFrontHmrEnvLegacy = process.env.CURSOR_REMOTE_FRONT_HMR;
    let mod;
    try {
      process.env.CRETLI_FRONT_HMR = '1';
      process.env.CURSOR_REMOTE_FRONT_HMR = '1';
      mod = await import(pathToFileURL(webpackConfigPath).href);
    } finally {
      if (typeof prevFrontHmrEnvCurrent === 'undefined') {
        delete process.env.CRETLI_FRONT_HMR;
      } else {
        process.env.CRETLI_FRONT_HMR = prevFrontHmrEnvCurrent;
      }
      if (typeof prevFrontHmrEnvLegacy === 'undefined') {
        delete process.env.CURSOR_REMOTE_FRONT_HMR;
      } else {
        process.env.CURSOR_REMOTE_FRONT_HMR = prevFrontHmrEnvLegacy;
      }
    }
    const configRequire = createRequire(pathToFileURL(webpackConfigPath).href);
    const webpack = configRequire('webpack');
    const webpackDevMiddleware = require('webpack-dev-middleware');
    const webpackHotMiddleware = require('webpack-hot-middleware');
    const devConfig = mod?.default || mod;
    if (!devConfig) {
      console.warn('[front-hmr] empty webpack.dev.js config');
      return;
    }
    hmrCompiler = webpack(devConfig);
    app.use(
      webpackDevMiddleware(hmrCompiler, {
        publicPath: devConfig.output?.publicPath || '/dist/app/',
        writeToDisk: false,
        stats: 'errors-warnings',
      })
    );
    app.use(
      webpackHotMiddleware(hmrCompiler, {
        path: '/__webpack_hmr',
        heartbeat: 10000,
        log: false,
      })
    );
    console.log('[front-hmr] active: /__webpack_hmr');
  } catch (err) {
    console.warn('[front-hmr] failed to start HMR:', err?.message || err);
  }
}

const uploadsDir = path.join(dataDir, 'uploads');
const CLIENT_DEBUG_LOG_PATH = path.join(dataDir, 'client-debug.log');
const CLIENT_DEBUG_LOG_PREV_PATH = path.join(dataDir, 'client-debug-prev.log');
const CLIENT_DEBUG_LOG_MAX_BYTES = 6 * 1024 * 1024;

function appendClientDebugLogFile(reason, ua, lines) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const stamp = new Date().toISOString();
  const uaShort = ua ? ua.slice(0, 360).replace(/\s+/g, ' ') : '';
  let block = `\n---------- ${stamp} reason=${reason}${uaShort ? ` ua=${uaShort}` : ''} ----------\n`;
  for (const line of lines) {
    block += `${line}\n`;
  }
  try {
    if (existsSync(CLIENT_DEBUG_LOG_PATH) && statSync(CLIENT_DEBUG_LOG_PATH).size > CLIENT_DEBUG_LOG_MAX_BYTES) {
      try {
        if (existsSync(CLIENT_DEBUG_LOG_PREV_PATH)) unlinkSync(CLIENT_DEBUG_LOG_PREV_PATH);
      } catch (_) {}
      try {
        renameSync(CLIENT_DEBUG_LOG_PATH, CLIENT_DEBUG_LOG_PREV_PATH);
      } catch (_) {}
    }
    appendFileSync(CLIENT_DEBUG_LOG_PATH, block, 'utf8');
  } catch (err) {
    console.error('[client-debug-file]', err?.message || err);
  }
}


registerClientDebugRoutes(app, {
  dataDir,
  appendClientDebugLogFile,
});
registerClientInstancesRoutes(app, { dataDir });

const settingsRoutesCtx = {
  port: PORT,
  useHttps,
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  frontHmrEnabled: FRONT_HMR_ENABLED,
  frontHmrForcedByEnv: FRONT_HMR_FORCED_BY_ENV,
  frontHotFallbackEnabled: FRONT_HOT_FALLBACK_ENABLED,
  getLanHost,
  getConfiguredWorkspaceSelection,
  isSessionSyncEnabled,
  resolveFrontHmrEnabledFromSettings,
};
registerHealthRoutes(app, {
  serverInstanceToken: SERVER_INSTANCE_TOKEN,
  serverStartedAt: SERVER_STARTED_AT,
  getFrontAssetVersion: currentFrontAssetVersion,
});
registerPushRoutes(app);
registerWidgetInstallationsRoutes(app);
registerAuthRoutes(app, {
  useHttps,
  buildWidgetAuthorizationPayload,
  isWidgetAuthRequest,
  parseWidgetAuthParams,
});
registerLanRoutes(app, { port: PORT, useHttps, getLanHost });
registerSettingsRoutes(app, settingsRoutesCtx);
registerWorkspaceRoutes(app, {
  projectRoot: __dirname,
  getCurrentWorkspace,
  getCurrentWorkspaceFile,
});
registerChatsRoutes(app, {
  dataDir,
  agentSessions,
  getCurrentAgentRunResumeId: () => currentAgentRunResumeId,
  setCurrentAgentRunResumeId: (id) => { currentAgentRunResumeId = id; },
  agentCmd: AGENT_CMD,
  agentModel: AGENT_MODEL,
  workspaceDirForAgent,
  getCurrentWorkspaceFile,
  getCurrentCwd,
  buildAgentSpawnEnv,
  widgetChatListScope,
});
const filesGitTodosCtx = { getCurrentCwd };
registerFilesRoutes(app, filesGitTodosCtx);
registerFsBrowseRoutes(app);
registerGitRoutes(app, filesGitTodosCtx);
registerTodosRoutes(app, {
  dataDir,
  getCurrentCwd,
  getCurrentWorkspaceFile,
  agentModel: AGENT_MODEL,
  getLocalCallbackBaseUrl,
  useHttps,
});
registerTasksAgentsRoutes(app, {
  loadCurrentTasks,
  taskRuns,
  agentRuns,
  devBuildRunId: DEV_BUILD_RUN_ID,
  buildTaskRunScopeSnapshot,
  isTaskRunInScope,
  randomSessionId,
  loadAgentsSchedule,
  saveAgentsSchedule,
  getCurrentCwd,
});
registerCursorContextRoutes(app, { getCurrentCwd });
registerAgentSdkRoutes(app);
registerOpenRouterRoutes(app);
registerOpenCodeRoutes(app, { workspaceDirForAgent });
registerCodeBuddyRoutes(app);
registerDeepSeekRoutes(app);
registerCodexRoutes(app);
registerQwenRoutes(app);
registerChatAgentRoutes(app, {
  dataDir,
  agentCmd: AGENT_CMD,
  agentModel: AGENT_MODEL,
  workspaceDirForAgent,
  getCurrentWorkspaceFile,
  getCurrentCwd,
  getLocalCallbackBaseUrl,
  useHttps,
  verifyAgentCallback,
});
registerUploadsRoutes(app, { uploadsDir });
registerVoiceRoutes(app);
registerUsageRoutes(app);

let lastTerminalSessionId = null;
registerTerminalRoutes(app, {
  isSessionSyncEnabled,
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
};
attachWebSocketHandlers(wss, wsRouterCtx);

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** LAN host for the in-app link/QR. Order: env → data/config.json → detected IP. On WSL detection is 172.x — set config or LAN_HOST. */
function getLanHost() {
  const env = process.env.LAN_HOST || readEnvAlias({
    current: 'CRETLI_LAN_HOST',
    legacy: 'CURSOR_REMOTE_LAN_HOST',
  });
  if (env && env.trim()) return env.trim();
  const settings = loadSettings();
  if (settings.lanHost && settings.lanHost.trim()) return settings.lanHost.trim();
  return getLocalIP();
}

/**
 * Base URL for agent callbacks (curl run by the agent on the same host).
 * Always localhost — the agent CLI runs on the server, so the callback hits
 * 127.0.0.1 and `verifyAgentCallback` trusts it without a token. That keeps
 * AGENT_CALLBACK_TOKEN out of the prompt (no secret leak to Cursor Cloud).
 */
function getLocalCallbackBaseUrl() {
  const protocol = useHttps ? 'https' : 'http';
  return `${protocol}://127.0.0.1:${PORT}`;
}

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

await installFrontHmrMiddleware();
const devActionsCtx = {
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
};
registerDevActionsRoutes(app, devActionsCtx);
registerUpdateRoutes(app, {
  projectRoot: __dirname,
  getServerRestartScheduled: () => serverRestartScheduled,
  setServerRestartScheduled: (scheduled) => { serverRestartScheduled = scheduled; },
  scheduleServerRestart: (restartRequestId) => scheduleServerRestart(devActionsCtx, restartRequestId),
});
app.use('/dist/app', (req, res, next) => {
  if (/\.(?:css|js)$/.test(String(req.path || ''))) {
    res.setHeader('Cache-Control', 'no-store');
  }
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
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Cretli: ${protocol}://localhost:${PORT}`);
  if (seededRevisionCount > 0) {
    console.log(`  Chat history revisions seeded: ${seededRevisionCount}`);
  }
  if (sdkRoomTransport?.mode === 'redis') {
    console.log('  SDK room bus: Redis pub-sub enabled');
    console.log(`  SDK room registry: ${getSdkRoomRegistryMode()}`);
  }
  if (isLanExposed()) {
    const lan = getLanHost();
    if (lan) console.log(`  on LAN: ${protocol}://${lan}:${PORT}`);
    if (!isAuthConfigured()) {
      console.warn('  ⚠️  LAN bind with no password — first-run /login requires CRETLI_SETUP_TOKEN.');
    }
    if (!AGENT_CALLBACK_TOKEN) {
      console.warn('  ⚠️  AGENT_CALLBACK_TOKEN not set — external agent callbacks (from LAN) are rejected. Localhost callbacks (auto chat title) work without a token.');
    }
  } else {
    console.log(`  Listening on: ${BIND_HOST} (local-only bind). For LAN: CRETLI_BIND=0.0.0.0 (legacy: CURSOR_REMOTE_BIND)`);
  }
  if (!useHttps) console.log('  (HTTPS: set USE_HTTPS=1 and add data/key.pem, data/cert.pem — required e.g. for phone dictation)');
  // Without HMR the page is served from public/dist/app; a missing bundle only
  // shows up as a blank page in the browser, so say it here instead.
  if (!FRONT_HMR_ENABLED && !existsSync(path.join(__dirname, 'public', 'dist', 'app', 'index.bundle.js'))) {
    console.warn('  ⚠️  Frontend not built — the page will be blank. Run: npm run build:front:prod');
  }
  if (!isAuthConfigured()) {
    console.log('  Auth: no password set — open /login to set one (setup).');
  } else {
    console.log('  Auth: enabled (password set).');
  }
  setInterval(() => runAgentsScheduler(wsRouterCtx), AGENTS_SCHEDULER_INTERVAL_MS);
  console.log('Chats:', resolveDataPath('chats.json'));
  console.log('Client logs (debugRemote):', CLIENT_DEBUG_LOG_PATH);
  console.log('Settings (LAN):', resolveDataPath('config.json'));
  if (hasOpenCodeCredentials()) {
    void import('./lib/opencode/opencode-server-manager.js')
      .then(({ warmUpOpenCodeFromSettings }) => warmUpOpenCodeFromSettings())
      .then((result) => {
        if (result?.skipped) return;
        if (result?.ok) {
          console.log('  OpenCode: warm-up ready');
          return;
        }
        console.warn('  OpenCode: warm-up pending —', result?.error || 'not ready yet');
      })
      .catch((err) => {
        console.warn('  OpenCode: warm-up failed —', err?.message || err);
      });
  }
  const ws = getCurrentWorkspace();
  console.log('Workspace CWD:', getCurrentCwd());
  if (ws) {
    console.log('Folders:', ws.folders.map((f) => f.name).join(', '));
  } else {
    console.log('(no workspace file — set WORKSPACE_FILE or pick one in the app)');
  }
});
