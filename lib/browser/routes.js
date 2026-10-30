import { invokeDecisionRoute, registerDecisionGateSource } from '../decisions/host-gates.js';
import { loadChats } from '../persist/chats-persist.js';
import { isChatInWorkspace } from '../mcp/builtin/tool-context.js';
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
import { getWorkspacePolicy, resolveBrowserPolicyKey, setWorkspacePolicy } from './policy-store.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { detectBrowserRuntime, resolveCdpEndpoint } from './runtime-detect.js';
import { buildBrowserRuntimeEnv, normalizeCdpAllowlist, normalizeExternalMaxSessions, resolveBrowserCdpConfig } from './cdp-config.js';
import { EXTERNAL_CDP_MAX_SESSIONS_DEFAULT, EXTERNAL_CDP_MAX_SESSIONS_LIMIT } from './constants.js';
import { findWorkspace } from '../persist/workspace-registry.js';
import {
  clearAllStorageState,
  clearWorkspaceStorageState,
  setConsent,
} from './storage-state.js';
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
 * @param {any} ctx
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
 * Policy key for the Settings panel. The panel names the workspace of its tab
 * (`workspaceFile` and/or `workspaceFolder`), so it edits the same policy the
 * agents of that tab read instead of the server's globally selected workspace.
 * An explicit file is honored only when it is a registered workspace; an
 * explicit folder alone is never combined with the global workspace file.
 *
 * @param {any} ctx
 * @param {import('express').Request} req
 * @returns {string}
 */
