/**
 * REST API for the Browser module (`/api/browser/*`).
 *
 * Security contract:
 * - normal Cretli session auth only — widget access tokens are rejected;
 * - every session/tab operation is scoped to the requesting session, workspace
 *   and (implicitly) this single Cretli instance;
 * - plan/ask mode blocks mutations, agent mode allows them;
 * - all payloads are redacted/bounded by the session manager.
 *
 * This module only registers routes; `requireAuth` is applied globally in
 * server.js (like every other /api route).
 */

import { BrowserError } from './session-manager.js';
import { evaluateBrowserActionGuard } from './guards.js';
import { getWorkspacePolicy, setWorkspacePolicy } from './policy-store.js';
import { normalizeOrigin } from './url-policy.js';
import { redactText } from './redaction.js';

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function requestOwnerSessionId(ctx, req) {
  if (typeof ctx.getOwnerSessionId === 'function') return String(ctx.getOwnerSessionId(req) || '');
  return '';
}

/**
 * @param {import('express').Request} req
 */
function requestScope(ctx, req) {
  const explicitFolder = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
  const workspaceFile = typeof ctx.getCurrentWorkspaceFile === 'function'
    ? String(ctx.getCurrentWorkspaceFile(req) || '')
    : '';
  const cwd = explicitFolder
    || (typeof ctx.getCurrentCwd === 'function' ? String(ctx.getCurrentCwd(req) || '') : '');
  return { workspaceFile, cwd, workspaceFolder: explicitFolder };
}

/**
 * @param {import('express').Request} req
 */
function requestModeInput(req) {
  return {
    mode: req.query?.mode ?? req.body?.mode,
    chatId: req.query?.chatId ?? req.body?.chatId,
  };
}

/**
 * @param {import('express').Response} res
 * @param {import('./guards.js').BrowserGuardDecision} decision
 */
