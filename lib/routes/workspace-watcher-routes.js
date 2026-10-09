/**
 * REST routes for the per-workspace Workspace Watcher.
 *
 * The watcher is keyed by the normalized workspace folder. Reads never create a
 * row (a missing row answers as an `off` default); writes are explicit through
 * PATCH/DELETE. This is the transport the settings UI and the remote MCP client
 * share; the actual semantics live in `lib/workspace-watcher-control.js`.
 */

import path from 'node:path';
import {
  applyWorkspaceWatcherPatch,
  archiveWorkspaceWatcherScoutProfile,
  clearWorkspaceWatcherLoopStop,
  claimNextWorkspaceWatcherTodo,
  createWorkspaceWatcherScoutProfile,
  createWorkspaceWatcherScoutProfileFromTemplate,
  deleteWorkspaceWatcher,
  duplicateWorkspaceWatcherScoutProfile,
  ensureWorkspaceWatcherPinnedChat,
  getWorkspaceWatcherPinnedChat,
  getWorkspaceWatcherScoutHistory,
  getWorkspaceWatcherScoutProfile,
  getWorkspaceWatcherView,
  listWorkspaceWatcherScoutProfiles,
  listWorkspaceWatcherScoutTemplates,
  previewWorkspaceWatcherScoutProfile,
  previewWorkspaceWatcherScoutProfileDraft,
  previewWorkspaceWatcherScoutRestoreDiff,
  toWorkspaceWatcherHttpView,
  resolveWatcherClaimOwner,
  recordWorkspaceWatcherFindings,
  recoverWorkspaceWatcherTodoForOperator,
  reportWorkspaceWatcherCycle,
  resetWorkspaceWatcherPlanRequests,
  restoreWorkspaceWatcherScoutProfileFromTemplate,
  runWorkspaceWatcherCycleNow,
  runWorkspaceWatcherScoutFindings,
  runWorkspaceWatcherScoutNow,
  runWorkspaceWatcherTick,
  saveWorkspaceWatcherTodoPlanDraft,
  updateWorkspaceWatcherScoutProfile,
} from '../workspace-watcher-control.js';
import { getWorkspaceWatcherStats } from '../workspace-watcher-stats.js';
import { broadcastWorkspaceWatcherChanged } from '../workspace-watcher-live.js';
import { suggestExecutionSettings } from '../execution-settings-suggest.js';
import {
  getWorkspaceWatcherRuntimeStatus,
  setWorkspaceWatcherStartsEnabled,
} from '../workspace-watcher-runtime-control.js';
import {
  WORKSPACE_WATCHER_STOP_LOOP_NO_ELIGIBLE,
  WORKSPACE_WATCHER_STOP_LOOP_SAME_FINDINGS,
} from '../workspace-watcher-guardrails.js';

/**
 * @param {unknown} err
 * @returns {400 | 503}
 */
function workspaceWatcherMutationStatus(err) {
  return String(err?.code || '') === 'WORKSPACE_WATCHERS_LOCKED' ? 503 : 400;
}

/**
 * HTTP status for a Scout profile operation: a server-owned revision CAS is a
 * 409, an absent profile is a 404, everything else is a client error (503 when
 * the watcher document itself is locked).
 *
 * @param {unknown} err
 * @returns {400 | 404 | 409 | 503}
 */
function workspaceScoutProfileStatus(err) {
  const code = String(err?.code || '');
  if (code === 'CONFLICT') return 409;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'WORKSPACE_WATCHERS_LOCKED') return 503;
  return 400;
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir: string, getCurrentCwd: () => string }} ctx
 */
