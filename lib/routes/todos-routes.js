import { randomUUID } from 'crypto';
import { applyExecutionSettingsToPolicy } from '../execution-settings.js';
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
import { buildTodoAgentInitialPrompt, buildTodoRefineInitialPrompt } from '../todo-agent.js';
import {
  createPlanReviewerSession,
  stalePlanReviewerSessionsForTodoPlanChange,
} from '../plan-reviewer-cooperation-service.js';
import { normalizePlanReviewerCooperationMode } from '../plan-reviewer-cooperation.js';
import { attachTodoReviewReadModels } from '../todo-review-read.js';
import { attachTodoIntegrationReadModels } from '../todo-integration-read.js';
import { collectTodoSubtreeIds, isTodoBranchBlocked, readTodoParentId } from '../todo-tree.js';
import {
  confirmWorkspaceTodoIntegration,
  applyWorkspaceTodoIntegration,
  mergeWorkspaceTodoIntegration,
  buildSmartMergeRequest,
  buildVerifyIntegrationRequest,
  prepareManualTodoIntegration,
  rejectWorkspaceTodoIntegration,
  invalidateTodoIntegrationProof,
  markTodoIntegrationNoCode,
} from '../workspace-watcher-integration.js';
import { readWorktreeRegistry } from '../persist/worktree-registry-persist.js';
import { prepareWorkspaceWatcherExecution } from '../workspace-watcher-worktree.js';
import { readChatExecutionFolder } from '../execution-folder.js';
import {
  buildLiveWorktreePredicate,
  collectManualLineageTodoIds,
  describeManualWorktreeError,
  manualStartNeedsAsyncPrepare,
  readLiveWorktreeRecord,
  adoptTreeWorktreeOnRoot,
  resolveManualTodoRoot,
} from '../todo-worktree-manual.js';
import { msg } from '../messages.js';
import { syncTodoReviewTarget } from '../todo-review-sync-hooks.js';
import { isWorktreeRecordLive } from '../worktree/worktree-record.js';
import { releaseWorktree } from '../worktree-manager.js';
import { worktreeRegistryOptions } from '../workspace-watcher-worktree.js';
import { setBuiltinMcpRuntimeDeps } from '../mcp/builtin/runtime-deps.js';
import { loadTodoUsage, loadWorkspaceTodoUsage } from '../usage/todo-usage-read.js';
import { describeUsageWindow } from '../usage/usage-window.js';

/**
 * Two-phase manual start jobs (D4): a worktree prepare can take minutes, so the
 * HTTP request must not block on it. Jobs are keyed by workspace + todo +
 * forceNew and live only in this process.
 *
 * @type {Map<string, { state: 'preparing'|'done'|'error', startedAt: number, payload?: object, error?: { status: number, key: string, code?: string } }>}
 */
const manualStartJobs = new Map();
const MANUAL_START_JOB_TTL_MS = 15 * 60 * 1000;

/** Test-only seam: forget every two-phase start job. */
export function clearManualStartJobs() {
  manualStartJobs.clear();
}

/**
 * @param {string} cwd
 * @param {string} todoId
 * @param {boolean} forceNew
 * @returns {string}
 */
function manualStartJobKey(cwd, todoId, forceNew) {
  return `${cwd}\u0000${todoId}\u0000${forceNew ? 'new' : 'reuse'}`;
}

/**
 * Drop jobs whose consumer never came back, so a crashed client cannot leak
 * memory forever.
 *
 * @param {number} now
 */
function pruneManualStartJobs(now) {
  for (const [key, job] of manualStartJobs) {
    if (now - job.startedAt > MANUAL_START_JOB_TTL_MS) manualStartJobs.delete(key);
  }
}

/**
 * Attach a per-item `worktree` summary when the item or one of its ancestors
 * owns a live worktree, so the client can offer integration from any node of the
 * tree without reading the registry itself. The owning todo differs by start
 * path (Watcher: the claimed leaf; manual start: the tree root), so the summary
 * names it explicitly as `ownerTodoId`.
 *
 * @param {object[]} items
 * @param {string} dataDir
 * @returns {object[]}
 */
function withWorktreeSummaries(items, dataDir) {
  const list = Array.isArray(items) ? items : [];
  if (!dataDir) return list;
  let registry = {};
  try {
    registry = readWorktreeRegistry({ dataDir })?.items || {};
  } catch {
    registry = {};
  }
  const byId = new Map(list.map((row) => [String(row?.id || ''), row]));
  /** @type {Map<string, object | null>} */
  const cache = new Map();
  const summaryFor = (item) => {
    const chain = [];
    const seen = new Set();
    let current = item;
    let summary = null;
    while (current && !seen.has(String(current.id))) {
      const id = String(current.id);
      seen.add(id);
      if (cache.has(id)) {
        summary = cache.get(id);
        break;
      }
      chain.push(id);
      const record = registry[id];
      if (isWorktreeRecordLive(record)) {
        summary = {
          live: true,
          ownerTodoId: id,
          branch: String(record.branch || ''),
          worktreePath: String(record.worktreePath || ''),
          baseCommit: String(record.baseCommit || ''),
          executionState: String(record.executionState || ''),
          integrationState: String(record.integrationState || ''),
        };
        break;
      }
      current = byId.get(readTodoParentId(current) || '') || null;
    }
    chain.forEach((id) => cache.set(id, summary));
    return summary;
  };
  return list.map((item) => {
    const summary = summaryFor(item);
    return summary ? { ...item, worktree: summary } : item;
  });
}

