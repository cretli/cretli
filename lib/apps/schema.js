/**
 * Workspace application registry: `.cretli/apps.json` schema, loading and saving.
 *
 * Loading never throws. A missing file is an empty registry; a broken or invalid
 * file yields `{ ok: false, errors }` so the API can answer with a readable message
 * instead of crashing the server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { writeJsonAtomic } from '../persist/atomic-write.js';

export const APPS_FILE_SEGMENTS = Object.freeze(['.cretli', 'apps.json']);
export const APP_ROLES = Object.freeze(['http', 'api', 'db', 'other']);
export const APP_EXPOSURES = Object.freeze(['local', 'lan']);
export const APPS_SCHEMA_VERSION = 1;

/** Same rule as isSafeHealthPath in monitor.js; duplicated to keep the schema free of runtime deps. */
// eslint-disable-next-line no-control-regex
const HEALTH_PATH_RE = /^\/(?!\/)[^\s\\#\u0000-\u001f\u007f]*$/;

/** @param {unknown} v */
function isValidBind(v) {
  if (typeof v !== 'string') return false;
  const b = v.trim().replace(/^\[|\]$/g, '');
  return b === 'localhost' || b === '*' || isIP(b) !== 0;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_APPS = 200;
const MAX_PORTS = 50;

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {unknown} raw
 * @param {string} where
 * @param {string[]} errors
 */
function validateStart(raw, where, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${where}.start must be an object with "taskLabel" or "command"`);
    return null;
  }
  const hasLabel = raw.taskLabel !== undefined;
  const hasCommand = raw.command !== undefined;
  if (hasLabel === hasCommand) {
    errors.push(`${where}.start needs exactly one of "taskLabel" or "command"`);
    return null;
  }
  if (hasLabel) {
    if (!nonEmptyString(raw.taskLabel)) {
      errors.push(`${where}.start.taskLabel must be a non-empty string`);
      return null;
    }
    return { taskLabel: raw.taskLabel.trim() };
  }
  if (!nonEmptyString(raw.command)) {
    errors.push(`${where}.start.command must be a non-empty string`);
    return null;
  }
  const start = { command: raw.command.trim() };
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
      errors.push(`${where}.start.args must be an array of strings`);
      return null;
    }
    start.args = [...raw.args];
  }
  if (raw.cwd !== undefined) {
    if (!nonEmptyString(raw.cwd)) {
      errors.push(`${where}.start.cwd must be a non-empty string`);
      return null;
    }
    const cwd = raw.cwd.trim();
    // Lexical check; the launch re-checks the real path so symlinks cannot escape either.
    const normalized = path.normalize(cwd);
    if (path.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      errors.push(`${where}.start.cwd must be a relative path inside the workspace folder`);
      return null;
    }
    start.cwd = cwd;
  }
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env) || Object.values(raw.env).some((x) => typeof x !== 'string')) {
      errors.push(`${where}.start.env must be an object of string values`);
      return null;
    }
    start.env = { ...raw.env };
  }
  return start;
}

/**
 * @param {unknown} raw
 * @param {string} where
 * @param {string[]} errors
 */
function validatePorts(raw, where, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}.ports must be an array`);
    return null;
  }
  if (raw.length > MAX_PORTS) {
    errors.push(`${where}.ports has more than ${MAX_PORTS} entries`);
    return null;
  }
  const out = [];
  const seen = new Set();
  let ok = true;
  raw.forEach((p, i) => {
    const w = `${where}.ports[${i}]`;
    if (!isPlainObject(p)) { errors.push(`${w} must be an object`); ok = false; return; }
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
      errors.push(`${w}.port must be an integer between 1 and 65535`); ok = false; return;
    }
    if (seen.has(p.port)) { errors.push(`${w}.port ${p.port} is listed twice`); ok = false; return; }
    seen.add(p.port);
    if (p.bind !== undefined && !isValidBind(p.bind)) {
      errors.push(`${w}.bind must be an IP address, "localhost" or "*"`); ok = false; return;
    }
    const role = p.role === undefined ? 'other' : p.role;
    if (!APP_ROLES.includes(role)) {
      errors.push(`${w}.role must be one of ${APP_ROLES.join(', ')}`); ok = false; return;
    }
    if (p.healthPath !== undefined && !HEALTH_PATH_RE.test(p.healthPath)) {
      errors.push(`${w}.healthPath must be a path starting with a single "/" and no whitespace, backslash or "#"`); ok = false; return;
    }
    const entry = { port: p.port, bind: p.bind ? p.bind.trim().replace(/^\[|\]$/g, '') : '127.0.0.1', role };
    if (p.healthPath !== undefined) entry.healthPath = p.healthPath;
    out.push(entry);
  });
  return ok ? out : null;
}

