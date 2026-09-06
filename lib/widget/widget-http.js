/**
 * Widget embed CSP, frame headers, and API scope gate.
 */

import { getWidgetInstallation } from './widget-installations.js';
import { widgetChatAccessScope } from './widget-chat-scope.js';
import { loadChats } from '../persist/chats-persist.js';
import { msg } from '../messages.js';

/**
 * @param {string} [reqPath]
 * @returns {string | null}
 */
export function widgetInstallationIdFromPath(reqPath) {
  const match = String(reqPath || '').match(/^\/embed\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param {string} [reqPath]
 * @returns {string | null}
 */
export function widgetInstallationIdFromWidgetAuthPath(reqPath) {
  const match = String(reqPath || '').match(/^\/widget-authorize\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} nextValue
 * @returns {string | null}
 */
export function widgetInstallationIdFromNext(nextValue) {
  if (typeof nextValue !== 'string' || !nextValue.trim()) return null;
  const match = nextValue.match(/\/widget-authorize\/([^/?&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param {{ allowedOrigins?: string[] } | null} installation
 * @returns {string}
 */
export function widgetFrameAncestors(installation) {
  const origins = Array.isArray(installation?.allowedOrigins)
    ? installation.allowedOrigins
    : [];
  return ["'self'", ...origins].join(' ');
}

/**
 * @param {string | null} installationId
 * @returns {string | null}
 */
export function resolveWidgetFrameAncestors(installationId) {
  if (!installationId) return null;
  try {
    return widgetFrameAncestors(getWidgetInstallation(installationId));
  } catch {
    return null;
  }
}

/**
 * @param {import('express').Response} res
 * @param {string} installationId
 * @returns {boolean}
 */
export function applyWidgetFrameHeaders(res, installationId) {
  const frameAncestors = resolveWidgetFrameAncestors(installationId);
  if (!frameAncestors) return false;
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.removeHeader('X-Frame-Options');
  return true;
}

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function resolveWidgetInstallationIdFromRequest(req) {
  if (typeof req.params?.installationId === 'string' && req.params.installationId.trim()) {
    return req.params.installationId.trim();
  }
  return widgetInstallationIdFromPath(req.path)
    || widgetInstallationIdFromWidgetAuthPath(req.path)
    || widgetInstallationIdFromNext(req.query?.next);
}

/**
 * @param {import('express').Express} app
 * @param {{ useHttps: boolean }} options
 */
export function installWidgetSecurityHeaders(app, options) {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    const installationId = resolveWidgetInstallationIdFromRequest(req);
    const frameAncestors = resolveWidgetFrameAncestors(installationId);
    if (frameAncestors) {
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    } else if (installationId) {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    } else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      if (String(req.path || '').startsWith('/widget-authorize/')) {
        res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
      }
    }
    if (options.useHttps) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });
}

/**
 * @param {import('express').Express} app
 */
export function installWidgetApiGate(app) {
  app.use((req, res, next) => {
    if (req.mcpIntegration) {
      const reqPath = String(req.path || '');
      if (reqPath.startsWith('/api/mcp/bridge')) return next();
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const access = req.widgetAccess;
    if (!access) return next();
    const reqPath = String(req.path || '');
    if (reqPath === '/api/chats' && ['GET', 'POST'].includes(req.method)) return next();
    if (reqPath === '/api/chats/history-revisions' && req.method === 'GET') return next();
    if (reqPath === '/api/chats/agent-states' && req.method === 'GET') return next();
    if (reqPath === '/api/delegations/executors' && req.method === 'GET') return next();
    if (/^\/api\/delegations\/[^/]+$/.test(reqPath) && req.method === 'GET') return next();
    if (/^\/api\/delegations\/[^/]+\/(cancel|retry|ack)$/.test(reqPath) && req.method === 'POST') return next();
    if (reqPath === '/api/agent-sdk' && req.method === 'GET') return next();
    if (reqPath === '/api/openrouter/status' && req.method === 'GET') return next();
    if (reqPath === '/api/openrouter/models' && req.method === 'GET') return next();
    if (reqPath === '/api/opencode/status' && req.method === 'GET') return next();
    if (reqPath === '/api/opencode/models' && req.method === 'GET') return next();
    if (reqPath === '/api/codebuddy/status' && req.method === 'GET') return next();
    if (reqPath === '/api/codebuddy/models' && req.method === 'GET') return next();
    if (reqPath === '/api/deepseek/status' && req.method === 'GET') return next();
    if (reqPath === '/api/deepseek/models' && req.method === 'GET') return next();
    if (reqPath === '/api/qwen/status' && req.method === 'GET') return next();
    if (reqPath === '/api/qwen/models' && req.method === 'GET') return next();
    if (reqPath === '/api/codex/status' && req.method === 'GET') return next();
    if (reqPath === '/api/codex/models' && req.method === 'GET') return next();
    if (reqPath === '/api/settings' && req.method === 'GET') return next();
    if (reqPath === '/api/workspaces' && req.method === 'GET') return next();
    if (reqPath === '/api/cursor-context' && req.method === 'GET') return next();
    if (reqPath === '/api/upload-screenshot' && req.method === 'POST') return next();
    if (/^\/api\/uploads\/[^/]+$/.test(reqPath) && req.method === 'GET') return next();
    const chatMatch = reqPath.match(/^\/api\/chats\/([^/]+)(?:\/.*)?$/);
    if (!chatMatch) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    let chatId = '';
    try {
      chatId = decodeURIComponent(chatMatch[1]);
    } catch {
      return res.status(400).json({ ok: false, error: msg(req, 'widget.invalidChatId') });
    }
    const chat = loadChats().find((entry) => entry.id === chatId);
    if (!widgetChatAccessScope(chat, access)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.chatOutOfScope') });
    }
    return next();
  });
}
