import { handleAgentSdkWebSocket } from '../sdk/cursor-agent-sdk-ws.js';
import { handleOpenRouterAgentWebSocket } from '../openrouter/openrouter-agent-ws.js';
import { handleOpenCodeAgentWebSocket } from '../opencode/opencode-agent-ws.js';
import { handleCodeBuddyAgentWebSocket } from '../codebuddy/codebuddy-agent-ws.js';
import { handleDeepSeekAgentWebSocket } from '../deepseek/deepseek-agent-ws.js';
import { handleCodexAgentWebSocket } from '../codex/codex-agent-ws.js';
import { handleQwenAgentWebSocket } from '../qwen/qwen-agent-ws.js';
import { handleClaudeAgentWebSocket } from '../claude/claude-agent-ws.js';
import { getChatByCursorSessionId } from '../persist/chats-persist.js';
import { isClaudeChat, isCodeBuddyChat, isCodexChat, isDeepSeekChat, isOpenCodeChat, isOpenRouterChat, isQwenChat, isSdkChat } from '../agent-transport.js';
import {
  dispatchLocalHarnessWebSocket,
  rawHarnessTransportKind,
} from '../agent-harness/local-harness-runtime.js';
import { resolveBuiltinHarnessChatHandler } from '../agent-harness/builtin-harness-providers.js';
import {
  isValidClientInstanceId,
  registerClientInstanceWebSocket,
  unregisterClientInstanceWebSocket,
} from '../client-instance-registry.js';
import { registerPageBridge } from '../page-bridge.js';
import { verifyWidgetAccessToken } from '../widget/widget-installations.js';
import { isAuthConfigured, isAuthenticated, getSessionIdFromRequest } from '../auth.js';
import {
  registerSessionWebSocket,
  unregisterSessionWebSocket,
} from './ws-session-registry.js';
import { isPushAvailable, broadcastPush } from '../push.js';
import { syncTodoAfterSdkRunFinished } from '../todo-plan-sync.js';
import { handlePtyConnection } from './pty-ws-handler.js';
import { handleTaskConnection } from './task-ws-handler.js';
import { handleAgentRunConnection } from './agent-run-ws-handler.js';
import { handleServerLogConnection } from './server-log-ws.js';
import { handleFrontBuildConnection } from './front-build-ws.js';
import { handleGeminiLiveRelayConnection } from '../voice/gemini-live-relay.js';
import { GEMINI_LIVE_RELAY_PATH } from '../voice/gemini-live-config.js';
import { msg } from '../messages.js';
import { attachWsKeepalive } from './ws-keepalive.js';
import { evaluateWidgetHandshake, requiresSessionAuth } from './ws-auth-boundary.js';
import { isBrowserPath, isPageBridgePath } from './ws-path.js';
import { createBrowserWsHandler } from '../browser/ws-handler.js';
import { isWsOriginAllowed } from './ws-origin.js';

/**
 * Runs a detached async task without letting a rejection reach
 * `unhandledRejection`, which terminates the process in production.
 * @param {Promise<unknown>} task
 * @param {string} label
 * @param {import('ws').WebSocket} [ws] - closed with 1011 when the task fails
 * @returns {void}
 */
function runDetached(task, label, ws = null) {
  Promise.resolve(task).catch((err) => {
    console.error(`[ws] ${label} failed:`, err?.stack || err?.message || err);
    if (!ws) return;
    try {
      ws.close(1011, 'Internal error');
    } catch {
      // the socket may already be gone
    }
  });
}

/**
 * @typedef {Object} WebSocketRouterContext
 * @property {boolean} frontHotFallbackEnabled
 * @property {(chat: object|null|undefined, access: object) => boolean} widgetChatAccessScope
 * @property {(workspacePath: string|null|undefined) => string} workspaceDirForAgent
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {() => string} getCurrentCwd
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {() => boolean} isSessionSyncEnabled
 * @property {Map<string, object>} terminalSessions
 * @property {Map<string, object>} agentSessions
 * @property {Map<string, object>} taskRuns
 * @property {Map<string, object>} agentRuns
 * @property {string} devBuildRunId
 * @property {() => string|null} getCurrentAgentRunResumeId
 * @property {(id: string|null) => void} setCurrentAgentRunResumeId
 * @property {() => string|null} getLastTerminalSessionId
 * @property {(sessionId: string|null) => void} setLastTerminalSessionId
 * @property {() => string} randomSessionId
 * @property {(overrides?: object) => NodeJS.ProcessEnv} buildInteractivePtyEnv
 * @property {() => object|null} loadCurrentTasks
 * @property {() => { workspaceFile: string, cwd: string }} buildTaskRunScopeSnapshot
 * @property {(run: object, scope: object) => boolean} isTaskRunInScope
 * @property {() => { schedules: object[] }} loadAgentsSchedule
 * @property {string} dataDir
 * @property {object} [browserManager]
 * @property {boolean} [useHttps]
 * @property {string|null} [publicOrigin]
 */

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {WebSocketRouterContext} ctx
 */
