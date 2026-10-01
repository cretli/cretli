import { randomUUID } from 'crypto';
import path from 'path';
import { loadChats, addChat, updateChat } from '../persist/chats-persist.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { buildTodoChatIndex, enrichTodoItemsWithSourceChat, resolveTodoChats } from '../todo-source-chat.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import {
  addTodo,
  deleteTodo,
  getTodoById,
  linkTodoChat,
  loadTodosData,
  TODOS_MAX_ITEMS,
  updateTodo,
} from '../persist/todos-persist.js';
import { buildTodoAgentInitialPrompt } from '../todo-agent.js';
import { msg } from '../messages.js';

/**
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: unknown[] }} data
 */
function jsonTodosPayload(cwd, data) {
  const chatIndex = buildTodoChatIndex(loadChats(), { workspaceFolder: cwd });
  return {
    ok: true,
    cwd,
    version: data.version,
    updatedAt: data.updatedAt,
    items: enrichTodoItemsWithSourceChat(data.items, chatIndex, cwd),
  };
}

/**
 * Explicit null (clear / move to root) must survive; `??` would drop it.
 *
 * @param {Record<string, unknown>} body
 * @param {string} camelKey
 * @param {string} snakeKey
 * @returns {unknown}
 */
function readBodyAlias(body, camelKey, snakeKey) {
  if (body[camelKey] !== undefined) return body[camelKey];
  return body[snakeKey];
}

function jsonTodosError(req, res, err) {
  const code = err && err.code;
  if (code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: msg(req, 'todo.notFound') });
  }
  if (code === 'LIMIT') {
    return res.status(422).json({ ok: false, error: msg(req, 'todo.limitReached', { n: TODOS_MAX_ITEMS }) });
  }
  if (code === 'CONFLICT') {
    return res.status(409).json({
      ok: false,
      error: err.message || 'Conflict',
      conflict: true,
      currentUpdatedAt: err.currentUpdatedAt,
    });
  }
  if (code === 'VALIDATION') {
    return res.status(400).json({ ok: false, error: err.message || msg(req, 'todo.titleRequired') });
  }
  if (code === 'NO_WORKSPACE') {
    return res.status(400).json({ ok: false, error: msg(req, 'files.noWorkspace') });
  }
  return res.status(500).json({ ok: false, error: err.message || msg(req, 'todo.saveError') });
}

/**
 * @typedef {Object} TodosRoutesContext
 * @property {string} dataDir
 * @property {() => string} getCurrentCwd
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {string} agentModel
 * @property {() => string} getLocalCallbackBaseUrl
 * @property {boolean} useHttps
 */

/**
 * @param {import('express').Express} app
 * @param {TodosRoutesContext} ctx
 */
