import { handleAgentSdkWebSocket } from '../sdk/cursor-agent-sdk-ws.js';
import { handleOpenRouterAgentWebSocket } from '../openrouter/openrouter-agent-ws.js';
import { handleOpenCodeAgentWebSocket } from '../opencode/opencode-agent-ws.js';
import { getChatByCursorSessionId } from '../persist/chats-persist.js';
import { isOpenCodeChat, isOpenRouterChat, isSdkChat } from '../agent-transport.js';
import {
  isValidClientInstanceId,
  registerClientInstanceWebSocket,
  unregisterClientInstanceWebSocket,
} from '../client-instance-registry.js';
import { registerPageBridge } from '../page-bridge.js';
import { verifyWidgetAccessToken } from '../widget/widget-installations.js';
import { isAuthConfigured, isAuthenticated } from '../auth.js';
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
 */

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {WebSocketRouterContext} ctx
 */
export function attachWebSocketHandlers(wss, ctx) {
  wss.on('connection', (ws, req) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const urlPath = requestUrl.pathname;
    const isAgentSdk = urlPath === '/ws-agent-sdk' || urlPath.endsWith('/ws-agent-sdk');
    const isPageBridge = urlPath === '/ws-page-bridge' || urlPath.endsWith('/ws-page-bridge');
    if (isPageBridge) {
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
    let widgetAccess = null;
    if (isAgentSdk) {
      const protocols = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const widgetProtocolIndex = Math.max(
        protocols.indexOf('cretli-widget'),
        protocols.indexOf('cursor-remote-widget')
      );
      if (widgetProtocolIndex >= 0) {
        try {
          const token = protocols[widgetProtocolIndex + 1] || '';
          widgetAccess = verifyWidgetAccessToken(token);
        } catch {
          ws.close(4403, msg(req, 'widget.invalidSession'));
          return;
        }
      }
    }
    if (!widgetAccess && (!isAuthConfigured() || !isAuthenticated(req))) {
      ws.close(4401, msg(req, 'auth.loginRequired'));
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
      if (routedChat && isOpenCodeChat(routedChat)) {
        runDetached(
          handleOpenCodeAgentWebSocket(ws, sessionKey, {
            workspaceDirForAgent: ctx.workspaceDirForAgent,
          }),
          'OpenCode agent handler',
          ws,
        );
        return;
      }
      if (routedChat && isOpenRouterChat(routedChat)) {
        runDetached(
          handleOpenRouterAgentWebSocket(ws, sessionKey, {
            workspaceDirForAgent: ctx.workspaceDirForAgent,
          }),
          'OpenRouter agent handler',
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
    if (isAgent && resumeId && !agentRunName) {
      const chat = getChatByCursorSessionId(resumeId);
      if (chat && (isSdkChat(chat) || isOpenRouterChat(chat) || isOpenCodeChat(chat))) {
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
