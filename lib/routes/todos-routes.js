import { buildTodoTimeline } from '../todo-timeline.js';
import { resolveTodoStartModel } from './resolve-start-model.js';
import { listDelegationsForWorkspace } from '../persist/delegations-persist.js';
import { createHash, randomUUID } from 'crypto';
import { applyExecutionSettingsToPolicy } from '../execution-settings.js';
import { registerTodoHomeGuard, resolveRequestTodoHome, validateRequestExecutionFolder } from '../todo-home-http.js';
import path from 'path';
import { loadChats, addChat, updateChat } from '../persist/chats-persist.js';
import { markDelegationAutomaticController } from '../delegation-start-context.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { buildTodoChatIndex, enrichTodoItemsWithSourceChat, resolveTodoChats } from '../todo-source-chat.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.ts';
import {
  describeBodyTruncation,
  getTodoById,
  linkTodoChat,
  getTodosFileRevision,
  isTodosDocCurrent,
  TODOS_MAX_ITEMS,
} from '../persist/todos-persist.js';
import { addTodo, deleteTodo, listTodos, updateTodo } from '../persist/todos-store.js';
import { resolveEffectivePhases, todoPhaseChain, validatePhasesInput } from '../watcher-phases.js';
import { resolveWorkspaceForFolder } from '../workspace-registry-service.js';
import { loadSettings } from '../persist/settings.js';
import { getWorkspaceWatcher, takeWatcherLockTimings } from '../persist/workspace-watchers-persist.js';
import { resolveTodoReviewerPoliciesForPrompt } from '../delegation-settings.js';
import { isUnderFeedbackRoot, isFeedbackDerivedTodo } from '../persist/feedback-store.js';
import { buildTodoAgentInitialPrompt, buildTodoFullOrchestratorPrompt, buildTodoRefineInitialPrompt } from '../todo-agent.js';
import {
  createPlanReviewerSession,
  stalePlanReviewerSessionsForTodoPlanChange,
} from '../plan-reviewer-cooperation-service.js';
import { normalizePlanReviewerCooperationMode } from '../plan-reviewer-cooperation.js';
import { attachTodoReviewReadModels } from '../todo-review-read.js';
import { attachTodoIntegrationReadModels } from '../todo-integration-read.js';
import { collectTodoSubtreeIds, findApprovedPlanAncestor, isTodoBranchBlocked, readTodoParentId } from '../todo-tree.js';
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
  readIntegrationTarget,
  rollbackIntegrationRequest,
} from '../workspace-watcher-integration.js';
import { readWorktreeRegistry } from '../persist/worktree-registry-persist.js';
import { buildWorktreeActiveAgentCheck, prepareWorkspaceWatcherExecution } from '../workspace-watcher-worktree.js';
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
import { acquireIntegrationLock, checkIntegrationUnlocked } from '../integration-lock.js';
import { annotateBatchEligibility } from '../integrate-batch.js';
import { syncTodoReviewTarget } from '../todo-review-sync-hooks.js';
import { isWorktreeRecordLive } from '../worktree/worktree-record.ts';
import { releaseWorktree } from '../worktree-manager.js';
import { worktreeRegistryOptions } from '../workspace-watcher-worktree.js';
import { setBuiltinMcpRuntimeDeps } from '../mcp/builtin/runtime-deps.js';
import {
  checkReviewGateForTodoWrite,
  clearReviewGateMarker,
  reapplyReviewGateLabel,
  resolveReviewGateCallerFromRequest,
} from '../workspace-watcher-review-gate-guard.js';
import { loadTodoUsage, loadWorkspaceTodoUsage } from '../usage/todo-usage-read.ts';
import { describeUsageWindow } from '../usage/usage-window.ts';

/**
 * Two-phase manual start jobs (D4): a worktree prepare can take minutes, so the
 * HTTP request must not block on it. Jobs are keyed by workspace + todo +
 * forceNew and live only in this process.
 *
 * @type {Map<string, { state: 'preparing'|'done'|'error', startedAt: number, payload?: Record<string, any>, error?: { status: number, key: string, code?: string } }>}
 */
const manualStartJobs = new Map();
const MANUAL_START_JOB_TTL_MS = 15 * 60 * 1000;

/** Test-only seam: forget every two-phase start job. */
/**
 * Effective phases for `mode: 'full'`: the same contract the watcher uses
 * (workspace policy merged with the per-todo override).
 */
async function resolveFullModePhases(dataDir, cwd, todoId) {
  try {
    const items = (await listTodos(dataDir, cwd)).items;
    const policy = getWorkspaceWatcher(cwd, { dataDir })?.policy || {};
    return resolveEffectivePhases(policy, todoPhaseChain(items, items.find((row) => row.id === todoId) || null));
  } catch {
    return resolveEffectivePhases(null, []);
  }
}

/**
 * Workspace of a todo-agent chat: the SQL registry row that owns the folder
 * (`workspaceId`), plus the legacy `workspaceFile` kept only for old readers.
 *
 * @param {Record<string, any>} body
 * @param {string | null | undefined} currentFile
 * @param {Record<string, any>} [settings] - registry view; loaded when omitted
 * @returns {{ workspaceId: string, workspaceFile: string | null }}
 */
