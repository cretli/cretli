import type { RawData, WebSocket, WebSocketServer } from 'ws';
import type { PtySession } from './pty-ws-handler.ts';
import type { TaskRun, TaskDefinition } from './task-ws-handler.ts';
import { handleAgentSdkWebSocket } from '../sdk/cursor-agent-sdk-ws.ts';
import { getChatByCursorSessionIdAsync } from '../persist/chats-persist.js';
import { guardArchivedChatSocket } from '../chat-message-guard.js';
import { dropBrowserChatOwnerSession, forgetBrowserChatOwner, rememberBrowserChatOwner } from '../browser/agent-tools.js';
import { getChatAgentTransport } from '../agent-transport.js';
import {
  dispatchLocalHarnessWebSocket,
  rawHarnessTransportKind,
} from '../agent-harness/local-harness-runtime.ts';
import { getBuiltinHarnessProvider } from '../agent-harness/builtin-harness-providers.ts';
import {
  attachDisabledOptionalHarnessSocket,
  getDisabledOptionalHarness,
} from '../agent-harness/disabled-optional-harness.ts';
import {
  isValidClientInstanceId,
  registerClientInstanceWebSocket,
  unregisterClientInstanceWebSocket,
} from '../client-instance-registry.js';
import { registerPageBridge } from '../page-bridge.js';
import { verifyWidgetAccessToken } from '../widget/widget-installations.ts';
import {
  isAuthConfigured,
  isAuthenticated,
  getSessionIdFromRequest,
  isBrowserPreviewSession,
  onBrowserPreviewSessionMarked,
} from '../auth.js';

// A login session recognised inside an agent-controlled Browser page loses any
// chat ownership it gained before it was recognised.
onBrowserPreviewSessionMarked((sessionId) => dropBrowserChatOwnerSession(sessionId));
import {
  registerSessionWebSocket,
  unregisterSessionWebSocket,
} from './ws-session-registry.ts';
import { notifyAgentFinished } from '../agent-finished-push.js';
import {
  syncTodoAfterSdkRunFinished,
} from '../todo-plan-sync.js';
import { handlePtyConnection } from './pty-ws-handler.ts';
import { handleTaskConnection } from './task-ws-handler.ts';
import { handleServerLogConnection } from './server-log-ws.ts';
import { handleFrontBuildConnection } from './front-build-ws.ts';
import { handleGeminiLiveRelayConnection } from '../voice/gemini-live-relay.ts';
import { GEMINI_LIVE_RELAY_PATH } from '../voice/gemini-live-config.ts';
import { msg } from '../messages.js';
import { attachWsKeepalive } from './ws-keepalive.ts';
import { evaluateWidgetHandshake, requiresSessionAuth } from './ws-auth-boundary.ts';
import { isBrowserPath, isChromeExtPath, isPageBridgePath } from './ws-path.ts';
import { createBrowserWsHandler } from '../browser/ws-handler.js';
import { isWsOriginAllowed } from './ws-origin.ts';
import { cretliExtensionBridge } from '../browser/cretli-extension-bridge.js';
import { resolveChatWorkspaceScope, resolveWorkspaceScope } from '../workspace-scope.js';
import { loadSettings } from '../persist/settings.js';

/**
 * Runs a detached async task without letting a rejection reach
 * `unhandledRejection`, which terminates the process in production.
 *
 * @param ws closed with 1011 when the task fails
 */
function runDetached(task: unknown, label: string, ws: WebSocket | null = null): void {
  Promise.resolve(task).catch((err) => {
    console.error(`[ws] ${label} failed:`, (err as Error | null)?.stack || (err as Error | null)?.message || err);
    if (!ws) return;
    try {
      ws.close(1011, 'Internal error');
    } catch {
      // the socket may already be gone
    }
  });
}

/**
 * Holds `message` frames of a socket while an async lookup runs, so a frame sent right after the handshake is not
 * lost before the handler attached its listener. `restore()` puts the original emit back (call it before wrapping the
 * socket again); `replay()` re-emits the held frames in order once the handler is attached.
 */
function holdWsMessages(ws: WebSocket): { restore: () => void, replay: () => void } {
  const originalEmit = ws.emit;
  const frames: unknown[][] = [];
  ws.emit = function emitHeld(this: WebSocket, event: string | symbol, ...args: unknown[]) {
    if (event === 'message') {
      frames.push(args);
      return true;
    }
    return originalEmit.call(this, event, ...args);
  } as typeof ws.emit;
  return {
    restore: () => { ws.emit = originalEmit; },
    replay: () => {
      for (const args of frames.splice(0)) ws.emit('message', ...args);
    },
  };
}

