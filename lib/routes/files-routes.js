import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { isPathInsideBase, listWorkspaceEntries, resolveExistingDir } from '../files-list.js';
import { msg } from '../messages.js';

const FILE_READ_MAX = 1024 * 1024;

/**
 * @typedef {Object} FilesRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {string} errorCode
 * @param {import('express').Request} req
 * @returns {string}
 */
function filesErrorMessage(errorCode, req) {
  if (errorCode === 'no-workspace') return msg(req, 'files.noWorkspace');
  if (errorCode === 'outside') return msg(req, 'files.outsideWorkspace');
  if (errorCode === 'missing') return msg(req, 'files.notDirOrMissing');
  return errorCode || msg(req, 'files.notDirOrMissing');
}

/**
 * @param {import('express').Express} app
 * @param {FilesRoutesContext} ctx
 */
export function registerFilesRoutes(app, ctx) {
  /** Directory listing (file tree). dir = path relative to cwd (empty = root). */
  app.get('/api/files/entries', (req, res) => {
    try {
      const includeHiddenRaw = String(req.query.includeHidden || '').trim().toLowerCase();
      const includeHidden = includeHiddenRaw === '1' || includeHiddenRaw === 'true';
      const result = listWorkspaceEntries({
        basePath: ctx.getCurrentCwd(),
        relDir: (req.query.dir && String(req.query.dir).trim()) || '',
        includeHidden,
      });
      if (!result.ok) {
        const status = result.error === 'outside' ? 400 : 200;
        return res.status(status).json({
          ok: false,
          error: filesErrorMessage(result.error, req),
          entries: [],
        });
      }
      res.json({
        ok: true,
        root: result.root,
        dir: result.dir,
        entries: result.entries,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, entries: [] });
    }
  });

  /** Read file content (text). path = relative to cwd. Limit ~1 MB. */
  app.get('/api/files/read', (req, res) => {
    try {
      const basePath = resolveExistingDir(ctx.getCurrentCwd());
      if (!basePath) {
        return res.status(500).json({ ok: false, error: msg(req, 'files.noWorkspace') });
      }
      const rel = (req.query.path && String(req.query.path).trim()) || '';
      if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
      const requested = path.join(basePath, rel);
      const resolved = resolveExistingDir(path.dirname(requested))
        ? path.resolve(requested)
        : '';
      if (!resolved || !isPathInsideBase(basePath, resolved)) {
        return res.status(400).json({ ok: false, error: msg(req, 'files.outsideWorkspace') });
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return res.status(404).json({ ok: false, error: msg(req, 'files.fileNotFound') });
      }
      const size = statSync(resolved).size;
      if (size > FILE_READ_MAX) {
        return res.status(413).json({ ok: false, error: msg(req, 'files.tooLargeForPreview') });
      }
      const content = readFileSync(resolved, 'utf8');
      res.json({ ok: true, path: rel.replace(/\\/g, '/'), content });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
