import { registerDecisionGateChangeListener } from '../decisions/gate-changes.js';
import { syncGateDecisionCards } from '../decisions/gate-adapters.js';
import fs from 'node:fs';
import path from 'node:path';
import { isAuthenticated, isAgentSessionRequest, verifyCsrfToken } from '../auth.js';
import { resolveRequestTodoHome, registerTodoHomeGuard } from '../todo-home-http.js';
import { requestDecision, OTHER_ANSWER_ID } from '../decisions/decision-request.js';
import {
  antiReflexState, computeDecisionMetrics, computeDecisionStats, proposePolicyUpgrades, readAutonomyState, runAutoDecisions,
  undoAutoDecision, writeAutonomyState, gestureCountToday,
} from '../decisions/decision-autonomy.js';
import { changeDecision, getDecision, listDecisionEvents, listDecisionHistory, listDecisions, startDecisionReceiptsRetention } from '../decisions/decision-store.js';
import { applyDecisionContinuation, presentDecision } from '../decisions/decision-continuation.js';
import { executeDecision, syncDecisionCards } from '../decisions/decision-adapters.js';
import { consumeDecisionToken, NEVER_TOKEN_KINDS } from '../decisions/decision-push.js';
import { registerTodoChangeListener, withTodoChangeNotificationsSuppressed } from '../persist/todos-store.js';

export function isHumanDecisionRequest(req) {
  return !req.mcpIntegration && !req.widgetAccess && isAuthenticated(req)
    && verifyCsrfToken(req) && !isAgentSessionRequest(req);
}
/** Immutable snapshot of the answer, appended to the card's event log in the same transaction as `decided`. */
function answeredEvent(optionId, result, at) {
  return { key: 'answered', type: 'answered', at, snapshot: {
    optionId, text: String(result.response?.text || ''), continuation: result.continuation || null,
  } };
}
export function audit(dataDir, row) {
  const file = path.join(dataDir, 'approvals', 'decisions-audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    at: row.decidedAt, id: row.id, kind: row.kind, subject: row.subject,
    optionId: row.optionId, decidedBy: row.decidedBy,
  }) + '\n', { mode: 0o600 });
}
/** A `deciding` claim older than this may be reopened by an explicit human action. */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