export type WebSocketRouterContext = {
  frontHotFallbackEnabled: boolean,
  widgetChatAccessScope: (chat: unknown, access: unknown) => boolean,
  workspaceDirForAgent: (workspacePath: string | null | undefined) => string,
  agentCmd: string,
  agentModel: string,
  getCurrentCwd: () => string,
  getCurrentWorkspaceFile: () => string | null,
  isSessionSyncEnabled: () => boolean,
  terminalSessions: Map<string, PtySession>,
  agentSessions: Map<string, PtySession>,
  taskRuns: Map<string, TaskRun>,
  devBuildRunId: string,
  getLastTerminalSessionId: () => string | null,
  setLastTerminalSessionId: (sessionId: string | null) => void,
  randomSessionId: () => string,
  buildInteractivePtyEnv: (overrides?: Record<string, string>) => NodeJS.ProcessEnv,
  loadTasksForWorkspace?: (scope: { workspaceFile: string, workspaceFolder: string }) => { tasks: TaskDefinition[] } | null,
  loadCurrentTasks: (workspaceFile?: string) => { tasks: TaskDefinition[] } | null,
  buildTaskRunScopeSnapshot: () => { workspaceFile: string, cwd: string },
  isTaskRunInScope: (run: TaskRun, scope: { workspaceFile: string, cwd: string }) => boolean,
  dataDir: string,
  browserManager?: Parameters<typeof createBrowserWsHandler>[0]['browserManager'],
  useHttps?: boolean,
  publicOrigin?: string | null,
  /** Override for tests; defaults to the process-wide Cretli Chrome extension bridge. */
  chromeExtBridge?: { handleConnection: (ws: WebSocket, req: unknown) => void },
};

/**
 * True for chats served by the harness WebSocket (/ws-agent-sdk) rather than a
 * PTY CLI session: `sdk` plus every transport with a built-in provider descriptor.
 */
export function isHarnessWebSocketChat(chat: { agentTransport?: string } | null | undefined): boolean {
  const transport = getChatAgentTransport(chat);
  return transport === 'sdk' || getBuiltinHarnessProvider(transport) !== null;
}