export function attachWebSocketHandlers(wss, ctx) {
  wss.on('connection', (ws, req) => {
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
    attachWsKeepalive(ws);
    const isAgentSdk = urlPath === '/ws-agent-sdk' || urlPath.endsWith('/ws-agent-sdk');
    if (isPageBridgePath(urlPath)) {
      const authTimeout = setTimeout(() => ws.close(4401, msg(req, 'widget.pageBridgeAuthMissing')), 5000);
      const handlePageBridgeAuth = (raw) => {
        let message;
        try {
          message = JSON.parse(Buffer.from(raw).toString('utf8'));
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
            onBindChat: (chatSessionKey) => {
              const chat = getChatByCursorSessionId(chatSessionKey);
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
      const handleBrowserConnection = createBrowserWsHandler({
        browserManager: ctx.browserManager,
        ownerSessionId: sessionId,
        getScope: () => ({
          workspaceFile: typeof ctx.getCurrentWorkspaceFile === 'function' ? ctx.getCurrentWorkspaceFile() : '',
          cwd: typeof ctx.getCurrentCwd === 'function' ? ctx.getCurrentCwd() : '',
        }),
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
    const isAgentRun = urlPath === '/ws-agent-run' || urlPath.endsWith('/ws-agent-run');
    if (isAgentRun) {
      let agentName = null;
      let runId = null;
      if (req.url) {
        const queryIndex = req.url.indexOf('?');
        if (queryIndex !== -1) {
          const params = new URLSearchParams(req.url.slice(queryIndex));
          agentName = params.get('agent') || null;
          runId = params.get('run') || null;
        }
      }
      if (!agentName) {
        ws.close();
        return;
      }
      handleAgentRunConnection(ws, agentName, runId, ctx);
      return;
    }
    if (isTask) {
      let taskLabel = null;
      let runId = null;
      if (req.url) {
        const queryIndex = req.url.indexOf('?');
        if (queryIndex !== -1) {
          const params = new URLSearchParams(req.url.slice(queryIndex));
          taskLabel = params.get('task') || null;
          runId = params.get('run') || null;
        }
      }
      if (!taskLabel) {
        ws.close();
        return;
      }
      handleTaskConnection(ws, taskLabel, runId, ctx);
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
      if (widgetAccess) {
        const chat = getChatByCursorSessionId(sessionKey);
        if (!ctx.widgetChatAccessScope(chat, widgetAccess)) {
          ws.close(4403, msg(req, 'widget.chatOutOfScope'));
          return;
        }
      }
      const routedChat = getChatByCursorSessionId(sessionKey);
      ws._chatListScope = widgetAccess
        ? { kind: 'widget', chatIds: routedChat?.id ? [routedChat.id] : [] }
        : { kind: 'session' };
      const harnessWsDeps = {
        workspaceDirForAgent: ctx.workspaceDirForAgent,
        todoSyncDataDir: ctx.dataDir || '',
      };
      if (routedChat && isOpenCodeChat(routedChat)) {
        runDetached(
          handleOpenCodeAgentWebSocket(ws, sessionKey, harnessWsDeps),
          'OpenCode agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isCodeBuddyChat(routedChat)) {
        runDetached(
          handleCodeBuddyAgentWebSocket(ws, sessionKey, harnessWsDeps),
          'CodeBuddy agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isDeepSeekChat(routedChat)) {
        runDetached(
          handleDeepSeekAgentWebSocket(ws, sessionKey, harnessWsDeps),
          'DeepSeek agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isCodexChat(routedChat)) {
        runDetached(
          handleCodexAgentWebSocket(ws, sessionKey, harnessWsDeps),
          'Codex agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isQwenChat(routedChat)) {
        runDetached(
          handleQwenAgentWebSocket(ws, sessionKey, harnessWsDeps),
          'Qwen agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isClaudeChat(routedChat)) {
        const claudeHandler = resolveBuiltinHarnessChatHandler(
          'claude',
          handleClaudeAgentWebSocket,
        );
        if (claudeHandler) {
          runDetached(
            claudeHandler(ws, sessionKey, harnessWsDeps),
            'Claude agent handler',
            ws,
          );
        }
        return;
      }
      if (routedChat && isOpenRouterChat(routedChat)) {
        // WR1 pilot: resolve the handler through the static built-in provider
        // registry. The direct import stays as the exact previous-handler
        // fallback, and the branch always returns so routing never falls
        // through to the SDK catch-all.
        const openRouterHandler = resolveBuiltinHarnessChatHandler(
          'openrouter',
          handleOpenRouterAgentWebSocket,
        );
        if (openRouterHandler) {
          runDetached(
            openRouterHandler(ws, sessionKey, harnessWsDeps),
            'OpenRouter agent handler',
            ws,
          );
        }
        return;
      }
      // A persisted transport that is neither blank, a built-in, nor the legacy
      // `cursor` alias is a local harness candidate. It must be routed to the
      // local plugin runtime, and when that plugin is stale/disabled/missing the
      // socket is closed explicitly — never handed to the SDK handler.
      if (routedChat && rawHarnessTransportKind(routedChat.agentTransport) === 'local') {
        runDetached(
          dispatchLocalHarnessWebSocket(ws, sessionKey, routedChat),
          'Local harness handler',
          ws,
        );
        return;
      }
      runDetached(
        handleAgentSdkWebSocket(ws, sessionKey, {
          workspaceDirForAgent: ctx.workspaceDirForAgent,
          todoSyncDataDir: ctx.dataDir,
          onRunFinished: ({ chatId, chatTitle, status, sdkMode, room }) => {
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
            if (!isPushAvailable()) return;
            if (status === 'plan_guard_cancelled') return;
            runDetached(
              broadcastPush({
                title: 'Cretli — agent finished',
                body: `Chat "${chatTitle || chatId || '?'}" — agent run ended (${status || 'done'}).`,
                tag: `cretli-${chatId || 'agent'}`,
                data: { url: chatId ? `/?source=pwa&panel=chat&chat=${encodeURIComponent(chatId)}` : '/?source=pwa&panel=chat' },
              }),
              'push broadcast',
            );
          },
        }),
        'Cursor SDK agent handler',
        ws,
      );
      return;
    }
    const isAgent = urlPath === '/ws-agent' || urlPath.endsWith('/ws-agent');
    let resumeId = null;
    let workspacePath = ctx.getCurrentWorkspaceFile() || null;
    let terminalSessionId = null;
    let workspaceFolder = null;
    let model = null;
    let agentRunName = null;
    if (req.url) {
      const queryIndex = req.url.indexOf('?');
      if (queryIndex !== -1) {
        const params = new URLSearchParams(req.url.slice(queryIndex));
        resumeId = params.get('resume') || null;
        terminalSessionId = params.get('session') || null;
        agentRunName = params.get('agentRun') || null;
        const workspaceParam = params.get('workspace');
        if (workspaceParam) {
          workspacePath = workspaceParam;
        }
        const workspaceFolderParam = params.get('workspaceFolder');
        if (workspaceFolderParam !== null && workspaceFolderParam !== '') {
          workspaceFolder = workspaceFolderParam;
        }
        const modelParam = params.get('model');
        if (modelParam !== null && modelParam !== '') {
          model = modelParam;
        }
      }
    }
    if (isAgent && resumeId) {
      const chat = getChatByCursorSessionId(resumeId);
      // A persisted local plugin id must never reach the PTY CLI as `--resume`;
      // the plugin runtime owns resume and accepts it only on /ws-agent-sdk.
      // Checked explicitly so this never relies on normalizeAgentTransport's
      // `sdk` fallback for unknown transports.
      if (chat && rawHarnessTransportKind(chat.agentTransport) === 'local') {
        ws.close(4000, 'Local harness chats use harness WebSocket (/ws-agent-sdk).');
        return;
      }
      if (!agentRunName && chat && (isSdkChat(chat) || isOpenRouterChat(chat) || isOpenCodeChat(chat) || isCodeBuddyChat(chat) || isDeepSeekChat(chat) || isCodexChat(chat) || isQwenChat(chat) || isClaudeChat(chat))) {
        ws.close(4000, 'Chats use harness WebSocket (/ws-agent-sdk).');
        return;
      }
    }
    if (isAgent && !workspacePath) workspacePath = ctx.getCurrentWorkspaceFile();
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
      agentRunName,
      ctx,
    );
  });
}
