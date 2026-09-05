import {
  AUTH_COOKIE_NAME_HTTP_FALLBACK,
  buildClearCookieHeader,
  buildSessionCookieHeader,
  clearSession,
  createSession,
  getCsrfTokenForRequest,
  getCsrfTokenForSessionToken,
  isAuthConfigured,
  isAuthenticated,
  isLanExposed,
  setPassword,
  verifyCsrfToken,
  verifyPassword,
} from '../auth.js';
import { readSetupToken } from '../bind-host.js';
import { msg } from '../messages.js';

const AUTH_RATE_LIMIT_MAX = 10;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const authRateLimit = new Map();

/**
 * @param {string} ip
 * @returns {boolean}
 */
function checkAuthRateLimit(ip) {
  const now = Date.now();
  const entry = authRateLimit.get(ip);
  if (!entry || now - entry.firstAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    authRateLimit.set(ip, { firstAt: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= AUTH_RATE_LIMIT_MAX;
}

/**
 * @param {string} ip
 */
function resetAuthRateLimit(ip) {
  authRateLimit.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authRateLimit) {
    if (!entry || now - entry.firstAt > AUTH_RATE_LIMIT_WINDOW_MS) authRateLimit.delete(ip);
  }
}, AUTH_RATE_LIMIT_WINDOW_MS).unref();

/**
 * @typedef {Object} AuthRoutesContext
 * @property {boolean} useHttps
 * @property {(installationId: string, params: { origin: string, pageSessionId: string }) => object} buildWidgetAuthorizationPayload
 * @property {(req: import('express').Request) => boolean} isWidgetAuthRequest
 * @property {(query?: object, body?: object) => { origin: string, pageSessionId: string } | null} parseWidgetAuthParams
 */

/**
 * @param {string} token
 * @param {boolean} useHttps
 * @returns {string|string[]}
 */
function buildLoginSessionCookiesForToken(token, useHttps) {
  const primaryCookie = buildSessionCookieHeader(token, { https: useHttps });
  if (useHttps) return primaryCookie;
  return [
    primaryCookie,
    buildSessionCookieHeader(token, {
      https: false,
      cookieName: AUTH_COOKIE_NAME_HTTP_FALLBACK,
    }),
  ];
}

/**
 * @param {import('express').Response} res
 * @param {object} body
 * @returns {void}
 */
function applyCsrfCacheControl(res, body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'csrfToken')) return;
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * @param {import('express').Response} res
 * @param {object} body
 * @param {number} [status]
 * @returns {import('express').Response}
 */
function sendAuthJson(res, body, status = 200) {
  applyCsrfCacheControl(res, body);
  if (status !== 200) return res.status(status).json(body);
  return res.json(body);
}

/**
 * @param {boolean} useHttps
 * @returns {string|string[]}
 */
function buildLogoutSessionCookies(useHttps) {
  const primaryCookie = buildClearCookieHeader({ https: useHttps });
  if (useHttps) return primaryCookie;
  return [
    primaryCookie,
    buildClearCookieHeader({
      https: false,
      cookieName: AUTH_COOKIE_NAME_HTTP_FALLBACK,
    }),
  ];
}

/**
 * @param {import('express').Express} app
 * @param {AuthRoutesContext} ctx
 */
export function registerAuthRoutes(app, ctx) {
  function logoutHandler(req, res) {
    if (isAuthenticated(req) && !verifyCsrfToken(req)) {
      return res.status(403).json({
        ok: false,
        error: msg(req, 'auth.invalidCsrf'),
        csrfRequired: true,
      });
    }
    clearSession(req);
    res.setHeader('Set-Cookie', buildLogoutSessionCookies(ctx.useHttps));
    sendAuthJson(res, { ok: true });
  }
  app.get('/api/auth-status', (req, res) => {
    sendAuthJson(res, {
      ok: true,
      configured: isAuthConfigured(),
      authRequired: isAuthConfigured() ? !isAuthenticated(req) : true,
      lanExposed: isLanExposed(),
      setupTokenRequired: isLanExposed() && !isAuthConfigured(),
      csrfToken: isAuthenticated(req) ? getCsrfTokenForRequest(req) : null,
    });
  });
  app.post('/api/setup', (req, res) => {
    try {
      const ip = String(req.socket?.remoteAddress || 'unknown');
      if (!checkAuthRateLimit(ip)) {
        return res.status(429).json({ ok: false, error: msg(req, 'auth.tooManyAttempts') });
      }
      if (isAuthConfigured()) {
        return res.status(409).json({ ok: false, error: msg(req, 'auth.alreadyConfigured') });
      }
      const setupToken = readSetupToken();
      if (isLanExposed() && !setupToken) {
        return res.status(403).json({ ok: false, error: msg(req, 'auth.setupTokenRequired') });
      }
      if (setupToken) {
        // Not read from the query string on purpose: URLs leak into proxy logs,
        // browser history and Referer headers.
        const provided =
          String(req.headers && req.headers['x-setup-token'] || '').trim() ||
          String(req.body && req.body.setupToken || '').trim();
        if (provided !== setupToken) {
          return res.status(401).json({ ok: false, error: msg(req, 'auth.invalidSetupToken') });
        }
      }
      const raw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      const result = setPassword(raw);
      if (!result.ok) return res.status(400).json({ ok: false, error: msg(req, 'auth.' + result.code) });
      resetAuthRateLimit(ip);
      const token = createSession();
      res.setHeader('Set-Cookie', buildLoginSessionCookiesForToken(token, ctx.useHttps));
      return sendAuthJson(res, { ok: true, csrfToken: getCsrfTokenForSessionToken(token) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/login', (req, res) => {
    try {
      const ip = String(req.socket?.remoteAddress || 'unknown');
      if (!checkAuthRateLimit(ip)) {
        return res.status(429).json({ ok: false, error: msg(req, 'auth.tooManyAttempts') });
      }
      if (!isAuthConfigured()) {
        return res.status(400).json({ ok: false, error: msg(req, 'auth.passwordNotSet'), setupRequired: true });
      }
      const raw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!verifyPassword(raw)) return res.status(401).json({ ok: false, error: msg(req, 'auth.invalidPassword') });
      resetAuthRateLimit(ip);
      const token = createSession();
      res.setHeader('Set-Cookie', buildLoginSessionCookiesForToken(token, ctx.useHttps));
      if (ctx.isWidgetAuthRequest(req)) {
        const installationId = typeof req.body?.installationId === 'string'
          ? req.body.installationId.trim()
          : typeof req.query?.installationId === 'string'
            ? req.query.installationId.trim()
            : '';
        const params = ctx.parseWidgetAuthParams(req.query || {}, req.body || {});
        if (!installationId || !params) {
          return res.status(400).json({ ok: false, error: 'Invalid widget authorization request' });
        }
        try {
          const widgetAuth = ctx.buildWidgetAuthorizationPayload(installationId, params);
          return sendAuthJson(res, {
            ok: true,
            widgetAuth,
            csrfToken: getCsrfTokenForSessionToken(token),
          });
        } catch (error) {
          return res.status(403).json({ ok: false, error: String(error?.message || 'Widget authorization failed') });
        }
      }
      return sendAuthJson(res, { ok: true, csrfToken: getCsrfTokenForSessionToken(token) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/logout', logoutHandler);
  app.get('/api/logout', logoutHandler);
}
