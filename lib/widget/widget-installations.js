import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { readEnvAlias } from '../env-alias.js';
import { resolveDataPath } from '../runtime-paths.js';

const WIDGET_TEST_DATA_DIR = readEnvAlias({
  current: 'CRETLI_TEST_DATA_DIR',
  legacy: 'CURSOR_REMOTE_TEST_DATA_DIR',
});
const DATA_DIR = WIDGET_TEST_DATA_DIR || resolveDataPath();
const DATA_FILE = path.join(DATA_DIR, 'widget-installations.json');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — stored in host localStorage between reloads
const ALLOWED_PERMISSIONS = new Set([
  'context',
  'dom',
  'console',
  'network',
  'screenshot',
  'interact',
  'navigate',
  'storage',
]);

function newDocument() {
  return {
    version: 1,
    tokenSecret: crypto.randomBytes(32).toString('base64url'),
    installations: [],
  };
}

function loadDocument() {
  if (!fs.existsSync(DATA_FILE)) {
    const document = newDocument();
    writeJsonAtomic(DATA_FILE, document);
    return document;
  }

  let document;
  try {
    document = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    throw new Error('Widget installations file contains invalid JSON');
  }

  if (!document || typeof document !== 'object' || !Array.isArray(document.installations)) {
    throw new Error('Widget installations file has an invalid format');
  }

  if (typeof document.tokenSecret !== 'string' || document.tokenSecret.length < 32) {
    document.tokenSecret = crypto.randomBytes(32).toString('base64url');
    writeJsonAtomic(DATA_FILE, document);
  }
  return document;
}

function saveDocument(document) {
  writeJsonAtomic(DATA_FILE, document);
}

function requireObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Installation input must be an object');
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, field);
}

