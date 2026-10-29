import fs from 'node:fs';
import path from 'node:path';
import { isAuthenticated, isAgentSessionRequest, verifyCsrfToken } from '../auth.js';
import { resolveRequestTodoHome, registerTodoHomeGuard } from '../todo-home-http.js';
import { requestDecision, OTHER_ANSWER_ID } from '../decisions/decision-request.js';
import { changeDecision, getDecision } from '../decisions/decision-store.js';
import { executeDecision, syncDecisionCards } from '../decisions/decision-adapters.js';
import { registerTodoChangeListener, withTodoChangeNotificationsSuppressed } from '../persist/todos-store.js';

export function isHumanDecisionRequest(req) {
  return !req.mcpIntegration && !req.widgetAccess && isAuthenticated(req)
    && verifyCsrfToken(req) && !isAgentSessionRequest(req);
}
function audit(dataDir, row) {
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
  app.get('/api/decisions', async (req, res) => {
    try { return res.json(await syncDecisionCards(ctx.dataDir, cwd(req))); }
    catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
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
  app.post('/api/decisions/:id', async (req, res) => {
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
      // Atomic claim: only one concurrent POST wins pending -> deciding; the effect runs only for the winner.
      const claimed = await changeDecision(ctx.dataDir, card.id, expectedRevision, 'deciding', { claimedAt: new Date().toISOString() });
      if (!claimed) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      const leaveClaim = (status, details) => changeDecision(ctx.dataDir, card.id, claimed.revision, status, details, 'deciding');
      let result;
      try {
        result = await withTodoChangeNotificationsSuppressed(() => executeDecision(card, optionId, ctx.dataDir, req.body?.reason));
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
      const decided = await leaveClaim('decided', { optionId, response: result.response || { text: String(req.body?.reason || '').slice(0, 4000) }, decidedAt, decidedBy: { kind: 'human-session' } });
      if (!decided) return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      audit(ctx.dataDir, decided);
      try { await syncDecisionCards(ctx.dataDir, workspaceFolder); }
      catch (error) { console.error('[decisions] post-decision sync failed:', error); }
      return res.json({ ok: true, decision: decided });
    } catch (err) {
      if (err?.code === 'CONFLICT') {
        return res.status(409).json({ ok: false, code: 'CONFLICT', error: 'Decision is stale' });
      }
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