export function registerDecisionsRoutes(app, ctx) {
  startDecisionReceiptsRetention(ctx.dataDir);
  const syncing = new Map();
  registerDecisionGateChangeListener(ctx.dataDir, (workspaceFolder, dataDir) => {
    if (dataDir && dataDir !== ctx.dataDir) return;
    if (syncing.has(workspaceFolder)) { syncing.set(workspaceFolder, true); return; }
    syncing.set(workspaceFolder, false);
    setImmediate(async () => {
      try {
        do {
          syncing.set(workspaceFolder, false);
          await syncGateDecisionCards(ctx.dataDir, workspaceFolder);
        } while (syncing.get(workspaceFolder));
      } catch (error) { console.error('[decisions] gate sync failed:', error); }
      finally { syncing.delete(workspaceFolder); }
    });
  });
  registerTodoHomeGuard(app, '/api/decisions');
  registerTodoChangeListener((changedDataDir, changedCwd) => {
    if (changedDataDir === ctx.dataDir) return syncDecisionCards(changedDataDir, changedCwd);
    return undefined;
  });
  const cwd = (req) => resolveRequestTodoHome(req, ctx.getCurrentCwd());
  // Agent-facing create/read endpoint. It never accepts an option or performs a resolution.
  app.post('/api/decisions/request', async (req, res) => {
    try {
      const chatId = req.mcpIntegration?.chatId || req.body?.chatId;
      const result = await requestDecision(ctx.dataDir, { ...req.body, chatId, workspaceFolder: cwd(req) });
      return res.json(result);
    } catch (error) {
      return res.status(error.code === 'OUT_OF_SCOPE' ? 403 : 400).json({ ok: false, error: error.message, code: error.code });
    }
  });
  // Service-worker action endpoint. The single-use push token is the credential (no session/CSRF);
  // it accepts only the Yes/No options of the card it was issued for.
  app.post('/api/decisions/resolve-by-token', async (req, res) => {
    const { token, choice, endpoint } = req.body || {};
    try {
      const used = /** @type {any} */ (consumeDecisionToken(token, { choice, endpoint }));
      if (!used.ok) return res.status(used.reason === 'invalid_choice' ? 400 : 403).json({ ok: false, error: used.reason });
      const card = await getDecision(ctx.dataDir, used.record.decisionId);
      if (card && NEVER_TOKEN_KINDS.includes(card.kind)) return res.status(403).json({ ok: false, error: 'not_allowed' });
      if (!card || card.status !== 'pending' || card.revision !== used.record.revision
        || !card.options.some((o) => o.id === used.optionId)) {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      }
      const claimed = await changeDecision(ctx.dataDir, card.id, card.revision, 'deciding', { claimedAt: new Date().toISOString() });
      if (!claimed) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      const leave = (status, details, event) => changeDecision(ctx.dataDir, card.id, claimed.revision, status, details, 'deciding', event);
      let result;
      try {
        result = await withTodoChangeNotificationsSuppressed(() => executeDecision(card, used.optionId, ctx.dataDir, '', req));
      } catch (error) {
        await leave(error?.code === 'CONFLICT' ? 'stale' : 'pending', {}).catch(() => {});
        throw error;
      }
      if (!result.ok) {
        await leave(result.reason === 'stale' || result.reason === 'conflict' ? 'stale' : 'pending', {});
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: result.reason });
      }
      const decidedAt = new Date().toISOString();
      const decided = await leave('decided', {
        optionId: used.optionId, response: result.response || { text: '' },
        decidedAt, decidedBy: { kind: 'push' }, ...(result.continuation ? { continuation: result.continuation } : {}),
      }, answeredEvent(used.optionId, result, decidedAt));
      if (!decided) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      audit(ctx.dataDir, decided);
      await applyDecisionContinuation(ctx.dataDir, decided.id).catch((e) => console.error('[decisions] continuation failed:', e));
      try { await syncDecisionCards(ctx.dataDir, card.workspaceFolder); } catch (e) { console.error('[decisions] post-decision sync failed:', e); }
      return res.json({ ok: true, decisionId: decided.id, optionId: used.optionId });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'resolve_failed' });
    }
  });
  app.get('/api/decisions', async (req, res) => {
    try {
      const workspaceFolder = cwd(req);
      const synced = await syncDecisionCards(ctx.dataDir, workspaceFolder);
      const autoDecided = await runAutoDecisions(ctx.dataDir, workspaceFolder, (card, optionId) => executeDecision(card, optionId, ctx.dataDir, '', undefined));
      const created = await proposePolicyUpgrades(ctx.dataDir, workspaceFolder);
      const all = await listDecisions(ctx.dataDir, workspaceFolder);
      const { policy } = readAutonomyState(ctx.dataDir);
      const pending = autoDecided.length || created.length ? all.filter((c) => c.status === 'pending') : synced.items;
      const items = await Promise.all(pending.map((c) => (c.kind === 'needs_human' ? presentDecision(ctx.dataDir, c) : c)));
      return res.json({ ...synced, items, autonomy: antiReflexState(all, policy) });
    }
    catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  // History of resolved cards, including automatic decisions with their undo window.
  app.get('/api/decisions/history', async (req, res) => {
    try {
      const page = await listDecisionHistory(ctx.dataDir, cwd(req), { cursor: String(req.query.cursor || ''), limit: Number(req.query.limit) || 50 });
      const items = await Promise.all(page.items.map((c) => (c.kind === 'needs_human' ? presentDecision(ctx.dataDir, c) : c)));
      return res.json({ ok: true, items, nextCursor: page.nextCursor });
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  app.get('/api/decisions/metrics', async (req, res) => {
    try {
      const all = await listDecisions(ctx.dataDir, cwd(req));
      return res.json({ ok: true, metrics: computeDecisionMetrics(all), stats: computeDecisionStats(all) });
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  app.get('/api/decisions/policy', (req, res) => res.json({ ok: true, ...readAutonomyState(ctx.dataDir) }));
  // Thresholds are editable by a human only; the auto-decide kind list changes solely through a `policy_upgrade` card.
  app.put('/api/decisions/policy', (req, res) => {
    if (!isHumanDecisionRequest(req)) return res.status(403).json({ ok: false, error: 'Human session required' });
    const state = readAutonomyState(ctx.dataDir);
    const body = req.body || {};
    for (const key of ['upgradeThreshold', 'dailyGestureLimit', 'controlEvery', 'undoWindowMs']) {
      if (body[key] !== undefined) state.policy[key] = body[key];
    }
    writeAutonomyState(ctx.dataDir, state);
    return res.json({ ok: true, ...readAutonomyState(ctx.dataDir) });
  });
  // Read model of one card (names, question, effects, continuation state) and its paginated event history.
  app.get('/api/decisions/:id', async (req, res) => {
    try {
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== cwd(req)) return res.status(404).json({ ok: false, error: 'Decision not found' });
      return res.json({ ok: true, decision: await presentDecision(ctx.dataDir, card) });
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  app.get('/api/decisions/:id/events', async (req, res) => {
    try {
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== cwd(req)) return res.status(404).json({ ok: false, error: 'Decision not found' });
      const page = await listDecisionEvents(ctx.dataDir, card.id, { cursor: Number(req.query.cursor) || 0, limit: Number(req.query.limit) || 50 });
      return res.json({ ok: true, items: page.items, nextCursor: page.nextCursor });
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  // Human-only retry of a failed/stranded continuation. Never changes the chosen option and never bypasses
  // the scheduler gates; calling it on a settled continuation is a no-op that returns the current state.
  app.post('/api/decisions/:id/continuation/retry', async (req, res) => {
    if (!isHumanDecisionRequest(req)) return res.status(403).json({ ok: false, error: 'Human session required' });
    try {
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== cwd(req)) return res.status(404).json({ ok: false, error: 'Decision not found' });
      if (card.status !== 'decided' || !card.continuation) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'No continuation to retry' });
      const next = await applyDecisionContinuation(ctx.dataDir, card.id, { force: true });
      return res.json({ ok: true, decision: await presentDecision(ctx.dataDir, next || card) });
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  app.post('/api/decisions/:id/undo', async (req, res) => {
    if (!isHumanDecisionRequest(req)) return res.status(403).json({ ok: false, error: 'Human session required' });
    try {
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== cwd(req)) return res.status(404).json({ ok: false, error: 'Decision not found' });
      const result = await undoAutoDecision(ctx.dataDir, card);
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  });
  // Explicit reconciliation of a stranded claim (crash between claim and outcome). Never automatic: a live
  // request or another server process may still be running the effect. The effect re-checks the subject CAS,
  // so re-running it after it already took effect ends as stale instead of applying twice.
  app.post('/api/decisions/:id/reopen', async (req, res) => {
    if (!isHumanDecisionRequest(req)) return res.status(403).json({ ok: false, error: 'Human session required' });
    const { expectedRevision } = req.body || {};
    if (!Number.isSafeInteger(expectedRevision)) return res.status(400).json({ ok: false, error: 'expectedRevision required' });
    try {
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== cwd(req)) return res.status(404).json({ ok: false, error: 'Decision not found' });
      const age = Date.now() - Date.parse(card.claimedAt || '');
      if (card.status !== 'deciding' || card.revision !== expectedRevision) {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is not a stranded claim' });
      }
      if (!(age >= (ctx.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS))) {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Claim is still within its lease' });
      }
      const reopened = await changeDecision(ctx.dataDir, card.id, expectedRevision, 'pending', {}, 'deciding');
      if (!reopened) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision changed' });
      return res.json({ ok: true, decision: reopened });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
  /**
   * Human resolves run one at a time per workspace so the anti-reflex checks (daily gesture cap, every-Nth control
   * card) and the decided write that feeds them cannot interleave across concurrent requests.
   */
  const resolveTails = new Map();
  const serializeResolve = (key, task) => {
    const run = (resolveTails.get(key) || Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    resolveTails.set(key, tail);
    void tail.then(() => { if (resolveTails.get(key) === tail) resolveTails.delete(key); });
    return run;
  };
  app.post('/api/decisions/:id', (req, res) => {
    let key = '';
    try { key = cwd(req); } catch { /* the handler reports the same failure */ }
    return serializeResolve(key, () => resolveDecision(req, res));
  });
  async function resolveDecision(req, res) {
    if (!isHumanDecisionRequest(req)) return res.status(403).json({ ok: false, error: 'Human session required' });
    const { optionId, expectedRevision } = req.body || {};
    if (typeof optionId !== 'string' || !Number.isSafeInteger(expectedRevision)) {
      return res.status(400).json({ ok: false, error: 'optionId and expectedRevision required' });
    }
    try {
      const workspaceFolder = cwd(req);
      const card = await getDecision(ctx.dataDir, req.params.id);
      if (!card || card.workspaceFolder !== workspaceFolder) return res.status(404).json({ ok: false, error: 'Decision not found' });
      if (card.status !== 'pending' || card.revision !== expectedRevision) {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      }
      if (optionId !== OTHER_ANSWER_ID && !card.options.some((option) => option.id === optionId)) return res.status(400).json({ ok: false, error: 'Unknown option' });
      // Anti-reflex: daily gesture cap and control cards that need the details opened.
      const history = await listDecisions(ctx.dataDir, workspaceFolder);
      const { policy } = readAutonomyState(ctx.dataDir);
      const reflex = antiReflexState(history, policy);
      const gesture = req.body?.gesture === true;
      if (gesture && card.kind === 'doc_proposal') return res.status(403).json({ ok: false, error: 'Explicit human action required' });
      if (gesture && gestureCountToday(history) >= policy.dailyGestureLimit) {
        return res.status(429).json({ ok: false, code: 'GESTURE_LIMIT', error: 'Daily gesture limit reached; use the buttons' });
      }
      if (reflex.nextIsControl && (gesture || req.body?.detailsOpened !== true)) {
        return res.status(400).json({ ok: false, code: 'DETAILS_REQUIRED', error: 'Control card: open the details first' });
      }
      // Atomic claim: only one concurrent POST wins pending -> deciding; the effect runs only for the winner.
      const claimed = await changeDecision(ctx.dataDir, card.id, expectedRevision, 'deciding', { claimedAt: new Date().toISOString() });
      if (!claimed) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      const leaveClaim = (status, details, event) => changeDecision(ctx.dataDir, card.id, claimed.revision, status, details, 'deciding', event);
      let result;
      try {
        result = await withTodoChangeNotificationsSuppressed(() => executeDecision(card, optionId, ctx.dataDir, req.body?.reason, req));
      } catch (error) {
        // The effect may have failed before or after writing; its own subject CAS makes a retry safe, so re-open the card.
        await leaveClaim(error?.code === 'CONFLICT' ? 'stale' : 'pending', {}).catch(() => {});
        throw error;
      }
      if (!result.ok) {
        const conflict = result.reason === 'stale' || result.reason === 'conflict';
        await leaveClaim(conflict ? 'stale' : 'pending', {});
        return res.status(conflict ? 409 : 400)
          .json({ ok: false, code: conflict ? 'CONFLICT' : 'VALIDATION', error: result.reason });
      }
      const decidedAt = new Date().toISOString();
      const decided = await leaveClaim('decided', { optionId, response: result.response || { text: String(req.body?.reason || '').slice(0, 4000) }, decidedAt, decidedBy: { kind: 'human-session' },
        ...(result.continuation ? { continuation: result.continuation } : {}),
        decisionMeta: { gesture, detailsOpened: req.body?.detailsOpened === true, openedMs: Number.isFinite(req.body?.openedMs) ? Math.max(0, req.body.openedMs) : null } },
      answeredEvent(optionId, result, decidedAt));
      if (!decided) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      audit(ctx.dataDir, decided);
      // The answer is durable now; applying the continuation is recorded either way and retryable.
      const applied = await applyDecisionContinuation(ctx.dataDir, decided.id).catch((error) => {
        console.error('[decisions] continuation failed:', error);
        return null;
      });
      try { await syncDecisionCards(ctx.dataDir, workspaceFolder); }
      catch (error) { console.error('[decisions] post-decision sync failed:', error); }
      return res.json({ ok: true, decision: await presentDecision(ctx.dataDir, applied || decided) });
    } catch (err) {
      if (err?.code === 'CONFLICT') {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
}
