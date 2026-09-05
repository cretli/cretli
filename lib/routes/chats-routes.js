import express from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  loadChats,
  addChat,
  updateChat,
  deleteChat,
  createConversationForkChat,
  rotateChatSdkSession,
} from '../persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  copyChatHistory,
  copyChatHistoryUntil,
  getChatHistoryPage,
  getChatHistorySince,
  deleteChatHistory,
  HISTORY_PULL_DEFAULT_LIMIT,
  HISTORY_PULL_MAX_LIMIT,
  HISTORY_TAIL_DEFAULT_LIMIT,
} from '../persist/chat-history-persist.js';
import { formatChatHistoryEventsToText } from '../context-compression.js';
import { getChatHistoryRevisions } from '../persist/chat-history-revisions.js';
import {
  disposeSdkRoom,
  getSdkRoomDiag,
  syncSdkRoomModelFromChat,
} from '../sdk/cursor-agent-sdk-ws.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { runSdkChatProbe } from '../sdk/sdk-agent-probe.js';
import {
  buildContextPressureAssessment,
  collectChatHistoryContextStats,
  collectSdkLocalStoreStats,
  resolveLiveContextUsageInputTokens,
} from '../sdk/sdk-context-stats.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import { loadCursorSdk } from '../sdk/cursor-sdk.js';
import { getEffectiveOpenRouterApiKey } from '../openrouter/openrouter-api-key.js';
import { hasOpenCodeCredentials } from '../opencode/opencode-api-key.js';
import { getEffectiveCodeBuddyApiKey } from '../codebuddy/codebuddy-api-key.js';
import { isCodeBuddyCliFound } from '../codebuddy/codebuddy-cli.js';
import { isCodeBuddySdkAvailable } from '../codebuddy/codebuddy-sdk.js';
import { getEffectiveDeepSeekApiKey } from '../deepseek/deepseek-api-key.js';
import { isDeepSeekCliFound } from '../deepseek/deepseek-cli.js';
import { isDeepSeekSdkAvailable } from '../deepseek/deepseek-sdk.js';
import { hasCodexCredentials } from '../codex/codex-credentials.js';
import { isCodexCliFound, getCodexCliMissingHint } from '../codex/codex-cli.js';
import { isCodexSdkAvailable } from '../codex/codex-sdk.js';
import { getEffectiveQwenApiKey } from '../qwen/qwen-api-key.js';
import { isQwenSdkAvailable } from '../qwen/qwen-sdk.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { disposeOpenRouterRoom, getOpenRouterRoomDiag } from '../openrouter/openrouter-agent-ws.js';
import {
  disposeOpenCodeRoom,
  getOpenCodeRoomDiag,
  syncOpenCodeRoomModelFromChat,
} from '../opencode/opencode-agent-ws.js';
import {
  disposeCodeBuddyRoom,
  getCodeBuddyRoomDiag,
  syncCodeBuddyRoomModelFromChat,
} from '../codebuddy/codebuddy-agent-ws.js';
import {
  disposeDeepSeekRoom,
  getDeepSeekRoomDiag,
  syncDeepSeekRoomModelFromChat,
} from '../deepseek/deepseek-agent-ws.js';
import {
  disposeCodexRoom,
  getCodexRoomDiag,
  syncCodexRoomModelFromChat,
} from '../codex/codex-agent-ws.js';
import {
  disposeQwenRoom,
  getQwenRoomDiag,
  syncQwenRoomModelFromChat,
} from '../qwen/qwen-agent-ws.js';
import { getOpenCodeHealth } from '../opencode/opencode-server-manager.js';
import { formatSdkAgentMessagesToBuffer } from '../sdk/sdk-chat-history.js';
import { parseTerminalInteraction, resolveTerminalState } from '../status-parser.js';
import { resolveForkSourceText } from '../fork-chat-text.js';
import { buildForkInitialPrompt } from '../conversation-fork.js';
import { msg } from '../messages.js';
import { getTodoById, updateTodo } from '../persist/todos-persist.js';
import { exportTodoPlanFromChat, syncTodoAfterSdkRunFinished } from '../todo-plan-sync.js';
import { findChatPinnedToPageUrl, isSamePageUrl } from '../widget/widget-page-url.js';
import { summarizeChatRunStates } from '../agent-run-state.js';
import { delegationService } from '../delegation-service.js';

