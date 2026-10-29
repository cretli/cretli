import { randomUUID } from 'crypto';
import { registerTodoHomeGuard, resolveRequestTodoHome } from '../todo-home-http.js';
import path from 'path';
import { addChat } from '../persist/chats-persist.js';
import { linkTodoChat } from '../persist/todos-store.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { resolveTodoStartModel } from './resolve-start-model.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.ts';
import { clearIntegrationLock, getIntegrationLock } from '../integration-lock.js';
import {
  abandonIntegrateBatch,
  attachBatchChat,
  cancelIntegrateBatch,
  createIntegrateBatch,
  handleBatchNext,
  listIntegrateBatches,
  readIntegrateBatch,
  recoverIntegrateBatchesOnStartup,
  resumeIntegrateBatch,
} from '../integrate-batch.js';
import { msg } from '../messages.js';
import { setBuiltinMcpRuntimeDeps } from '../mcp/builtin/runtime-deps.js';

/** Reasons that mean "state conflict" rather than "bad request". */
const CONFLICT_REASONS = new Set([
  'integration_locked', 'busy', 'not_active', 'not_resumable', 'agent_busy', 'liveness_unknown',
  'boundary_unsafe', 'batch_owned',
]);

/**
 * @param {string} reason
 * @returns {number}
 */
function statusForReason(reason) {
  if (reason === 'not_found' || reason === 'no_lock') return 404;
  if (reason === 'empty') return 422;
  if (CONFLICT_REASONS.has(reason)) return 409;
  return 500;
}

/**
 * Bulk integrate routes. Registered before the `/api/todos/:id/*` family so the
 * literal `integrate-batch` segment is never captured as a todo id.
 *
 * @param {import('express').Express} app
 * @param {{
 *   dataDir: string,
 *   getCurrentCwd: () => string,
 *   getCurrentWorkspaceFile: () => string,
 *   agentModel?: string,
 *   getLocalCallbackBaseUrl: () => string,
 *   useHttps?: boolean,
 *   worktreeDeps?: object,
 *   verifyAgentCallback?: (req: object) => boolean,
 *   probeChatRunLiveness?: (input: { chatId: string, runId?: string }) => object,
 * }} ctx
 */