export function resolveTodoChatWorkspace(body, currentFile, settings) {
  const folder = String(body?.workspaceFolder || '').trim();
  const explicitId = String(body?.workspaceId || '').trim();
  const entry = folder && !explicitId ? resolveWorkspaceForFolder(settings || loadSettings(), folder) : null;
  const file = entry ? String(entry.importedFrom || entry.workspaceFile || '') : '';
  return {
    workspaceId: explicitId || entry?.id || '',
    workspaceFile: body?.workspaceFile || file || (folder ? null : currentFile || null),
  };
}

export function clearManualStartJobs() {
  manualStartJobs.clear();
}

export { resolveTodoStartModel };

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
 * @param {Record<string, any>[]} items
 * @param {string} dataDir
 * @returns {Record<string, any>[]}
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
  /** @type {Map<string, Record<string, any> | null>} */
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
 * Read-only `batchEligibility` per todo (bulk integrate). A failure here must
 * never break the todo list itself.
 *
 * @param {Record<string, any>[]} items
 * @param {string} cwd
 * @param {{ dataDir?: string }} [ctx]
 * @returns {Record<string, any>[]}
 */
function withBatchEligibility(items, cwd, ctx) {
  if (!ctx?.dataDir) return items;
  try {
    return annotateBatchEligibility({ dataDir: ctx.dataDir, workspaceFolder: cwd, items });
  } catch {
    return items;
  }
}

/**
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: unknown[] }} data
 * @param {{ dataDir?: string }} [ctx]
 * @param {{ lean?: boolean }} [options] `lean` drops the heavy editor-only fields
 */
function jsonTodosPayload(cwd, data, ctx, options = {}) {
  const chatIndex = buildTodoChatIndex(loadChats(), { workspaceFolder: cwd });
  const items = enrichTodoItemsWithSourceChat(data.items, chatIndex, cwd);
  return {
    ok: true,
    cwd,
    version: data.version,
    updatedAt: data.updatedAt,
    items: withBatchEligibility(
      attachTodoIntegrationReadModels(withWorktreeSummaries(attachTodoReviewReadModels(items), ctx?.dataDir)),
      cwd,
      ctx,
    ).map((item) => slimTodoForList(item, options)),
  };
}

/**
 * @param {Record<string, any>} source
 * @param {string[]} keys
 * @returns {Record<string, any>} only the keys that are present on `source`
 */
function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * Compact review read model for a list row: exactly what the review badges,
 * filters and status icon read (state, reason, first reviewer, counts,
 * independence, pair-policy hint and the aggregate). Reviewer rows, material and
 * acceptance details come with the full item from `GET /api/todos/:id`.
 *
 * @param {Record<string, any>} review
 * @returns {Record<string, any>}
 */
function compactReviewForList(review) {
  const out = pickDefined(review, ['generation', 'aggregate']);
  // aggregate.computedAt is stamped on every read: in the list it changed every
  // row signature and the list rev on each fetch, so the panel repainted all rows.
  if (out.aggregate && typeof out.aggregate === 'object' && 'computedAt' in out.aggregate) {
    const { computedAt: _computedAt, ...aggregate } = out.aggregate;
    out.aggregate = aggregate;
  }
  for (const subject of ['code', 'plan', 'other']) {
    const snap = review[subject];
    if (!snap || typeof snap !== 'object') continue;
    const compact = pickDefined(snap, ['state', 'stateReason', 'reviewerCount']);
    const first = Array.isArray(snap.reviewers) ? snap.reviewers[0] : null;
    if (first && typeof first === 'object') compact.reviewers = [pickDefined(first, ['harness', 'model'])];
    // The badge only tests presence; the identity comes with the full item.
    if (snap.implementer) compact.implementer = true;
    // Presence flags only: the badge checks truthiness to offer a details panel.
    if (snap.acceptance) compact.acceptance = true;
    if (snap.independence && typeof snap.independence === 'object' && snap.state !== 'none') {
      compact.independence = pickDefined(snap.independence, ['independent', 'class']);
    }
    if (snap.pairPolicy && typeof snap.pairPolicy === 'object') {
      compact.pairPolicy = pickDefined(snap.pairPolicy, ['source', 'liveSelection']);
    }
    out[subject] = compact;
  }
  return out;
}

/** Chat roles whose runs the row status icon follows. */
const LIST_AGENT_CHAT_ROLES = new Set(['executor', 'delegate', 'orchestrator']);

