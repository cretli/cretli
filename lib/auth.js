/**
 * Cretli authentication layer.
 *
 * Model: a single password (scrypt + salt) stored in data/auth.json. Sessions
 * are random HMAC-signed tokens with TTL, persisted in data/sessions.json
 * (so restart does not force relogin). The session cookie is httpOnly.
 *
 * No external dependencies — only the built-in Node `crypto` module.
 */

import fs from 'fs';
import path from 'path';
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from 'crypto';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { isLanBindHost } from './bind-host.js';
import { readEnvAlias } from './env-alias.js';
import { msg } from './messages.js';
import { verifyWidgetAccessToken } from './widget/widget-installations.js';
import { isMcpIntegrationToken, verifyMcpIntegrationToken } from './mcp/mcp-integration-token.js';
import { resolveDataPath } from './runtime-paths.js';
import { isSpaShellPath } from './spa-routes.js';
import {
  revokeAllSessionWebSockets,
  revokeSessionWebSockets,
} from './ws/ws-session-registry.js';

const AUTH_TEST_DATA_DIR = readEnvAlias({
  current: 'CRETLI_TEST_DATA_DIR',
  legacy: 'CURSOR_REMOTE_TEST_DATA_DIR',
});
const DATA_DIR = AUTH_TEST_DATA_DIR
  ? path.resolve(AUTH_TEST_DATA_DIR)
  : resolveDataPath();
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const COOKIE_NAME = 'cr_session';
const COOKIE_NAME_HTTP_FALLBACK = 'cr_session_http';
const CSRF_HEADER = 'x-cretli-csrf';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_SWEEP_INTERVAL_MS = 1000 * 60 * 10;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** token (id) -> { expiresAt, csrfToken } */
const sessions = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveSessionsToDisk() {
  ensureDataDir();
  const now = Date.now();
  const rows = [];
  for (const [id, entry] of sessions.entries()) {
    if (!entry || typeof entry.expiresAt !== 'number') continue;
    if (entry.expiresAt <= now) continue;
    rows.push({ id, expiresAt: entry.expiresAt, csrfToken: entry.csrfToken });
  }
  writeJsonAtomic(SESSIONS_FILE, { v: 1, sessions: rows }, 'utf8');
}

function loadSessionsFromDisk() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const list = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const now = Date.now();
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const expiresAt = Number(row.expiresAt);
      if (!id || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
      const csrfToken = typeof row.csrfToken === 'string' && row.csrfToken
        ? row.csrfToken
        : randomBytes(24).toString('hex');
      sessions.set(id, { expiresAt, csrfToken });
    }
  } catch {
    // ignore broken file; sessions map remains empty
  }
}

/**
 * Simulates process restart for tests: clears in-memory map and reloads sessions from disk.
 * @returns {void}
 */
export function __reloadSessionsFromDiskForTest() {
  sessions.clear();
  loadSessionsFromDisk();
}

/**
 * @typedef {{ passwordHash?: string, passwordSalt?: string, sessionSecret?: string }} AuthConfig
 */

