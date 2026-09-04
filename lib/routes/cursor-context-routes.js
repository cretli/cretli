import path from 'path';
import { getCursorContext } from '../sdk/cursor-context.js';

/**
 * @param {string} pathValue
 * @returns {string}
 */
function normalizeWorkspaceScopePath(pathValue) {
  const raw = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!raw) return '';
  return path.resolve(raw);
}

/**
 * @typedef {Object} CursorContextRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {import('express').Express} app
 * @param {CursorContextRoutesContext} ctx
 */
export function registerCursorContextRoutes(app, ctx) {
  app.get('/api/cursor-context', (req, res) => {
    try {
      const widgetFolder = req.widgetAccess?.workspaceFolder;
      const workspaceDir = widgetFolder
        ? normalizeWorkspaceScopePath(widgetFolder)
        : ctx.getCurrentCwd();
      const context = getCursorContext(workspaceDir);
      res.json({ ok: true, ...context });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
