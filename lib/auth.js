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
import { resolveDataPath } from './runtime-paths.js';

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
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_SWEEP_INTERVAL_MS = 1000 * 60 * 10;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** token (id) -> { expiresAt } */
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
    rows.push({ id, expiresAt: entry.expiresAt });
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
      sessions.set(id, { expiresAt });
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
  // A new password invalidates old sessions.
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
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessionsToDisk();
  return `${id}.${sig}`;
}

/** @param {string} token */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signToken(id);
  if (expected.length !== sig.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  const entry = sessions.get(id);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(id);
    saveSessionsToDisk();
    return false;
  }
  return true;
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
export function isAuthenticated(req) {
  const token =
    readCookie(req.headers?.cookie || '', COOKIE_NAME) ||
    readCookie(req.headers?.cookie || '', COOKIE_NAME_HTTP_FALLBACK);
  return verifyToken(token);
}

/** Destroys the session from a request. */
export function clearSession(req) {
  const tokens = [
    readCookie(req.headers?.cookie || '', COOKIE_NAME),
    readCookie(req.headers?.cookie || '', COOKIE_NAME_HTTP_FALLBACK),
  ].filter(Boolean);
  if (tokens.length === 0) return;
  let changed = false;
  for (const token of tokens) {
    const dot = token.lastIndexOf('.');
    if (dot > 0) {
      if (sessions.delete(token.slice(0, dot))) changed = true;
    }
  }
  if (changed) saveSessionsToDisk();
}

/**
 * Express middleware: requires login for /api/* (with exceptions) and for the SPA shells.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
/**
 * Login URL preserving the requested path as a `next` parameter.
 * Only the query string is carried over, so this cannot redirect off-origin.
 * @param {import('express').Request} req
 * @returns {string}
 */
export function buildLoginRedirect(req) {
  const query = typeof req.originalUrl === 'string' ? req.originalUrl.split('?')[1] : '';
  if (!query) return '/login';
  return `/login?next=${encodeURIComponent(`/?${query}`)}`;
}

export function requireAuth(req, res, next) {
  const reqPath = req.path || '';
  if (isPublicApiPath(reqPath)) return next();
  // CORS preflight must not require a session cookie / bearer token.
  if (req.method === 'OPTIONS' && reqPath.startsWith('/api/')) return next();
  // Static files (JS/CSS bundles, fonts) are public — the HTML shell is gated below.
  if (reqPath === '/' || reqPath === '/index.html' || reqPath === '/embed.html') {
    if (!isAuthConfigured()) return res.redirect('/login');
    if (isAuthenticated(req)) return next();
    // Keep deep-link params (?panel=, ?chat= from push notifications and PWA
    // shortcuts) so login returns the user to what they actually clicked.
    return res.redirect(buildLoginRedirect(req));
  }
  if (!reqPath.startsWith('/api/')) return next();
  if (!isAuthConfigured()) return res.status(401).json({ ok: false, error: msg(req, 'auth.noPassword'), setupRequired: true });
  const authorization = typeof req.headers?.authorization === 'string'
    ? req.headers.authorization
    : '';
  if (authorization.startsWith('Bearer ')) {
    try {
      req.widgetAccess = verifyWidgetAccessToken(authorization.slice(7).trim());
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: msg(req, 'widget.invalidOrExpiredSession') });
    }
  }
  if (isAuthenticated(req)) return next();
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
  const token = (req.headers && req.headers['x-agent-token']) || (req.query && req.query.token) || '';
  return token === agentCallbackToken;
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

// Periodic sweep of expired sessions.
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now > entry.expiresAt) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) saveSessionsToDisk();
}, SESSION_SWEEP_INTERVAL_MS).unref();