/** @returns {AuthConfig} */
function loadAuthConfig() {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** @param {AuthConfig} cfg */
function saveAuthConfig(cfg) {
  ensureDataDir();
  writeJsonAtomic(AUTH_FILE, cfg, 'utf8');
}

function ensureSessionSecret() {
  const cfg = loadAuthConfig();
  if (cfg.sessionSecret && typeof cfg.sessionSecret === 'string') return cfg.sessionSecret;
  const secret = randomBytes(48).toString('hex');
  saveAuthConfig({ ...cfg, sessionSecret: secret });
  return secret;
}

const SESSION_SECRET = ensureSessionSecret();
loadSessionsFromDisk();

/** @returns {boolean} */
export function isAuthConfigured() {
  const cfg = loadAuthConfig();
  return Boolean(cfg.passwordHash && cfg.passwordSalt);
}

/**
 * Sets the access password (scrypt hash + random salt). Requires min. 8 characters.
 * Returns an error code (translated by lib/messages.js at the API layer).
 * @param {string} raw
 * @returns {{ ok: true } | { ok: false, code: 'passwordTooShort' | 'passwordTooLong' }}
 */
export function setPassword(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (value.length < 8) return { ok: false, code: 'passwordTooShort' };
  if (value.length > 200) return { ok: false, code: 'passwordTooLong' };
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(value, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
  const cfg = loadAuthConfig();
  cfg.passwordSalt = salt;
  cfg.passwordHash = hash;
  saveAuthConfig(cfg);
  revokeAllSessionWebSockets(4401, 'session ended');
  sessions.clear();
  saveSessionsToDisk();
  return { ok: true };
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function verifyPassword(raw) {
  const cfg = loadAuthConfig();
  if (!cfg.passwordHash || !cfg.passwordSalt) return false;
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return false;
  try {
    const expected = Buffer.from(cfg.passwordHash, 'hex');
    const actual = scryptSync(value, cfg.passwordSalt, expected.length, SCRYPT_PARAMS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function signToken(id) {
  return createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
}

/** Creates a session and returns the `id.signature` cookie value. */
export function createSession() {
  const id = randomBytes(24).toString('hex');
  const sig = signToken(id);
  sessions.set(id, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    csrfToken: randomBytes(24).toString('hex'),
  });
  saveSessionsToDisk();
  return `${id}.${sig}`;
}

/**
 * @param {string} token
 * @returns {{ id: string, csrfToken: string } | null}
 */
function resolveSessionFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signToken(id);
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(id);
    saveSessionsToDisk();
    revokeSessionWebSockets([id], 4401, 'session expired');
    return null;
  }
  return { id, csrfToken: entry.csrfToken };
}

/** @param {string} token */
function verifyToken(token) {
  return resolveSessionFromToken(token) !== null;
}

/** @param {string} cookieHeader */
function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

/** @param {import('http').IncomingMessage} req */
function readSessionCookieToken(req) {
  return readCookie(req.headers?.cookie || '', COOKIE_NAME)
    || readCookie(req.headers?.cookie || '', COOKIE_NAME_HTTP_FALLBACK);
}

/** @param {import('http').IncomingMessage} req */
export function isAuthenticated(req) {
  return verifyToken(readSessionCookieToken(req));
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
export function getSessionIdFromRequest(req) {
  const resolved = resolveSessionFromToken(readSessionCookieToken(req));
  return resolved ? resolved.id : null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
export function getCsrfTokenForRequest(req) {
  const resolved = resolveSessionFromToken(readSessionCookieToken(req));
  return resolved ? resolved.csrfToken : null;
}

/**
 * @param {string} sessionToken Full `id.signature` cookie value from createSession().
 * @returns {string|null}
 */
export function getCsrfTokenForSessionToken(sessionToken) {
  const resolved = resolveSessionFromToken(sessionToken);
  return resolved ? resolved.csrfToken : null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function usesBearerWidgetAuth(req) {
  const authorization = typeof req.headers?.authorization === 'string'
    ? req.headers.authorization
    : '';
  return authorization.startsWith('Bearer ');
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function isMutatingHttpMethod(method) {
  const normalized = String(method || 'GET').toUpperCase();
  return normalized === 'POST'
    || normalized === 'PUT'
    || normalized === 'PATCH'
    || normalized === 'DELETE';
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function verifyCsrfToken(req) {
  const expected = getCsrfTokenForRequest(req);
  if (!expected) return false;
  const header = req.headers?.[CSRF_HEADER];
  const provided = String(Array.isArray(header) ? header[0] : (header || '')).trim();
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/** Destroys the session from a request. */
export function clearSession(req) {
  const tokens = [
    readCookie(req.headers?.cookie || '', COOKIE_NAME),
    readCookie(req.headers?.cookie || '', COOKIE_NAME_HTTP_FALLBACK),
  ].filter(Boolean);
  if (tokens.length === 0) return;
  let changed = false;
  const revokedIds = [];
  for (const token of tokens) {
    const resolved = resolveSessionFromToken(token);
    if (!resolved) continue;
    if (sessions.delete(resolved.id)) {
      changed = true;
      revokedIds.push(resolved.id);
    }
  }
  if (revokedIds.length > 0) revokeSessionWebSockets(revokedIds, 4401, 'session ended');
  if (changed) saveSessionsToDisk();
}

/**
 * Login URL preserving the requested SPA path and query as a `next` parameter.
 * Only same-origin shell paths are accepted, so this cannot redirect off-origin.
 * @param {import('express').Request} req
 * @returns {string}
 */
export function buildLoginRedirect(req) {
  const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
  if (!originalUrl || originalUrl === '/') return '/login';
  let parsed;
  try {
    parsed = new URL(originalUrl, 'https://cretli.local');
  } catch {
    return '/login';
  }
  if (parsed.origin !== 'https://cretli.local') return '/login';
  if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) return '/login';
  if (!isSpaShellPath(parsed.pathname)) return '/login';
  const next = `${parsed.pathname}${parsed.search}`;
  if (next === '/') return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Express middleware: requires login for /api/* (with exceptions) and for the SPA shells.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAuth(req, res, next) {
  const reqPath = req.path || '';
  if (isPublicApiPath(reqPath)) return next();
  // CORS preflight must not require a session cookie / bearer token.
  if (req.method === 'OPTIONS' && reqPath.startsWith('/api/')) return next();
  // Static files (JS/CSS bundles, fonts) are public — the HTML shell is gated below.
  if (reqPath === '/embed.html' || isSpaShellPath(reqPath)) {
    if (!isAuthConfigured()) return res.redirect('/login');
    if (isAuthenticated(req)) return next();
    // Keep the view path and deep-link params (?panel=, ?chat= from push / PWA)
    // so login returns the user to what they actually opened.
    return res.redirect(buildLoginRedirect(req));
  }
  if (!reqPath.startsWith('/api/')) return next();
  if (!isAuthConfigured()) return res.status(401).json({ ok: false, error: msg(req, 'auth.noPassword'), setupRequired: true });
  const authorization = typeof req.headers?.authorization === 'string'
    ? req.headers.authorization
    : '';
  if (authorization.startsWith('Bearer ')) {
    const bearer = authorization.slice(7).trim();
    if (isMcpIntegrationToken(bearer)) {
      try {
        req.mcpIntegration = verifyMcpIntegrationToken(bearer);
        return next();
      } catch {
        return res.status(401).json({ ok: false, error: msg(req, 'widget.invalidOrExpiredSession') });
      }
    }
    try {
      req.widgetAccess = verifyWidgetAccessToken(bearer);
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: msg(req, 'widget.invalidOrExpiredSession') });
    }
  }
  if (isAuthenticated(req)) {
    if (isMutatingHttpMethod(req.method) && !verifyCsrfToken(req)) {
      return res.status(403).json({
        ok: false,
        error: msg(req, 'auth.invalidCsrf'),
        csrfRequired: true,
      });
    }
    return next();
  }
  return res.status(401).json({ ok: false, error: msg(req, 'auth.loginRequired'), authRequired: true });
}

/** Public endpoints (no session) — own verification (agent callbacks) or setup/login. */
const PUBLIC_API_PATHS = new Set([
  '/api/login',
  '/api/logout',
  '/api/setup',
  '/api/auth-status',
  '/api/health',
  '/api/set-todo-from-agent',
  '/api/set-chat-title-from-agent',
  '/api/set-chat-summary-from-agent',
  '/api/set-chat-pinned-url-from-agent',
]);

/** @param {string} reqPath */
export function isPublicApiPath(reqPath) {
  if (PUBLIC_API_PATHS.has(reqPath)) return true;
  // HMR dev: do not block the hot-update stream.
  if (reqPath === '/__webpack_hmr' || reqPath.startsWith('/__webpack_hmr')) return true;
  return false;
}

/** Whether the server listens beyond localhost (LAN/Internet exposure). */
export function isLanExposed() {
  return isLanBindHost();
}

/**
 * Validates an agent callback: requires AGENT_CALLBACK_TOKEN when the server is exposed on LAN.
 * Localhost connections are always trusted (the server starts fork-agent callbacks itself).
 * An external LAN client (different source IP) must present the token.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function verifyAgentCallback(req) {
  const agentCallbackToken = process.env.AGENT_CALLBACK_TOKEN || '';
  const remote = String(req.socket?.remoteAddress || '');
  const isLocalOrigin = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLocalOrigin) return true;
  if (!agentCallbackToken) return !isLanExposed();
  const headerToken = req.headers && req.headers['x-agent-token'];
  const queryToken = req.query && req.query.token;
  const token = String(Array.isArray(headerToken) ? headerToken[0] : (headerToken || queryToken || ''));
  const expected = Buffer.from(agentCallbackToken);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Builds the session Set-Cookie header. */
export function buildSessionCookieHeader(token, { https, maxAgeMs = SESSION_TTL_MS, cookieName = COOKIE_NAME } = {}) {
  const name = cookieName || COOKIE_NAME;
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'HttpOnly',
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookieHeader({ https, cookieName = COOKIE_NAME } = {}) {
  const name = cookieName || COOKIE_NAME;
  const parts = [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) parts.push('Secure');
  return parts.join('; ');
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_COOKIE_NAME_HTTP_FALLBACK = COOKIE_NAME_HTTP_FALLBACK;
export const AUTH_CSRF_HEADER = CSRF_HEADER;

// Periodic sweep of expired sessions.
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now > entry.expiresAt) {
      sessions.delete(id);
      revokeSessionWebSockets([id], 4401, 'session expired');
      changed = true;
    }
  }
  if (changed) saveSessionsToDisk();
}, SESSION_SWEEP_INTERVAL_MS).unref();