/**
 * Drop raw integration material the UI does not read; it consumes the computed
 * integrationSummary instead. Keep complete changelog text because the editor
 * History tab uses the same response and has no separate detail fetch.
 *
 * With `lean`, the editor-only text fields are cut as well: `body` and
 * `plan.markdown` shrink to a short preview (so "has a plan/notes" checks keep
 * working), `changelog` and `linkedChatIds` are dropped, and `chats` becomes
 * `chatCount`, `chatLastAt`, `latestChat` and `agentChatIds`. The editor loads the full values lazily
 * from `GET /api/todos/:id`.
 *
 * @param {Record<string, any>} item
 * @param {{ lean?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function slimTodoForList(item, options = {}) {
  if (!item || typeof item !== 'object') return item;
  const slim = { ...item };
  delete slim.activity;
  if (options.lean) {
    slim.listSlim = true;
    delete slim.changelog;
    // Redundant with the chat records; only server-side logic reads it.
    delete slim.linkedChatIds;
    if (Array.isArray(item.chats)) {
      // Rows only count open chats, open the newest one and detect running agents
      // by role, so the per-chat records collapse into a few scalars. Everything
      // else lives in GET /api/todos/:id.
      const open = item.chats.filter((chat) => chat && typeof chat === 'object' && !chat.deleted);
      delete slim.chats;
      slim.chatCount = open.length;
      const lastAt = open.map((chat) => String(chat.lastAt || '')).filter(Boolean).sort().pop();
      if (lastAt) slim.chatLastAt = lastAt;
      if (open[0]?.id) slim.latestChat = pickDefined(open[0], ['id', 'harness']);
      const agentIds = open
        .filter((chat) => Array.isArray(chat.roles) && chat.roles.some((role) => LIST_AGENT_CHAT_ROLES.has(role)))
        .map((chat) => chat.id)
        .filter(Boolean);
      if (agentIds.length) slim.agentChatIds = agentIds;
    }
    if (item.review && typeof item.review === 'object') slim.review = compactReviewForList(item.review);
    if (item.worktree && typeof item.worktree === 'object') {
      // Branch, owner and integration state are read only for a live worktree.
      slim.worktree = item.worktree.live === true
        ? pickDefined(item.worktree, ['live', 'ownerTodoId', 'branch', 'integrationState'])
        : { live: false };
    }
    if (item.integrationSummary && typeof item.integrationSummary === 'object') {
      slim.integrationSummary = pickDefined(item.integrationSummary, ['state', 'detail']);
    }
    // Server-side material and run diagnostics; no list consumer reads them.
    delete slim.execution;
    delete slim.leafMaterial;
    if (typeof item.body === 'string' && item.body.length > LEAN_TEXT_PREVIEW_CHARS) {
      slim.body = item.body.trimStart().slice(0, LEAN_TEXT_PREVIEW_CHARS);
    }
    const markdown = item.plan && typeof item.plan === 'object' ? item.plan.markdown : undefined;
    if (typeof markdown === 'string' && markdown.length > LEAN_TEXT_PREVIEW_CHARS) {
      slim.plan = { ...item.plan, markdown: markdown.trimStart().slice(0, LEAN_TEXT_PREVIEW_CHARS) };
    }
  }
  if (item.integration && typeof item.integration === 'object') {
    const { evidence, changedFiles, ...integration } = item.integration;
    slim.integration = options.lean
      ? pickDefined(integration, ['state', 'branch', 'appliedAt', 'reason', 'resultPath'])
      : integration;
  }
  if (!options.lean && item.leafMaterial && typeof item.leafMaterial === 'object') {
    // Per-file hash manifests can reach hundreds of KB per checkpointed leaf and
    // no client reads them; server-side logic reads the stored todo, not this
    // response. Keep a path count so the shape stays informative.
    const { baseManifest, ...leafMaterial } = item.leafMaterial;
    if (baseManifest && typeof baseManifest === 'object') {
      leafMaterial.baseManifestPaths = Object.keys(baseManifest).length;
    }
    const checkpoint = leafMaterial.lastCheckpoint;
    if (checkpoint && typeof checkpoint === 'object' && checkpoint.manifest) {
      const { manifest, ...lastCheckpoint } = checkpoint;
      lastCheckpoint.manifestPaths = Object.keys(manifest).length;
      leafMaterial.lastCheckpoint = lastCheckpoint;
    }
    slim.leafMaterial = leafMaterial;
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
  const provenanceKey = ['feedbackOrigin', 'feedback_origin'].find(
    (candidate) => Object.prototype.hasOwnProperty.call(body, candidate),
  );
  if (provenanceKey) {
    /** @type {Error & { code?: string }} */
    const err = new Error('Feedback origin is server-managed and cannot be set through the API');
    err.code = 'VALIDATION';
    return err;
  }
  const key = SERVER_MANAGED_REVIEW_KEYS.find(
    (candidate) => Object.prototype.hasOwnProperty.call(body, candidate) && body[candidate] !== undefined,
  );
  if (!key) return null;
  /** @type {Error & { code?: string }} */
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
 * @param {Record<string, any>} req
 * @param {Record<string, any>} res
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
 * @property {Record<string, any>} [worktreeDeps]
 * @property {any} [loadWatcherPolicy]
 * @property {any} [probeChatRunLiveness]
 */

/** Upper bound on staleness of the cached list body (other inputs than the todo file). */
const TODOS_LIST_CACHE_TTL_MS = 2000;
/** Length of the body / plan preview kept in a lean list row. */
const LEAN_TEXT_PREVIEW_CHARS = 80;

/**
 * @param {import('express').Express} app
 * @param {TodosRoutesContext} ctx
 */
