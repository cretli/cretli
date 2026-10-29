import { readCodexContextUsage } from '../codex/codex-context-usage.ts';
import { resolveCodexHomeDir } from '../codex/codex-home.ts';
import express from 'express';
import { readChatCatalog } from '../chat-catalog.js';
import { CHAT_LIST_DTO_VERSION, toChatListDtos } from '../chat-list-dto.js';
import { buildChatListSyncResponse, formatSyncToken, getChatListSyncState } from '../chat-list-sync.js';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  loadChats,
  peekChats,
  peekChatsByIds,
  addChat,
  updateChat,
  deleteChat,
  rotateChatSdkSession,
  setChatTitleLocked,
  markChatReadState,
} from '../persist/chats-persist.js';
import { getChatTitleHistory } from '../persist/chat-title-history-persist.js';
import { getChatTitleService } from '../chat-title-service.js';
import { applyAgentTitle } from '../chat-title-agent.js';
import { runChatTitleBackfill } from '../chat-title-backfill.js';
import {
  appendChatHistoryEvents,
  readChatHistoryFromHttpQuery,
  readChatHistoryBatch,
  deleteChatHistory,
} from '../persist/chat-history-service.js';
import { appendRelatedChatHistoryLinks } from '../chat-relation-history.js';
import { sendHistoryError } from '../persist/chat-history-http.js';
import { guardAsyncRoutes } from '../http-async-guard.js';
import { getChatHistoryRevisions } from '../persist/chat-history-revisions.js';
import {
  mapChatForClientList,
  mapChatsForClientList,
  countArchivedChatsByWorkspace,
  collectLiveWorktreeTodoIds,
  markWorktreeChats,
} from '../chat-list-payload.js';
import { getWorktreeRecord, readWorktreeRegistry } from '../persist/worktree-registry-persist.js';
import { isWorktreeRecordLive } from '../worktree/worktree-record-live.ts';
import { selectChatsForSidebarList, isChatArchived } from '../chat-tree.js';
import '../chat-archive-guard.js';
import { publishChatLifecycleNotification } from '../notifications/notification-producers.ts';
import {
  disposeSdkRoom,
  getSdkRoomDiag,
  syncSdkRoomModelFromChat,
} from '../sdk/cursor-agent-sdk-ws.ts';
import { resolveSdkCwdForChat } from '../workspace.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import { runSdkChatProbe } from '../sdk/sdk-agent-probe.ts';
import {
  buildContextPressureAssessment,
  collectChatHistoryContextStats,
  collectSdkLocalStoreStats,
  resolveLiveContextUsageInputTokens,
} from '../sdk/sdk-context-stats.ts';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.ts';
import { loadCursorSdk } from '../sdk/cursor-sdk.ts';
import { classifyCreateHarness } from '../agent-harness/chat-create-harness-guard.ts';
import {
  disposeLocalHarnessSession,
  rawHarnessTransportKind,
} from '../agent-harness/local-harness-runtime.ts';
import {
  isPersistedLocalChatTransport,
  resolvePersistedLocalChatState,
  resolvePersistedLocalChatStates,
} from '../agent-harness/persisted-local-chat-state.ts';
import { getBuiltinHarnessProvider } from '../agent-harness/builtin-harness-providers.ts';
import { formatSdkAgentMessagesToBuffer } from '../sdk/sdk-chat-history.ts';
import { parseTerminalInteraction, resolveTerminalState } from '../status-parser.js';
import { ConversationForkError, executeConversationFork } from '../conversation-fork-execute.js';
import { createProductionGate, executeSummaryFork } from '../context/summary-fork.js';
import { buildChatCacheView } from '../usage/cache-freshness-view.ts';
import { msg } from '../messages.js';
import { resolveTodoStartModel } from './resolve-start-model.js';
import { getTodo as getTodoById, updateTodo } from '../persist/todos-store.js';
import { exportTodoPlanFromChat, syncTodoAfterSdkRunFinished } from '../todo-plan-sync.js';
import { findChatPinnedToPageUrl, isSamePageUrl } from '../widget/widget-page-url.ts';
import { summarizeChatRunStates } from '../agent-run-state.js';
import { initAgentPresenceBus } from '../agent-presence-bus.js';
import { delegationService } from '../delegation-service.js';
import { checkExternalRestoreGeneration } from '../backup/offline/restore-gate.js';

/**
 * @typedef {Object} ChatsRoutesContext
 * @property {string} dataDir
 * @property {Map<string, Record<string, any>>} agentSessions
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {(workspacePath: string|null|undefined) => string} workspaceDirForAgent
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {() => string} getCurrentCwd
 * @property {(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv} buildAgentSpawnEnv
 * @property {(chat: Record<string, any>, access: Record<string, any>) => boolean} widgetChatListScope
 */

/**
 * Chat ids this request may see. Omit `ids` = the full allowlist (widget scoped).
 * Requested ids are intersected with the allowlist so widgets cannot leak others.
 *
 * @param {import('express').Request} req
 * @param {ChatsRoutesContext} ctx
 * @param {string[]} [requestedIds] when given, only these ids are looked up (O(ids), no full-list scan)
 * @returns {string[]}
 */