/**
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: unknown[] }} data
 * @param {{ dataDir?: string }} [ctx]
 */
function jsonTodosPayload(cwd, data, ctx) {
  const chatIndex = buildTodoChatIndex(loadChats(), { workspaceFolder: cwd });
  const items = enrichTodoItemsWithSourceChat(data.items, chatIndex, cwd);
  return {
    ok: true,
    cwd,
    version: data.version,
    updatedAt: data.updatedAt,
    items: attachTodoIntegrationReadModels(withWorktreeSummaries(attachTodoReviewReadModels(items), ctx?.dataDir))
      .map(slimTodoForList),
  };
}

/**
 * Drop raw integration material the UI does not read; it consumes the computed
 * integrationSummary instead. Keep complete changelog text because the editor
 * History tab uses the same response and has no separate detail fetch.
 *
 * @param {object} item
 * @returns {object}
 */
export function slimTodoForList(item) {
  if (!item || typeof item !== 'object') return item;
  const slim = { ...item };
  if (item.integration && typeof item.integration === 'object') {
    const { evidence, changedFiles, ...integration } = item.integration;
    slim.integration = integration;
  }
  return slim;
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

/**
 * Keys a REST client may never write: `review` is server-owned (contract §10.1).
 * A body that carries one is rejected explicitly instead of being silently
 * dropped by the update mapping.
 */
const SERVER_MANAGED_REVIEW_KEYS = Object.freeze(['review', 'review_subject', 'reviewSubject']);

/**
 * @param {Record<string, unknown>} body
 * @returns {Error|null}
 */
function rejectServerManagedReview(body) {
  if (!body || typeof body !== 'object') return null;
  const key = SERVER_MANAGED_REVIEW_KEYS.find(
    (candidate) => Object.prototype.hasOwnProperty.call(body, candidate) && body[candidate] !== undefined,
  );
  if (!key) return null;
  const err = new Error('The review field is server-managed and cannot be set through the API');
  err.code = 'VALIDATION';
  return err;
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
 * Error mapping for the read-only usage endpoints. A ledger that cannot be read
 * is "unavailable" (503), never an empty result.
 *
 * @param {object} req
 * @param {object} res
 * @param {Error} err
 */
function jsonTodoUsageError(req, res, err) {
  const code = err && err.code;
  if (code === 'VALIDATION') {
    return res.status(400).json({ ok: false, error: err.message || 'Invalid usage query', code });
  }
  if (code === 'CONFLICT') {
    return res.status(409).json({ ok: false, error: err.message || 'Usage cursor is stale; restart pagination', code });
  }
  if (code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: msg(req, 'todo.notFound'), code });
  }
  if (code === 'USAGE_UNAVAILABLE') {
    return res.status(503).json({ ok: false, error: 'Usage statistics are unavailable.', code });
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

  /**
   * First todo in `id`'s subtree that still owns a live worktree, or ''. Used to
   * refuse a delete/re-parent that would orphan a worktree silently.
   *
   * @param {string} cwd
   * @param {string} id
   * @returns {string}
   */
  function worktreeSubtreeConflict(cwd, id) {
    const items = loadTodosData(ctx.dataDir, cwd).items;
    const subtree = collectTodoSubtreeIds(items, id);
    const live = buildLiveWorktreePredicate(ctx.dataDir);
    return subtree.find((todoId) => live(todoId)) || '';
  }

  /** Todo list for current CWD (JSON in data/todos on server). */
  app.get('/api/todos', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const data = loadTodosData(ctx.dataDir, cwd);
      return res.json(jsonTodosPayload(cwd, data, ctx));
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Workspace-wide TODO usage, read from the existing usage ledger.
   *
   * Registered before the parametric `/api/todos/:id*` routes so the literal
   * `usage` segment can never be captured as an id.
   */
  app.get('/api/todos/usage', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const loaded = loadWorkspaceTodoUsage({
        dataDir: ctx.dataDir,
        cwd,
        query: req.query || {},
      });
      if (!loaded.ok) {
        const error = new Error(loaded.error);
        error.code = loaded.code;
        return jsonTodoUsageError(req, res, error);
      }
      return res.json({
        ok: true,
        window: describeUsageWindow(loaded.window),
        ...loaded.report,
      });
    } catch (err) {
      return jsonTodoUsageError(req, res, err);
    }
  });

  /**
   * Usage of one TODO, split into `own` (bound to this todo) and
   * `consolidated` (bound to its descendants).
   */
  app.get('/api/todos/:id/usage', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const loaded = loadTodoUsage({
        dataDir: ctx.dataDir,
        cwd,
        todoId: req.params.id,
        query: req.query || {},
      });
      if (!loaded.ok) {
        const error = new Error(loaded.error);
        error.code = loaded.code;
        return jsonTodoUsageError(req, res, error);
      }
      return res.json({
        ok: true,
        todoId: loaded.todoId,
        todo: loaded.todo,
        window: describeUsageWindow(loaded.window),
        usage: loaded.usage,
      });
    } catch (err) {
      return jsonTodoUsageError(req, res, err);
    }
  });

  app.post('/api/todos', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      const reviewError = rejectServerManagedReview(body);
      if (reviewError) throw reviewError;
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
        executionMode: body.executionMode ?? body.execution_mode,
        orchestratorChatId: body.orchestratorChatId ?? body.orchestrator_chat_id,
        createdByChatId: body.createdByChatId ?? body.created_by_chat_id,
        sourceHarness: body.sourceHarness ?? body.source_harness,
      });
      return res.json({
        ...jsonTodosPayload(cwd, data, ctx),
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
      const reviewError = rejectServerManagedReview(body);
      if (reviewError) throw reviewError;
      const nextParent = readBodyAlias(body, 'parentId', 'parent_id');
      if (nextParent !== undefined) {
        const current = loadTodosData(ctx.dataDir, cwd).items.find((row) => row.id === id) || null;
        if (current && readTodoParentId(current) !== String(nextParent || '').trim()) {
          const conflict = worktreeSubtreeConflict(cwd, id);
          if (conflict) {
            return res.status(409).json({
              ok: false,
              error: msg(req, 'todo.worktreeReparentBlocked'),
              code: 'WORKTREE_REGISTRY_CONFLICT',
              conflictTodoId: conflict,
            });
          }
        }
      }
      let data = updateTodo(ctx.dataDir, cwd, id, {
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
        executionMode: readBodyAlias(body, 'executionMode', 'execution_mode'),
        orchestratorChatId: readBodyAlias(body, 'orchestratorChatId', 'orchestrator_chat_id'),
      });
      if (body.plan !== undefined) {
        try {
          stalePlanReviewerSessionsForTodoPlanChange({
            dataDir: ctx.dataDir,
            workspaceFolder: cwd,
            todoId: id,
          });
        } catch {
          // Todo update must succeed even if cooperation stale marking fails.
        }
        // A plan revision opens a new plan review round (todo-review contract 4.3).
        syncTodoReviewTarget({ todoId: id, workspaceFolder: cwd, dataDir: ctx.dataDir }, { source: 'plan-edit' });
        data = loadTodosData(ctx.dataDir, cwd);
      }
      return res.json({
        ...jsonTodosPayload(cwd, data, ctx),
        item: data.items.find((row) => row.id === id) || null,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Smart merge: prepare the worktree diff and open an agent chat in the logical
   * workspace whose job is to merge the worktree result by hand (the deterministic
   * three-way apply refused it). The chat is deliberately NOT bound to the todo or
   * its worktree, so the agent works on the real workspace.
   */
  app.post('/api/todos/:id/smart-merge', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      const built = buildSmartMergeRequest({
        todoId: req.params.id,
        workspaceFolder: cwd,
        dataDir: ctx.dataDir,
        conflicts: body.conflicts,
        baseUrl: ctx.getLocalCallbackBaseUrl(),
        insecureTls: ctx.useHttps,
        deps: ctx.worktreeDeps,
      });
      if (!built.ok) {
        const status = built.reason === 'not_found' ? 404 : built.reason === 'no_worktree' || built.reason === 'busy' ? 409 : 500;
        return res.status(status).json({ ok: false, error: built.reason || 'smart merge failed' });
      }
      const transport = normalizeAgentTransport(body.agentTransport);
      if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
        return res.status(503).json({ ok: false, error: msg(req, 'sdk.noApiKey') });
      }
      const model = String(body.model || ctx.agentModel || '').trim();
      const chat = addChat(randomUUID(), built.title, body.workspaceFile || ctx.getCurrentWorkspaceFile(), body.workspaceFolder || null, model || undefined, {
        agentTransport: transport,
        sdkMode: 'agent',
      });
      // Pin the chat to the todo (history + chats tab) without binding it to the worktree.
      new Set([built.targetId, req.params.id]).forEach((linkId) => linkTodoChat(ctx.dataDir, cwd, linkId, chat.id));
      return res.json({ ok: true, chat, initialPrompt: built.prompt, targetId: built.targetId });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Verify integration: open an agent chat in the logical workspace that checks a
   * finished todo (no live worktree) is in the checked-out branch and records the
   * integration proof, closing the todo as integrated.
   */
  app.post('/api/todos/:id/verify-integration', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      const built = buildVerifyIntegrationRequest({ todoId: req.params.id, workspaceFolder: cwd, dataDir: ctx.dataDir });
      if (!built.ok) {
        const status = built.reason === 'not_found' ? 404 : 409;
        return res.status(status).json({ ok: false, error: built.reason || 'verify integration failed' });
      }
      const transport = normalizeAgentTransport(body.agentTransport);
      if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
        return res.status(503).json({ ok: false, error: msg(req, 'sdk.noApiKey') });
      }
      const model = String(body.model || ctx.agentModel || '').trim();
      const chat = addChat(randomUUID(), built.title, body.workspaceFile || ctx.getCurrentWorkspaceFile(), body.workspaceFolder || null, model || undefined, {
        agentTransport: transport,
        sdkMode: 'agent',
      });
      // Pin the chat to the todo (history + chats tab) without binding it to the worktree.
      new Set([built.targetId, req.params.id]).forEach((linkId) => linkTodoChat(ctx.dataDir, cwd, linkId, chat.id));
      return res.json({ ok: true, chat, initialPrompt: built.prompt, targetId: built.targetId });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Manual integration of a worktree-backed tree. Any node of the tree may be
   * named; the action resolves the ROOT that owns the worktree. `merge` is the
   * explicit human "integrate with workspace" step: prepare when needed, then
   * apply the guarded three-way merge. `confirm` marks the todo done (which
   * unblocks sequential siblings); `reject` returns it to `ready` with a reason
   * and preserves the worktree for a retry. Nothing is ever committed, pushed or
   * merged at the Git level.
   */
  app.post('/api/todos/:id/integration', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      const body = req.body || {};
      const action = String(body.action || '').trim().toLowerCase();
      const proofBody = body.proof && typeof body.proof === 'object' ? body.proof : body;
      if (action !== 'confirm' && action !== 'reject' && action !== 'prepare' && action !== 'apply' && action !== 'merge' && action !== 'invalidate' && action !== 'no-code') {
        return res.status(400).json({ ok: false, error: 'action must be prepare, merge, apply, confirm, reject, invalidate or no-code' });
      }
      let result;
      if (action === 'prepare') {
        result = prepareManualTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
        });
      } else if (action === 'merge') {
        result = mergeWorkspaceTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          deps: ctx.worktreeDeps,
        });
      } else if (action === 'apply') {
        result = applyWorkspaceTodoIntegration({ todoId: id, workspaceFolder: cwd, dataDir: ctx.dataDir, deps: ctx.worktreeDeps });
      } else if (action === 'confirm') {
        result = confirmWorkspaceTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
          proof: {
            targetBranch: proofBody.targetBranch || proofBody.target_branch,
            targetCommit: proofBody.targetCommit || proofBody.target_commit,
            sourceCommit: proofBody.sourceCommit || proofBody.source_commit,
            materialRevision: proofBody.materialRevision || proofBody.material_revision,
            changeRef: proofBody.changeRef || proofBody.change_ref,
            changeAttested: proofBody.changeAttested === true || proofBody.change_attested === true,
            scope: proofBody.scope,
            simple: proofBody.simple === true,
          },
        });
      } else if (action === 'invalidate') {
        result = invalidateTodoIntegrationProof({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
          reason: body.reason,
        });
      } else if (action === 'no-code') {
        result = markTodoIntegrationNoCode({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
          reason: body.reason,
        });
      } else {
        result = rejectWorkspaceTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
          reason: body.reason,
        });
      }
      if (!result.ok) {
        const status = result.reason === 'not_found' ? 404
          : result.reason === 'conflict' || result.reason === 'not_ready' || result.reason === 'integration_ready' || result.reason === 'not_done'
            || result.reason === 'not_root' || result.reason === 'no_worktree'
            || result.reason === 'integration_conflict' || result.reason === 'already_applied'
            || result.reason === 'busy' || result.reason === 'already_integrated' || result.reason === 'target_commit_not_on_branch'
            || result.reason === 'target_ref_missing' || result.reason === 'material_revision_mismatch' ? 409
            : ['invalid_target_branch', 'full_commit_required', 'task_change_link_required', 'expected_revision_required', 'reason_required'].includes(result.reason) ? 400 : 500;
        return res.status(status).json({
          ok: false,
          error: result.reason || 'integration failed',
          conflicts: Array.isArray(result.conflicts) ? result.conflicts : [],
        });
      }
      const data = loadTodosData(ctx.dataDir, cwd);
      return res.json({
        ...jsonTodosPayload(cwd, data, ctx),
        applied: result.applied === true,
        alreadyApplied: result.alreadyApplied === true,
        conflicts: Array.isArray(result.conflicts) ? result.conflicts : [],
        item: data.items.find((row) => row.id === (result.targetId || id)) || null,
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.delete('/api/todos/:id', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      // Deleting a subtree that still owns a live worktree would orphan the
      // registry record and its diff; refuse unless the client explicitly
      // confirms the discard with `?force=true`.
      const force = String(req.query?.force || req.body?.force || '') === 'true';
      const conflict = worktreeSubtreeConflict(cwd, id);
      if (conflict && !force) {
        return res.status(409).json({
          ok: false,
          error: msg(req, 'todo.worktreeDeleteBlocked'),
          code: 'WORKTREE_REGISTRY_CONFLICT',
          conflictTodoId: conflict,
        });
      }
      const { doc, removedItems } = deleteTodo(ctx.dataDir, cwd, id);
      // Plan sync links chat -> todo without setting todo.chatId, so unlink by
      // both directions.
      const removedIds = new Set((removedItems || []).map((row) => String(row?.id || '')));
      const chatIds = new Set((removedItems || []).map((row) => row?.chatId).filter(Boolean));
      loadChats().forEach((chat) => {
        if (removedIds.has(String(chat?.todoId || ''))) chatIds.add(chat.id);
      });
      chatIds.forEach((chatId) => updateChat(chatId, { todoId: null }));
      return res.json(jsonTodosPayload(cwd, doc, ctx));
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * Non-creating read of the watcher row policy. The manual start resolves the
   * tree ROOT's execution mode against this default; a workspace without a
   * watcher row simply gets the product default (`project`).
   *
   * @param {string} cwd
   * @returns {object | null}
   */
  function readManualPolicy(cwd) {
    if (typeof ctx.loadWatcherPolicy !== 'function') return null;
    try {
      const row = ctx.loadWatcherPolicy(cwd);
      const legacy = row?.policy && typeof row.policy === 'object' ? row.policy : null;
      // The saved execution settings win over the legacy watcher policy.
      return applyExecutionSettingsToPolicy(legacy, cwd, ctx.dataDir);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} chatId
   * @returns {boolean}
   */
  function chatRunBusy(chatId) {
    const probe = typeof ctx.probeChatRunLiveness === 'function' ? ctx.probeChatRunLiveness : null;
    if (!probe || !chatId) return true;
    try {
      const result = probe({ chatId });
      if (result?.known === true) return result.busy !== false;
      // Cold rooms and deleted chats have no live run. Probe failures keep
      // ownership frozen until liveness can be established.
      return !['chat_missing', 'state_missing', 'adapter_missing'].includes(result?.reason);
    } catch {
      return true;
    }
  }

  /**
   * Map a thrown start error to an HTTP status + i18n key. Worktree failures
   * carry their own stable code; everything else reuses the todo error shape.
   *
   * @param {unknown} error
   * @returns {{ status: number, key: string, code?: string, details?: object }}
   */
  function classifyStartError(error) {
    if (error && typeof error === 'object' && typeof error.key === 'string') {
      return /** @type {any} */ (error);
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
    if (code === 'NOT_FOUND') return { status: 404, key: 'todo.notFound' };
    if (code === 'NO_WORKSPACE') return { status: 400, key: 'files.noWorkspace' };
    if (code === 'VALIDATION') return { status: 400, key: 'todo.titleRequired' };
    return { status: 500, key: 'todo.saveError' };
  }

  /**
   * The full manual start: resolve the tree root, prepare its worktree (without
   * blocking on a long prepare for the fast paths), then reuse or create the
   * chat with the frozen execution folder. Failing work happens before
   * `addChat` and before the `doing` transition, so a refusal never leaves a
   * half-created chat or an orphan `doing` row.
   *
   * @param {{ cwd: string, todoId: string, body: object, forceNew: boolean, req: object }} input
   * @returns {Promise<object>}
   */
  async function executeTodoAgentStart(input) {
    const { cwd, todoId, body } = input;
    // A refine start is a side chat for the plan review loop: always a fresh
    // chat, and it never takes over the todo's executor chat or its status.
    const refine = body.mode === 'refine';
    const forceNew = input.forceNew === true || refine;
    let todo = getTodoById(ctx.dataDir, cwd, todoId);
    if (!todo) throw { status: 404, key: 'todo.notFound' };
    const allItems = loadTodosData(ctx.dataDir, cwd).items;
    if (isTodoBranchBlocked(allItems, todo)) throw { status: 409, key: 'todo.blockedByTree' };
    const { rootId, root: resolvedRoot } = resolveManualTodoRoot(allItems, todoId);
    const requestedExecutionMode = String(body.executionMode || body.execution_mode || '').trim();
    const root = requestedExecutionMode === 'worktree' || requestedExecutionMode === 'project'
      ? { ...resolvedRoot, executionMode: requestedExecutionMode }
      : resolvedRoot;
    const policy = readManualPolicy(cwd);
    const lineage = collectManualLineageTodoIds(allItems, rootId);
    // An explicit `project` start never silently falls back to a frozen
    // worktree: the caller must opt in to releasing it (the directory and its
    // branch stay on disk; only the live record is closed).
    const releaseRequested = body.releaseWorktree === true || body.release_worktree === true;
    let releasedWorktree = false;
    if (requestedExecutionMode === 'project' && readLiveWorktreeRecord(rootId, ctx.dataDir)) {
      if (!releaseRequested) {
        throw { status: 409, key: 'todo.worktreeFrozen', code: 'WORKTREE_FROZEN' };
      }
      try {
        releaseWorktree({
          todoId: rootId,
          registryOptions: worktreeRegistryOptions(ctx.dataDir),
          hasActiveAgent: (record) => (Array.isArray(record.chats) ? record.chats : []).some(chatRunBusy),
        });
      } catch (error) {
        const described = describeManualWorktreeError(error);
        throw { status: described.status, key: described.key, code: described.code };
      }
      updateTodo(ctx.dataDir, cwd, rootId, { executionMode: 'project' });
      releasedWorktree = true;
    }
    // Release completed integration history, then adopt a single active leaf.
    // Remaining live descendants still block mixing the two keyings.
    if (!refine) adoptTreeWorktreeOnRoot({ rootId, lineage, items: allItems, workspaceFolder: cwd, dataDir: ctx.dataDir, hasActiveAgent: (record) => (Array.isArray(record.chats) ? record.chats : []).some(chatRunBusy) });
    const conflictId = refine
      ? null
      : lineage.find((id) => id !== rootId && readLiveWorktreeRecord(id, ctx.dataDir));
    if (conflictId) {
      throw {
        status: 409,
        key: 'todo.worktreeMixing',
        code: 'WORKTREE_REGISTRY_CONFLICT',
        details: { conflictTodoId: conflictId },
      };
    }
    let prepared;
    try {
      prepared = await prepareWorkspaceWatcherExecution({
        todoId: rootId,
        workspaceFolder: cwd,
        todo: root,
        policy,
        dataDir: ctx.dataDir,
        lineageTodoIds: lineage,
        lockKey: rootId,
        // A manual start must not dead-end on a settings form scoped to another
        // workspace: derive and persist the layout from the workspace itself.
        allowSuggestedLayout: true,
        // Continuing a tree in a new chat must not reinstall dependencies in a
        // worktree that is already prepared; the route answers synchronously
        // for that case (see manualStartNeedsAsyncPrepare).
        reuseActivePrepare: true,
        // Plan refinement is read-only review work in the project folder. It
        // must not prepare, reuse, or otherwise enter the todo's worktree.
        planOnly: refine,
        dirtyPolicy: body.dirtyPolicy || 'block',
        deps: ctx.worktreeDeps,
      });
    } catch (error) {
      const described = describeManualWorktreeError(error);
      throw { status: described.status, key: described.key, code: described.code, ...(error?.details ? { details: error.details } : {}) };
    }
    const executionFolder = prepared.mode === 'worktree' ? prepared.executionFolder : '';
    const hasChildren = allItems.some((row) => String(row?.parentId || '') === todoId);
    let reused = false;
    /** @type {ReturnType<typeof addChat> | null} */
    let chat = null;
    // Previous chats for this todo, captured before a new chat is linked so the
    // prompt can point the fresh agent at the earlier context.
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
        // A reused chat must run in the same frozen folder as the tree. Never
        // silently re-point a chat that already has a different folder, and do
        // not touch a live run.
        if (!executionFolder && releasedWorktree && readChatExecutionFolder(chat)) {
          // The tree left its worktree: re-point the linked chat to the project.
          if (chatRunBusy(chat.id)) {
            throw { status: 409, key: 'todo.worktreeReuseBusy', code: 'WORKTREE_REUSE_BUSY' };
          }
          updateChat(chat.id, { executionFolder: '' });
          chat = loadChats().find((c) => c.id === chat.id) || chat;
        }
        if (executionFolder) {
          const currentFolder = readChatExecutionFolder(chat);
          if (currentFolder && currentFolder !== executionFolder) {
            throw {
              status: 409,
              key: 'todo.worktreeReuseMismatch',
              code: 'WORKTREE_REUSE_MISMATCH',
            };
          }
          if (!currentFolder) {
            if (chatRunBusy(chat.id)) {
              throw { status: 409, key: 'todo.worktreeReuseBusy', code: 'WORKTREE_REUSE_BUSY' };
            }
            updateChat(chat.id, { executionFolder });
            chat = loadChats().find((c) => c.id === chat.id) || chat;
          }
        }
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
        throw { status: 503, key: 'sdk.noApiKey' };
      }
      const workspaceFile = body.workspaceFile || ctx.getCurrentWorkspaceFile();
      const workspaceFolder = body.workspaceFolder || null;
      const model = (body.model || assignee?.model || ctx.agentModel || '').trim();
      const chatTitle = (`${refine ? '[Todo plan]' : '[Todo]'} ${todo.title || 'Task'}`).slice(0, 120);
      const sdkSessionKey = randomUUID();
      const hasPersistedPlan =
        !!(todo.plan && typeof todo.plan === 'object' && String(todo.plan.markdown || '').trim());
      const roleSdkMode = { plan: 'plan', implement: 'agent' }[assignee?.role];
      // Continuing in a fresh chat starts an agent even when the task has no plan.
      const defaultSdkMode = forceNew || hasChildren ? 'agent' : roleSdkMode || (hasPersistedPlan ? 'agent' : 'plan');
      try {
        chat = addChat(sdkSessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
          agentTransport: transport,
          sdkMode: body.sdkMode || defaultSdkMode,
          sdkUiMode: body.sdkUiMode,
          todoId,
          // Freeze the ROOT worktree on the chat so delegations copy it.
          ...(executionFolder ? { executionFolder } : {}),
        });
      } catch (error) {
        // The worktree record is idempotent and is reused on the next start;
        // make sure the failure surfaces as a normal start error.
        throw { status: 500, key: 'todo.saveError', code: 'ADD_CHAT_FAILED', cause: error };
      }
      // A new chat only moves an unfinished todo to doing; a done item is
      // never silently reopened (the UI asks first).
      const shouldSetDoing = todo.status === 'idea' || todo.status === 'ready';
      if (refine) {
        todo = linkTodoChat(ctx.dataDir, cwd, todoId, chat.id).item || todo;
      } else {
        if (forceNew && previousChatId && previousChatId !== chat.id) {
          // Keep the replaced executor in the visible history even when it was
          // only reachable through the single chatId field (legacy data).
          const stillExists = loadChats().some((row) => row.id === previousChatId);
          if (stillExists) linkTodoChat(ctx.dataDir, cwd, todoId, previousChatId);
        }
        const linked = updateTodo(ctx.dataDir, cwd, todoId, {
          ...(shouldSetDoing ? { status: 'doing' } : {}),
          chatId: chat.id,
          ...(hasChildren ? { orchestratorChatId: chat.id } : {}),
          linkedChatId: chat.id,
          sourceHarness: transport,
        });
        todo = linked.items.find((it) => it.id === todoId) || todo;
      }
    }
    const baseUrl = ctx.getLocalCallbackBaseUrl();
    const priorChats = previousChats.filter((entry) => entry.id !== chat.id);
    /** @type {{ id?: string, cooperationMode?: string } | null} */
    let planReviewerSession = null;
    const cooperationMode = refine
      ? normalizePlanReviewerCooperationMode(
        body.cooperationMode ?? body.cooperation_mode ?? body.planReviewerCooperationMode,
      )
      : '';
    if (refine) {
      const createdSession = createPlanReviewerSession({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoId,
        coordinatorChatId: chat.id,
        cooperationMode,
      });
      if (createdSession.ok) {
        planReviewerSession = {
          id: createdSession.session.id,
          cooperationMode: createdSession.session.cooperationMode,
        };
      }
    }
    const initialPrompt = refine
      ? buildTodoRefineInitialPrompt(todo, chat.id, {
        previousChats: priorChats,
        planReviewerSession: planReviewerSession || { cooperationMode },
      })
      : buildTodoAgentInitialPrompt(todo, chat.id, baseUrl, {
        insecureTls: ctx.useHttps,
        previousChats: priorChats,
        hasChildren,
      });
    const data = loadTodosData(ctx.dataDir, cwd);
    return {
      ...jsonTodosPayload(cwd, data, ctx),
      reused,
      forceNew,
      chat,
      todo,
      initialPrompt,
      ...(planReviewerSession ? { planReviewerSession } : {}),
      ...(executionFolder ? { executionFolder, worktree: true } : {}),
      ...(releasedWorktree ? { releasedWorktree: true } : {}),
    };
  }

  setBuiltinMcpRuntimeDeps({
    startTodoAgent: async ({ workspaceFolder, todoId, body = {} }) => {
      const workspace = String(workspaceFolder || '').trim();
      if (!workspace) throw { status: 400, code: 'NO_WORKSPACE' };
      const cwd = path.resolve(workspace);
      return executeTodoAgentStart({ cwd, todoId: String(todoId || ''), body, forceNew: body.forceNew === true, req: {} });
    },
  });

  /**
   * Creates (or reopens existing) agent chat linked to a Todo. A tree whose ROOT
   * resolves to `worktree` prepares/reuses the ROOT worktree and freezes it on
   * the chat. When that prepare can be long the route answers 202 and the client
   * polls `/api/todos/:id/start-agent/status` (D4).
   *
   * Optional body: workspaceFile, workspaceFolder, model, agentTransport ('sdk'),
   * sdkMode, forceNew (always create a fresh chat instead of reusing todo.chatId),
   * mode ('refine' starts a plan review-and-refine chat; implies forceNew).
   */
  app.post('/api/todos/:id/start-agent', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const todoId = req.params.id;
      const body = req.body || {};
      const forceNew = body.forceNew === true || body.mode === 'refine';
      const todo = getTodoById(ctx.dataDir, cwd, todoId);
      if (!todo) return res.status(404).json({ ok: false, error: msg(req, 'todo.notFound') });
      const allItems = loadTodosData(ctx.dataDir, cwd).items;
      if (isTodoBranchBlocked(allItems, todo)) {
        return res.status(409).json({ ok: false, error: msg(req, 'todo.blockedByTree') });
      }
      const { rootId } = resolveManualTodoRoot(allItems, todoId);
      // Resolve historical/active leaf records before the quick mixing guard.
      const lineage = collectManualLineageTodoIds(allItems, rootId);
      const refine = body.mode === 'refine';
      if (!refine) adoptTreeWorktreeOnRoot({ rootId, lineage, items: allItems, workspaceFolder: cwd, dataDir: ctx.dataDir, hasActiveAgent: (record) => (Array.isArray(record.chats) ? record.chats : []).some(chatRunBusy) });
      const conflictId = refine
        ? null
        : lineage.find((id) => id !== rootId && readLiveWorktreeRecord(id, ctx.dataDir));
      if (conflictId) {
        return res.status(409).json({
          ok: false,
          error: msg(req, 'todo.worktreeMixing'),
          code: 'WORKTREE_REGISTRY_CONFLICT',
          conflictTodoId: conflictId,
        });
      }
      const policy = readManualPolicy(cwd);
      if (!refine && manualStartNeedsAsyncPrepare({ items: allItems, rootId, policy, dataDir: ctx.dataDir })) {
        pruneManualStartJobs(Date.now());
        const key = manualStartJobKey(cwd, todoId, forceNew);
        const existing = manualStartJobs.get(key);
        if (existing) {
          if (existing.state === 'done') {
            manualStartJobs.delete(key);
            return res.json(existing.payload);
          }
          if (existing.state === 'error') {
            manualStartJobs.delete(key);
            const classified = existing.error || { status: 500, key: 'todo.saveError' };
            return res.status(classified.status).json({
              ok: false,
              error: msg(req, classified.key),
              code: classified.code,
              ...(classified.details ? { details: classified.details } : {}),
              worktree: true,
            });
          }
          return res.status(202).json({ ok: true, state: 'preparing', todoId, rootId });
        }
        const job = { state: 'preparing', startedAt: Date.now() };
        manualStartJobs.set(key, job);
        executeTodoAgentStart({ cwd, todoId, body, forceNew, req }).then(
          (payload) => {
            job.state = 'done';
            job.payload = payload;
          },
          (error) => {
            job.state = 'error';
            job.error = classifyStartError(error);
          },
        );
        return res.status(202).json({ ok: true, state: 'preparing', todoId, rootId });
      }
      const payload = await executeTodoAgentStart({ cwd, todoId, body, forceNew, req });
      return res.json(payload);
    } catch (error) {
      const classified = classifyStartError(error);
      return res.status(classified.status).json({
        ok: false,
        error: msg(req, classified.key),
        code: classified.code,
        ...(classified.details ? { details: classified.details } : {}),
      });
    }
  });

  /**
   * Poll a two-phase start job. Mirrors the POST fast path once the chat is
   * ready; an unknown/expired job returns `idle` and the client may retry the
   * POST.
   */
  app.get('/api/todos/:id/start-agent/status', (req, res) => {
    try {
      const cwd = todosCwd(req);
      const todoId = req.params.id;
      const forceNew = String(req.query?.forceNew || '') === 'true';
      pruneManualStartJobs(Date.now());
      const job = manualStartJobs.get(manualStartJobKey(cwd, todoId, forceNew));
      if (!job) return res.json({ ok: true, state: 'idle', todoId });
      if (job.state === 'preparing') return res.status(202).json({ ok: true, state: 'preparing', todoId });
      if (job.state === 'error') {
        manualStartJobs.delete(manualStartJobKey(cwd, todoId, forceNew));
        const classified = job.error || { status: 500, key: 'todo.saveError' };
        return res.status(classified.status).json({
          ok: false,
          error: msg(req, classified.key),
          code: classified.code,
          ...(classified.details ? { details: classified.details } : {}),
          worktree: true,
        });
      }
      manualStartJobs.delete(manualStartJobKey(cwd, todoId, forceNew));
      return res.json({ ...job.payload, state: 'ready' });
    } catch (error) {
      return jsonTodosError(req, res, error);
    }
  });
}
