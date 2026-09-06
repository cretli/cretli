import { randomUUID } from 'crypto';
import path from 'path';
import { loadChats, addChat, updateChat } from '../persist/chats-persist.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { enrichTodoItemsWithSourceChat } from '../todo-source-chat.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import {
  addTodo,
  deleteTodo,
  getTodoById,
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
  return {
    ok: true,
    cwd,
    version: data.version,
    updatedAt: data.updatedAt,
    items: enrichTodoItemsWithSourceChat(data.items, loadChats(), cwd),
  };
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
      const { doc, removed } = deleteTodo(ctx.dataDir, cwd, id);
      if (removed?.chatId) {
        updateChat(removed.chatId, { todoId: null });
      }
      return res.json(jsonTodosPayload(cwd, doc));
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Creates (or reopens existing) agent chat linked to a Todo.
   * Optional body: workspaceFile, workspaceFolder, model, agentTransport ('sdk'), sdkMode.
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
      let reused = false;
      /** @type {ReturnType<typeof addChat> | null} */
      let chat = null;
      if (todo.chatId) {
        chat = loadChats().find((c) => c.id === todo.chatId) || null;
        if (chat) {
          reused = true;
        } else {
          const unlinked = updateTodo(ctx.dataDir, cwd, todoId, { chatId: null });
          todo = unlinked.items.find((it) => it.id === todoId) || todo;
        }
      }
      if (!chat) {
        const transport = normalizeAgentTransport(body.agentTransport || todo.sourceHarness);
        if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
          return res.status(503).json({
            ok: false,
            error: msg(req, 'sdk.noApiKey'),
          });
        }
        const workspaceFile = body.workspaceFile || ctx.getCurrentWorkspaceFile();
        const workspaceFolder = body.workspaceFolder || null;
        const model = (body.model || ctx.agentModel || '').trim();
        const chatTitle = (`[Todo] ${todo.title || 'Task'}`).slice(0, 120);
        const sdkSessionKey = randomUUID();
        const hasPersistedPlan =
          !!(todo.plan && typeof todo.plan === 'object' && String(todo.plan.markdown || '').trim());
        const defaultSdkMode = hasPersistedPlan ? 'agent' : 'plan';
        chat = addChat(sdkSessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
          agentTransport: transport,
          sdkMode: body.sdkMode || defaultSdkMode,
          sdkUiMode: body.sdkUiMode,
          todoId,
        });
        const linked = updateTodo(ctx.dataDir, cwd, todoId, {
          status: 'doing',
          chatId: chat.id,
          linkedChatId: chat.id,
          sourceHarness: transport,
        });
        todo = linked.items.find((it) => it.id === todoId) || todo;
      }
      const baseUrl = ctx.getLocalCallbackBaseUrl();
      const initialPrompt = buildTodoAgentInitialPrompt(todo, chat.id, baseUrl, {
        insecureTls: ctx.useHttps,
      });
      const data = loadTodosData(ctx.dataDir, cwd);
      return res.json({
        ...jsonTodosPayload(cwd, data),
        reused,
        chat,
        todo,
        initialPrompt,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });
}