export function registerWorkspaceWatcherRoutes(app, ctx) {
  function watcherCwd(req) {
    const explicit = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
    if (explicit) return path.resolve(explicit);
    return ctx.getCurrentCwd();
  }

  // Server-wide maintenance gate shared by every workspace and harness.
  app.get('/api/workspace-watcher/runtime-control', (_req, res) => {
    try {
      return res.json({ ok: true, runtimeControl: getWorkspaceWatcherRuntimeStatus({ dataDir: ctx.dataDir }) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher runtime status failed' });
    }
  });

  app.patch('/api/workspace-watcher/runtime-control', (req, res) => {
    try {
      const body = req.body || {};
      const setting = setWorkspaceWatcherStartsEnabled({
        dataDir: ctx.dataDir,
        startsEnabled: body.startsEnabled,
      });
      broadcastWorkspaceWatcherChanged();
      return res.json({
        ok: true,
        runtimeControl: getWorkspaceWatcherRuntimeStatus({ dataDir: ctx.dataDir }),
        setting,
      });
    } catch (err) {
      const status = String(err?.code || '') === 'VALIDATION' ? 400 : 500;
      return res.status(status).json({ ok: false, error: err?.message || 'workspace watcher runtime update failed' });
    }
  });

  app.get('/api/workspace-watcher', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const view = getWorkspaceWatcherView({ dataDir: ctx.dataDir, workspaceFolder: cwd });
      // The worktree suggestion runs `git rev-parse`; only the form-building
      // (full) fetch asks for it, so the live poll never pays for it.
      const withSuggestion = String(req.query?.suggest ?? '') === '1';
      return res.json({
        ok: true,
        cwd,
        ...toWorkspaceWatcherHttpView(view),
        ...(withSuggestion ? { executionSuggest: suggestExecutionSettings(cwd) } : {}),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher read failed' });
    }
  });

  app.patch('/api/workspace-watcher', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const watcher = applyWorkspaceWatcherPatch({ dataDir: ctx.dataDir, workspaceFolder: cwd, patch: req.body || {} });
      return res.json({ ok: true, cwd, watcher });
    } catch (err) {
      return res.status(workspaceWatcherMutationStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace watcher update failed',
      });
    }
  });

  // Explicit control endpoints: the todo top bar and the settings panel share
  // them, so "pause" never has to synthesize a full PATCH body.
  app.post('/api/workspace-watcher/pause', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const watcher = applyWorkspaceWatcherPatch({ dataDir: ctx.dataDir, workspaceFolder: cwd, patch: { paused: true } });
      return res.json({ ok: true, cwd, watcher });
    } catch (err) {
      return res.status(workspaceWatcherMutationStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace watcher pause failed',
      });
    }
  });

  app.post('/api/workspace-watcher/resume', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const watcher = applyWorkspaceWatcherPatch({ dataDir: ctx.dataDir, workspaceFolder: cwd, patch: { paused: false } });
      return res.json({ ok: true, cwd, watcher });
    } catch (err) {
      return res.status(workspaceWatcherMutationStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace watcher resume failed',
      });
    }
  });

  app.post('/api/workspace-watcher/clear-stop', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const existing = getWorkspaceWatcherView({ dataDir: ctx.dataDir, workspaceFolder: cwd }).watcher;
      const stopReason = String(existing?.stopReason || '').trim();
      const isLoopStop = stopReason === WORKSPACE_WATCHER_STOP_LOOP_NO_ELIGIBLE
        || stopReason === WORKSPACE_WATCHER_STOP_LOOP_SAME_FINDINGS;
      if (isLoopStop) {
        // Full reset: clear failures, backoff, unblock parked todos so the
        // watcher can start fresh instead of immediately re-stopping.
        const result = clearWorkspaceWatcherLoopStop({ dataDir: ctx.dataDir, workspaceFolder: cwd });
        return res.json({ ok: true, cwd, watcher: result.watcher, unblockedTodoIds: result.unblockedTodoIds });
      }
      const watcher = applyWorkspaceWatcherPatch({ dataDir: ctx.dataDir, workspaceFolder: cwd, patch: { stopReason: '' } });
      return res.json({ ok: true, cwd, watcher });
    } catch (err) {
      return res.status(workspaceWatcherMutationStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace watcher clear-stop failed',
      });
    }
  });

  app.get('/api/workspace-watcher/pinned-chat', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      return res.json({ ok: true, cwd, ...getWorkspaceWatcherPinnedChat({ dataDir: ctx.dataDir, workspaceFolder: cwd }) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher pinned chat failed' });
    }
  });

  app.post('/api/workspace-watcher/pinned-chat', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = ensureWorkspaceWatcherPinnedChat({ dataDir: ctx.dataDir, workspaceFolder: cwd });
      return res.status(result.ok ? 200 : 400).json({ ok: result.ok, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher pinned chat failed' });
    }
  });

  app.get('/api/workspace-watcher/decisions', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
      const watcher = getWorkspaceWatcherView({ dataDir: ctx.dataDir, workspaceFolder: cwd }).watcher;
      const decisions = Array.isArray(watcher?.decisions) ? watcher.decisions.slice(-limit) : [];
      return res.json({ ok: true, cwd, decisions });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher decisions failed' });
    }
  });

  // Aggregated monitoring stats for the Settings → Workspace Watcher dashboard
  // (throughput, success rate, stop reasons, top harnesses). Reads the bounded
  // cycle history plus the delegation store; never creates a watcher row.
  app.get('/api/workspace-watcher/stats', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      return res.json({
        ok: true,
        cwd,
        ...getWorkspaceWatcherStats({ dataDir: ctx.dataDir, workspaceFolder: cwd }),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher stats failed' });
    }
  });

  app.delete('/api/workspace-watcher', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      return res.json({ ok: true, cwd, removed: deleteWorkspaceWatcher({ dataDir: ctx.dataDir, workspaceFolder: cwd }) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher delete failed' });
    }
  });

  app.post('/api/workspace-watcher/tick', async (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = await runWorkspaceWatcherTick({ dataDir: ctx.dataDir, workspaceFolder: cwd });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher tick failed' });
    }
  });

  app.post('/api/workspace-watcher/run-cycle', async (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = await runWorkspaceWatcherCycleNow({ dataDir: ctx.dataDir, workspaceFolder: cwd });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher cycle failed' });
    }
  });

  // Scout profiles (stage 4a): CRUD + duplicate/archive/preview/history. These
  // are registered before the generic `/scout` handler; express matches exact
  // paths so neither can shadow the other. Every route honors the same
  // `workspaceFolder` from query/body as the rest of the file.
  //
  // Stage 5.2 adds the template catalog, create-from-template, draft preview and
  // the restore diff/apply pair. The literal `/profiles/from-template` and
  // `/profiles/preview-draft` paths are registered before `/profiles/:id` so a
  // literal path can never be parsed as an id.
  app.get('/api/workspace-watcher/scout/templates', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = listWorkspaceWatcherScoutTemplates({ workspaceFolder: cwd });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout templates list failed',
      });
    }
  });

  app.get('/api/workspace-watcher/scout/profiles', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = listWorkspaceWatcherScoutProfiles({ dataDir: ctx.dataDir, workspaceFolder: cwd });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profiles list failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const profile = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
        ? body.profile
        : body;
      const result = createWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        profile,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile create failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/from-template', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const result = createWorkspaceWatcherScoutProfileFromTemplate({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        templateId: String(body.templateId || body.template_id || '').trim(),
        overrides: body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
          ? body.overrides
          : undefined,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile from-template failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/preview-draft', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const profile = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
        ? body.profile
        : null;
      const result = previewWorkspaceWatcherScoutProfileDraft({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        profile,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout draft preview failed',
      });
    }
  });

  app.get('/api/workspace-watcher/scout/profiles/:id', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = getWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile read failed',
      });
    }
  });

  app.patch('/api/workspace-watcher/scout/profiles/:id', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const profile = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
        ? body.profile
        : body;
      const result = updateWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
        profile,
        expectedRevision: body.expectedRevision ?? body.expected_revision,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile update failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/:id/duplicate', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = duplicateWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile duplicate failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/:id/archive', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = archiveWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile archive failed',
      });
    }
  });

  app.get('/api/workspace-watcher/scout/profiles/:id/preview', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = previewWorkspaceWatcherScoutProfile({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile preview failed',
      });
    }
  });

  app.get('/api/workspace-watcher/scout/profiles/:id/restore-diff', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = previewWorkspaceWatcherScoutRestoreDiff({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
        templateId: String(req.query?.templateId || req.query?.template_id || '').trim() || undefined,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout restore diff failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/:id/restore', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const result = restoreWorkspaceWatcherScoutProfileFromTemplate({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
        expectedRevision: body.expectedRevision ?? body.expected_revision,
        confirm: body.confirm === true,
        templateId: String(body.templateId || body.template_id || '').trim() || undefined,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout restore failed',
      });
    }
  });

  app.post('/api/workspace-watcher/scout/profiles/:id/run', async (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = await runWorkspaceWatcherScoutNow({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: req.params?.id,
      });
      return res.json({ ok: result.ok !== false, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout profile run failed',
      });
    }
  });

  app.get('/api/workspace-watcher/scout/history', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const maxRaw = Number(req.query?.max);
      const result = getWorkspaceWatcherScoutHistory({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        scoutId: String(req.query?.scoutId || req.query?.scout_id || '').trim(),
        max: Number.isFinite(maxRaw) ? maxRaw : undefined,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(workspaceScoutProfileStatus(err)).json({
        ok: false,
        error: err?.message || 'workspace scout history failed',
      });
    }
  });

  // Scout: a separate periodic read-only scan that proposes work. `action=run`
  // (default) starts a scan now; list/accept/reject/submit manage proposals.
  app.get('/api/workspace-watcher/scout', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const maxRaw = Number(req.query?.max);
      const result = runWorkspaceWatcherScoutFindings({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        action: 'list',
        status: String(req.query?.status || '').trim(),
        category: String(req.query?.category || '').trim(),
        scoutId: String(req.query?.scoutId || req.query?.scout_id || '').trim(),
        max: Number.isFinite(maxRaw) ? maxRaw : undefined,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err?.message || 'workspace scout list failed' });
    }
  });

  app.post('/api/workspace-watcher/scout', async (req, res) => {
    const cwd = watcherCwd(req);
    const body = req.body || {};
    const action = String(body.action || 'run').trim().toLowerCase() || 'run';
    try {
      if (action === 'run') {
        const result = await runWorkspaceWatcherScoutNow({
          dataDir: ctx.dataDir,
          workspaceFolder: cwd,
          scoutId: String(body.scoutId || body.scout_id || '').trim() || undefined,
        });
        return res.json({ ok: result.ok !== false, cwd, ...result });
      }
      const result = runWorkspaceWatcherScoutFindings({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        action,
        ids: Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [],
        id: body.id,
        findings: Array.isArray(body.findings) ? body.findings : undefined,
        text: body.text,
        status: body.status,
        category: body.category,
        scoutId: String(body.scoutId || body.scout_id || '').trim(),
        max: body.max,
        sourceChatId: String(body.sourceChatId || body.source_chat_id || '').trim(),
        scanId: String(body.scanId || body.scan_id || '').trim(),
        scoutSubmitToken: String(body.scoutSubmitToken || body.submit_token || body.submitToken || '').trim(),
      });
      return res.json({ ok: result.ok !== false, cwd, ...result });
    } catch (err) {
      const code = String(err?.code || '');
      const status = code === 'VALIDATION' ? 400 : code === 'OUT_OF_SCOPE' ? 403 : 500;
      return res.status(status).json({ ok: false, error: err?.message || 'workspace scout failed' });
    }
  });

  app.post('/api/workspace-watcher/todos/:id/recover', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const todoId = String(req.params?.id || '').trim();
      const body = req.body || {};
      const expectedUpdatedAt = String(
        body.expectedUpdatedAt
        || body.expected_updated_at
        || body.todoRevision
        || '',
      ).trim();
      const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
      const result = recoverWorkspaceWatcherTodoForOperator({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoId,
        expectedUpdatedAt,
        idempotencyKey,
      });
      const outcome = String(result.outcome || '');
      if (outcome === 'conflict') return res.status(409).json({ ok: false, cwd, ...result });
      if (outcome === 'api-error' && result.error?.code === 'VALIDATION') {
        return res.status(400).json({ ok: false, cwd, ...result });
      }
      if (outcome === 'blocked' || outcome === 'user-action' || outcome === 'unknown') {
        return res.status(422).json({ ok: false, cwd, ...result });
      }
      if (outcome === 'already-active') return res.status(409).json({ ok: false, cwd, ...result });
      broadcastWorkspaceWatcherChanged(cwd);
      return res.json({ ok: result.ok === true, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'todo recover failed' });
    }
  });

  app.post('/api/workspace-watcher/claim-next', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const sourceChatId = String(body.sourceChatId || body.source_chat_id || '').trim();
      const requestedClaimChatId = String(body.claimedByChatId || body.claimed_by_chat_id || '').trim();
      if (sourceChatId) {
        const resolved = resolveWatcherClaimOwner({
          dataDir: ctx.dataDir,
          workspaceFolder: cwd,
          sourceChatId,
          requestedClaimChatId,
        });
        if (!resolved.ok) {
          const status = resolved.reason === 'no_claimer' ? 400 : 403;
          return res.status(status).json({ ok: false, cwd, reason: resolved.reason });
        }
        const claim = claimNextWorkspaceWatcherTodo({
          dataDir: ctx.dataDir,
          workspaceFolder: cwd,
          claimedByChatId: resolved.claimedByChatId,
          ttlMs: body.ttlMs,
          maxFailures: Number.isFinite(body.maxFailures) ? Number(body.maxFailures) : undefined,
        });
        return res.json({ ok: true, cwd, ...claim });
      }
      const claimedByChatId = requestedClaimChatId;
      if (!claimedByChatId) {
        return res.status(400).json({ ok: false, cwd, reason: 'no_claimer' });
      }
      const claim = claimNextWorkspaceWatcherTodo({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        claimedByChatId,
        ttlMs: body.ttlMs,
        maxFailures: Number.isFinite(body.maxFailures) ? Number(body.maxFailures) : undefined,
      });
      return res.json({ ok: true, cwd, ...claim });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher claim failed' });
    }
  });

  app.post('/api/workspace-watcher/reset-plan-requests', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = resetWorkspaceWatcherPlanRequests({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoId: String(req.body?.todoId || '').trim(),
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher reset failed' });
    }
  });

  app.post('/api/workspace-watcher/findings', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = recordWorkspaceWatcherFindings({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        hash: String(req.body?.hash || req.body?.findingsHash || '').trim(),
        todoId: String(req.body?.todoId || req.body?.todo_id || '').trim(),
        summary: String(
          req.body?.summary
          || req.body?.findingsText
          || req.body?.findings_text
          || '',
        ).trim(),
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher findings failed' });
    }
  });

  app.post('/api/workspace-watcher/report', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const body = req.body || {};
      const result = reportWorkspaceWatcherCycle({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        sourceChatId: String(body.sourceChatId || body.source_chat_id || '').trim(),
        outcome: body.outcome,
        todoIds: Array.isArray(body.todoIds) ? body.todoIds : body.todo_ids,
        cycleId: String(body.cycleId || body.cycle_id || '').trim(),
        reportId: String(body.reportId || body.report_id || '').trim(),
        message: body.message,
      });
      const status = result.ok
        ? 200
        : result.reason === 'no_cycle' ? 404
          : result.reason === 'not_orchestrator' || result.reason === 'cycle_mismatch' ? 403
            : 400;
      return res.status(status).json({ ok: result.ok, cwd, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'workspace watcher report failed' });
    }
  });

  app.post('/api/workspace-watcher/save-plan', (req, res) => {
    try {
      const cwd = watcherCwd(req);
      const result = saveWorkspaceWatcherTodoPlanDraft({
        dataDir: ctx.dataDir,
        workspaceFolder: cwd,
        todoId: req.body?.todoId,
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
        planMarkdown: req.body?.planMarkdown,
        sourceChatId: req.body?.sourceChatId,
      });
      return res.json({ ok: true, cwd, ...result });
    } catch (err) {
      const status = err?.code === 'CONFLICT' ? 409 : err?.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ ok: false, error: err?.message || 'workspace watcher plan save failed' });
    }
  });
}
