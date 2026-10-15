import { randomUUID } from 'crypto';
import path from 'path';
import { addChat } from '../persist/chats-persist.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import { readWorktreeRegistry } from '../persist/worktree-registry-persist.js';
import { buildSmartMergeRequest, readIntegrationTarget, rejectWorkspaceTodoIntegration, rollbackIntegrationRequest } from '../workspace-watcher-integration.js';
import { GIT_BRANCH_MERGE_MODE } from '../worktree-merge.js';
import { listWorkspaceWorktrees, readWorktreeDiff, readWorktreeMergePreview } from '../worktree-list.js';
import { removeWorktree } from '../worktree-manager.js';
import { worktreeRegistryOptions } from '../workspace-watcher-worktree.js';
import { describeManualWorktreeError } from '../todo-worktree-manual.js';
import { runGit } from '../worktree/git-worktree.js';
import { msg } from '../messages.js';
import { acquireIntegrationLock, checkIntegrationUnlocked } from '../integration-lock.js';

/** Preflight blockers and integration refusals that are a state conflict, not a bad request. */
const CONFLICT_REASONS = new Set([
  'workspace_busy', 'dirty_workspace', 'merge_in_progress', 'detached_head', 'same_branch',
  'branch_missing', 'worktree_missing', 'repo_unavailable', 'no_worktree', 'busy', 'not_ready',
  'conflict', 'already_applied', 'already_integrated', 'integration_locked',
]);

/**
 * Worktree list and merge actions. Every location comes from a server-side
 * registry record; a client only names a todo id.
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
 *   probeChatRunLiveness?: (input: { chatId: string }) => { known?: boolean, busy?: boolean },
 * }} ctx
 */