/**
 * @typedef {Object} ChatsRoutesContext
 * @property {string} dataDir
 * @property {Map<string, object>} agentSessions
 * @property {() => string|null} getCurrentAgentRunResumeId
 * @property {(id: string|null) => void} setCurrentAgentRunResumeId
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {(workspacePath: string|null|undefined) => string} workspaceDirForAgent
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {() => string} getCurrentCwd
 * @property {(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv} buildAgentSpawnEnv
 * @property {(chat: object, access: object) => boolean} widgetChatListScope
 */

/**
 * @param {import('express').Express} app
 * @param {ChatsRoutesContext} ctx
 */
export function registerChatsRoutes(app, ctx) {
  app.get('/api/chats', (req, res) => {
    try {
      const includeArchived = String(req.query?.includeArchived || '').trim() === '1';
      if (req.widgetAccess) {
        const installationChats = loadChats().filter((chat) => {
          if (chat.widgetInstallationId !== req.widgetAccess.installationId) return false;
          if (includeArchived) return true;
          return !chat.archivedAt;
        });
        const scopedChats = installationChats.filter((chat) => ctx.widgetChatListScope(chat, req.widgetAccess));
        const pinnedTo = typeof req.query.pinnedTo === 'string' ? req.query.pinnedTo.trim() : '';
        if (pinnedTo) {
          const linkedChat = findChatPinnedToPageUrl(installationChats, pinnedTo);
          const mergedChats = linkedChat && !scopedChats.some((chat) => chat.id === linkedChat.id)
            ? [...scopedChats, linkedChat]
            : scopedChats;
          return res.json({ ok: true, chats: mergedChats, linkedChat });
        }
        return res.json({ ok: true, chats: scopedChats });
      }
      const chats = loadChats().filter((chat) => includeArchived || !chat.archivedAt);
      res.json({ ok: true, chats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * SDK chat message history from Cursor Cloud (Agent.messages.list) — view rebuild.
   * Query: limit (1–500, default 200), offset (default 0).
   */
  app.get('/api/chats/:id/sdk-messages', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) {
        return res.status(404).json({ ok: false, error: 'Chat not found' });
      }
      if (chat.agentTransport !== 'sdk') {
        return res.status(400).json({ ok: false, error: msg(req, 'chat.sdkOnly') });
      }
      const agentId = chat.sdkAgentId && String(chat.sdkAgentId).trim();
      if (!agentId) {
        return res.json({
          ok: true,
          formatted: '',
          messageCount: 0,
          note: 'No sdkAgentId yet — send the first message to create the agent.',
        });
      }
      if (!getEffectiveCursorApiKey()) {
        return res.status(503).json({
          ok: false,
          error: msg(req, 'chat.noApiKey'),
        });
      }
      const limitRaw = Number.parseInt(String(req.query?.limit || '200'), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;
      const offsetRaw = Number.parseInt(String(req.query?.offset || '0'), 10);
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
      const { Agent } = await loadCursorSdk();
      let rows;
      try {
        rows = await Agent.messages.list(agentId, { limit, offset });
      } catch (err) {
        const msg =
          err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
        return res.status(502).json({ ok: false, error: msg });
      }
      if (!Array.isArray(rows)) {
        rows = [];
      }
      const formatted = formatSdkAgentMessagesToBuffer(rows);
      return res.json({
        ok: true,
        agentId,
        messageCount: rows.length,
        formatted,
        messages: rows,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Lightweight revision index for cross-device history pull sync.
   * GET /api/chats/history-revisions?ids=id1,id2
   */
  app.get('/api/chats/history-revisions', (req, res) => {
    try {
      const rawIds = typeof req.query?.ids === 'string' ? req.query.ids : '';
      const chatIds = rawIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      res.json({
        ok: true,
        revisions: getChatHistoryRevisions(chatIds.length > 0 ? chatIds : undefined),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Lightweight agent presence for the chat list (busy / waiting / attention).
   * GET /api/chats/agent-states?ids=id1,id2
   */
  app.get('/api/chats/agent-states', (req, res) => {
    try {
      const rawIds = typeof req.query?.ids === 'string' ? req.query.ids : '';
      const requested = rawIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const chats = loadChats();
      const allowed = new Set(
        chats
          .filter((chat) => {
            if (req.widgetAccess) {
              if (chat.widgetInstallationId !== req.widgetAccess.installationId) return false;
              return ctx.widgetChatListScope(chat, req.widgetAccess);
            }
            return true;
          })
          .map((chat) => chat.id),
      );
      const chatIds = (requested.length > 0 ? requested : [...allowed]).filter((id) => allowed.has(id));
      res.json({ ok: true, states: summarizeChatRunStates(chatIds) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Pull chat history (append-only log with server seq).
   * GET /api/chats/:id/history?since=<seq>&limit=<n>        — forward delta sync
   * GET /api/chats/:id/history?tail=<n>[&before=<seq>]      — backwards window pagination
   */
  app.get('/api/chats/:id/history', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });

      const tailRaw = Number.parseInt(String(req.query?.tail || '0'), 10);
      const beforeRaw = Number.parseInt(String(req.query?.before || '0'), 10);
      const wantsPage = Number.isFinite(tailRaw) && tailRaw > 0;
      const wantsBefore = Number.isFinite(beforeRaw) && beforeRaw > 0;
      if (wantsPage || wantsBefore) {
        return res.json(
          getChatHistoryPage(req.params.id, {
            beforeSeq: wantsBefore ? beforeRaw : 0,
            limit: wantsPage ? tailRaw : HISTORY_TAIL_DEFAULT_LIMIT,
          }),
        );
      }

      const sinceRaw = Number.parseInt(String(req.query?.since || '0'), 10);
      const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
      const limitRaw = Number.parseInt(String(req.query?.limit || String(HISTORY_PULL_DEFAULT_LIMIT)), 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(HISTORY_PULL_MAX_LIMIT, Math.max(1, limitRaw))
        : HISTORY_PULL_DEFAULT_LIMIT;
      const result = getChatHistorySince(req.params.id, since, limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Push event batch to history log (server assigns seq, idempotent by clientSeq).
   * POST /api/chats/:id/history  body: { cursorSessionId, events: [{ rec, clientSeq? }] }
   */
  app.post(
    '/api/chats/:id/history',
    express.json({ limit: '32mb' }),
    (req, res) => {
      try {
        const chats = loadChats();
        const chat = chats.find((c) => c.id === req.params.id);
        if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
        const cursorSessionId = typeof req.body?.cursorSessionId === 'string' ? req.body.cursorSessionId : '';
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        const items = events
          .map((e) => (e && typeof e === 'object' ? { rec: e.rec, clientSeq: typeof e.clientSeq === 'number' ? e.clientSeq : undefined } : null))
          .filter(Boolean);
        const result = appendChatHistoryEvents(req.params.id, cursorSessionId, items);
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    },
  );

  /**
   * Cascade delete history (also invoked from deleteChat).
   * DELETE /api/chats/:id/history
   */
  app.delete('/api/chats/:id/history', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      deleteChatHistory(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Debug status parser for a chat:
   * - returns last tail of active agent session buffer
   * - returns parseTerminalInteraction + resolveTerminalState result
   */
  app.get('/api/chats/:id/status-tail', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (chat.agentTransport === 'sdk' || chat.agentTransport === 'codebuddy' || chat.agentTransport === 'deepseek' || chat.agentTransport === 'codex' || chat.agentTransport === 'qwen') {
        const limitRaw = Number.parseInt(String(req.query?.limit || '4000'), 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 200), 32000) : 4000;
        return res.json({
          ok: true,
          chatId: chat.id,
          cursorSessionId: chat.cursorSessionId || '',
          transport: chat.agentTransport || 'sdk',
          hasActiveSession: false,
          limit,
          tail: '',
          parsed: null,
          state: null,
          note: 'Harness chat — PTY terminal state does not apply; events arrive over WebSocket.',
        });
      }
      const cursorSessionId = chat.cursorSessionId || '';
      if (!cursorSessionId) {
        return res.status(400).json({ ok: false, error: msg(req, 'chat.noCursorSessionId') });
      }
      const session = ctx.agentSessions.get(cursorSessionId);
      const limitRaw = Number.parseInt(String(req.query?.limit || '4000'), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 200), 32000) : 4000;
      if (!session || typeof session.buffer !== 'string') {
        return res.json({
          ok: true,
          chatId: chat.id,
          cursorSessionId,
          hasActiveSession: false,
          limit,
          tail: '',
        });
      }
      const tail = session.buffer.slice(-limit);
      const parsed = parseTerminalInteraction(tail);
      const state = resolveTerminalState(parsed, 'connected', 'idle', false);
      return res.json({
        ok: true,
        chatId: chat.id,
        cursorSessionId,
        hasActiveSession: true,
        limit,
        tail,
        parsed,
        state,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/chats/:id/diag', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const cursorSessionId = chat.cursorSessionId || '';
      const room = chat.agentTransport === 'sdk' && cursorSessionId
        ? getSdkRoomDiag(cursorSessionId)
        : chat.agentTransport === 'openrouter' && cursorSessionId
          ? getOpenRouterRoomDiag(cursorSessionId)
          : chat.agentTransport === 'opencode' && cursorSessionId
            ? getOpenCodeRoomDiag(cursorSessionId)
            : chat.agentTransport === 'codebuddy' && cursorSessionId
              ? getCodeBuddyRoomDiag(cursorSessionId)
              : chat.agentTransport === 'deepseek' && cursorSessionId
                ? getDeepSeekRoomDiag(cursorSessionId)
                : chat.agentTransport === 'codex' && cursorSessionId
                  ? getCodexRoomDiag(cursorSessionId)
                  : chat.agentTransport === 'qwen' && cursorSessionId
                    ? getQwenRoomDiag(cursorSessionId)
                  : null;
      const historyStats = collectChatHistoryContextStats(chat.id);
      const localStoreStats = collectSdkLocalStoreStats(cursorSessionId);
      const contextPressure = buildContextPressureAssessment({
        modelId: chat.model || room?.modelId,
        lastUsageInputTokens: resolveLiveContextUsageInputTokens({
          chat,
          room,
          historyStats,
        }),
        maxUsageInputTokens:
          historyStats?.maxEffectiveUsageInputTokens ?? historyStats?.maxUsageInputTokens,
        rawLastUsageInputTokens: historyStats?.lastUsageInputTokens ?? room?.lastUsageInputTokens,
        rawMaxUsageInputTokens: historyStats?.maxUsageInputTokens,
        localStoreTotalBytes: localStoreStats?.totalBytes,
        headSeq: historyStats?.headSeq,
      });
      const modelAudit = {
        requestedModelId: room?.requestedModelId || chat.model || null,
        effectiveModelId: room?.effectiveModelId || room?.modelId || chat.model || null,
        strictModelRequested: room?.strictModelRequested === true,
        strictModelActive: room?.strictModelActive === true,
        lastModelFallback:
          room?.lastModelFallback && typeof room.lastModelFallback === 'object'
            ? room.lastModelFallback
            : null,
      };
      const runOutcome = {
        lastRunId: room?.lastRunId || null,
        lastRunStatus: room?.lastRunStatus || null,
        lastRunStatusNormalized: room?.lastRunStatusNormalized || null,
        lastErrorCode: room?.lastErrorCode || null,
        lastErrorMessage: room?.lastErrorMessage || null,
      };
      return res.json({
        ok: true,
        chatId: chat.id,
        cursorSessionId,
        sdkAgentId: chat.sdkAgentId || null,
        model: chat.model || null,
        sdkMode: chat.sdkMode || null,
        transport: chat.agentTransport || 'sdk',
        room,
        modelAudit,
        runOutcome,
        contextStats: {
          history: historyStats,
          localStore: localStoreStats,
          pressure: contextPressure,
        },
        serverTime: Date.now(),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/sdk-probe', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (chat.agentTransport !== 'sdk') {
        return res.status(400).json({ ok: false, error: 'SDK probe is available only for SDK chats' });
      }
      if (!getEffectiveCursorApiKey()) {
        return res.status(503).json({
          ok: false,
          error: 'Missing API key (CURSOR_API_KEY or Settings → Cursor API).',
        });
      }
      const cwd = resolveSdkCwdForChat(chat, ctx.workspaceDirForAgent);
      if (!cwd) {
        return res.status(400).json({ ok: false, error: 'Missing workspace folder for SDK probe' });
      }
      const timeoutRaw = Number.parseInt(String(req.body?.timeoutMs || '120000'), 10);
      const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(Math.max(timeoutRaw, 10000), 180000) : 120000;
      const includeCreateProbe = req.body?.includeCreate !== false;
      const probe = await runSdkChatProbe(chat, {
        cwd,
        includeCreateProbe,
        probePrompt: typeof req.body?.prompt === 'string' ? req.body.prompt : undefined,
        timeoutMs,
      });
      return res.json({ ok: true, probe });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/dispose-sdk-room', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (chat.agentTransport !== 'sdk' || !chat.cursorSessionId) {
        if (chat.agentTransport === 'openrouter' && chat.cursorSessionId) {
          disposeOpenRouterRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        if (chat.agentTransport === 'opencode' && chat.cursorSessionId) {
          disposeOpenCodeRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        if (chat.agentTransport === 'codebuddy' && chat.cursorSessionId) {
          disposeCodeBuddyRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        if (chat.agentTransport === 'deepseek' && chat.cursorSessionId) {
          disposeDeepSeekRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        if (chat.agentTransport === 'codex' && chat.cursorSessionId) {
          disposeCodexRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        if (chat.agentTransport === 'qwen' && chat.cursorSessionId) {
          disposeQwenRoom(chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        return res.status(400).json({ ok: false, error: 'Not an SDK chat' });
      }
      disposeSdkRoom(chat.cursorSessionId);
      return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats', async (req, res) => {
    try {
      const forAgentRun = !!(req.body && req.body.forAgentRun);
      const agentName = req.body && req.body.agentName;
      if (forAgentRun && !agentName) {
        return res.status(400).json({ ok: false, error: msg(req, 'chat.forAgentRunRequires') });
      }
      if (!forAgentRun) {
        const agentTransport = normalizeAgentTransport(req.body?.agentTransport);
        if (agentTransport === 'openrouter') {
          if (!getEffectiveOpenRouterApiKey()) {
            return res.status(503).json({
              ok: false,
              error:
                'OpenRouter chat requires an API key: set OPENROUTER_API_KEY or save it in Settings.',
            });
          }
        } else if (agentTransport === 'opencode') {
          if (!hasOpenCodeCredentials()) {
            return res.status(503).json({
              ok: false,
              error:
                'OpenCode chat requires an API key: set OPENCODE_API_KEY, ZAI_API_KEY / ZAI_CODING_API_KEY, or save a Zen or Z.AI key in Settings → Harness → OpenCode.',
            });
          }
          const workspaceFile = req.widgetAccess?.workspaceFile
            || (req.body && req.body.workspaceFile)
            || ctx.getCurrentWorkspaceFile();
          const workspaceFolder = req.widgetAccess?.workspaceFolder
            || (req.body && req.body.workspaceFolder)
            || ctx.workspaceDirForAgent(workspaceFile);
          const health = await getOpenCodeHealth(workspaceFolder);
          if (!health.opencodeReady) {
            return res.status(503).json({
              ok: false,
              error: health.error
                || 'OpenCode is not ready — install opencode and configure a Zen or Z.AI API key in Settings.',
            });
          }
        } else if (agentTransport === 'codebuddy') {
          if (!getEffectiveCodeBuddyApiKey()) {
            return res.status(503).json({
              ok: false,
              error:
                'CodeBuddy chat requires an API key: set CODEBUDDY_API_KEY or save it in Settings → Harness → CodeBuddy.',
            });
          }
          if (!(await isCodeBuddySdkAvailable())) {
            return res.status(503).json({
              ok: false,
              error: 'CodeBuddy SDK is not installed. Run npm install @tencent-ai/agent-sdk.',
            });
          }
          if (!isCodeBuddyCliFound()) {
            return res.status(503).json({
              ok: false,
              error: 'CodeBuddy CLI not found. Install `codebuddy` or set CODEBUDDY_CODE_PATH.',
            });
          }
        } else if (agentTransport === 'deepseek') {
          if (!getEffectiveDeepSeekApiKey()) {
            return res.status(503).json({
              ok: false,
              error:
                'DeepSeek chat requires an API key: set DEEPSEEK_API_KEY or save it in Settings → Harness → DeepSeek.',
            });
          }
          if (!(await isDeepSeekSdkAvailable())) {
            return res.status(503).json({
              ok: false,
              error: 'DeepSeek Harness SDK is not installed. Run npm install @deepseek-ai/dsh-sdk-client @deepseek-ai/dsh.',
            });
          }
          if (!isDeepSeekCliFound()) {
            return res.status(503).json({
              ok: false,
              error: 'DeepSeek Harness CLI not found. Install `@deepseek-ai/dsh` or set DSH_BIN.',
            });
          }
        } else if (agentTransport === 'codex') {
          if (!hasCodexCredentials()) {
            return res.status(503).json({
              ok: false,
              error:
                'Codex chat requires ChatGPT sign-in or an API key in Settings → Harness → Codex.',
            });
          }
          if (!(await isCodexSdkAvailable())) {
            return res.status(503).json({
              ok: false,
              error: 'Codex SDK is not installed. Run npm install @openai/codex-sdk.',
            });
          }
          if (!isCodexCliFound()) {
            return res.status(503).json({
              ok: false,
              error: getCodexCliMissingHint(),
            });
          }
        } else if (agentTransport === 'qwen') {
          if (!getEffectiveQwenApiKey()) {
            return res.status(503).json({
              ok: false,
              error:
                'Qwen chat requires an API key: set QWEN_API_KEY or save it in Settings → Harness → Qwen.',
            });
          }
          if (!(await isQwenSdkAvailable())) {
            return res.status(503).json({
              ok: false,
              error: 'Qwen Code SDK is not installed. Run npm install @qwen-code/sdk.',
            });
          }
        } else if (!getEffectiveCursorApiKey()) {
          return res.status(503).json({
            ok: false,
            error:
              'SDK chat requires an API key: set CURSOR_API_KEY or save it in Settings → Harness. Or create an OpenCode / OpenRouter chat instead.',
          });
        }
        const workspaceFile = req.widgetAccess?.workspaceFile
          || (req.body && req.body.workspaceFile)
          || ctx.getCurrentWorkspaceFile();
        const workspaceFolder = req.widgetAccess?.workspaceFolder
          || (req.body && req.body.workspaceFolder)
          || null;
        const model = req.widgetAccess?.model
          || (req.body && req.body.model)
          || ctx.agentModel
          || '';
        const requestedPinnedUrl = req.body && typeof req.body.widgetPinnedUrl === 'string'
          ? req.body.widgetPinnedUrl.trim()
          : '';
        const forceNewPinnedChat = req.body?.forceNewPinnedChat === true;
        if (requestedPinnedUrl && !forceNewPinnedChat) {
          const existingPinnedChat = loadChats().find((chat) => {
            if (req.widgetAccess && chat.widgetInstallationId !== req.widgetAccess.installationId) return false;
            if (chat.archivedAt) return false;
            const pinnedUrl = typeof chat.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
            return pinnedUrl && isSamePageUrl(pinnedUrl, requestedPinnedUrl);
          });
          if (existingPinnedChat) {
            return res.json({ ok: true, chat: existingPinnedChat, reused: true });
          }
        }
        const sessionKey = randomUUID();
        const defaultTitle =
          agentTransport === 'openrouter'
            ? 'OpenRouter chat ' + (loadChats().length + 1)
            : agentTransport === 'opencode'
              ? 'OpenCode chat ' + (loadChats().length + 1)
              : agentTransport === 'codebuddy'
                ? 'CodeBuddy chat ' + (loadChats().length + 1)
                : agentTransport === 'deepseek'
                  ? 'DeepSeek chat ' + (loadChats().length + 1)
                  : agentTransport === 'codex'
                    ? 'Codex chat ' + (loadChats().length + 1)
                    : agentTransport === 'qwen'
                      ? 'Qwen chat ' + (loadChats().length + 1)
                    : 'SDK chat ' + (loadChats().length + 1);
        const chatTitle = (req.body && req.body.title) || defaultTitle;
        const sdkMode = req.body && req.body.sdkMode;
        const newChat = addChat(sessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
          agentTransport,
          sdkMode,
          sdkUiMode: req.body && req.body.sdkUiMode,
          widgetInstallationId: req.widgetAccess?.installationId,
          widgetPageSessionId: req.widgetAccess?.pageSessionId,
        });
        if (requestedPinnedUrl) {
          const pinnedChat = updateChat(newChat.id, { widgetPinnedUrl: requestedPinnedUrl });
          return res.json({ ok: true, chat: pinnedChat || newChat });
        }
        return res.json({ ok: true, chat: newChat });
      }
      const workspaceFile = (req.body && req.body.workspaceFile) || ctx.getCurrentWorkspaceFile();
      const workspaceFolder = (req.body && req.body.workspaceFolder) || null;
      const model = (req.body && req.body.model) || ctx.agentModel || '';
      const cliModel = model === 'Auto' ? 'auto' : model;
      const workspaceDir = workspaceFile ? path.dirname(workspaceFile) : ctx.getCurrentCwd();
      const agentDir = workspaceFolder || ctx.workspaceDirForAgent(workspaceFile);
      const createArgs = [];
      if (workspaceFile) createArgs.push('--workspace', agentDir);
      if (cliModel) createArgs.push('--model', cliModel);
      createArgs.push('create-chat');
      const currentAgentRunResumeId = ctx.getCurrentAgentRunResumeId();
      if (forAgentRun && currentAgentRunResumeId && ctx.agentSessions.has(currentAgentRunResumeId)) {
        const prev = ctx.agentSessions.get(currentAgentRunResumeId);
        if (prev && prev.pty) {
          try { prev.pty.kill(); } catch (_) {}
        }
        ctx.agentSessions.delete(currentAgentRunResumeId);
        ctx.setCurrentAgentRunResumeId(null);
      }
      const result = spawnSync(ctx.agentCmd, createArgs, {
        cwd: workspaceDir,
        encoding: 'utf8',
        env: ctx.buildAgentSpawnEnv({ ...process.env, TERM: 'dumb' }),
      });
      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      const cursorSessionId = stdout.split('\n').pop()?.trim() || stdout || null;
      if (!cursorSessionId) {
        return res.status(500).json({
          ok: false,
          error: 'Failed to create session (agent create-chat). ' + (stderr || result.error?.message || ''),
        });
      }
      ctx.setCurrentAgentRunResumeId(cursorSessionId);
      return res.json({
        ok: true,
        chat: {
          cursorSessionId,
          workspaceFile: workspaceFile || null,
          workspaceFolder: workspaceFolder || null,
          model: model || undefined,
          forAgentRun: true,
          agentName,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/fork', async (req, res) => {
    let chat = null;
    try {
      const parentChat = loadChats().find((entry) => entry.id === req.params.id);
      if (!parentChat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      const analyze = req.body?.analyze === true;
      const clientSourceText =
        typeof req.body?.sourceText === 'string' ? req.body.sourceText : '';
      // Partial fork: copy history (and the inherited transcript) only up to the record
      // created at `upToCreatedAt` — the per-message "fork from here" entry point.
      const upToCreatedAt =
        typeof req.body?.upToCreatedAt === 'string' ? req.body.upToCreatedAt.trim() : '';
      const partialFork = !analyze && upToCreatedAt !== '';
      const sourceText = analyze
        ? ''
        : partialFork
          ? ''
          : await resolveForkSourceText(parentChat.id, clientSourceText);
      let promptSourceText = sourceText;
      const requestedWorkspaceFile =
        typeof req.body?.workspaceFile === 'string' ? req.body.workspaceFile.trim() : '';
      const requestedWorkspaceFolder =
        typeof req.body?.workspaceFolder === 'string' ? req.body.workspaceFolder.trim() : '';
      const requestedTitle =
        typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const requestedModel =
        typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      const hasTransportOverride =
        typeof req.body?.agentTransport === 'string' && req.body.agentTransport.trim() !== '';
      const toHarness = hasTransportOverride
        ? normalizeAgentTransport(req.body.agentTransport)
        : normalizeAgentTransport(parentChat.agentTransport);
      const toModel = requestedModel || parentChat.model;
      chat = createConversationForkChat(parentChat, {
        workspaceFile: requestedWorkspaceFile || undefined,
        workspaceFolder: requestedWorkspaceFolder || undefined,
        title: requestedTitle || undefined,
        model: requestedModel || undefined,
        agentTransport: hasTransportOverride ? toHarness : undefined,
        forkKind: analyze ? 'analyze' : undefined,
      });
      if (!analyze) {
        let copiedHistory;
        if (partialFork) {
          copiedHistory = copyChatHistoryUntil(
            parentChat.id,
            chat.id,
            chat.cursorSessionId,
            upToCreatedAt
          );
        } else {
          copiedHistory = copyChatHistory(parentChat.id, chat.id, chat.cursorSessionId);
        }
        if (!copiedHistory.ok) {
          throw new Error(copiedHistory.error || msg(req, 'chat.forkCopyHistoryFailed'));
        }
        if (partialFork) {
          // The cut log is the transcript authority here — the client window may not
          // reach back to the fork point.
          const cutText = formatChatHistoryEventsToText(copiedHistory.events || []);
          promptSourceText = cutText.length > 0 ? cutText : clientSourceText;
        }
      }
      return res.json({
        ok: true,
        chat,
        initialPrompt: buildForkInitialPrompt({
          sourceText: analyze ? '' : promptSourceText,
          message,
          fromHarness: parentChat.agentTransport,
          toHarness,
          fromModel: parentChat.model,
          toModel,
          analyze,
          partial: partialFork,
        }),
      });
    } catch (err) {
      if (chat?.id) {
        try {
          deleteChat(chat.id);
        } catch (_) {}
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/chats/:id', (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      delete body.sdkAgentId;
      if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
        body.archived = body.archived === true;
      }
      const chat = updateChat(req.params.id, body);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (typeof body.model === 'string' && chat.cursorSessionId) {
        if (chat.agentTransport === 'sdk') {
          syncSdkRoomModelFromChat(chat.cursorSessionId, body.model);
        } else if (chat.agentTransport === 'opencode') {
          syncOpenCodeRoomModelFromChat(chat.cursorSessionId, body.model);
        } else if (chat.agentTransport === 'codebuddy') {
          syncCodeBuddyRoomModelFromChat(chat.cursorSessionId, body.model);
        } else if (chat.agentTransport === 'deepseek') {
          syncDeepSeekRoomModelFromChat(chat.cursorSessionId, body.model);
        } else if (chat.agentTransport === 'codex') {
          syncCodexRoomModelFromChat(chat.cursorSessionId, body.model);
        } else if (chat.agentTransport === 'qwen') {
          syncQwenRoomModelFromChat(chat.cursorSessionId, body.model);
        }
      }
      res.json({ ok: true, chat });
    } catch (err) {
      const message = String(err?.message || '');
      if (
        message === 'Chat cannot be nested under itself' ||
        message === 'Parent chat not found' ||
        message === 'Cannot nest a chat under its descendant'
      ) {
        return res.status(400).json({ ok: false, error: message });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/reset-sdk-context', (req, res) => {
    try {
      const chats = loadChats();
      const current = chats.find((entry) => entry.id === req.params.id);
      if (!current) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (current.agentTransport !== 'sdk') {
        return res.status(400).json({ ok: false, error: 'Reset context is available only for SDK chats' });
      }
      if (current.cursorSessionId) {
        disposeSdkRoom(current.cursorSessionId);
      }
      const chat = rotateChatSdkSession(req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      return res.json({ ok: true, chat });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/sync-todo-plan', (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((entry) => entry.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const cwd = resolveSdkCwdForChat(chat, ctx.workspaceDirForAgent);
      if (!cwd) {
        return res.status(400).json({ ok: false, error: 'Missing workspace folder for Todo sync' });
      }
      const approved = req.body?.approved === true;
      const synced = syncTodoAfterSdkRunFinished({
        dataDir: ctx.dataDir,
        chatId: chat.id,
        sdkMode: 'plan',
        approvedAt: approved ? new Date().toISOString() : null,
        room: {
          cwd,
          chatId: chat.id,
          chatTitle: chat.title || chat.id,
        },
      });
      if (!synced) {
        return res.status(422).json({ ok: false, error: 'No plan content found in chat history' });
      }
      const refreshed = loadChats().find((entry) => entry.id === chat.id) || chat;
      const todoId = typeof refreshed.todoId === 'string' ? refreshed.todoId.trim() : '';
      const todo = todoId ? getTodoById(ctx.dataDir, cwd, todoId) : null;
      return res.json({ ok: true, todo, chat: refreshed });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/chats/:id', async (req, res) => {
    try {
      const chats = loadChats();
      const doomed = chats.find((c) => c.id === req.params.id);
      if (!doomed) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const cancelled = await delegationService.cancelForDeletedChat(doomed.id);
      if (!cancelled.ok) {
        return res.status(cancelled.status || 409).json({
          ok: false,
          error: cancelled.error || 'Could not stop the executor run.',
          code: cancelled.code || 'cancel_failed',
        });
      }
      if (doomed?.todoId) {
        try {
          const cwd = resolveSdkCwdForChat(doomed, ctx.workspaceDirForAgent);
          if (cwd) {
            exportTodoPlanFromChat({ dataDir: ctx.dataDir, cwd, chat: doomed });
            updateTodo(ctx.dataDir, cwd, doomed.todoId, {
              chatId: null,
              status: 'ready',
              linkedChatId: doomed.id,
            });
          }
        } catch (_) {}
      }
      if (doomed?.agentTransport === 'sdk' && doomed.cursorSessionId) {
        disposeSdkRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'openrouter' && doomed.cursorSessionId) {
        disposeOpenRouterRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'opencode' && doomed.cursorSessionId) {
        disposeOpenCodeRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'codebuddy' && doomed.cursorSessionId) {
        disposeCodeBuddyRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'deepseek' && doomed.cursorSessionId) {
        disposeDeepSeekRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'codex' && doomed.cursorSessionId) {
        disposeCodexRoom(doomed.cursorSessionId);
      } else if (doomed?.agentTransport === 'qwen' && doomed.cursorSessionId) {
        disposeQwenRoom(doomed.cursorSessionId);
      }
      deleteChat(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