export function registerTodosRoutes(app, ctx) {
  function todosCwd(req) {
    const explicit = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
    if (explicit) return path.resolve(explicit);
    return ctx.getCurrentCwd();
  }

  /** Todo list for current CWD (JSON in data/todos on server). */
  app.get('/api/todos', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const data = loadTodosData(ctx.dataDir, cwd);
      return res.json(jsonTodosPayload(cwd, data));
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.post('/api/todos', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      const data = addTodo(ctx.dataDir, cwd, {
        title: body.title,
        body: body.body,
        status: body.status,
        idempotencyKey: body.idempotencyKey || body.idempotency_key,
        strictStatus: body.strictStatus === true,
        parentId: body.parentId ?? body.parent_id,
        siblingIndex: body.siblingIndex ?? body.sibling_index,
        assignee: body.assignee,
        runMode: body.runMode ?? body.run_mode,
        orchestratorChatId: body.orchestratorChatId ?? body.orchestrator_chat_id,
        createdByChatId: body.createdByChatId ?? body.created_by_chat_id,
        sourceHarness: body.sourceHarness ?? body.source_harness,
      });
      return res.json({
        ...jsonTodosPayload(cwd, data),
        item: data.item,
        replayed: data.replayed === true,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.patch('/api/todos/:id', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      const body = req.body || {};
      const data = updateTodo(ctx.dataDir, cwd, id, {
        title: body.title,
        body: body.body,
        status: body.status,
        chatId: body.chatId,
        plan: body.plan,
        appendChangelog: body.appendChangelog,
        linkedChatId: body.linkedChatId,
        sourceHarness: body.sourceHarness,
        expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
        strictStatus: body.strictStatus === true,
        parentId: readBodyAlias(body, 'parentId', 'parent_id'),
        siblingIndex: readBodyAlias(body, 'siblingIndex', 'sibling_index'),
        assignee: body.assignee,
        runMode: readBodyAlias(body, 'runMode', 'run_mode'),
        orchestratorChatId: readBodyAlias(body, 'orchestratorChatId', 'orchestrator_chat_id'),
      });
      return res.json({
        ...jsonTodosPayload(cwd, data),
        item: data.items.find((row) => row.id === id) || null,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.delete('/api/todos/:id', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      const { doc, removedItems } = deleteTodo(ctx.dataDir, cwd, id);
      // Plan sync links chat -> todo without setting todo.chatId, so unlink by
      // both directions.
      const removedIds = new Set((removedItems || []).map((row) => String(row?.id || '')));
      const chatIds = new Set((removedItems || []).map((row) => row?.chatId).filter(Boolean));
      loadChats().forEach((chat) => {
        if (removedIds.has(String(chat?.todoId || ''))) chatIds.add(chat.id);
      });
      chatIds.forEach((chatId) => updateChat(chatId, { todoId: null }));
      return res.json(jsonTodosPayload(cwd, doc));
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Creates (or reopens existing) agent chat linked to a Todo.
   * Optional body: workspaceFile, workspaceFolder, model, agentTransport ('sdk'),
   * sdkMode, forceNew (always create a fresh chat instead of reusing todo.chatId).
   */
  app.post('/api/todos/:id/start-agent', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const todoId = req.params.id;
      let todo = getTodoById(ctx.dataDir, cwd, todoId);
      if (!todo) {
        return res.status(404).json({ ok: false, error: msg(req, 'todo.notFound') });
      }
      const body = req.body || {};
      const forceNew = body.forceNew === true;
      let reused = false;
      /** @type {ReturnType<typeof addChat> | null} */
      let chat = null;
      // Previous chats for this todo, captured before a new chat is linked so
      // the prompt can point the fresh agent at the earlier context.
      const previousChats = resolveTodoChats(
        todo,
        buildTodoChatIndex(loadChats(), { workspaceFolder: cwd })
      )
        .filter((entry) => !entry.deleted)
        .slice(0, 20)
        .map((entry) => ({ id: entry.id, title: entry.title, roles: entry.roles }));
      if (todo.chatId && !forceNew) {
        chat = loadChats().find((c) => c.id === todo.chatId) || null;
        if (chat) {
          reused = true;
        } else {
          const unlinked = updateTodo(ctx.dataDir, cwd, todoId, { chatId: null });
          todo = unlinked.items.find((it) => it.id === todoId) || todo;
        }
      }
      if (!chat) {
        const previousChatId = String(todo.chatId || '').trim();
        const assignee = todo.assignee && typeof todo.assignee === 'object' ? todo.assignee : null;
        const transport = normalizeAgentTransport(
          body.agentTransport || assignee?.harness || todo.sourceHarness
        );
        if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
          return res.status(503).json({
            ok: false,
            error: msg(req, 'sdk.noApiKey'),
          });
        }
        const workspaceFile = body.workspaceFile || ctx.getCurrentWorkspaceFile();
        const workspaceFolder = body.workspaceFolder || null;
        const model = (body.model || assignee?.model || ctx.agentModel || '').trim();
        const chatTitle = (`[Todo] ${todo.title || 'Task'}`).slice(0, 120);
        const sdkSessionKey = randomUUID();
        const hasPersistedPlan =
          !!(todo.plan && typeof todo.plan === 'object' && String(todo.plan.markdown || '').trim());
        const roleSdkMode = { plan: 'plan', implement: 'agent' }[assignee?.role];
        const defaultSdkMode = roleSdkMode || (hasPersistedPlan ? 'agent' : 'plan');
        chat = addChat(sdkSessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
          agentTransport: transport,
          sdkMode: body.sdkMode || defaultSdkMode,
          sdkUiMode: body.sdkUiMode,
          todoId,
        });
        // A new chat only moves an unfinished todo to doing; a done item is
        // never silently reopened (the UI asks first).
        const shouldSetDoing = todo.status === 'idea' || todo.status === 'ready';
        if (forceNew && previousChatId && previousChatId !== chat.id) {
          // Keep the replaced executor in the visible history even when it was
          // only reachable through the single chatId field (legacy data).
          const stillExists = loadChats().some((row) => row.id === previousChatId);
          if (stillExists) linkTodoChat(ctx.dataDir, cwd, todoId, previousChatId);
        }
        const linked = updateTodo(ctx.dataDir, cwd, todoId, {
          ...(shouldSetDoing ? { status: 'doing' } : {}),
          chatId: chat.id,
          linkedChatId: chat.id,
          sourceHarness: transport,
        });
        todo = linked.items.find((it) => it.id === todoId) || todo;
      }
      const baseUrl = ctx.getLocalCallbackBaseUrl();
      const priorChats = previousChats.filter((entry) => entry.id !== chat.id);
      const initialPrompt = buildTodoAgentInitialPrompt(todo, chat.id, baseUrl, {
        insecureTls: ctx.useHttps,
        previousChats: priorChats,
      });
      const data = loadTodosData(ctx.dataDir, cwd);
      return res.json({
        ...jsonTodosPayload(cwd, data),
        reused,
        forceNew,
        chat,
        todo,
        initialPrompt,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });
}