export function registerTodosRoutes(app, ctx) {
  registerTodoHomeGuard(app, '/api/todos');

  function todosCwd(req) {
    return resolveRequestTodoHome(req, ctx.getCurrentCwd());
  }

  /**
   * First todo in `id`'s subtree that still owns a live worktree, or ''. Used to
   * refuse a delete/re-parent that would orphan a worktree silently.
   *
   * @param {string} cwd
   * @param {string} id
   * @returns {Promise<string>}
   */
  async function worktreeSubtreeConflict(cwd, id) {
    const items = (await listTodos(ctx.dataDir, cwd)).items;
    const subtree = collectTodoSubtreeIds(items, id);
    const live = buildLiveWorktreePredicate(ctx.dataDir);
    return subtree.find((todoId) => live(todoId)) || '';
  }

  /**
   * 409 `integration_locked` while a bulk batch or another single integration
   * owns the workspace.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} cwd
   * @returns {boolean} true when the response was sent
   */
  function refuseWhenIntegrationLocked(req, res, cwd) {
    const gate = checkIntegrationUnlocked({ dataDir: ctx.dataDir, workspaceFolder: cwd });
    if (gate.ok) return false;
    res.status(409).json({
      ok: false,
      error: 'integration_locked',
      message: msg(req, 'integrate.integration_locked'),
      lock: gate.lock,
    });
    return true;
  }

  /**
   * Link the chat to the todo and take the `single` lock. Any failure rolls the
   * `smart_merge_running` marker and the lock back so nothing is stranded.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} cwd
   * @param {{ targetId: string }} built
   * @param {{ id: string }} chat
   * @returns {boolean} false when a response was already sent
   */
  function bindSingleFlow(req, res, cwd, built, chat) {
    const rollback = () => rollbackIntegrationRequest({
      dataDir: ctx.dataDir, workspaceFolder: cwd, targetId: built.targetId, todoId: req.params.id,
    });
    try {
      new Set([built.targetId, req.params.id]).forEach((linkId) => linkTodoChat(ctx.dataDir, cwd, linkId, chat.id));
      const acquired = acquireIntegrationLock({ dataDir: ctx.dataDir, workspaceFolder: cwd, owner: 'single', todoId: built.targetId, chatId: chat.id });
      if (!acquired.ok) {
        rollback();
        res.status(409).json({
          ok: false, error: 'integration_locked', message: msg(req, 'integrate.integration_locked'), lock: acquired.lock,
        });
        return false;
      }
      return true;
    } catch (error) {
      rollback();
      throw error;
    }
  }

  /**
   * Like `refuseWhenIntegrationLocked`, but a `single` lock owned by the named
   * todo (or its resolved target) does not refuse its own owner.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} cwd
   * @param {string} todoId
   * @returns {boolean} true when the response was sent
   */
  function refuseWhenLockedForOthers(req, res, cwd, todoId) {
    const gate = checkIntegrationUnlocked({ dataDir: ctx.dataDir, workspaceFolder: cwd });
    if (gate.ok) return false;
    if (gate.lock?.owner === 'single') {
      const resolved = readIntegrationTarget(ctx.dataDir, cwd, todoId);
      const owned = String(gate.lock.todoId || '');
      if (owned && (owned === todoId || owned === resolved?.targetId)) return false;
    }
    return refuseWhenIntegrationLocked(req, res, cwd);
  }

  // Serialized list responses per workspace. Keyed by the todo file revision;
  // the payload also folds in chats, worktrees and delegations, so entries
  // additionally expire after a short TTL and on any mutating /api/todos call.
  /** @type {Map<string, { at: number, revision: string, body: string, etag: string }>} */
  const listCache = new Map();
  if (typeof app.use === 'function') {
    app.use('/api/todos', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Clear now as well as on finish: test doubles and early errors may
        // never emit 'finish', and a stale list must not survive a write.
        listCache.clear();
        if (typeof res.on === 'function') res.on('finish', () => listCache.clear());
      }
      next();
    });
  }

  /** Todo list for current CWD (JSON in data/todos on server). */
  app.get('/api/todos', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const lean = req.query?.slim === '1' || req.query?.slim === 'true';
      const cacheKey = lean ? `${cwd}\u0000lean` : cwd;
      const revision = getTodosFileRevision(ctx.dataDir, cwd);
      const now = Date.now();
      let entry = revision ? listCache.get(cacheKey) : undefined;
      if (!entry || entry.revision !== revision || now - entry.at > TODOS_LIST_CACHE_TTL_MS) {
        const data = await listTodos(ctx.dataDir, cwd);
        const raw = JSON.stringify(jsonTodosPayload(cwd, data, ctx, { lean }));
        const hash = createHash('sha1').update(raw).digest('base64url');
        const etag = `W/"${hash}"`;
        // `rev` lets the client skip a re-render without diffing the rows. It is
        // spliced in after hashing so the payload is serialized only once.
        const body = `{"rev":"${hash}",${raw.slice(1)}`;
        entry = { at: now, revision, body, etag };
        if (revision) {
          if (listCache.size > 32) listCache.clear();
          listCache.set(cacheKey, entry);
        }
      }
      // Minimal response doubles (tests, embedded callers) only implement json().
      if (typeof res.set !== 'function' || typeof res.send !== 'function') return res.json(JSON.parse(entry.body));
      res.set('ETag', entry.etag);
      res.set('Cache-Control', 'no-cache');
      if (req.fresh) return res.status(304).end();
      res.type('application/json');
      return res.send(entry.body);
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  /**
   * One complete todo (body, plan, changelog) for the editor, which opens from
   * a lean list row. Same enrichment as the list, restricted to one item.
   */
  app.get('/api/todos/:id', async (req, res, next) => {
    // Literal GET routes registered later (`integrate-batch`, ...) share this shape.
    if (req.params.id === 'usage' || req.params.id === 'integrate-batch') return next();
    try {
      const cwd = todosCwd(req);
      const data = await listTodos(ctx.dataDir, cwd);
      const payload = jsonTodosPayload(cwd, data, ctx);
      const item = payload.items.find((row) => row?.id === req.params.id);
      if (!item) {
        /** @type {Error & { code?: string }} */
        const error = new Error('Item not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      return res.json({ ok: true, cwd, item });
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
  app.get('/api/todos/:id/history', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const item = getTodoById(ctx.dataDir, cwd, req.params.id);
      if (!item) {
        /** @type {Error & { code?: string }} */
        const error = new Error('Item not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const entries = buildTodoTimeline(item, listDelegationsForWorkspace(cwd));
      return res.json({ ok: true, todoId: item.id, cwd, entries });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.get('/api/todos/usage', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const loaded = await loadWorkspaceTodoUsage({
        dataDir: ctx.dataDir,
        cwd,
        query: req.query || {},
      });
      if (!loaded.ok) {
        /** @type {Error & { code?: string }} */
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
  app.get('/api/todos/:id/usage', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const loaded = await loadTodoUsage({
        dataDir: ctx.dataDir,
        cwd,
        todoId: req.params.id,
        query: req.query || {},
      });
      if (!loaded.ok) {
        /** @type {Error & { code?: string }} */
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

  app.post('/api/todos', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      const reviewError = rejectServerManagedReview(body);
      if (reviewError) throw reviewError;
      const data = await addTodo(ctx.dataDir, cwd, {
        title: body.title,
        body: body.body,
        status: body.status,
        deferredUntil: body.deferredUntil ?? body.deferred_until,
        deferredReason: body.deferredReason ?? body.deferred_reason,
        idempotencyKey: body.idempotencyKey || body.idempotency_key,
        strictStatus: body.strictStatus === true,
        parentId: body.parentId ?? body.parent_id,
        siblingIndex: body.siblingIndex ?? body.sibling_index,
        assignee: body.assignee,
        runMode: body.runMode ?? body.run_mode,
        nonBlocking: body.nonBlocking ?? body.non_blocking,
        executionMode: body.executionMode ?? body.execution_mode,
        ...{ executionFolder: validateRequestExecutionFolder(req, body.executionFolder ?? body.execution_folder) },
        reviewerPair: body.reviewerPair ?? body.reviewer_pair,
        orchestratorChatId: body.orchestratorChatId ?? body.orchestrator_chat_id,
        sourceTodoId: body.sourceTodoId ?? body.source_todo_id,
        createdByChatId: body.createdByChatId ?? body.created_by_chat_id,
        sourceHarness: body.sourceHarness ?? body.source_harness,
      });
      const createCut = describeBodyTruncation(body.body);
      return res.json({
        ...jsonTodosPayload(cwd, data, ctx),
        item: data.item,
        replayed: data.replayed === true,
        ...(createCut.truncated ? { truncated: true, truncatedChars: createCut.truncated_chars, maxBodyLen: createCut.max_body_len } : {}),
      });
    } catch (err) {
      return jsonTodosError(req, res, err);
    }
  });

  app.patch('/api/todos/:id', async (req, res) => {
    const timingStart = process.env.CRETLI_TODO_TIMING === '1' ? performance.now() : null;
    if (timingStart != null) {
      takeWatcherLockTimings();
      res.once('finish', () => {
        const lock = takeWatcherLockTimings();
        const total = performance.now() - timingStart;
        console.log(
          `[todo-timing] PATCH /api/todos/${req.params.id} status=${res.statusCode} `
          + `total=${total.toFixed(1)}ms lockWait=${(lock?.waitMs ?? 0).toFixed(1)}ms `
          + `lockHold=${(lock?.holdMs ?? 0).toFixed(1)}ms locks=${lock?.acquisitions ?? 0}`,
        );
      });
    }
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      const body = req.body || {};
      const reviewError = rejectServerManagedReview(body);
      if (reviewError) throw reviewError;
      const nextParent = readBodyAlias(body, 'parentId', 'parent_id');
      if (nextParent !== undefined) {
        const current = (await listTodos(ctx.dataDir, cwd)).items.find((row) => row.id === id) || null;
        if (current && readTodoParentId(current) !== String(nextParent || '').trim()) {
          const conflict = await worktreeSubtreeConflict(cwd, id);
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
      const watcherPhasesInput = readBodyAlias(body, 'watcherPhases', 'watcher_phases');
      if (watcherPhasesInput !== undefined && watcherPhasesInput !== null) {
        const phasesError = validatePhasesInput(watcherPhasesInput);
        if (phasesError) {
          /** @type {Error & { code?: string }} */
          const error = new Error(phasesError);
          error.code = 'VALIDATION';
          throw error;
        }
      }
      // Review gate (D1): identity from the signed token only, never body.chatId.
      const reviewGate = await checkReviewGateForTodoWrite({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoId: id,
        patch: { status: body.status },
        caller: resolveReviewGateCallerFromRequest(req),
      });
      const executionFolder = validateRequestExecutionFolder(req, readBodyAlias(body, 'executionFolder', 'execution_folder'));
      if (executionFolder !== undefined) {
        const current = (await listTodos(ctx.dataDir, cwd)).items.find((it) => it.id === id);
        if ((/** @type {any} */ (current)?.executionFolder || '') !== executionFolder) {
          const conflict = await worktreeSubtreeConflict(cwd, id);
          if (conflict) {
            return res.status(409).json({
              ok: false,
              error: 'Cannot change the execution folder while the todo tree has a live worktree',
              code: 'execution_folder_locked',
              conflictTodoId: conflict,
            });
          }
        }
      }
      let data = await updateTodo(ctx.dataDir, cwd, id, {
        executionFolder,
        title: body.title,
        body: body.body,
        status: body.status,
        deferredUntil: readBodyAlias(body, 'deferredUntil', 'deferred_until'),
        deferredReason: readBodyAlias(body, 'deferredReason', 'deferred_reason'),
        chatId: body.chatId,
        // UI approval deliberately carries no approvedBy: provenance is written
        // only by the operator MCP tool, so a REST caller cannot forge it.
        plan: body.plan && typeof body.plan === 'object' ? (({ approvedBy: _ignored, ...rest }) => rest)(body.plan) : body.plan,
        appendChangelog: body.appendChangelog,
        linkedChatId: body.linkedChatId,
        sourceHarness: body.sourceHarness,
        expectedUpdatedAt: body.expectedUpdatedAt || body.expected_updated_at,
        strictStatus: body.strictStatus === true,
        parentId: readBodyAlias(body, 'parentId', 'parent_id'),
        siblingIndex: readBodyAlias(body, 'siblingIndex', 'sibling_index'),
        assignee: body.assignee,
        runMode: readBodyAlias(body, 'runMode', 'run_mode'),
        nonBlocking: readBodyAlias(body, 'nonBlocking', 'non_blocking'),
        executionMode: readBodyAlias(body, 'executionMode', 'execution_mode'),
        reviewerPair: readBodyAlias(body, 'reviewerPair', 'reviewer_pair'),
        orchestratorChatId: readBodyAlias(body, 'orchestratorChatId', 'orchestrator_chat_id'),
        sourceTodoId: readBodyAlias(body, 'sourceTodoId', 'source_todo_id'),
        moveToLater: readBodyAlias(body, 'moveToLater', 'move_to_later'),
        restoreToTree: readBodyAlias(body, 'restoreToTree', 'restore_to_tree'),
        watcherPhases: watcherPhasesInput,
      });
      await reviewGate.afterWrite();
      // Reuse the saved document unless a later writer (review-gate bookkeeping,
      // the `done` checkpoint) touched the file after it.
      if (!isTodosDocCurrent(ctx.dataDir, cwd, data)) data = await listTodos(ctx.dataDir, cwd);
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
        await syncTodoReviewTarget({ todoId: id, workspaceFolder: cwd, dataDir: ctx.dataDir }, { source: 'plan-edit' });
        if (!isTodosDocCurrent(ctx.dataDir, cwd, data)) data = await listTodos(ctx.dataDir, cwd);
      }
      const bodyCut = describeBodyTruncation(body.body);
      return res.json({
        ...jsonTodosPayload(cwd, data, ctx),
        item: slimTodoForList(data.items.find((row) => row.id === id) || null),
        ...(bodyCut.truncated ? { truncated: true, truncatedChars: bodyCut.truncated_chars, maxBodyLen: bodyCut.max_body_len } : {}),
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
  app.post('/api/todos/:id/smart-merge', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      if (refuseWhenIntegrationLocked(req, res, cwd)) return undefined;
      const built = await buildSmartMergeRequest({
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
      const model = resolveTodoStartModel(transport, body.model, ctx.agentModel);
      let chat;
      const chatWorkspace = resolveTodoChatWorkspace(body, ctx.getCurrentWorkspaceFile());
      try {
        chat = addChat(randomUUID(), built.title, chatWorkspace.workspaceFile, body.workspaceFolder || null, model || undefined, {
          workspaceId: chatWorkspace.workspaceId,
          agentTransport: transport,
          sdkMode: 'agent',
          todoId: built.targetId,
        });
      } catch (error) {
        rollbackIntegrationRequest({ dataDir: ctx.dataDir, workspaceFolder: cwd, targetId: built.targetId, todoId: req.params.id });
        throw error;
      }
      // Pin the chat to the todo (history + chats tab) without binding it to the worktree.
      const lock = bindSingleFlow(req, res, cwd, built, chat);
      if (!lock) return undefined;
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
  app.post('/api/todos/:id/verify-integration', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const body = req.body || {};
      if (refuseWhenIntegrationLocked(req, res, cwd)) return undefined;
      const built = buildVerifyIntegrationRequest({ todoId: req.params.id, workspaceFolder: cwd, dataDir: ctx.dataDir });
      if (!built.ok) {
        const status = built.reason === 'not_found' ? 404 : 409;
        return res.status(status).json({ ok: false, error: built.reason || 'verify integration failed' });
      }
      const transport = normalizeAgentTransport(body.agentTransport);
      if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
        return res.status(503).json({ ok: false, error: msg(req, 'sdk.noApiKey') });
      }
      const model = resolveTodoStartModel(transport, body.model, ctx.agentModel);
      let chat;
      const chatWorkspace = resolveTodoChatWorkspace(body, ctx.getCurrentWorkspaceFile());
      try {
        chat = addChat(randomUUID(), built.title, chatWorkspace.workspaceFile, body.workspaceFolder || null, model || undefined, {
          workspaceId: chatWorkspace.workspaceId,
          agentTransport: transport,
          sdkMode: 'agent',
          todoId: built.targetId,
        });
      } catch (error) {
        rollbackIntegrationRequest({ dataDir: ctx.dataDir, workspaceFolder: cwd, targetId: built.targetId, todoId: req.params.id });
        throw error;
      }
      // Pin the chat to the todo (history + chats tab) without binding it to the worktree.
      const lock = bindSingleFlow(req, res, cwd, built, chat);
      if (!lock) return undefined;
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
   *
   * Lock gating: prepare / merge / apply and reject / invalidate are checked in
   * the route; confirm / no-code are checked in lib code for REST and MCP alike.
   * This route is the human attestation, so it passes `humanAttested: true` for
   * those two actions only.
   */
  app.post('/api/todos/:id/integration', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      const body = req.body || {};
      const action = String(body.action || '').trim().toLowerCase();
      const proofBody = body.proof && typeof body.proof === 'object' ? body.proof : body;
      if (action !== 'confirm' && action !== 'reject' && action !== 'prepare' && action !== 'apply' && action !== 'merge' && action !== 'invalidate' && action !== 'no-code') {
        return res.status(400).json({ ok: false, error: 'action must be prepare, merge, apply, confirm, reject, invalidate or no-code' });
      }
      if ((action === 'prepare' || action === 'merge' || action === 'apply') && refuseWhenIntegrationLocked(req, res, cwd)) {
        return undefined;
      }
      // reject / invalidate rewrite integration state a running flow depends on;
      // only the todo owning a `single` lock may do so (that also releases it).
      if ((action === 'reject' || action === 'invalidate') && refuseWhenLockedForOthers(req, res, cwd, id)) {
        return undefined;
      }
      let result;
      if (action === 'prepare') {
        result = await prepareManualTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
        });
      } else if (action === 'merge') {
        result = await mergeWorkspaceTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          deps: ctx.worktreeDeps,
        });
      } else if (action === 'apply') {
        result = await applyWorkspaceTodoIntegration({ todoId: id, workspaceFolder: cwd, dataDir: ctx.dataDir, deps: ctx.worktreeDeps });
      } else if (action === 'confirm') {
        result = confirmWorkspaceTodoIntegration({
          todoId: id,
          workspaceFolder: cwd,
          dataDir: ctx.dataDir,
          // The UI click is the operator's attestation: it must not be refused
          // by a lock owned by an agent. Only this REST path sets the marker.
          humanAttested: true,
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
          // Same human attestation as confirm (see above).
          humanAttested: true,
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
            || result.reason === 'busy' || result.reason === 'integration_locked' || result.reason === 'already_integrated' || result.reason === 'target_commit_not_on_branch'
            || result.reason === 'target_ref_missing' || result.reason === 'material_revision_mismatch' || result.reason === 'git_ownership' ? 409
            : ['invalid_target_branch', 'full_commit_required', 'task_change_link_required', 'expected_revision_required', 'reason_required'].includes(result.reason) ? 400 : 500;
        return res.status(status).json({
          ok: false,
          error: result.reason || 'integration failed',
          conflicts: Array.isArray(result.conflicts) ? result.conflicts : [],
        });
      }
      const data = await listTodos(ctx.dataDir, cwd);
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

  app.delete('/api/todos/:id', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const id = req.params.id;
      // Deleting a subtree that still owns a live worktree would orphan the
      // registry record and its diff; refuse unless the client explicitly
      // confirms the discard with `?force=true`.
      const force = String(req.query?.force || req.body?.force || '') === 'true';
      const conflict = await worktreeSubtreeConflict(cwd, id);
      if (conflict && !force) {
        return res.status(409).json({
          ok: false,
          error: msg(req, 'todo.worktreeDeleteBlocked'),
          code: 'WORKTREE_REGISTRY_CONFLICT',
          conflictTodoId: conflict,
        });
      }
      const { doc, removedItems } = await deleteTodo(ctx.dataDir, cwd, id);
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
   * @returns {Record<string, any> | null}
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
   * @returns {{ status: number, key: string, code?: string, details?: Record<string, any> }}
   */
  function classifyStartError(/** @type {Record<string, any>} */ error) {
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
   * @param {{ cwd: string, todoId: string, body: Record<string, any>, forceNew: boolean, req: Record<string, any> }} input
   * @returns {Promise<Record<string, any>>}
   */
  async function executeTodoAgentStart(input) {
    const { cwd, todoId, body } = input;
    // A refine start is a side chat for the plan review loop: always a fresh
    // chat, and it never takes over the todo's executor chat or its status.
    const initialTodo = /** @type {any} */ (getTodoById(ctx.dataDir, cwd, todoId));
    const initialItems = (await listTodos(ctx.dataDir, cwd)).items;
    const refine = body.mode === 'refine' || (isFeedbackDerivedTodo(initialItems, initialTodo)
      && !String(initialTodo?.plan?.approvedAt || '').trim());
    // A full start is the per-todo orchestrator: a fresh chat that becomes the
    // root's orchestrator_chat_id (unlike refine).
    const full = body.mode === 'full';
    const forceNew = input.forceNew === true || refine || full;
    let todo = getTodoById(ctx.dataDir, cwd, todoId);
    if (!todo) throw { status: 404, key: 'todo.notFound' };
    const allItems = (await listTodos(ctx.dataDir, cwd)).items;
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
          hasActiveAgent: (/** @type {Record<string, any>} */ record) => (Array.isArray(record.chats) ? record.chats : []).some(chatRunBusy),
        });
      } catch (error) {
        const described = describeManualWorktreeError(error);
        throw { status: described.status, key: described.key, code: described.code };
      }
      await updateTodo(ctx.dataDir, cwd, rootId, { executionMode: 'project' });
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
        hasActiveAgent: buildWorktreeActiveAgentCheck(ctx.probeChatRunLiveness),
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
    const hasChildren = allItems.some((/** @type {Record<string, any>} */ row) => String(row?.parentId || '') === todoId);
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
        const unlinked = await updateTodo(ctx.dataDir, cwd, todoId, { chatId: null });
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
      const chatWorkspace = resolveTodoChatWorkspace(body, ctx.getCurrentWorkspaceFile());
      const workspaceFile = chatWorkspace.workspaceFile;
      const workspaceFolder = body.workspaceFolder || null;
      const model = resolveTodoStartModel(transport, body.model || assignee?.model, ctx.agentModel);
      const chatTitle = (`${refine ? '[Todo plan]' : '[Todo]'} ${todo.title || 'Task'}`).slice(0, 120);
      const sdkSessionKey = randomUUID();
      const roleSdkMode = { plan: 'plan', implement: 'agent' }[assignee?.role];
      // Plan mode is never inferred from a missing (or unapproved) plan: an
      // executor start without an explicit `sdkMode` runs in Agent. Only a
      // plan-only assignee role keeps a fresh chat in plan mode, and a
      // forced/full start is always an executor regardless of that role.
      const defaultSdkMode = !forceNew && !hasChildren && roleSdkMode === 'plan' ? 'plan' : 'agent';
      try {
        chat = addChat(sdkSessionKey, chatTitle, workspaceFile, workspaceFolder, model || undefined, {
          workspaceId: chatWorkspace.workspaceId,
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
        const linked = await updateTodo(ctx.dataDir, cwd, todoId, {
          ...(shouldSetDoing ? { status: 'doing' } : {}),
          chatId: chat.id,
          ...(hasChildren || full ? { orchestratorChatId: chat.id } : {}),
          linkedChatId: chat.id,
          sourceHarness: transport,
        });
        todo = linked.items.find((it) => it.id === todoId) || todo;
      }
      // Server-launched TODO execution is an automatic controller even when the
      // user clicked Start: persist it before any child can start.
      markDelegationAutomaticController(chat.id, 'todo_start', { dataDir: ctx.dataDir });
    }
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
    // Opt-in reviewer pool: empty (so prompts stay unchanged) unless enabled.
    const { policies: reviewerPolicies, workPolicies, reviewerPool, reviewerPoolStrict } = resolveTodoReviewerPoliciesForPrompt(cwd, {
      dataDir: ctx.dataDir,
      parentChatId: chat.id,
      todoReviewerPair: todo?.reviewerPair,
    });
    const currentItems = (await listTodos(ctx.dataDir, cwd)).items;
    // The plan gate the tree applies: an approved ancestor plan covers this todo.
    const approvedAncestor = isFeedbackDerivedTodo(currentItems, todo) ? null : findApprovedPlanAncestor(currentItems, todo);
    const initialPrompt = refine
      ? buildTodoRefineInitialPrompt(todo, chat.id, {
        reviewerPool,
        reviewerPoolStrict,
        reviewerPolicies,
        workPolicies,
        previousChats: priorChats,
        planReviewerSession: planReviewerSession || { cooperationMode },
      })
      : full
      ? buildTodoFullOrchestratorPrompt(
        { ...todo, review: currentItems.find((row) => row.id === todoId)?.review || todo.review },
        chat.id,
        { previousChats: priorChats, phases: await resolveFullModePhases(ctx.dataDir, cwd, todoId), approvedAncestor, reviewerPool, reviewerPoolStrict, reviewerPolicies, workPolicies },
      )
      : buildTodoAgentInitialPrompt(todo, chat.id, {
        underFeedbackRoot: isUnderFeedbackRoot(currentItems, todo),
        approvedAncestor,
        previousChats: priorChats,
        hasChildren,
        reviewerPool,
        reviewerPoolStrict,
        reviewerPolicies,
        workPolicies,
      });
    // Review gate (contract §4.1): a human start clears a marker, an agent start
    // (MCP tool, MCP-token REST, widget) keeps it and re-applies the label.
    if (!refine) {
      const reviewCaller = resolveReviewGateCallerFromRequest(input.req);
      const markerInput = { dataDir: ctx.dataDir, workspaceFolder: cwd, todoId };
      if (reviewCaller.kind === 'session') clearReviewGateMarker(markerInput);
      else await reapplyReviewGateLabel(markerInput);
    }
    const data = await listTodos(ctx.dataDir, cwd);
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
      return executeTodoAgentStart({
        cwd,
        todoId: String(todoId || ''),
        body,
        forceNew: body.forceNew === true,
        // An MCP tool start is an agent caller: it must not clear review markers.
        req: { mcpIntegration: { chatId: '' } },
      });
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
   * mode ('refine' starts a plan review-and-refine chat; 'full' starts the per-todo
   * orchestrator that owns orchestrator_chat_id; both imply forceNew).
   */
  app.post('/api/todos/:id/start-agent', async (req, res) => {
    try {
      const cwd = todosCwd(req);
      const todoId = req.params.id;
      const requestedBody = req.body || {};
      const initialItems = (await listTodos(ctx.dataDir, cwd)).items;
      const initialTodo = /** @type {any} */ (getTodoById(ctx.dataDir, cwd, todoId));
      const body = isFeedbackDerivedTodo(initialItems, initialTodo)
        && !String(initialTodo?.plan?.approvedAt || '').trim()
        ? { ...requestedBody, mode: 'refine' }
        : requestedBody;
      const forceNew = body.forceNew === true || body.mode === 'refine' || body.mode === 'full';
      const todo = getTodoById(ctx.dataDir, cwd, todoId);
      if (!todo) return res.status(404).json({ ok: false, error: msg(req, 'todo.notFound') });
      const allItems = (await listTodos(ctx.dataDir, cwd)).items;
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
            /** @type {Record<string, any>} */
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
  app.get('/api/todos/:id/start-agent/status', async (req, res) => {
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
        /** @type {Record<string, any>} */
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