export function registerIntegrateBatchRoutes(app, ctx) {
  registerTodoHomeGuard(app, '/api/todos/integrate-batch');
  registerTodoHomeGuard(app, '/api/integration-lock');
  registerTodoHomeGuard(app, '/api/integrate-batch');
  const deps = /** @type {import('../integrate-batch.js').BatchDeps} */ (/** @type {unknown} */ ({
    probeChatRunLiveness: ctx.probeChatRunLiveness,
    worktreeDeps: ctx.worktreeDeps,
  }));
  // The MCP twin of `next` (integrate_next) must dispatch with the same deps.
  setBuiltinMcpRuntimeDeps({ integrateBatchDeps: deps });

  /**
   * @param {import('express').Request} req
   * @returns {string}
   */
  function workspaceOf(req) {
    return resolveRequestTodoHome(req, ctx.getCurrentCwd());
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ reason?: string, [key: string]: unknown }} failure
   */
  function sendFailure(req, res, failure) {
    const reason = String(failure.reason || 'failed');
    const { reason: _drop, ok: _ok, ...rest } = failure;
    return res.status(statusForReason(reason)).json({
      ok: false,
      error: reason,
      message: msg(req, `integrate.${reason}`),
      ...rest,
    });
  }

  /**
   * Create a chat for a batch and bind it (and the lock) to it.
   *
   * @param {import('express').Request} req
   * @param {string} workspaceFolder
   * @param {string} title
   * @returns {{ chat: Record<string, any> } | { error: { status: number, body: Record<string, any> } }}
   */
  function createBatchChat(req, workspaceFolder, title) {
    const body = req.body || {};
    const transport = normalizeAgentTransport(body.agentTransport);
    if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
      return { error: { status: 503, body: { ok: false, error: msg(req, 'sdk.noApiKey') } } };
    }
    const model = resolveTodoStartModel(transport, body.model, ctx.agentModel);
    const chat = addChat(randomUUID(), title, body.workspaceFile || ctx.getCurrentWorkspaceFile(), workspaceFolder || null, model || undefined, {
      agentTransport: transport,
      sdkMode: 'agent',
    });
    return { chat };
  }

  app.post('/api/todos/integrate-batch', async (req, res) => {
    try {
      const cwd = workspaceOf(req);
      const body = req.body || {};
      const transport = normalizeAgentTransport(body.agentTransport);
      if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
        return res.status(503).json({ ok: false, error: msg(req, 'sdk.noApiKey') });
      }
      const created = await createIntegrateBatch({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoIds: Array.isArray(body.todoIds) ? body.todoIds : [],
        baseUrl: ctx.getLocalCallbackBaseUrl(),
        insecureTls: ctx.useHttps,
        deps,
      });
      if (!created.ok) {
        return sendFailure(req, res, { reason: created.reason, skipped: created.skipped || [], lock: created.lock || null });
      }
      const title = `[Integrate] ${created.batch.entries.length} todo${created.batch.entries.length === 1 ? '' : 's'}`;
      let chat;
      try {
        /** @type {Record<string, any>} */
        const made = createBatchChat(req, cwd, title);
        if (made.error) throw Object.assign(new Error('chat_unavailable'), { response: made.error });
        chat = made.chat;
      } catch (error) {
        // No chat means no agent: give the lock back instead of stranding it.
        await abandonIntegrateBatch({ dataDir: ctx.dataDir, batchId: created.batch.id, forceLiveness: true, deps });
        if (error?.response) return res.status(error.response.status).json(error.response.body);
        throw error;
      }
      try {
        attachBatchChat({ dataDir: ctx.dataDir, batchId: created.batch.id, chatId: chat.id, deps });
        for (const todoId of new Set(created.batch.entries.flatMap((entry) => [entry.todoId, entry.targetId]))) {
          await linkTodoChat(ctx.dataDir, cwd, todoId, chat.id);
        }
      } catch (error) {
        // A half-bound batch has no usable agent: roll it back and free the lock.
        await abandonIntegrateBatch({ dataDir: ctx.dataDir, batchId: created.batch.id, forceLiveness: true, deps });
        throw error;
      }
      return res.json({
        ok: true,
        batch: readIntegrateBatch({ dataDir: ctx.dataDir, batchId: created.batch.id, deps }),
        chat,
        initialPrompt: created.prompt,
        skipped: created.skipped,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch failed' });
    }
  });

  app.get('/api/todos/integrate-batch', (req, res) => {
    try {
      const cwd = workspaceOf(req);
      return res.json({
        ok: true,
        batches: listIntegrateBatches({ dataDir: ctx.dataDir, workspaceFolder: cwd, deps }),
        lock: getIntegrationLock({ dataDir: ctx.dataDir, workspaceFolder: cwd }),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch list failed' });
    }
  });

  app.get('/api/todos/integrate-batch/:batchId', (req, res) => {
    try {
      const batch = readIntegrateBatch({ dataDir: ctx.dataDir, batchId: req.params.batchId, deps });
      if (!batch) return sendFailure(req, res, { reason: 'not_found' });
      return res.json({ ok: true, batch });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch read failed' });
    }
  });

  app.post('/api/todos/integrate-batch/:batchId/cancel', async (req, res) => {
    try {
      const result = await cancelIntegrateBatch({ dataDir: ctx.dataDir, batchId: req.params.batchId, deps });
      if (!result.ok) return sendFailure(req, res, result);
      return res.json({ ok: true, batch: readIntegrateBatch({ dataDir: ctx.dataDir, batchId: req.params.batchId, deps }) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch cancel failed' });
    }
  });

  app.post('/api/todos/integrate-batch/:batchId/resume', async (req, res) => {
    try {
      const body = req.body || {};
      const stored = readIntegrateBatch({ dataDir: ctx.dataDir, batchId: req.params.batchId, deps });
      if (!stored) return sendFailure(req, res, { reason: 'not_found' });
      // The batch's own workspace wins over whatever the request claims.
      const cwd = stored.workspaceFolder || workspaceOf(req);
      /** @type {Record<string, any>} */
      const resumed = await resumeIntegrateBatch({
        dataDir: ctx.dataDir,
        batchId: req.params.batchId,
        entryAction: body.entryAction,
        forceLiveness: body.forceLiveness === true,
        openChat: () => createBatchChat(req, cwd, `[Integrate] resume ${req.params.batchId.slice(0, 8)}`),
        deps,
      });
      if (!resumed.ok) {
        if (resumed.response) return res.status(resumed.response.status).json(resumed.response.body);
        return sendFailure(req, res, resumed);
      }
      const chat = resumed.chat || null;
      if (chat) {
        for (const todoId of resumed.todoIds || []) await linkTodoChat(ctx.dataDir, cwd, todoId, chat.id);
      }
      return res.json({
        ok: true,
        batch: readIntegrateBatch({ dataDir: ctx.dataDir, batchId: req.params.batchId, deps }),
        chat,
        initialPrompt: resumed.prompt || '',
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch resume failed' });
    }
  });

  app.post('/api/todos/integrate-batch/:batchId/abandon', async (req, res) => {
    try {
      const result = await abandonIntegrateBatch({
        dataDir: ctx.dataDir,
        batchId: req.params.batchId,
        forceLiveness: (req.body || {}).forceLiveness === true,
        deps,
      });
      if (!result.ok) return sendFailure(req, res, result);
      return res.json({ ok: true, batch: result.view });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch abandon failed' });
    }
  });

  /** Explicit operator clear; a still-running agent may keep writing. */
  app.post('/api/integration-lock/clear', (req, res) => {
    try {
      const result = clearIntegrationLock({ dataDir: ctx.dataDir, workspaceFolder: workspaceOf(req) });
      if (!result.ok) return sendFailure(req, res, result);
      return res.json({ ok: true, cleared: result.cleared });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'lock clear failed' });
    }
  });

  /**
   * Agent callback (public path). The capability secret in the body is the
   * authority and is validated even for loopback callers; the shared agent
   * token additionally applies to non-loopback callers.
   */
  app.post('/api/integrate-batch/next', async (req, res) => {
    try {
      if (typeof ctx.verifyAgentCallback === 'function' && !ctx.verifyAgentCallback(req)) {
        return res.status(401).json({ ok: false, error: msg(req, 'callback.invalidToken') });
      }
      const result = await handleBatchNext({ dataDir: ctx.dataDir, body: req.body || {}, deps });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'integrate batch next failed' });
    }
  });

  try {
    recoverIntegrateBatchesOnStartup({ dataDir: ctx.dataDir, deps });
  } catch {
    // A corrupt store must not stop route registration.
  }
}
