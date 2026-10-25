/**
 * Express glue for the todo home resolver: one middleware per route family
 * resolves the workspace's home folder (or answers 409), and handlers read it
 * through `resolveRequestTodoHome`.
 */

import path from 'node:path';
import { resolveTodoHomeFromSettings } from './todo-home.js';

const HOME_KEY = Symbol('todoHome');

/**
 * @param {import('express').Request} req
 * @returns {{ workspaceId: string, workspaceFile: string, workspaceFolder: string }}
 */
function readScope(req) {
  const pick = (key) => String(req.query?.[key] || req.body?.[key] || '').trim();
  return { workspaceId: pick('workspaceId'), workspaceFile: pick('workspaceFile'), workspaceFolder: pick('workspaceFolder') };
}

/**
 * @param {import('express').Express} app
 * @param {string} prefix
 */
export function registerTodoHomeGuard(app, prefix) {
  if (typeof app?.use !== 'function') return;
  app.use(prefix, (req, res, next) => {
    if (req[HOME_KEY] || res.headersSent) return next();
    const scope = readScope(req);
    if (!scope.workspaceId && !scope.workspaceFile && !scope.workspaceFolder) return next();
    let result;
    try {
      result = resolveTodoHomeFromSettings(scope);
    } catch {
      return next();
    }
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        code: result.code,
        error: result.code === 'todo_home_shared'
          ? 'This workspace shares its todo folder with another workspace; pin a unique folder.'
          : 'The workspace could not be determined; pass workspaceId.',
        others: result.others || [],
        candidates: result.candidates || [],
      });
    }
    req[HOME_KEY] = result;
    // Responses report the list folder (`cwd`, the workspace's home) but also
    // echo the folder the caller asked for, so a client's stale-response guard
    // can keep comparing what it sent rather than the shared home.
    const requestedFolder = scope.workspaceFolder ? path.resolve(scope.workspaceFolder) : '';
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.cwd === 'string') {
        return json({ ...body, workspaceId: result.workspaceId, ...(requestedFolder ? { requestedFolder } : {}) });
      }
      return json(body);
    };
    return next();
  });
}

/**
 * @param {import('express').Request} req
 * @param {string} fallbackCwd
 * @returns {string}
 */
export function resolveRequestTodoHome(req, fallbackCwd) {
  const resolved = req[HOME_KEY];
  if (resolved?.homeFolder) return path.resolve(resolved.homeFolder);
  const scope = readScope(req);
  if (scope.workspaceId || scope.workspaceFile || scope.workspaceFolder) {
    try {
      const loose = resolveTodoHomeFromSettings(scope);
      if (loose.ok) return path.resolve(loose.homeFolder);
    } catch {
      // Fall through to the explicit folder.
    }
  }
  const explicit = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
  if (explicit) return path.resolve(explicit);
  return fallbackCwd;
}

/**
 * Resolution stored by the guard for this request, if any.
 *
 * @param {import('express').Request} req
 */
export function getRequestTodoHomeResult(req) {
  return req[HOME_KEY] || null;
}

/**
 * Validate a requested todo execution folder against the workspace's folders.
 * Returns the normalised folder ('' clears it) or throws a VALIDATION error.
 *
 * @param {import('express').Request} req
 * @param {unknown} raw
 * @returns {string | undefined} undefined when the caller did not ask for a change
 */
export function validateRequestExecutionFolder(req, raw) {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (!value) return '';
  const allowed = getRequestTodoHomeResult(req)?.folders;
  if (!Array.isArray(allowed) || !allowed.includes(value)) {
    const err = new Error('executionFolder must be one of the workspace folders');
    /** @type {any} */ (err).code = 'VALIDATION';
    throw err;
  }
  return value;
}