/**
 * Validates one app definition.
 *
 * @param {unknown} raw
 * @param {string} where  error prefix, e.g. `apps[0]`
 * @param {string[]} errors  appended to
 * @returns {Record<string, any> | null}
 */
export function validateApp(raw, where, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const before = errors.length;
  if (!nonEmptyString(raw.id) || !ID_RE.test(raw.id.trim())) {
    errors.push(`${where}.id must be 1-64 characters: letters, digits, ".", "_" or "-"`);
  }
  if (!nonEmptyString(raw.name)) errors.push(`${where}.name must be a non-empty string`);
  const start = validateStart(raw.start, where, errors);
  const ports = validatePorts(raw.ports, where, errors);
  const exposure = raw.exposure === undefined ? 'local' : raw.exposure;
  if (!APP_EXPOSURES.includes(exposure)) {
    errors.push(`${where}.exposure must be one of ${APP_EXPOSURES.join(', ')}`);
  }
  if (raw.autoStart !== undefined && typeof raw.autoStart !== 'boolean') {
    errors.push(`${where}.autoStart must be a boolean`);
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    errors.push(`${where}.notes must be a string`);
  }
  if (errors.length > before) return null;
  const app = { id: raw.id.trim(), name: raw.name.trim(), start, ports, exposure };
  if (raw.autoStart !== undefined) app.autoStart = raw.autoStart;
  if (raw.notes !== undefined) app.notes = raw.notes;
  return app;
}

/**
 * Validates the whole document (`{ version?, apps: [...] }`).
 *
 * @param {unknown} doc
 * @returns {{ ok: boolean, apps?: Record<string, any>[], errors?: string[] }}
 */
export function validateAppsDocument(doc) {
  if (!isPlainObject(doc)) return { ok: false, errors: ['apps.json must be a JSON object with an "apps" array'] };
  if (!Array.isArray(doc.apps)) return { ok: false, errors: ['"apps" must be an array'] };
  if (doc.apps.length > MAX_APPS) return { ok: false, errors: [`"apps" has more than ${MAX_APPS} entries`] };
  const errors = [];
  const apps = [];
  const ids = new Set();
  const ports = new Map();
  doc.apps.forEach((raw, i) => {
    const app = validateApp(raw, `apps[${i}]`, errors);
    if (!app) return;
    if (ids.has(app.id)) { errors.push(`apps[${i}].id "${app.id}" is used twice`); return; }
    ids.add(app.id);
    for (const p of app.ports) {
      const other = ports.get(p.port);
      if (other) errors.push(`apps[${i}] port ${p.port} is already declared by app "${other}"`);
      else ports.set(p.port, app.id);
    }
    apps.push(app);
  });
  return errors.length ? { ok: false, errors } : { ok: true, apps };
}

/** @param {string} workspaceDir */
export function appsFilePath(workspaceDir) {
  return path.join(path.resolve(workspaceDir), ...APPS_FILE_SEGMENTS);
}

/**
 * Reads and validates `.cretli/apps.json`. Never throws.
 *
 * @param {string} workspaceDir
 * @returns {{ ok: boolean, exists: boolean, apps?: Record<string, any>[], errors?: string[] }}
 */
export function loadAppsFile(workspaceDir) {
  const file = appsFilePath(workspaceDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, exists: false, apps: [] };
    return { ok: false, exists: true, errors: [`apps.json could not be read: ${err?.code || 'read error'}`] };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, exists: true, errors: [`apps.json is not valid JSON: ${err.message}`] };
  }
  const result = /** @type {any} */ (validateAppsDocument(doc));
  return result.ok ? { ok: true, exists: true, apps: result.apps } : { ok: false, exists: true, errors: result.errors };
}

/**
 * Validates and writes the registry. A definition-only write: nothing is started.
 *
 * @param {string} workspaceDir
 * @param {unknown} apps
 * @returns {{ ok: boolean, apps?: Record<string, any>[], errors?: string[] }}
 */
export function saveAppsFile(workspaceDir, apps) {
  const result = /** @type {any} */ (validateAppsDocument({ apps }));
  if (!result.ok) return result;
  try {
    writeJsonAtomic(appsFilePath(workspaceDir), { version: APPS_SCHEMA_VERSION, apps: result.apps });
  } catch (err) {
    return { ok: false, errors: [`apps.json could not be written: ${err?.code || err?.message || 'write error'}`] };
  }
  return { ok: true, apps: result.apps };
}