export function attachWebSocketHandlers(wss: WebSocketServer, ctx: WebSocketRouterContext): void {
  wss.on('connection', (ws: WebSocket & { _chatListScope?: object }, req) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const urlPath = requestUrl.pathname;
    const originOptions = {
      useHttps: ctx.useHttps,
      publicOrigin: ctx.publicOrigin,
    };
    if (!isWsOriginAllowed(req, urlPath, originOptions)) {
      ws.close(4403, 'origin not allowed');
      return;
    }
    if (isChromeExtPath(urlPath)) {
      (ctx.chromeExtBridge || cretliExtensionBridge).handleConnection(ws, req);
      return;
    }
    attachWsKeepalive(ws);
    // Presence v2 clients announce support and may receive a partial first snapshot; others get the full map.
    (ws as WebSocket & { _presenceProtocol?: number })._presenceProtocol = requestUrl.searchParams.get('presence') === '2' ? 2 : 1;
    const isAgentSdk = urlPath === '/ws-agent-sdk' || urlPath.endsWith('/ws-agent-sdk');
    if (isPageBridgePath(urlPath)) {
      const authTimeout = setTimeout(() => ws.close(4401, msg(req, 'widget.pageBridgeAuthMissing')), 5000);
      const handlePageBridgeAuth = (raw: RawData) => {
        let message;
        try {
          message = JSON.parse(Buffer.from(raw as Buffer).toString('utf8'));
        } catch {
          ws.close(4403, msg(req, 'widget.pageBridgeAuthInvalid'));
          return;
        }
        if (message?.type !== 'auth' || !req.headers.origin) {
          ws.close(4403, msg(req, 'widget.pageBridgeAuthInvalid'));
          return;
        }
        try {
          const tokenPayload = verifyWidgetAccessToken(message.token, {
            origin: req.headers.origin,
          });
          const pageSessionId = typeof message.pageSessionId === 'string'
            ? message.pageSessionId.trim()
            : '';
          if (!pageSessionId || pageSessionId !== tokenPayload.pageSessionId) {
            throw new Error('Invalid page session');
          }
          clearTimeout(authTimeout);
          ws.off('message', handlePageBridgeAuth);
          registerPageBridge(ws, {
            pageSessionId,
            installationId: tokenPayload.installationId,
            origin: tokenPayload.origin,
            workspaceFile: tokenPayload.workspaceFile,
            workspaceFolder: tokenPayload.workspaceFolder,
            permissions: tokenPayload.permissions,
            onBindChat: async (chatSessionKey: string) => {
              const chat = await getChatByCursorSessionIdAsync(chatSessionKey);
              if (!chat) throw new Error('Chat not found');
              if (chat.widgetInstallationId !== tokenPayload.installationId
                || chat.widgetPageSessionId !== tokenPayload.pageSessionId) {
                throw new Error('Chat belongs to a different widget session');
              }
              if (tokenPayload.workspaceFile
                && chat.workspaceFile !== tokenPayload.workspaceFile) {
                throw new Error('Chat workspace is outside the widget scope');
              }
              if (tokenPayload.workspaceFolder
                && chat.workspaceFolder !== tokenPayload.workspaceFolder) {
                throw new Error('Chat folder is outside the widget scope');
              }
            },
          });
        } catch {
          clearTimeout(authTimeout);
          ws.close(4403, msg(req, 'widget.pageBridgeAccessDenied'));
        }
      };
      ws.once('close', () => clearTimeout(authTimeout));
      ws.on('message', handlePageBridgeAuth);
      return;
    }
    const widgetHandshake = evaluateWidgetHandshake(req, urlPath, originOptions);
    if (widgetHandshake.action === 'reject') {
      ws.close(widgetHandshake.closeCode || 4403, msg(req, 'widget.invalidSession'));
      return;
    }
    const widgetAccess = widgetHandshake.widgetAccess;
    if (requiresSessionAuth(widgetHandshake) && (!isAuthConfigured() || !isAuthenticated(req))) {
      ws.close(4401, msg(req, 'auth.loginRequired'));
      return;
    }
    const sessionId = widgetAccess ? null : getSessionIdFromRequest(req);
    if (sessionId) {
      registerSessionWebSocket(sessionId, ws);
      ws.on('close', () => unregisterSessionWebSocket(sessionId, ws));
    }
    if (isBrowserPath(urlPath)) {
      // Browser uses the normal Cretli session cookie; widget tokens are rejected
      // by evaluateWidgetHandshake above (widget protocol is only valid on the SDK path).
      if (!sessionId || !ctx.browserManager) {
        ws.close(4401, msg(req, 'auth.loginRequired'));
        return;
      }
      const browserParams = new URLSearchParams((req.url || '').split('?')[1] || '');
      const explicitFile = browserParams.get('workspaceFile') || '';
      const explicitFolder = browserParams.get('workspaceFolder') || '';
      const handleBrowserConnection = createBrowserWsHandler({
        browserManager: ctx.browserManager,
        ownerSessionId: sessionId,
        // The connection's own scope (query), never the globally selected workspace.
        getScope: () => ({ workspaceFile: explicitFile, cwd: explicitFolder, workspaceFolder: explicitFolder }),
      });
      handleBrowserConnection(ws, req);
      return;
    }
    const isGeminiLive = urlPath === GEMINI_LIVE_RELAY_PATH || urlPath.endsWith(GEMINI_LIVE_RELAY_PATH);
    if (isGeminiLive) {
      handleGeminiLiveRelayConnection(ws, requestUrl.searchParams.get('ticket') || '');
      return;
    }
    const isServerLogs = urlPath === '/ws-server-logs' || urlPath.endsWith('/ws-server-logs');
    if (isServerLogs) {
      handleServerLogConnection(ws);
      return;
    }
    const isFrontBuild = urlPath === '/ws-front-build' || urlPath.endsWith('/ws-front-build');
    if (isFrontBuild) {
      if (!ctx.frontHotFallbackEnabled) {
        ws.close();
        return;
      }
      handleFrontBuildConnection(ws);
      return;
    }
    const isTask = urlPath === '/ws-task' || urlPath.endsWith('/ws-task');
    if (isTask) {
      let taskLabel = null;
      let runId = null;
      let workspaceFile = null;
      let workspaceFolder = null;
      if (req.url) {
        const queryIndex = req.url.indexOf('?');
        if (queryIndex !== -1) {
          const params = new URLSearchParams(req.url.slice(queryIndex));
          taskLabel = params.get('task') || null;
          runId = params.get('run') || null;
          workspaceFile = params.get('workspaceFile') || null;
          workspaceFolder = params.get('workspaceFolder') || null;
        }
      }
      if (!taskLabel) {
        ws.close();
        return;
      }
      handleTaskConnection(ws, taskLabel, runId, workspaceFile, ctx, workspaceFolder);
      return;
    }
    if (isAgentSdk) {
      let sessionKey = null;
      let clientInstanceId = null;
      if (req.url) {
        const queryIndex = req.url.indexOf('?');
        if (queryIndex !== -1) {
          const params = new URLSearchParams(req.url.slice(queryIndex));
          sessionKey = params.get('session') || null;
          clientInstanceId = params.get('clientInstance') || null;
        }
      }
      if (!sessionKey) {
        ws.close();
        return;
      }
      if (clientInstanceId && isValidClientInstanceId(clientInstanceId)) {
        registerClientInstanceWebSocket(clientInstanceId, ws);
        ws.on('close', () => unregisterClientInstanceWebSocket(clientInstanceId, ws));
      }
      // The chat lookup is async: frames that arrive meanwhile are held and replayed once the handler is attached.
      const held = holdWsMessages(ws);
      const sdkSessionKey = sessionKey;
      const routing = (async () => {
          const routedChat = await getChatByCursorSessionIdAsync(sdkSessionKey);
          if (ws.readyState > 1) return;
          if (widgetAccess && !ctx.widgetChatAccessScope(routedChat, widgetAccess)) {
            ws.close(4403, msg(req, 'widget.chatOutOfScope'));
            return;
          }
          held.restore();
          const dispatch = () => {
          guardArchivedChatSocket(ws, sdkSessionKey);
          // Harness runs have no request of their own: browser_* tools act for the
          // login session that is attached to the chat (never for a widget token).
          // The owner is live-only, so a UI-less run falls back to the dedicated
          // system owner instead of this user's session.
          // A Browser self-preview may display the chat but cannot take ownership
          // of the very Browser session the agent is using to inspect it.
          if (sessionId && routedChat?.id && !isBrowserPreviewSession(sessionId)) {
            rememberBrowserChatOwner(routedChat.id, sessionId);
            ws.on('close', () => forgetBrowserChatOwner(routedChat.id, sessionId));
          }
          // Scope the list channel to the routed chat's logical workspace so a
          // todo-review refresh frame is emitted only to subscribers authorized for
          // that workspace (`docs/todo-review-contract.md` U7). A widget never
          // receives a todo-change frame, but keeps its workspace for the shared key.
          const routedWorkspaceFolder = String(routedChat?.workspaceFolder || '').trim();
          ws._chatListScope = widgetAccess
            ? {
              kind: 'widget',
              chatIds: routedChat?.id ? [routedChat.id] : [],
              ...(String(widgetAccess.workspaceFolder || routedWorkspaceFolder).trim()
                ? { workspaceFolder: String(widgetAccess.workspaceFolder || routedWorkspaceFolder).trim() }
                : {}),
            }
            : { kind: 'session', ...(routedWorkspaceFolder ? { workspaceFolder: routedWorkspaceFolder } : {}) };
          const harnessWsDeps = {
            workspaceDirForAgent: ctx.workspaceDirForAgent,
            todoSyncDataDir: ctx.dataDir || '',
          };
          // Built-in harnesses resolve through the provider registry; the branch
          // always returns so a built-in chat never falls through to the SDK
          // catch-all. `sdk` (Cursor) has no descriptor and is that catch-all.
          // A known optional plugin that is switched off has no provider, and its id
          // is a built-in transport, so without this branch the chat would fall to
          // the SDK catch-all. Serve a read-only socket instead.
          const disabledPlugin = routedChat ? getDisabledOptionalHarness(getChatAgentTransport(routedChat)) : null;
          if (disabledPlugin) {
            attachDisabledOptionalHarnessSocket(ws, disabledPlugin);
            return;
          }
          const builtinProvider = routedChat
            ? getBuiltinHarnessProvider(getChatAgentTransport(routedChat))
            : null;
          if (builtinProvider) {
            runDetached(
              builtinProvider.handler(ws, sdkSessionKey, harnessWsDeps),
              builtinProvider.handlerLabel,
              ws,
            );
            return;
          }
          // A persisted transport that is neither blank, a built-in, nor the legacy
          // `cursor` alias is a local harness candidate. It must be routed to the
          // local plugin runtime, and when that plugin is stale/disabled/missing the
          // socket is closed explicitly — never handed to the SDK handler.
          if (routedChat && rawHarnessTransportKind(routedChat.agentTransport) === 'local') {
            runDetached(
              dispatchLocalHarnessWebSocket(ws, sdkSessionKey, routedChat),
              'Local harness handler',
              ws,
            );
            return;
          }
          runDetached(
            handleAgentSdkWebSocket(ws, sdkSessionKey, {
              workspaceDirForAgent: ctx.workspaceDirForAgent,
              todoSyncDataDir: ctx.dataDir,
              onRunFinished: ({ chatId, chatTitle, status, sdkMode, runId, room }) => {
                if (ctx.dataDir) {
                  runDetached(
                    syncTodoAfterSdkRunFinished({
                      dataDir: ctx.dataDir,
                      chatId,
                      status,
                      sdkMode,
                      room,
                    }),
                    'todo sync after run',
                  );
                }
                // Shared with room-kernel harnesses; the room flag dedupes one run.
                notifyAgentFinished({ chatId, chatTitle, status, runId, room });
              },
            }),
            'Cursor SDK agent handler',
            ws,
          );
          };
          dispatch();
          held.replay();
        })();
      runDetached(routing, 'Agent SDK routing', ws);
      // Resolves once the chat row was read and the handler attached (tests, shutdown).
      (ws as WebSocket & { whenRouted?: Promise<void> }).whenRouted = routing.catch(() => {});
      return;
    }
    const isAgent = urlPath === '/ws-agent' || urlPath.endsWith('/ws-agent');
    let resumeId: string | null = null;
    let workspacePath = isAgent ? null : ctx.getCurrentWorkspaceFile() || null;
    let terminalSessionId: string | null = null;
    let workspaceFolder: string | null = null;
    let model: string | null = null;
    let ptyScopedSelector = false;
    if (req.url) {
      const queryIndex = req.url.indexOf('?');
      if (queryIndex !== -1) {
        const params = new URLSearchParams(req.url.slice(queryIndex));
        ptyScopedSelector = params.get('scoped') === '1';
        resumeId = params.get('resume') || null;
        terminalSessionId = params.get('session') || null;
        const workspaceParam = params.get('workspace');
        if (workspaceParam) {
          workspacePath = workspaceParam;
        }
        const workspaceFolderParam = params.get('workspaceFolder');
        if (workspaceFolderParam !== null && workspaceFolderParam !== '') {
          workspaceFolder = workspaceFolderParam;
        }
        if (isAgent && (workspaceParam || workspaceFolderParam)) {
          const scope = resolveWorkspaceScope({ workspaceFile: workspaceParam, workspaceFolder: workspaceFolderParam }, loadSettings());
          workspacePath = scope.ok ? scope.workspaceFile || null : null;
          workspaceFolder = scope.ok ? scope.folder || null : null;
        }
        const modelParam = params.get('model');
        if (modelParam !== null && modelParam !== '') {
          model = modelParam;
        }
      }
    }
    if (isAgent && resumeId) {
      const heldPty = holdWsMessages(ws);
      const resumeSessionKey = resumeId;
      const routing = (async () => {
        const chat = await getChatByCursorSessionIdAsync(resumeSessionKey);
        if (ws.readyState > 1) return;
        const chatScope = resolveChatWorkspaceScope(chat);
        workspacePath = chatScope.workspaceFile || null;
        workspaceFolder = chatScope.folder || null;
        heldPty.restore();
        if (!rejectPtyResume(chat)) startPty();
        heldPty.replay();
      })();
      runDetached(routing, 'PTY resume routing', ws);
      (ws as WebSocket & { whenRouted?: Promise<void> }).whenRouted = routing.catch(() => {});
      return;
    }
    startPty();

    /** Closes the socket for a chat that must not be resumed through the PTY CLI; true when it did. */
    function rejectPtyResume(chat: Record<string, any> | null | undefined): boolean {
      // A persisted local plugin id must never reach the PTY CLI as `--resume`;
      // the plugin runtime owns resume and accepts it only on /ws-agent-sdk.
      // Checked explicitly so this never relies on normalizeAgentTransport's
      // `sdk` fallback for unknown transports.
      if (chat && rawHarnessTransportKind(chat.agentTransport) === 'local') {
        ws.close(4000, 'Local harness chats use harness WebSocket (/ws-agent-sdk).');
        return true;
      }
      // Registry-driven (see isHarnessWebSocketChat): new transports are covered.
      if (chat && isHarnessWebSocketChat(chat)) {
        ws.close(4000, 'Chats use harness WebSocket (/ws-agent-sdk).');
        return true;
      }
      return false;
    }

    function startPty(): void {
      const sessionSyncEnabled = ctx.isSessionSyncEnabled();
      const effectiveTerminalSessionId = sessionSyncEnabled ? terminalSessionId : null;
      handlePtyConnection(
        ws,
        isAgent,
        resumeId,
        workspacePath,
        workspaceFolder,
        model,
        effectiveTerminalSessionId,
        sessionSyncEnabled,
        ctx,
        ptyScopedSelector,
      );
    }
  });
}