function isPrivateOrLoopbackIpv4(octets) {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (host === 'localhost') return true;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return isPrivateOrLoopbackIpv4(host.split('.').map(Number));
  }
  if (ipVersion === 6) {
    if (host === '::1') return true;
    if (host.startsWith('fe80:')) return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) {
      return isPrivateOrLoopbackIpv4(mapped[1].split('.').map(Number));
    }
  }
  return false;
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) {
    throw new Error('origin must be a non-empty string');
  }

  let url;
  try {
    url = new URL(origin.trim());
  } catch {
    throw new Error(`Invalid origin: ${origin}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new Error(`Invalid origin: ${origin}`);
  }

  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new Error('HTTP origins are allowed only for localhost and local network addresses');
  }
  return url.origin;
}

function normalizeOrigins(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('allowedOrigins must be a non-empty array');
  }
  return [...new Set(value.map(normalizeOrigin))];
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) {
    throw new Error('permissions must be an array');
  }
  const permissions = [...new Set(value)];
  for (const permission of permissions) {
    if (typeof permission !== 'string' || !ALLOWED_PERMISSIONS.has(permission)) {
      throw new Error(`Unsupported permission: ${String(permission)}`);
    }
  }
  return permissions;
}

function normalizeEnabled(value) {
  if (typeof value !== 'boolean') throw new Error('enabled must be a boolean');
  return value;
}

function installationFields(input, partial = false) {
  requireObject(input);
  const fields = {};

  if (!partial || Object.hasOwn(input, 'name')) fields.name = requiredString(input.name, 'name');
  if (!partial || Object.hasOwn(input, 'workspaceFile')) {
    fields.workspaceFile = optionalString(input.workspaceFile, 'workspaceFile');
  }
  if (!partial || Object.hasOwn(input, 'workspaceFolder')) {
    fields.workspaceFolder = optionalString(input.workspaceFolder, 'workspaceFolder');
  }
  if (!partial || Object.hasOwn(input, 'model')) {
    fields.model = optionalString(input.model, 'model');
  }
  if (!partial || Object.hasOwn(input, 'allowedOrigins')) {
    fields.allowedOrigins = normalizeOrigins(input.allowedOrigins);
  }
  if (!partial || Object.hasOwn(input, 'permissions')) {
    fields.permissions = normalizePermissions(input.permissions);
  }
  if (!partial || Object.hasOwn(input, 'enabled')) {
    fields.enabled = input.enabled === undefined && !partial
      ? true
      : normalizeEnabled(input.enabled);
  }
  return fields;
}

function findInstallation(document, id) {
  if (typeof id !== 'string' || !id) throw new Error('Installation id is required');
  const installation = document.installations.find((entry) => entry.id === id);
  if (!installation) throw new Error(`Widget installation not found: ${id}`);
  return installation;
}

export function listWidgetInstallations() {
  return structuredClone(loadDocument().installations);
}

export function getWidgetInstallation(id) {
  return structuredClone(findInstallation(loadDocument(), id));
}

export function createWidgetInstallation(input) {
  const document = loadDocument();
  const now = new Date().toISOString();
  const installation = {
    id: crypto.randomUUID(),
    ...installationFields(input),
    createdAt: now,
    updatedAt: now,
  };
  document.installations.push(installation);
  saveDocument(document);
  return structuredClone(installation);
}

export function updateWidgetInstallation(id, input) {
  const document = loadDocument();
  const installation = findInstallation(document, id);
  const fields = installationFields(input, true);
  Object.assign(installation, fields, { updatedAt: new Date().toISOString() });
  saveDocument(document);
  return structuredClone(installation);
}

export function deleteWidgetInstallation(id) {
  const document = loadDocument();
  const installation = findInstallation(document, id);
  document.installations = document.installations.filter((entry) => entry.id !== id);
  saveDocument(document);
  return structuredClone(installation);
}

export function isOriginAllowed(installation, origin) {
  if (!installation || !Array.isArray(installation.allowedOrigins)) return false;
  try {
    return installation.allowedOrigins.includes(normalizeOrigin(origin));
  } catch {
    return false;
  }
}

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createWidgetAccessToken({ installationId, origin, pageSessionId } = {}) {
  const document = loadDocument();
  const installation = findInstallation(document, installationId);
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedPageSessionId = requiredString(pageSessionId, 'pageSessionId');
  if (normalizedPageSessionId.length > 128) throw new Error('pageSessionId is too long');
  if (!installation.enabled) throw new Error('Widget installation is disabled');
  if (!isOriginAllowed(installation, normalizedOrigin)) {
    throw new Error(`Origin is not allowed: ${normalizedOrigin}`);
  }

  const now = Date.now();
  const payload = {
    tokenId: crypto.randomUUID(),
    installationId: installation.id,
    pageSessionId: normalizedPageSessionId,
    origin: normalizedOrigin,
    permissions: installation.permissions,
    workspaceFile: installation.workspaceFile,
    workspaceFolder: installation.workspaceFolder,
    model: installation.model,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  installation.lastUsedAt = new Date(now).toISOString();
  saveDocument(document);
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, document.tokenSecret)}`;
}

export function verifyWidgetAccessToken(token, { origin } = {}) {
  if (typeof token !== 'string') throw new Error('Widget access token must be a string');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid widget access token');
  }

  const document = loadDocument();
  const expected = Buffer.from(sign(parts[0], document.tokenSecret));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('Invalid widget access token signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid widget access token payload');
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
    throw new Error('Widget access token has expired');
  }
  requiredString(payload.tokenId, 'tokenId');
  if (requiredString(payload.pageSessionId, 'pageSessionId').length > 128) {
    throw new Error('pageSessionId is too long');
  }

  const installation = findInstallation(document, payload.installationId);
  if (!installation.enabled) throw new Error('Widget installation is disabled');
  if (origin !== undefined && normalizeOrigin(origin) !== payload.origin) {
    throw new Error('Widget access token origin does not match');
  }
  if (!isOriginAllowed(installation, payload.origin)) {
    throw new Error('Widget access token origin is no longer allowed');
  }
  const currentPermissions = normalizePermissions(installation.permissions);
  const tokenPermissions = normalizePermissions(payload.permissions);
  const permissions = tokenPermissions.filter((permission) => currentPermissions.includes(permission));
  return structuredClone({
    ...payload,
    permissions,
    workspaceFile: installation.workspaceFile,
    workspaceFolder: installation.workspaceFolder,
    model: installation.model,
  });
}
