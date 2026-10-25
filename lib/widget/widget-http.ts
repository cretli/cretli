/**
 * Widget embed CSP, frame headers, and API scope gate.
 */

import type { IncomingMessage } from 'node:http';
import type { ExpressRequest, ExpressResponse, ExpressNext } from '../shared-types/index.ts';
import { getWidgetInstallation } from './widget-installations.ts';
import { widgetChatAccessScope, type WidgetAccessRecord } from './widget-chat-scope.ts';
import { loadChats } from '../persist/chats-persist.js';
import { msg } from '../messages.js';

type WidgetRes = ExpressResponse & { removeHeader(name: string): void; redirect(url: string): unknown };
type WidgetApp = {
  use(handler: (req: ExpressRequest, res: WidgetRes, next: ExpressNext) => unknown): unknown;
};

/**
 * @param reqPath
 */
export function widgetInstallationIdFromPath(reqPath?: string): string | null {
  const match = String(reqPath || '').match(/^\/embed\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param reqPath
 */
export function widgetInstallationIdFromWidgetAuthPath(reqPath?: string): string | null {
  const match = String(reqPath || '').match(/^\/widget-authorize\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param nextValue
 */
export function widgetInstallationIdFromNext(nextValue: unknown): string | null {
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
 * @param installation
 */
export function widgetFrameAncestors(installation: { allowedOrigins?: string[] } | null): string {
  const origins = Array.isArray(installation?.allowedOrigins)
    ? installation.allowedOrigins
    : [];
  return ["'self'", ...origins].join(' ');
}

/**
 * @param installationId
 */
export function resolveWidgetFrameAncestors(installationId: string | null): string | null {
  if (!installationId) return null;
  try {
    return widgetFrameAncestors(getWidgetInstallation(installationId));
  } catch {
    return null;
  }
}

/**
 * @param res
 * @param installationId
 */
export function applyWidgetFrameHeaders(res: WidgetRes, installationId: string): boolean {
  const frameAncestors = resolveWidgetFrameAncestors(installationId);
  if (!frameAncestors) return false;
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.removeHeader('X-Frame-Options');
  return true;
}

/**
 * @param req
 */
export function resolveWidgetInstallationIdFromRequest(req: ExpressRequest): string | null {
  if (typeof req.params?.installationId === 'string' && req.params.installationId.trim()) {
    return req.params.installationId.trim();
  }
  return widgetInstallationIdFromPath(req.path)
    || widgetInstallationIdFromWidgetAuthPath(req.path)
    || widgetInstallationIdFromNext(req.query?.next);
}

/**
 * @param app
 * @param options
 */
export function installWidgetSecurityHeaders(app: WidgetApp, options: { useHttps: boolean }) {
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
 * @param app
 */
export function installWidgetApiGate(app: WidgetApp) {
  app.use((req, res, next) => {
    if (req.mcpIntegration) {
      const reqPath = String(req.path || '');
      if (reqPath.startsWith('/api/mcp/bridge')) return next();
      return res.status(403).json({ ok: false, error: msg(req as unknown as IncomingMessage, 'widget.endpointUnavailable') });
    }
    const access = req.widgetAccess;
    if (!access) return next();
    const reqPath = String(req.path || '');
    if (reqPath === '/api/chats' && ['GET', 'POST'].includes(req.method)) return next();
    if (reqPath === '/api/chats/history-revisions' && req.method === 'GET') return next();
    if (reqPath === '/api/chats/history-revisions-batch' && req.method === 'POST') return next();
    if (reqPath === '/api/chats/history-batch' && req.method === 'POST') return next();
    if (reqPath === '/api/chats/agent-states' && req.method === 'GET') return next();
    if (reqPath === '/api/delegations/executors' && req.method === 'GET') return next();
    // Global aggregates stay host-only: a widget session may read one delegation
    // it owns via `/:id`, but not the cross-workspace stats feed. This explicit
    // rejection must stay ahead of the `/:id` pattern below.
    if (reqPath === '/api/delegations/stats') {
      return res.status(403).json({ ok: false, error: msg(req as unknown as IncomingMessage, 'widget.endpointUnavailable') });
    }
    if (/^\/api\/delegations\/[^/]+$/.test(reqPath) && req.method === 'GET') return next();
    if (/^\/api\/delegations\/[^/]+\/(cancel|retry|ack|rate)$/.test(reqPath) && req.method === 'POST') return next();
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
    if (reqPath === '/api/claude/status' && req.method === 'GET') return next();
    if (reqPath === '/api/claude/models' && req.method === 'GET') return next();
    if (reqPath === '/api/codex/status' && req.method === 'GET') return next();
    if (reqPath === '/api/codex/models' && req.method === 'GET') return next();
    if (reqPath === '/api/settings' && req.method === 'GET') return next();
    if (reqPath === '/api/workspaces' && req.method === 'GET') return next();
    if (reqPath === '/api/cursor-context' && req.method === 'GET') return next();
    if (reqPath === '/api/upload-screenshot' && req.method === 'POST') return next();
    if (/^\/api\/uploads\/[^/]+$/.test(reqPath) && req.method === 'GET') return next();
    const chatMatch = reqPath.match(/^\/api\/chats\/([^/]+)(?:\/.*)?$/);
    if (!chatMatch) {
      return res.status(403).json({ ok: false, error: msg(req as unknown as IncomingMessage, 'widget.endpointUnavailable') });
    }
    let chatId = '';
    try {
      chatId = decodeURIComponent(chatMatch[1]);
    } catch {
      return res.status(400).json({ ok: false, error: msg(req as unknown as IncomingMessage, 'widget.invalidChatId') });
    }
    const chat = loadChats().find((entry) => entry.id === chatId);
    if (!widgetChatAccessScope(chat, access as WidgetAccessRecord)) {
      return res.status(403).json({ ok: false, error: msg(req as unknown as IncomingMessage, 'widget.chatOutOfScope') });
    }
    return next();
  });
}