function denyGuard(res, decision) {
  return res.status(403).json({
    ok: false,
    error: decision.reason,
    code: decision.code,
    planModeReadOnly: decision.code === 'plan-mode-readonly',
    mode: decision.mode,
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {unknown} err
 */
function sendError(req, res, err) {
  if (err instanceof BrowserError) {
    return res.status(err.status).json({ ok: false, error: redactText(err.message), code: err.code });
  }
  const status = Number.isInteger(err?.status) ? err.status : 500;
  return res.status(status).json({
    ok: false,
    error: redactText(err?.message || 'Browser error'),
    code: err?.code || 'browser-error',
  });
}

/**
 * Rejects widget-embedded callers: Browser is a first-party, session-auth feature.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was rejected
 */
function rejectWidgetOrForeignAuth(ctx, req, res) {
  if (req.widgetAccess) {
    res.status(403).json({ ok: false, error: 'Browser API is not available to widget tokens', code: 'widget-auth-forbidden' });
    return true;
  }
  const owner = requestOwnerSessionId(ctx, req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'Login required', code: 'auth-required' });
    return true;
  }
  return false;
}

/**
 * @param {{
 *   browserManager: import('./session-manager.js').BrowserSessionManager,
 *   dataDir: string,
 *   getCurrentCwd?: () => string,
 *   getCurrentWorkspaceFile?: () => string|null,
 *   getOwnerSessionId?: (req: import('express').Request) => string,
 * }} ctx
 * @returns {void}
 */
export function registerBrowserRoutes(app, ctx) {
  const manager = ctx.browserManager;

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} action
   * @returns {boolean} true when blocked
   */
  function guard(req, res, action) {
    const decision = evaluateBrowserActionGuard({ action, ...requestModeInput(req) });
    if (!decision.allowed) {
      denyGuard(res, decision);
      return true;
    }
    return false;
  }

  app.get('/api/browser/status', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const runtime = manager.getRuntimeStatus();
    return res.json({
      ok: true,
      runtime,
      limits: runtime.limits,
      namespace: 'browser_*',
      wsPath: '/ws-browser',
    });
  });

  app.get('/api/browser/sessions', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const owner = requestOwnerSessionId(ctx, req);
    const scope = requestScope(ctx, req);
    // An empty workspace never lists another workspace's sessions.
    const sessions = manager.listSessions(owner, scope);
    return res.json({ ok: true, sessions });
  });

  app.post('/api/browser/sessions', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'create-session')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const scope = requestScope(ctx, req);
      if (!scope.workspaceFile && !scope.cwd) {
        return res.status(400).json({ ok: false, error: 'No workspace selected', code: 'no-workspace' });
      }
      const session = await manager.createSession({
        ownerSessionId: owner,
        workspaceFile: scope.workspaceFile,
        workspaceFolder: scope.workspaceFolder,
        cwd: scope.cwd,
        chatId: req.body?.chatId,
        viewport: req.body?.viewport,
      });
      return res.status(201).json({ ok: true, session });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const scope = requestScope(ctx, req);
      return res.json({ ok: true, session: manager.getSessionSummary(req.params.sessionId, owner, scope) });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.delete('/api/browser/sessions/:sessionId', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'close-session')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const result = await manager.closeSession(req.params.sessionId, owner, {
        reason: 'api-close',
        scope: requestScope(ctx, req),
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/api/browser/sessions/:sessionId/bind', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'create-session')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const session = manager.bindChat(
        req.params.sessionId,
        owner,
        { chatId: req.body?.chatId },
        requestScope(ctx, req),
      );
      return res.json({ ok: true, session });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId/tabs', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const tabs = manager.listTabs(req.params.sessionId, owner, requestScope(ctx, req));
      return res.json({ ok: true, tabs });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/api/browser/sessions/:sessionId/tabs', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'create-tab')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const tab = await manager.createTab(
        req.params.sessionId,
        owner,
        { url: req.body?.url, activate: req.body?.activate },
        { scope: requestScope(ctx, req) },
      );
      return res.status(201).json({ ok: true, tab });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/api/browser/sessions/:sessionId/tabs/:tabId/select', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'select-tab')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const tab = manager.selectTab(req.params.sessionId, req.params.tabId, owner, requestScope(ctx, req));
      return res.json({ ok: true, tab });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.delete('/api/browser/sessions/:sessionId/tabs/:tabId', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'close-tab')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const result = await manager.closeTab(req.params.sessionId, req.params.tabId, owner, requestScope(ctx, req));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/api/browser/sessions/:sessionId/tabs/:tabId/navigate', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'navigate')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const state = await manager.navigate(
        req.params.sessionId,
        req.params.tabId,
        req.body?.url,
        owner,
        requestScope(ctx, req),
      );
      return res.json({ ok: true, state });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  for (const action of ['back', 'forward', 'reload']) {
    app.post(`/api/browser/sessions/:sessionId/tabs/:tabId/${action}`, async (req, res) => {
      if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
      if (guard(req, res, action)) return;
      try {
        const owner = requestOwnerSessionId(ctx, req);
        const state = await manager.historyAction(req.params.sessionId, req.params.tabId, owner, action, requestScope(ctx, req));
        return res.json({ ok: true, state });
      } catch (err) {
        return sendError(req, res, err);
      }
    });
  }

  app.get('/api/browser/sessions/:sessionId/tabs/:tabId/state', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const state = await manager.getState(req.params.sessionId, req.params.tabId, owner, requestScope(ctx, req));
      return res.json({ ok: true, state });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId/tabs/:tabId/screenshot', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const frame = await manager.screenshot(req.params.sessionId, req.params.tabId, owner, {
        quality: req.query?.quality,
        // Manual refresh hint. It never removes the cap: the manager still
        // enforces its per-tab interval (REST and WS share the same limits), so
        // a public caller cannot stream frames.
        force: req.query?.force === '1' || req.query?.force === 'true',
        ...requestScope(ctx, req),
      });
      return res.json({ ok: true, frame });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId/tabs/:tabId/dom', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const dom = await manager.getDom(req.params.sessionId, req.params.tabId, owner, {
        ...requestScope(ctx, req),
        maxBytes: req.query?.maxBytes,
      });
      return res.json({ ok: true, channel: 'dom', dom });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/api/browser/sessions/:sessionId/tabs/:tabId/input', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'input')) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const result = await manager.dispatchInput(
        req.params.sessionId,
        req.params.tabId,
        owner,
        req.body?.event || req.body || {},
        requestScope(ctx, req),
      );
      return res.json({ ok: true, result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId/tabs/:tabId/console', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const payload = manager.pullConsole(req.params.sessionId, req.params.tabId, owner, {
        since: req.query?.since,
        limit: req.query?.limit,
      }, requestScope(ctx, req));
      return res.json({ ok: true, channel: 'console', ...payload });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/sessions/:sessionId/tabs/:tabId/network', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    try {
      const owner = requestOwnerSessionId(ctx, req);
      const payload = manager.pullNetwork(req.params.sessionId, req.params.tabId, owner, {
        since: req.query?.since,
        limit: req.query?.limit,
      }, requestScope(ctx, req));
      return res.json({ ok: true, channel: 'network', ...payload });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/policy', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const scope = requestScope(ctx, req);
    const key = scope.workspaceFile || scope.cwd;
    return res.json({ ok: true, workspaceKey: key, policy: getWorkspacePolicy(ctx.dataDir, key) });
  });

  app.put('/api/browser/policy', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'policy-write')) return;
    try {
      const scope = requestScope(ctx, req);
      const key = scope.workspaceFile || scope.cwd;
      if (!key) return res.status(400).json({ ok: false, error: 'No workspace selected', code: 'no-workspace' });
      const patch = req.body?.policy || req.body || {};
      // Normalize origins eagerly so a stored policy can never contain garbage.
      if (Array.isArray(patch.allowedOrigins)) {
        patch.allowedOrigins = patch.allowedOrigins.map(normalizeOrigin).filter(Boolean);
      }
      const policy = setWorkspacePolicy(ctx.dataDir, key, patch);
      return res.json({ ok: true, workspaceKey: key, policy });
    } catch (err) {
      return sendError(req, res, err);
    }
  });
}
