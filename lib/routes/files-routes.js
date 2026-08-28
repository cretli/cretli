import path from 'path';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { msg } from '../messages.js';

const FILE_READ_MAX = 1024 * 1024;

/**
 * @typedef {Object} FilesRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {import('express').Express} app
 * @param {FilesRoutesContext} ctx
 */
export function registerFilesRoutes(app, ctx) {
  /** Directory listing (file tree). dir = path relative to cwd (empty = root). */
  app.get('/api/files/entries', (req, res) => {
    try {
      const basePath = ctx.getCurrentCwd();
      if (!basePath || !existsSync(basePath) || !statSync(basePath).isDirectory()) {
        return res.json({ ok: false, error: msg(req, 'files.noWorkspace'), entries: [] });
      }
      const rel = (req.query.dir && String(req.query.dir).trim()) || '';
      const requested = rel ? path.join(basePath, rel) : basePath;
      const resolved = path.resolve(requested);
      let baseReal;
      let resolvedReal;
      try {
        baseReal = realpathSync(basePath);
        resolvedReal = realpathSync(resolved);
      } catch {
        return res.status(400).json({ ok: false, error: 'Path outside workspace', entries: [] });
      }
      if (resolvedReal !== baseReal && !resolvedReal.startsWith(baseReal + path.sep)) {
        return res.status(400).json({ ok: false, error: 'Path outside workspace', entries: [] });
      }
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return res.json({ ok: false, error: msg(req, 'files.notDirOrMissing'), entries: [] });
      }
      const includeHiddenRaw = String(req.query.includeHidden || '').trim().toLowerCase();
      const includeHidden = includeHiddenRaw === '1' || includeHiddenRaw === 'true';
      const toPosix = (p) => (p || '').split(path.sep).join('/');
      const entries = readdirSync(resolved, { withFileTypes: true })
        .filter((e) => includeHidden || !e.name.startsWith('.'))
        .map((e) => {
          const name = e.name;
          const relPath = path.join(rel, name);
          const fullPath = path.join(resolved, name);
          const isDir = e.isDirectory();
          let sizeBytes = null;
          let dirEntries = null;
          try {
            const st = statSync(fullPath);
            if (st.isFile()) sizeBytes = st.size;
          } catch (_) {}
          if (isDir) {
            try {
              dirEntries = readdirSync(fullPath, { withFileTypes: true })
                .filter((x) => includeHidden || !x.name.startsWith('.'))
                .length;
            } catch (_) {}
          }
          return { name, path: toPosix(relPath), isDir, sizeBytes, dirEntries };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
      res.json({ ok: true, root: basePath, dir: rel || '.', entries });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, entries: [] });
    }
  });

  /** Read file content (text). path = relative to cwd. Limit ~1 MB. */
  app.get('/api/files/read', (req, res) => {
    try {
      const basePath = ctx.getCurrentCwd();
      if (!basePath || !existsSync(basePath)) {
        return res.status(500).json({ ok: false, error: msg(req, 'files.noWorkspace') });
      }
      const rel = (req.query.path && String(req.query.path).trim()) || '';
      if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
      const requested = path.join(basePath, rel);
      const resolved = path.resolve(requested);
      let baseReal;
      let resolvedReal;
      try {
        baseReal = realpathSync(basePath);
        resolvedReal = realpathSync(resolved);
      } catch {
        return res.status(400).json({ ok: false, error: 'Path outside workspace' });
      }
      if (resolvedReal !== baseReal && !resolvedReal.startsWith(baseReal + path.sep)) {
        return res.status(400).json({ ok: false, error: 'Path outside workspace' });
      }
      if (!existsSync(resolvedReal) || !statSync(resolvedReal).isFile()) {
        return res.status(404).json({ ok: false, error: msg(req, 'files.fileNotFound') });
      }
      const size = statSync(resolvedReal).size;
      if (size > FILE_READ_MAX) {
        return res.status(413).json({ ok: false, error: msg(req, 'files.tooLargeForPreview') });
      }
      const content = readFileSync(resolvedReal, 'utf8');
      res.json({ ok: true, path: rel.replace(/\\/g, '/'), content });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