function policyKeyFor(ctx, req) {
  const settings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings() : loadSettings();
  const explicitFile = String(req.query?.workspaceFile || req.body?.workspaceFile || '').trim();
  const scope = requestScope(ctx, req);
  let base = scope.workspaceFile || scope.cwd;
  if (explicitFile && findWorkspace(settings?.workspaces, explicitFile)) base = explicitFile;
  else if (scope.workspaceFolder) base = scope.workspaceFolder;
  return resolveBrowserPolicyKey(ctx.dataDir, base, settings);
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
 * @param {any} err
 */
function sendError(req, res, err) {
  if (err instanceof BrowserError) {
    const body = { ok: false, error: redactText(err.message), code: err.code };
    if (typeof err.holder === 'string') body.holder = err.holder;
    return res.status(err.status).json(body);
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
 *   navigationConsent?: ReturnType<typeof import('./navigation-consent.js').createNavigationConsentRegistry>|null,
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

  app.get('/api/browser/health', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    // Read-only operator surface: `status` is a read action, so the guard can
    // never block it, but the same mode/plan decision path is applied.
    if (guard(req, res, 'status')) return;
    return res.json({
      ok: true,
      health: manager.healthcheck(),
      metrics: manager.metricsSnapshot(),
    });
  });

  app.get('/api/browser/sessions', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const owner = requestOwnerSessionId(ctx, req);
    const scope = requestScope(ctx, req);
    // An empty workspace never lists another workspace's sessions.
    const sessions = manager.listSessions(owner, scope);
    // The external slot is global; report a holder outside this list so the
    // panel can explain a session limit with an empty list.
    const external = manager.describeExternalHolder?.(owner, scope) || null;
    return res.json({ ok: true, sessions, external });
  });

  app.post('/api/browser/external/release', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'close-session')) return;
    try {
      const result = await manager.releaseExternalSession({ reason: 'external-release' });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
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
        // HAR is opt-in per session; the per-workspace policy flag is read by
        // the manager, so `recordHar: false` changes nothing by default.
        recordHar: req.body?.recordHar === true,
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
        const state = await manager.historyAction(req.params.sessionId, req.params.tabId, owner, /** @type {any} */ (action), requestScope(ctx, req));
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

  // Navigation consent: prompts an agent's out-of-allowlist navigation parks on.
  app.get('/api/browser/consent', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const chatId = String(req.query?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required', code: 'invalid-chat' });
    return res.json({ ok: true, prompts: ctx.navigationConsent?.list(chatId) || [] });
  });

  const replyNavigationConsent = (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (!ctx.navigationConsent) return res.status(404).json({ ok: false, error: 'Consent unavailable', code: 'not-found' });
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required', code: 'invalid-chat' });
    const result = ctx.navigationConsent.resolve(req.params.id, String(req.body?.decision || ''), { chatId });
    if (result.ok) return res.json({ ok: true, origin: result.origin });
    const status = result.code === 'not-found' ? 404 : result.code === 'persist-failed' ? 500 : 400;
    return res.status(status).json({ ok: false, error: result.code, code: result.code });
  };
  app.post('/api/browser/consent/:id', replyNavigationConsent);
  registerDecisionGateSource(ctx.navigationConsent || ctx, (workspaceFolder) => loadChats()
    .filter((chat) => isChatInWorkspace(chat, workspaceFolder))
    .flatMap((chat) => (ctx.navigationConsent?.list(chat.id) || []).map((prompt) => ({
      kind: 'browser_consent', key: `browser:${prompt.chatId}:${prompt.id}`,
      subject: { chatId: prompt.chatId, consentId: prompt.id, updatedAt: String(prompt.createdAt) },
      title: 'Allow browser navigation?', summary: prompt.origin,
      options: [
        { id: 'once', label: 'Allow once', effect: 'Allow this origin for the browser session' },
        { id: 'allow', label: 'Always allow', effect: 'Add this origin to the workspace allowlist' },
        { id: 'deny', label: 'Reject', effect: 'Deny navigation' },
      ],
      resolve: (decision, request) => invokeDecisionRoute(replyNavigationConsent, request, { id: prompt.id }, { chatId: prompt.chatId, decision }),
    }))));

  app.get('/api/browser/policy', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    const key = policyKeyFor(ctx, req);
    return res.json({ ok: true, workspaceKey: key, policy: getWorkspacePolicy(ctx.dataDir, key) });
  });

  app.put('/api/browser/policy', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'policy-write')) return;
    try {
      const key = policyKeyFor(ctx, req);
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

  /** Public view of the external Chrome (CDP) endpoint configuration. */
  const runtimeConfigView = () => {
    const config = resolveBrowserCdpConfig(process.env, loadSettings());
    return {
      source: config.source,
      envLocked: config.envLocked,
      cdpUrl: config.envLocked ? config.url : config.settingsUrl,
      cdpAllowlist: config.envLocked ? config.allowlist : config.settingsAllowlist,
      nativeNetwork: config.nativeNetwork,
      calmPaceMode: config.calmPaceMode,
      maxSessions: config.maxSessions,
      maxSessionsLimit: EXTERNAL_CDP_MAX_SESSIONS_LIMIT,
    };
  };

  app.get('/api/browser/runtime-config', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    return res.json({ ok: true, config: runtimeConfigView(), runtime: manager.getRuntimeStatus() });
  });

  // Saves the external Chrome endpoint from Settings and swaps the driver in
  // place, so no server restart is needed. An env pin always wins, and the swap
  // is refused while a Browser session is alive (its browser was opened by the
  // current driver and must be closed by it).
  app.put('/api/browser/runtime-config', async (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'policy-write')) return;
    try {
      const current = resolveBrowserCdpConfig(process.env, loadSettings());
      const calmPaceMode = typeof req.body?.calmPaceMode === 'boolean' ? req.body.calmPaceMode : current.calmPaceMode;
      const nativeNetwork = typeof req.body?.nativeNetwork === 'boolean' ? req.body.nativeNetwork : current.nativeNetwork;
      // Lowering the cap never closes live sessions; it only gates new ones.
      const maxSessions = req.body?.maxSessions !== undefined
        ? normalizeExternalMaxSessions(req.body.maxSessions)
        : current.maxSessions;
      // The endpoint fields are ignored while .env pins them; the network mode
      // is a Settings-only switch and can always change.
      const cdpUrl = current.envLocked ? current.settingsUrl
        : (typeof req.body?.cdpUrl === 'string' ? req.body.cdpUrl.trim() : current.settingsUrl);
      const cdpAllowlist = current.envLocked ? current.settingsAllowlist
        : (req.body?.cdpAllowlist !== undefined ? normalizeCdpAllowlist(req.body.cdpAllowlist) : current.settingsAllowlist);
      const endpointChanged = cdpUrl !== current.settingsUrl || cdpAllowlist !== current.settingsAllowlist;
      if (endpointChanged && (manager.sessions?.size > 0 || manager.externalSessionReserved)) {
        return res.status(409).json({ ok: false, code: 'sessions-active', error: 'Close the open Browser sessions before switching the browser runtime.' });
      }
      if (endpointChanged && cdpUrl) {
        try {
          await resolveCdpEndpoint(cdpUrl, { allowlist: cdpAllowlist });
        } catch (err) {
          return res.status(400).json({ ok: false, code: 'cdp-unreachable', error: redactText(err?.message || String(err)) });
        }
      }
      const settings = loadSettings();
      if (cdpUrl) settings.browserCdpUrl = cdpUrl;
      else delete settings.browserCdpUrl;
      if (cdpAllowlist) settings.browserCdpAllowlist = cdpAllowlist;
      else delete settings.browserCdpAllowlist;
      if (nativeNetwork) settings.browserCdpNativeNetwork = true;
      else delete settings.browserCdpNativeNetwork;
      if (calmPaceMode) settings.browserCalmPaceMode = true;
      else delete settings.browserCalmPaceMode;
      if (maxSessions !== EXTERNAL_CDP_MAX_SESSIONS_DEFAULT) settings.browserCdpMaxSessions = maxSessions;
      else delete settings.browserCdpMaxSessions;
      delete settings.browserHumanMode;
      saveSettings(settings);
      manager.calmPaceMode = calmPaceMode;
      manager.externalMaxSessions = maxSessions;
      // Read per request by the route handler, so it applies to open sessions too.
      manager.externalNativeNetwork = nativeNetwork;
      if (endpointChanged) {
        const next = await detectBrowserRuntime({ env: buildBrowserRuntimeEnv(process.env, settings) });
        manager.setDriver(next);
      }
      return res.json({ ok: true, config: runtimeConfigView(), runtime: manager.getRuntimeStatus() });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/api/browser/storage-state', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'storage-state-read')) return;
    const scope = requestScope(ctx, req);
    const key = scope.workspaceFile || scope.cwd;
    return res.json({ ok: true, workspaceKey: key, storageState: manager.getStorageStateStatus(key) });
  });

  app.put('/api/browser/storage-state/consent', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'storage-state-write')) return;
    try {
      const scope = requestScope(ctx, req);
      const key = scope.workspaceFile || scope.cwd;
      if (!key) return res.status(400).json({ ok: false, error: 'No workspace selected', code: 'no-workspace' });
      const result = setConsent(ctx.dataDir, key, req.body?.consent === true);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.delete('/api/browser/storage-state', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'storage-state-write')) return;
    try {
      const scope = requestScope(ctx, req);
      const key = scope.workspaceFile || scope.cwd;
      if (!key) return res.status(400).json({ ok: false, error: 'No workspace selected', code: 'no-workspace' });
      const keepConsent = req.query?.keepConsent === '1' || req.body?.keepConsent === true;
      const result = clearWorkspaceStorageState(ctx.dataDir, key, { keepConsent });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.delete('/api/browser/storage-state/all', (req, res) => {
    if (rejectWidgetOrForeignAuth(ctx, req, res)) return;
    if (guard(req, res, 'storage-state-write')) return;
    try {
      const result = clearAllStorageState(ctx.dataDir);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(req, res, err);
    }
  });
}
