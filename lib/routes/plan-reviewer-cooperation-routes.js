/**
 * HTTP API for plan-reviewer cooperation sessions.
 */

import { msg } from '../messages.js';
import {
  createPlanReviewerSession,
  ensurePlanReviewerSession,
  getPlanReviewerExchangePayload,
  postPlanReviewerCollaborativeMessage,
  refreshPlanReviewerSessionView,
} from '../plan-reviewer-cooperation-service.js';
import {
  getPlanReviewerSessionById,
  listPlanReviewerSessionsForTodo,
} from '../persist/plan-reviewer-sessions-persist.js';
import { normalizePlanReviewerCooperationMode } from '../plan-reviewer-cooperation.js';

/**
 * @param {import('express').Express} app
 * @param {{ dataDir: string }} ctx
 */
export function registerPlanReviewerCooperationRoutes(app, ctx) {
  app.get('/api/todos/:id/plan-reviewer-sessions', (req, res) => {
    try {
      const todoId = String(req.params.id || '').trim();
      const workspaceFolder = String(req.query?.workspaceFolder || req.query?.workspace_folder || '').trim();
      const sessions = listPlanReviewerSessionsForTodo(todoId, workspaceFolder);
      return res.json({ ok: true, sessions });
    } catch {
      return res.status(500).json({ ok: false, error: msg(req, 'todo.saveError') });
    }
  });

  app.post('/api/todos/:id/plan-reviewer-session', (req, res) => {
    try {
      const todoId = String(req.params.id || '').trim();
      const body = req.body || {};
      const workspaceFolder = String(body.workspaceFolder || req.query?.workspaceFolder || '').trim();
      const coordinatorChatId = String(body.coordinatorChatId || body.coordinator_chat_id || '').trim();
      const cooperationMode = normalizePlanReviewerCooperationMode(
        body.cooperationMode ?? body.cooperation_mode,
      );
      const prepareSession = body.reuseCurrentRevision === true ? ensurePlanReviewerSession : createPlanReviewerSession;
      /** @type {Record<string, any>} */
      const created = prepareSession({
        dataDir: ctx.dataDir,
        workspaceFolder,
        todoId,
        coordinatorChatId,
        cooperationMode,
      });
      if (!created.ok) {
        return res.status(created.status).json({ ok: false, error: created.error, code: created.code });
      }
      return res.json({ ok: true, session: created.session });
    } catch {
      return res.status(500).json({ ok: false, error: msg(req, 'todo.saveError') });
    }
  });

  app.get('/api/plan-reviewer-sessions/:sessionId', (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const session = refreshPlanReviewerSessionView(sessionId) || getPlanReviewerSessionById(sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found.', code: 'not_found' });
    }
    return res.json({ ok: true, session });
  });

  app.post('/api/plan-reviewer-sessions/:sessionId/messages', (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const body = req.body || {};
    /** @type {Record<string, any>} */
    const result = postPlanReviewerCollaborativeMessage({
      sessionId,
      delegationId: body.delegationId || body.delegation_id,
      text: body.text,
    });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error, code: result.code });
    }
    return res.json({ ok: true, session: result.session, message: result.message });
  });

  app.get('/api/plan-reviewer-sessions/:sessionId/exchange-payload', (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const delegationId = String(req.query?.delegationId || req.query?.delegation_id || '').trim();
    /** @type {Record<string, any>} */
    const result = getPlanReviewerExchangePayload(sessionId, delegationId);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error, code: result.code });
    }
    return res.json({ ok: true, session: result.session, peerSummaries: result.peerSummaries });
  });
}