function listAllowedChatIds(req, ctx, requestedIds) {
  const rows = Array.isArray(requestedIds) ? peekChatsByIds(requestedIds) : peekChats();
  const ids = [];
  for (const chat of rows) {
    if (req.widgetAccess) {
      if (chat.widgetInstallationId !== req.widgetAccess.installationId) continue;
      if (!ctx.widgetChatListScope(chat, req.widgetAccess)) continue;
    }
    ids.push(chat.id);
  }
  return ids;
}

function listScopedChatIds(req, ctx) {
  const rawIds = typeof req.query?.ids === 'string' ? req.query.ids : '';
  const requested = rawIds
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) return listAllowedChatIds(req, ctx);
  return listAllowedChatIds(req, ctx, requested);
}

/**
 * Explicit id list only. Empty request never expands to the full allowlist.
 *
 * @param {import('express').Request} req
 * @param {ChatsRoutesContext} ctx
 * @param {unknown[]} requestedIds
 * @returns {string[]}
 */
function listExplicitScopedChatIds(req, ctx, requestedIds) {
  const requested = (Array.isArray(requestedIds) ? requestedIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (requested.length === 0) return [];
  const allowedSet = new Set(listAllowedChatIds(req, ctx, requested));
  return requested.filter((id) => allowedSet.has(id));
}

/**
 * Normalize a workspace path for the archive window comparison so a client that
 * sends backslashes or a trailing slash still matches the persisted `workspaceFile`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeChatWorkspaceScope(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/**
 * @param {import('express').Express} app
 * @param {ChatsRoutesContext} ctx
 */

/**
 * Built-in provider for a persisted chat, matched on the exact stored id (the
 * pre-registry branches compared `chat.agentTransport === '<id>'`). `sdk`
 * (Cursor) has no provider and is handled explicitly.
 *
 * @param {{ agentTransport?: unknown } | null | undefined} chat
 */
function builtinProviderForChat(chat) {
  const provider = getBuiltinHarnessProvider(chat?.agentTransport);
  return provider && provider.id === chat?.agentTransport ? provider : null;
}
export function registerChatsRoutes(app, ctx) {
  guardAsyncRoutes(app);
  initAgentPresenceBus();
  /**
   * Live task worktrees of one workspace folder, for the new-chat picker.
   * Read-only; paths are shown as labels, the create route re-resolves them.
   */
  app.get('/api/worktrees', async (req, res) => {
    const folder = String(req.query?.workspaceFolder || '').trim();
    if (!folder) return res.status(400).json({ ok: false, error: 'workspaceFolder is required.' });
    const wanted = path.resolve(folder);
    const items = await Promise.all(Object.values(readWorktreeRegistry({ dataDir: ctx.dataDir }).items || {})
      .filter((record) => isWorktreeRecordLive(record) && record.worktreePath)
      .filter((record) => path.resolve(String(record.workspaceFolder || '')) === wanted)
      .map(async (record) => {
        let title = '';
        try {
          title = String((await getTodoById(ctx.dataDir, record.workspaceFolder, record.todoId))?.title || '');
        } catch (_) {}
        return {
          todoId: record.todoId,
          branch: record.branch,
          worktreePath: record.worktreePath,
          title,
        };
      }));
    return res.json({ ok: true, worktrees: items });
  });

  /**
   * Live-worktree markers for the list: one registry read. A corrupt registry must
   * not blank the sidebar, so it degrades to "no markers".
   *
   * @returns {Set<string>}
   */
  const readLiveWorktreeTodoIds = () => {
    try {
      return collectLiveWorktreeTodoIds(Object.values(readWorktreeRegistry({ dataDir: ctx.dataDir }).items));
    } catch {
      return new Set();
    }
  };

  /**
   * Same scope policy for every list endpoint: widget installation + widget controller
   * scope are applied by the catalog BEFORE any limit or delta.
   *
   * @param {import('express').Request} req
   */
  const readScopedListCatalog = (req) => {
    const widget = req.widgetAccess || null;
    const q = req.query || {};
    const catalog = readChatCatalog(widget && typeof ctx.widgetChatListScope === 'function'
      ? { matchesWorkspace: (chat) => Boolean(ctx.widgetChatListScope(chat, widget)) }
      : {});
    const scope = {
      workspaceFolder: typeof q.workspaceFolder === 'string' ? q.workspaceFolder : '',
      workspaceFile: typeof q.workspaceFile === 'string' ? q.workspaceFile : '',
      widgetInstallationId: widget ? widget.installationId : '',
    };
    const matcher = widget && typeof ctx.widgetChatListScope === 'function'
      ? (chat) => Boolean(ctx.widgetChatListScope(chat, widget))
      : undefined;
    return { catalog, scope, matcher, widget };
  };

  /**
   * @param {unknown} err
   * @param {import('express').Response} res
   */
  const respondListError = (/** @type {Record<string, any>} */ err, res) => {
    const code = err && err.code;
    if (code === 'INVALID_ARGUMENT') return res.status(400).json({ ok: false, error: err.message, code });
    if (code === 'STALE_CURSOR') return res.status(409).json({ ok: false, error: err.message, code });
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Internal error' });
  };

  /**
   * Bounded keyset page of the chat list (additive; GET /api/chats stays the full
   * index). Scope (workspace, widget installation, widget controller scope) is
   * applied before the limit. Query: limit, cursor, archived=include|exclude|only|tree (default tree =
   * GET /api/chats parity: live rows plus archived ancestors of live rows; exclude is strict),
   * workspaceFolder, workspaceFile, view=list (lightweight DTO, docs/architecture-list-sync-contract.md),
   * pinnedTo (widget only: adds `linkedChat`). Rows carry `onWorktree` like GET /api/chats;
   * `harnessState` is resolved for persisted local transports (full rows only).
   * A response includes `sync` (`<epoch>.<seq>`) so a client can continue with GET /api/chats/sync.
   */
  app.get('/api/chats/page', (req, res) => {
    try {
      const q = req.query || {};
      const { catalog, scope, matcher, widget } = readScopedListCatalog(req);
      const worktreeTodoIds = readLiveWorktreeTodoIds();
      const position = getChatListSyncState().observe(catalog, { worktreeTodoIds });
      const archived = typeof q.archived === 'string' && q.archived ? q.archived : 'tree';
      const result = catalog.page({
        scope,
        archived,
        limit: q.limit,
        cursor: typeof q.cursor === 'string' ? q.cursor : '',
      });
      const lightweight = String(q.view || '') === 'list';
      const body = {
        ok: true,
        revision: result.revision,
        sync: formatSyncToken(position),
        nextCursor: result.nextCursor,
        archivedCounts: catalog.archivedCountsByWorkspace({ scope }),
      };
      if (lightweight) {
        body.dtoVersion = CHAT_LIST_DTO_VERSION;
        body.chats = toChatListDtos(result.items, { worktreeTodoIds });
        return res.json(body);
      }
      const rows = markWorktreeChats(
        mapChatsForClientList(result.items, { includeSummaries: String(q.includeSummaries || '') === '1' }),
        worktreeTodoIds,
      );
      const pinnedTo = widget && typeof q.pinnedTo === 'string' ? q.pinnedTo.trim() : '';
      if (pinnedTo) {
        const linked = findChatPinnedToPageUrl(
          catalog.list({ scope: { widgetInstallationId: widget.installationId } }),
          pinnedTo,
        );
        body.linkedChat = linked ? markWorktreeChats([mapChatForClientList(linked)], worktreeTodoIds)[0] : null;
      }
      const transports = rows.map((row) => (row && row.agentTransport));
      if (!transports.some((value) => isPersistedLocalChatTransport(value))) {
        return res.json({ ...body, chats: rows });
      }
      // Rare path: at least one persisted local transport needs its harness state.
      resolvePersistedLocalChatStates(transports).catch(() => new Map()).then((states) => {
        const withState = states.size === 0 ? rows : rows.map((row) => {
          const id = row && typeof row.agentTransport === 'string' ? row.agentTransport.trim().toLowerCase() : '';
          const harnessState = id ? states.get(id) : null;
          return harnessState ? { ...row, harnessState } : row;
        });
        res.json({ ...body, chats: withState });
      });
    } catch (err) {
      respondListError(err, res);
    }
  });

  /**
   * Delta since a client position (`since=<epoch>.<seq>`): upserted DTOs + removed ids, a
   * noop, or an explicit `mode: 'resync'` (restart, gap, too large, ahead, no `since`) after
   * which the client walks GET /api/chats/page?view=list. Same scope policy as /page.
   * Read-only; at most 100 rows and 128 KiB per answer (frozen API caps).
   */
  app.get('/api/chats/sync', (req, res) => {
    try {
      const q = req.query || {};
      const { catalog, scope, matcher } = readScopedListCatalog(req);
      const body = buildChatListSyncResponse(getChatListSyncState(), catalog, {
        since: typeof q.since === 'string' ? q.since : undefined,
        scope,
        matcher,
        worktreeTodoIds: readLiveWorktreeTodoIds(),
      });
      if (body.mode === 'delta') body.archivedCounts = catalog.archivedCountsByWorkspace({ scope });
      res.json({ ok: true, ...body });
    } catch (err) {
      respondListError(err, res);
    }
  });

  app.get('/api/chats', async (req, res) => {
    try {
      const includeArchived = String(req.query?.includeArchived || '').trim() === '1';
      const includeSummaries = String(req.query?.includeSummaries || '').trim() === '1';
      /**
       * Optional server-side window for an archive expansion: when set together
       * with `includeArchived`, only that workspace's archived rows are added to
       * the live rows instead of returning every archived row in the index. A
       * single workspace expansion does not need ~1800 rows from all workspaces.
       * Absent this param the archived load is unchanged (full index).
       */
      const archiveWorkspace = normalizeChatWorkspaceScope(req.query?.archiveWorkspace);
      const listOpts = { includeSummaries };
      /**
       * One registry read marks every chat whose task tree owns a live worktree.
       * A corrupt registry must not blank the sidebar, so the read degrades to
       * "no markers" instead of failing the whole list.
       */
      const liveWorktreeTodoIds = (() => {
        try {
          return collectLiveWorktreeTodoIds(
            Object.values(readWorktreeRegistry({ dataDir: ctx.dataDir }).items),
          );
        } catch {
          return new Set();
        }
      })();
      /**
       * Map rows exactly as before, then append `harnessState` only to persisted
       * local transports. Built-in rows keep their existing JSON byte-for-byte
       * (same object reference) and a discovery failure degrades to a safe state
       * instead of turning the whole list into a 500.
       */
      const toClientChats = async (rows) => {
        const mapped = markWorktreeChats(mapChatsForClientList(rows, listOpts), liveWorktreeTodoIds);
        const transports = mapped.map((row) => (row && row.agentTransport));
        if (!transports.some((value) => isPersistedLocalChatTransport(value))) return mapped;
        let states = new Map();
        try {
          states = await resolvePersistedLocalChatStates(transports);
        } catch {
          states = new Map();
        }
        if (states.size === 0) return mapped;
        return mapped.map((row) => {
          if (!row || typeof row !== 'object') return row;
          const id = typeof row.agentTransport === 'string'
            ? row.agentTransport.trim().toLowerCase()
            : '';
          const harnessState = id ? states.get(id) : null;
          return harnessState ? { ...row, harnessState } : row;
        });
      };
      const pinnedToQuery = typeof req.query.pinnedTo === 'string' ? req.query.pinnedTo.trim() : '';
      const fullIndex = !req.widgetAccess && !pinnedToQuery && includeArchived && !archiveWorkspace;
      if (req.widgetAccess) {
        const installationChats = loadChats().filter((chat) => {
          if (chat.widgetInstallationId !== req.widgetAccess.installationId) return false;
          if (includeArchived) return true;
          return !chat.archivedAt;
        });
        const scopedChats = selectChatsForSidebarList(
          loadChats().filter((chat) => (
            chat.widgetInstallationId === req.widgetAccess.installationId
            && ctx.widgetChatListScope(chat, req.widgetAccess)
          )),
          { includeArchived },
        );
        const archivedCounts = countArchivedChatsByWorkspace(
          loadChats().filter((chat) => (
            chat.widgetInstallationId === req.widgetAccess.installationId
            && ctx.widgetChatListScope(chat, req.widgetAccess)
            && chat.archivedAt
          )),
        );
        if (pinnedToQuery) {
          const linkedChat = findChatPinnedToPageUrl(installationChats, pinnedToQuery);
          const mergedChats = linkedChat && !scopedChats.some((chat) => chat.id === linkedChat.id)
            ? [...scopedChats, linkedChat]
            : scopedChats;
          return res.json({
            ok: true,
            fullIndex: false,
            chats: await toClientChats(mergedChats),
            linkedChat: linkedChat ? (await toClientChats([linkedChat]))[0] : linkedChat,
            archivedCounts,
          });
        }
        return res.json({
          ok: true,
          fullIndex: false,
          chats: await toClientChats(scopedChats),
          archivedCounts,
        });
      }
      const allChats = loadChats();
      let chats = selectChatsForSidebarList(allChats, { includeArchived });
      if (includeArchived && archiveWorkspace) {
        // Window: keep every live row across all workspaces (so the sidebar tree
        // is never pruned by the replacement reconcile) and add only the archived
        // rows of the expanded workspace. archivedCounts stays global so closed
        // groups still show their count.
        const liveRows = selectChatsForSidebarList(allChats, { includeArchived: false });
        const seenIds = new Set(liveRows.map((chat) => chat?.id).filter(Boolean));
        const scopedArchived = allChats.filter((chat) => (
          chat && typeof chat === 'object'
          && isChatArchived(chat)
          && normalizeChatWorkspaceScope(chat.workspaceFile) === archiveWorkspace
          && !seenIds.has(chat.id)
        ));
        chats = [...liveRows, ...scopedArchived];
      }
      res.json({
        ok: true,
        fullIndex,
        chats: await toClientChats(chats),
        archivedCounts: countArchivedChatsByWorkspace(allChats),
      });
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
   * Omit `ids` to return revisions for every chat the caller may see (widget
   * scoped). Never dump the unscoped in-memory index — empty/overflow queries
   * used to leak other chats to widgets (431 header workaround).
   */
  app.get('/api/chats/history-revisions', (req, res) => {
    try {
      const chatIds = listScopedChatIds(req, ctx);
      res.json({
        ok: true,
        revisions: getChatHistoryRevisions(chatIds),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Keep in sync with MAX_POLL_REVISIONS_BATCH in chatHistorySyncPoll.js. One poll sends every monitored id in a single POST; ~40 B per id keeps 2000 ids well under the body limit. */
  const MAX_CHAT_REVISIONS_BATCH = 2000;

  /**
   * Explicit revision index batch. POST body must list ids — empty/missing ids is 400,
   * never "every chat".
   */
  app.post(
    '/api/chats/history-revisions-batch',
    express.json({ limit: '512kb' }),
    (req, res) => {
      try {
        const rawIds = req.body?.ids;
        if (!Array.isArray(rawIds) || rawIds.length === 0) {
          return res.status(400).json({ ok: false, error: 'ids required' });
        }
        if (rawIds.length > MAX_CHAT_REVISIONS_BATCH) {
          return res.status(400).json({ ok: false, error: 'ids batch too large' });
        }
        if (rawIds.every((id) => !String(id || '').trim())) {
          return res.status(400).json({ ok: false, error: 'ids required' });
        }
        const scopedIds = listExplicitScopedChatIds(req, ctx, rawIds);
        return res.json({
          ok: true,
          revisions: getChatHistoryRevisions(scopedIds),
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    },
  );

  /**
   * Lightweight agent presence for the chat list (busy / waiting / attention).
   * GET /api/chats/agent-states?ids=id1,id2
   * Omit `ids` to return non-idle rows for every chat the caller may see.
   * Missing listed chat id means idle.
   */
  app.get('/api/chats/agent-states', (req, res) => {
    try {
      const chatIds = listScopedChatIds(req, ctx);
      res.json({ ok: true, states: summarizeChatRunStates(chatIds) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Batch history delta. POST body must list chats explicitly — missing ids is 400,
   * never "every chat" (that fallback belongs only to history-revisions).
   * Widget callers are intersected with listScopedChatIds / widgetAccess.
   */
  app.post(
    '/api/chats/history-batch',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const rawChats = req.body?.chats;
        if (!Array.isArray(rawChats) || rawChats.length === 0) {
          return res.status(400).json({ ok: false, error: 'chats required' });
        }
        const requestedIds = rawChats.map((row) => row?.id);
        if (requestedIds.every((id) => !String(id || '').trim())) {
          return res.status(400).json({ ok: false, error: 'chats required' });
        }
        const scopedIds = listExplicitScopedChatIds(req, ctx, requestedIds);
        return res.json({
          ok: true,
          histories: await readChatHistoryBatch(rawChats, scopedIds),
        });
      } catch (err) {
        return sendHistoryError(res, err);
      }
    },
  );

  /**
   * Pull chat history (append-only log with server seq).
   * GET /api/chats/:id/history?since=<seq>&limit=<n>        — forward delta sync
   * GET /api/chats/:id/history?tail=<n>[&before=<seq>]      — backwards window pagination
   */
  app.get('/api/chats/:id/history', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });

      return res.json(await readChatHistoryFromHttpQuery(req.params.id, req.query));
    } catch (err) {
      return sendHistoryError(res, err);
    }
  });

  /**
   * Push event batch to history log (server assigns seq, idempotent by clientSeq).
   * POST /api/chats/:id/history  body: { cursorSessionId, events: [{ rec, clientSeq? }] }
   */
  app.post(
    '/api/chats/:id/history',
    express.json({ limit: '32mb' }),
    async (req, res) => {
      try {
        const chats = loadChats();
        const chat = chats.find((c) => c.id === req.params.id);
        if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
        const generationError = checkExternalRestoreGeneration(ctx.restoreGate, req.body?.restoreGeneration);
        if (generationError) return res.status(generationError.status).json(generationError.body);
        const cursorSessionId = typeof req.body?.cursorSessionId === 'string' ? req.body.cursorSessionId : '';
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        const items = events
          .map((e) => (e && typeof e === 'object' ? { rec: e.rec, clientSeq: typeof e.clientSeq === 'number' ? e.clientSeq : undefined } : null))
          .filter(Boolean);
        // Browser queue identity (SQLite backend; the legacy backend ignores it): the producer namespaces the
        // client sequence numbers, `chatEpoch` pins the chat generation the queue was built against and
        // `retryToken` re-drives an earlier uncertain attempt with the SAME events.
        const callOptions = {};
        if (typeof req.body?.queueProducerId === 'string' && req.body.queueProducerId) callOptions.queueProducerId = req.body.queueProducerId;
        if (typeof req.body?.datasetGeneration === 'string' && req.body.datasetGeneration) callOptions.datasetGeneration = req.body.datasetGeneration;
        if (typeof req.body?.chatEpoch === 'string' && req.body.chatEpoch) callOptions.chatEpoch = req.body.chatEpoch;
        if (typeof req.body?.retryToken === 'string' && req.body.retryToken) callOptions.retryToken = req.body.retryToken;
        const result = await appendChatHistoryEvents(req.params.id, cursorSessionId, items, callOptions);
        if (!result.ok) return res.status(result.code === 'history_unnamespaced_input' ? 409 : 400).json(result);
        res.json(result);
      } catch (err) {
        return sendHistoryError(res, err);
      }
    },
  );

  /**
   * Cascade delete history (also invoked from deleteChat).
   * DELETE /api/chats/:id/history
   */
  app.delete('/api/chats/:id/history', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const generationError = checkExternalRestoreGeneration(ctx.restoreGate, req.query?.restoreGeneration);
      if (generationError) return res.status(generationError.status).json(generationError.body);
      const deleteOptions = {};
      if (typeof req.query?.retryToken === 'string' && req.query.retryToken) deleteOptions.retryToken = req.query.retryToken;
      if (typeof req.query?.datasetGeneration === 'string' && req.query.datasetGeneration) deleteOptions.datasetGeneration = req.query.datasetGeneration;
      await deleteChatHistory(req.params.id, Object.keys(deleteOptions).length > 0 ? deleteOptions : undefined);
      res.json({ ok: true });
    } catch (err) {
      return sendHistoryError(res, err);
    }
  });

  /**
   * Debug status parser for a chat:
   * - returns last tail of active agent session buffer
   * - returns parseTerminalInteraction + resolveTerminalState result
   */
  app.get('/api/chats/:id/status-tail', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (chat.agentTransport === 'sdk' || builtinProviderForChat(chat)?.historyStatusTail === true) {
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
      if (rawHarnessTransportKind(chat.agentTransport) === 'local') {
        const limitRaw = Number.parseInt(String(req.query?.limit || '4000'), 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 200), 32000) : 4000;
        let harnessState = null;
        try {
          harnessState = await resolvePersistedLocalChatState(chat.agentTransport);
        } catch {
          harnessState = null;
        }
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
          harnessState,
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

  app.get('/api/chats/:id/diag', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((c) => c.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const cursorSessionId = chat.cursorSessionId || '';
      const chatProvider = builtinProviderForChat(chat);
      /** @type {Record<string, any>} */
      const room = !cursorSessionId
        ? null
        : chat.agentTransport === 'sdk'
          ? getSdkRoomDiag(cursorSessionId)
          : chatProvider
            ? chatProvider.room.getDiag(cursorSessionId)
            : null;
      const historyStats = await collectChatHistoryContextStats(chat.id);
      const localStoreStats = await collectSdkLocalStoreStats(cursorSessionId);
      /** @type {Record<string, any>} */
      const codexContext = chat.agentTransport === 'codex' && chat.codexThreadId
        ? readCodexContextUsage({ homeDir: resolveCodexHomeDir(), threadId: chat.codexThreadId, model: chat.model || '' }) ?? historyStats?.lastContextUsage ?? null
        : null;
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
        ...(chat.agentTransport === 'codex' ? {
          modelId: codexContext?.model || chat.model,
          contextWindowTokens: codexContext?.contextWindowTokens,
          lastUsageInputTokens: codexContext?.usage?.totalTokens,
          maxUsageInputTokens: null,
          rawLastUsageInputTokens: codexContext?.usage?.inputTokens,
          rawMaxUsageInputTokens: null,
        } : {}),
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
          codex: codexContext,
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
      const cwd = resolveExecutionFolderForChat(chat, ctx.workspaceDirForAgent);
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
        if (rawHarnessTransportKind(chat.agentTransport) === 'local' && chat.cursorSessionId) {
          disposeLocalHarnessSession(chat.agentTransport, chat.cursorSessionId);
          return res.json({ ok: true, chatId: chat.id, cursorSessionId: chat.cursorSessionId });
        }
        const chatProvider = builtinProviderForChat(chat);
        if (chatProvider && chat.cursorSessionId) {
          chatProvider.room.dispose(chat.cursorSessionId);
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
      /** @type {Record<string, any>} */
      const createHarness = await classifyCreateHarness(req.body?.agentTransport);
      if (!createHarness.ok) {
        return res.status(createHarness.status || 400).json({
          ok: false,
          error: createHarness.error,
          code: createHarness.code,
        });
      }
      const agentTransport = createHarness.harness;
      if (createHarness.source === 'local') {
        // The guard already loaded and verified the local plugin's entry
        // contract and hostMin; no vendor credential applies to it.
      } else if (getBuiltinHarnessProvider(agentTransport)) {
        const notReady = await getBuiltinHarnessProvider(agentTransport)?.checkCreateReady({
          resolveWorkspaceFolder: () => {
            const workspaceFile = req.widgetAccess?.workspaceFile
              || (req.body && req.body.workspaceFile)
              || ctx.getCurrentWorkspaceFile();
            return req.widgetAccess?.workspaceFolder
              || (req.body && req.body.workspaceFolder)
              || ctx.workspaceDirForAgent(workspaceFile);
          },
        });
        if (notReady) return res.status(503).json({ ok: false, error: notReady });
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
      const model = resolveTodoStartModel(
        agentTransport,
        req.widgetAccess?.model || (req.body && req.body.model),
        ctx.agentModel,
      );
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
        createHarness.source === 'local'
          ? `${createHarness.label || 'Local'} chat ${loadChats().length + 1}`
          : `${getBuiltinHarnessProvider(agentTransport)?.chatTitlePrefix ?? 'SDK'} chat ${loadChats().length + 1}`;
      const chatTitle = (req.body && req.body.title) || defaultTitle;
      const sdkMode = req.body && req.body.sdkMode;
      // A chat may join a live task worktree. The client only names the
      // root todo; the execution folder always comes from the registry.
      const worktreeTodoId = String(req.body?.worktreeTodoId || '').trim();
      const worktreeExtras = {};
      if (worktreeTodoId) {
        const record = getWorktreeRecord(worktreeTodoId, { dataDir: ctx.dataDir });
        if (!record || !isWorktreeRecordLive(record) || !record.worktreePath) {
          return res.status(400).json({ ok: false, error: 'The worktree is no longer available.' });
        }
        const recordFolder = path.resolve(String(record.workspaceFolder || ''));
        if (workspaceFolder && path.resolve(String(workspaceFolder)) !== recordFolder) {
          return res.status(400).json({
            ok: false,
            error: 'The worktree belongs to a different workspace folder.',
          });
        }
        worktreeExtras.executionFolder = record.worktreePath;
        worktreeExtras.todoId = record.todoId;
      }
      const newChat = addChat(sessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
        ...worktreeExtras,
        agentTransport,
        localHarnessTransport: createHarness.source === 'local',
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
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/fork', async (req, res) => {
    let chat = null;
    try {
      const parentChat = loadChats().find((entry) => entry.id === req.params.id);
      if (!parentChat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      // Local harness plugins have no fork/resume contract in this slice. Reject
      // explicitly instead of silently normalizing the id down to the SDK.
      if (
        rawHarnessTransportKind(parentChat.agentTransport) === 'local'
        || rawHarnessTransportKind(req.body?.agentTransport) === 'local'
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Forking a local harness chat is not supported',
          code: 'local_harness_fork_unsupported',
        });
      }
      const forked = await executeConversationFork({
        parentChat,
        message: typeof req.body?.message === 'string' ? req.body.message : '',
        analyze: req.body?.analyze === true,
        mode: req.body?.mode,
        sourceText: typeof req.body?.sourceText === 'string' ? req.body.sourceText : '',
        upToCreatedAt: typeof req.body?.upToCreatedAt === 'string' ? req.body.upToCreatedAt : '',
        workspaceFile: typeof req.body?.workspaceFile === 'string' ? req.body.workspaceFile : '',
        workspaceFolder: typeof req.body?.workspaceFolder === 'string' ? req.body.workspaceFolder : '',
        title: typeof req.body?.title === 'string' ? req.body.title : '',
        model: typeof req.body?.model === 'string' ? req.body.model : '',
        agentTransport: typeof req.body?.agentTransport === 'string' ? req.body.agentTransport : '',
        copyFailedMessage: msg(req, 'chat.forkCopyHistoryFailed'),
      });
      chat = forked.chat;
      return res.json({
        ok: true,
        chat: forked.chat,
        initialPrompt: forked.initialPrompt,
      });
    } catch (err) {
      if (err instanceof ConversationForkError) {
        return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
      }
      if (chat?.id) {
        try {
          await deleteChat(chat.id);
        } catch (_) {}
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Opt-in "New chat with summary": one cheap-model call, only on explicit click. A summary
  // failure still creates a plain reference chat and reports `summaryFallback` for the UI.
  app.post('/api/chats/:id/fork-with-summary', async (req, res) => {
    try {
      if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const parentChat = loadChats().find((entry) => entry.id === req.params.id);
      if (!parentChat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (rawHarnessTransportKind(parentChat.agentTransport) === 'local') {
        return res.status(400).json({
          ok: false,
          error: 'Forking a local harness chat is not supported',
          code: 'local_harness_fork_unsupported',
        });
      }
      const body = req.body || {};
      const str = (value) => (typeof value === 'string' ? value : '');
      const forked = await executeSummaryFork({
        parentChat,
        message: str(body.message),
        fork: {
          workspaceFile: str(body.workspaceFile),
          workspaceFolder: str(body.workspaceFolder),
          title: str(body.title),
          model: str(body.model),
          agentTransport: str(body.agentTransport),
          copyFailedMessage: msg(req, 'chat.forkCopyHistoryFailed'),
        },
        deps: {
          checkGate: createProductionGate(buildChatCacheView, ctx.dataDir),
          ...(ctx.summaryForkDeps || {}),
        },
      });
      return res.json({
        ok: true,
        chat: forked.chat,
        initialPrompt: forked.initialPrompt,
        summarized: forked.summarized,
        summaryFallback: forked.summaryFallback,
      });
    } catch (err) {
      if (err instanceof ConversationForkError) {
        return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // One-off backfill for placeholder titles. Dry-run is the default; writing needs apply === true
  // in the JSON body (a query string / truthy string is not enough).
  app.post('/api/chats/backfill-titles', async (req, res) => {
    try {
      const body = req.body || {};
      const report = await runChatTitleBackfill({
        apply: body.apply === true,
        propose: body.propose === true,
        limit: body.limit,
      });
      res.json({ ok: true, ...report });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/chats/:id/title-history', (req, res) => {
    /** @type {Record<string, any>} */
    const chat = readChatCatalog().get(req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
    res.json({
      ok: true,
      chatId: chat.id,
      title: chat.title || '',
      titleSource: chat.titleSource || '',
      history: getChatTitleHistory(chat.id),
    });
  });

  // Explicit regenerate: force bypasses the manual lock, the throttle and the 'off' mode.
  app.post('/api/chats/:id/regenerate-title', async (req, res) => {
    try {
      const chat = loadChats().find((row) => row.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const result = await getChatTitleService().requestTitle(chat.id, {
        reason: 'regenerate',
        force: true,
      });
      const current = loadChats().find((row) => row.id === chat.id) || chat;
      const payload = { ok: result.status === 'applied', ...result, chat: current };
      if (result.status === 'applied') return res.json(payload);
      const httpStatus = result.reason === 'no_generator' ? 503 : (result.status === 'error' ? 502 : 200);
      return res.status(httpStatus).json(payload);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Agent-set title (MCP chat_set_title): same sanitizer/CAS/lock as the server generator.
  app.post('/api/chats/:id/agent-title', (req, res) => {
    try {
      const result = applyAgentTitle(req.params.id, req.body?.title);
      const status = result.reason === 'not_found' ? 404 : 200;
      return res.status(status).json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/title-lock', (req, res) => {
    const chat = setChatTitleLocked(req.params.id, req.body?.locked === true);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
    res.json({ ok: true, chat });
  });

  app.patch('/api/chats/:id', async (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      delete body.sdkAgentId;
      // Title provenance is decided by the server only (a PATCH title is always 'manual').
      delete body.titleSource;
      delete body.titleHistory;
      delete body.titleRev;
      // The execution folder is resolved server-side from the authorized
      // chat/TODO context; a client must not set an arbitrary runner cwd.
      delete body.executionFolder;
      if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
        body.archived = body.archived === true;
      }
      const chat = updateChat(req.params.id, body);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (Object.prototype.hasOwnProperty.call(body, 'archived') && Boolean(chat.archivedAt) === body.archived) {
        void publishChatLifecycleNotification({
          chatId: chat.id,
          chatTitle: chat.title,
          action: body.archived ? 'archived' : 'restored',
        }).catch(() => {});
      }
      if (Object.prototype.hasOwnProperty.call(body, 'forkParentChatId')) {
        const parentId = String(chat.forkParentChatId || '').trim();
        const parent = parentId ? loadChats().find((row) => row.id === parentId) : null;
        if (parent) {
          await appendRelatedChatHistoryLinks({
            parentChat: parent,
            childChat: chat,
            reason: 'nested',
          });
        }
      }
      if (typeof body.model === 'string' && chat.cursorSessionId) {
        if (chat.agentTransport === 'sdk') {
          syncSdkRoomModelFromChat(chat.cursorSessionId, body.model);
        } else {
          builtinProviderForChat(chat)?.room.syncModel?.(chat.cursorSessionId, body.model);
        }
      }
      res.json({ ok: true, chat });
    } catch (err) {
      const message = String(err?.message || '');
      if (err?.code === 'parent_archived') {
        return res.status(409).json({ ok: false, error: message, code: err.code });
      }
      if (err?.code === 'CHAT_ARCHIVE_BUSY') {
        return res.status(409).json({
          ok: false,
          error: message,
          code: 'CHAT_ARCHIVE_BUSY',
          chatId: String(err.chatId || ''),
        });
      }
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

  // Marks the chat's latest finished run as read (sidebar "finished" check turns grey).
  app.post('/api/chats/:id/seen', (req, res) => {
    /** @type {Record<string, any>} */
    const chat = readChatCatalog().get(req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
    const finishedAt = String(chat.lastFinishedAt || '');
    const seenAt = String(chat.lastSeenAt || '');
    // Nothing unread: skip the write and the broadcast.
    if (!finishedAt || (seenAt && seenAt >= finishedAt)) {
      return res.json({ ok: true, lastFinishedAt: finishedAt, lastSeenAt: seenAt });
    }
    const next = markChatReadState(chat.id, { seenAt: new Date().toISOString() });
    res.json({
      ok: true,
      lastFinishedAt: next?.lastFinishedAt || finishedAt,
      lastSeenAt: next?.lastSeenAt || seenAt,
    });
  });

  app.post('/api/chats/:id/reset-sdk-context', (req, res) => {
    try {
      const chats = loadChats();
      const current = chats.find((entry) => entry.id === req.params.id);
      if (!current) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (current.agentTransport !== 'sdk') {
        return res.status(400).json({ ok: false, error: 'Reset context is available only for SDK chats' });
      }
      // Automatic compression must never cut into a live run; manual reset keeps its force semantics.
      if (req.body?.auto === true && current.cursorSessionId) {
        const diag = getSdkRoomDiag(current.cursorSessionId);
        if (diag && diag.busy) {
          return res.status(409).json({ ok: false, code: 'run_active', error: 'A run is active; context reset deferred' });
        }
      }
      // Rotate first (single atomic save; chat history is keyed by chat id and untouched), then dispose
      // the old room: if the rotation throws, the old session and history are still intact.
      const chat = rotateChatSdkSession(req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      if (current.cursorSessionId) {
        disposeSdkRoom(current.cursorSessionId);
      }
      return res.json({ ok: true, chat });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/chats/:id/sync-todo-plan', async (req, res) => {
    try {
      const chats = loadChats();
      const chat = chats.find((entry) => entry.id === req.params.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const cwd = resolveSdkCwdForChat(chat, ctx.workspaceDirForAgent);
      if (!cwd) {
        return res.status(400).json({ ok: false, error: 'Missing workspace folder for Todo sync' });
      }
      const approved = req.body?.approved === true;
      const synced = await syncTodoAfterSdkRunFinished({
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
      const todo = todoId ? await getTodoById(ctx.dataDir, cwd, todoId) : null;
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
      const generationError = checkExternalRestoreGeneration(ctx.restoreGate, req.query?.restoreGeneration);
      if (generationError) return res.status(generationError.status).json(generationError.body);
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
            await exportTodoPlanFromChat({ dataDir: ctx.dataDir, cwd, chat: doomed });
            await updateTodo(ctx.dataDir, cwd, doomed.todoId, {
              chatId: null,
              status: 'ready',
              linkedChatId: doomed.id,
            });
          }
        } catch (_) {}
      }
      if (doomed?.agentTransport === 'sdk' && doomed.cursorSessionId) {
        disposeSdkRoom(doomed.cursorSessionId);
      } else if (builtinProviderForChat(doomed) && doomed.cursorSessionId) {
        builtinProviderForChat(doomed)?.room.dispose(doomed.cursorSessionId);
      } else if (rawHarnessTransportKind(doomed?.agentTransport) === 'local' && doomed.cursorSessionId) {
        // Idempotent best-effort: a plugin that is no longer loaded is a no-op.
        disposeLocalHarnessSession(doomed.agentTransport, doomed.cursorSessionId);
      }
      await deleteChat(req.params.id, typeof req.query?.retryToken === 'string' && req.query.retryToken ? { retryToken: req.query.retryToken } : undefined);
      void publishChatLifecycleNotification({
        chatId: doomed.id,
        chatTitle: doomed.title,
        action: 'deleted',
      }).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      return sendHistoryError(res, err);
    }
  });
}