export function registerWorktreesRoutes(app, ctx) {
  /**
   * @param {import('express').Request} req
   * @returns {string}
   */
  function workspaceOf(req) {
    const explicit = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
    return explicit ? path.resolve(explicit) : ctx.getCurrentCwd();
  }

  /**
   * @param {string} chatId
   * @returns {boolean}
   */
  function chatRunBusy(chatId) {
    if (typeof ctx.probeChatRunLiveness !== 'function' || !chatId) return false;
    try {
      const result = ctx.probeChatRunLiveness({ chatId });
      return Boolean(result && result.known === true && result.busy === true);
    } catch {
      return false;
    }
  }

  /**
   * @param {string} todoId
   * @param {string} workspaceFolder
   * @returns {object | null}
   */
  function readOwnedRecord(todoId, workspaceFolder) {
    const record = readWorktreeRegistry({ dataDir: ctx.dataDir }).items?.[todoId];
    if (!record) return null;
    if (path.resolve(String(record.workspaceFolder || '')) !== path.resolve(workspaceFolder)) return null;
    return record;
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
   * Like `refuseWhenIntegrationLocked`, but the todo owning a `single` lock (or
   * its resolved target) may still act on itself.
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

  app.get('/api/worktrees/list', (req, res) => {
    try {
      const folder = workspaceOf(req);
      if (!folder) return res.status(400).json({ ok: false, error: 'workspaceFolder is required' });
      const listed = listWorkspaceWorktrees({ dataDir: ctx.dataDir, workspaceFolder: folder });
      return res.json({ ok: true, workspaceFolder: folder, ...listed });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'worktree list failed' });
    }
  });

  app.get('/api/worktrees/:todoId/diff', (req, res) => {
    try {
      const result = readWorktreeDiff({ dataDir: ctx.dataDir, workspaceFolder: workspaceOf(req), todoId: String(req.params.todoId) });
      if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json({ ok: false, error: result.reason });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'diff failed' });
    }
  });

  app.get('/api/worktrees/:todoId/merge-preview', (req, res) => {
    try {
      const result = readWorktreeMergePreview({ dataDir: ctx.dataDir, workspaceFolder: workspaceOf(req), todoId: String(req.params.todoId) });
      if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json({ ok: false, error: result.reason });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'preview failed' });
    }
  });

  /**
   * Start the git-level merge chat. Preflight runs first and a refusal leaves
   * the todo untouched. The chat runs in the main project folder and is not
   * bound to the worktree.
   */
  app.post('/api/worktrees/:todoId/merge', (req, res) => {
    try {
      const cwd = workspaceOf(req);
      const body = req.body || {};
      const todoId = String(req.params.todoId);
      if (!readOwnedRecord(todoId, cwd)) return res.status(404).json({ ok: false, error: 'not_found' });
      if (refuseWhenIntegrationLocked(req, res, cwd)) return undefined;
      const transport = normalizeAgentTransport(body.agentTransport);
      if (transport === 'sdk' && !getEffectiveCursorApiKey()) {
        return res.status(503).json({ ok: false, error: msg(req, 'sdk.noApiKey') });
      }
      const built = buildSmartMergeRequest({
        todoId,
        workspaceFolder: cwd,
        dataDir: ctx.dataDir,
        mode: GIT_BRANCH_MERGE_MODE,
        instructions: body.instructions,
        baseUrl: ctx.getLocalCallbackBaseUrl(),
        insecureTls: ctx.useHttps,
        deps: ctx.worktreeDeps,
      });
      if (!built.ok) {
        const status = built.reason === 'not_found' ? 404 : CONFLICT_REASONS.has(built.reason || '') ? 409 : 500;
        return res.status(status).json({ ok: false, error: built.reason || 'merge failed', blockers: built.blockers || [] });
      }
      const model = String(body.model || ctx.agentModel || '').trim();
      const rollback = () => rollbackIntegrationRequest({ dataDir: ctx.dataDir, workspaceFolder: cwd, targetId: built.targetId, todoId });
      let chat;
      try {
        chat = addChat(randomUUID(), built.title, body.workspaceFile || ctx.getCurrentWorkspaceFile(), cwd, model || undefined, {
          agentTransport: transport,
          sdkMode: 'agent',
        });
        const acquired = acquireIntegrationLock({ dataDir: ctx.dataDir, workspaceFolder: cwd, owner: 'single', todoId: built.targetId, chatId: chat.id });
        if (!acquired.ok) {
          rollback();
          return res.status(409).json({
            ok: false, error: 'integration_locked', message: msg(req, 'integrate.integration_locked'), lock: acquired.lock,
          });
        }
      } catch (error) {
        rollback();
        throw error;
      }
      return res.json({ ok: true, chat, initialPrompt: built.prompt, targetId: built.targetId });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'merge failed' });
    }
  });

  app.post('/api/worktrees/:todoId/reject', (req, res) => {
    try {
      const cwd = workspaceOf(req);
      const todoId = String(req.params.todoId);
      if (!readOwnedRecord(todoId, cwd)) return res.status(404).json({ ok: false, error: 'not_found' });
      if (refuseWhenLockedForOthers(req, res, cwd, todoId)) return undefined;
      const result = rejectWorkspaceTodoIntegration({
        todoId,
        workspaceFolder: cwd,
        dataDir: ctx.dataDir,
        reason: req.body?.reason,
      });
      if (!result.ok) {
        const status = result.reason === 'not_found' ? 404 : CONFLICT_REASONS.has(result.reason || '') ? 409 : 500;
        return res.status(status).json({ ok: false, error: result.reason || 'reject failed' });
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'reject failed' });
    }
  });

  /**
   * Remove the worktree directory (and, on request, its fully merged branch).
   * An unintegrated worktree needs `discard: true` plus `confirmBranch` echoing
   * the recorded branch; the path and branch used are always the record's own.
   */
  app.post('/api/worktrees/:todoId/cleanup', (req, res) => {
    try {
      const cwd = workspaceOf(req);
      const body = req.body || {};
      const todoId = String(req.params.todoId);
      const record = readOwnedRecord(todoId, cwd);
      if (!record) return res.status(404).json({ ok: false, error: 'not_found' });
      if (refuseWhenIntegrationLocked(req, res, cwd)) return undefined;
      const discard = body.discard === true && String(body.confirmBranch || '') === String(record.branch || '');
      if (body.discard === true && !discard) {
        return res.status(400).json({ ok: false, error: 'confirm_branch_mismatch' });
      }
      let removal;
      try {
        removal = removeWorktree({
          todoId,
          registryOptions: worktreeRegistryOptions(ctx.dataDir),
          hasActiveAgent: (row) => (Array.isArray(row.chats) ? row.chats : []).some(chatRunBusy),
          ...(discard ? { confirmation: { discard: true, worktreePath: record.worktreePath, branch: record.branch } } : {}),
        });
      } catch (error) {
        const described = describeManualWorktreeError(error);
        return res.status(described.status).json({ ok: false, error: described.code || 'cleanup_failed', message: msg(req, described.key) });
      }
      let branchDeleted = false;
      let branchMessage = '';
      if (body.deleteBranch === true) {
        // `-d` only deletes a fully merged branch: unmerged work is never lost here.
        const repoRoot = String(record.repoRoot || record.workspaceFolder || '');
        const result = runGit(['branch', '-d', String(record.branch)], repoRoot, { allowFailure: true });
        branchDeleted = result.status === 0;
        branchMessage = branchDeleted ? '' : (result.stderr.trim() || 'branch not deleted');
      }
      return res.json({ ok: true, removed: removal.removed === true, alreadyCleaned: removal.alreadyCleaned === true, branchDeleted, branchMessage });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'cleanup failed' });
    }
  });
}
