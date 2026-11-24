/**
 * Owner routes of the internal operator (stage 2d). Everything under
 * `/api/operator/internal/*` is human-only: a signed-in browser session with a
 * valid CSRF token. Agent sessions, MCP integrations and widget callers get 403
 * on every route (also GET) so an agent can never read or steer the operator
 * through HTTP.
 *
 *   GET  /status              state chip data (`off|paused|budget|running|queued|idle`)
 *   POST /message             owner message -> `owner_message` event (priority 0)
 *   POST /pause, /resume      owner pause (resume also clears the circuit breaker)
 *   POST /test-event          synthetic `operator_test` event (loopback, registered workspace, 10/h)
 */

import { isLoopbackAddress } from '../local-login.js';
import { getSessionIdFromRequest, isBrowserOwnerSessionActive, verifyCsrfToken } from '../auth.js';
import {
  postOwnerMessage, postTestEvent, readOperatorStatus, setOwnerPause,
} from '../operator/operator-owner.js';

/**
 * Human session check. Reads need the cookie session only; every mutating
 * route also needs the CSRF token (the global middleware checks it too).
 *
 * @param {any} req
 * @param {boolean} mutating
 * @returns {boolean}
 */
export function isOperatorOwnerRequest(req, mutating) {
  if (req.mcpIntegration || req.widgetAccess) return false;
  if (!isBrowserOwnerSessionActive(getSessionIdFromRequest(req))) return false;
  return mutating ? verifyCsrfToken(req) : true;
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string, getCurrentCwd?: () => string, isHuman?: (req: any, mutating: boolean) => boolean,
 *   isLocal?: (req: any) => boolean, ownerOptions?: Record<string, any> }} [ctx] `isHuman`, `isLocal`, `ownerOptions` are test seams
 */
export function registerOperatorInternalRoutes(app, ctx = {}) {
  const store = ctx.dataDir ? { dataDir: ctx.dataDir } : {};
  const isHuman = ctx.isHuman || isOperatorOwnerRequest;
  const isLocal = ctx.isLocal || ((req) => isLoopbackAddress(req.socket?.remoteAddress));
  const options = () => ({ ...store, workspaceFolder: ctx.getCurrentCwd?.(), ...(ctx.ownerOptions || {}) });

  app.use('/api/operator/internal', (req, res, next) => {
    if (isHuman(req, req.method !== 'GET' && req.method !== 'HEAD')) return next();
    return res.status(403).json({ ok: false, error: 'operator_human_only' });
  });

  /** @param {import('express').Response} res @param {any} error */
  const sendError = (res, error) => {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ ok: false, error: String(error?.code || 'operator_failed'), ...(status >= 500 ? {} : { message: String(error?.message || '') }) });
  };

  app.get('/api/operator/internal/status', async (_req, res) => {
    try { return res.json(await readOperatorStatus(options())); } catch (error) { return sendError(res, error); }
  });

  app.post('/api/operator/internal/message', async (req, res) => {
    try { return res.json(await postOwnerMessage({ text: req.body?.text, source: req.body?.source }, options())); } catch (error) { return sendError(res, error); }
  });

  app.post('/api/operator/internal/pause', (_req, res) => {
    try { return res.json({ ok: true, ...setOwnerPause(true, options()) }); } catch (error) { return sendError(res, error); }
  });

  app.post('/api/operator/internal/resume', (_req, res) => {
    try { return res.json({ ok: true, ...setOwnerPause(false, options()) }); } catch (error) { return sendError(res, error); }
  });

  app.post('/api/operator/internal/test-event', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false, error: 'operator_test_local_only' });
    try { return res.json(postTestEvent({ workspaceFolder: req.body?.workspaceFolder }, options())); } catch (error) { return sendError(res, error); }
  });
}
