import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { isPathInsideBase, listWorkspaceEntries, resolveExistingDir } from '../files-list.js';
import { msg } from '../messages.js';

import { getChatByIdAsync } from '../persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import { readChatFilePreview } from '../chat-file-preview.js';

// Match the explicit folder selection supported by the filesystem and Git panels.
function filesRoot(req, ctx) {
  return typeof req.query.workspaceFolder === 'string' && req.query.workspaceFolder.trim()
    ? req.query.workspaceFolder.trim()
    : (req.query.workspaceFile ? '' : ctx.getCurrentCwd());
}

const FILE_READ_MAX = 1024 * 1024;

/**
 * @typedef {Object} FilesRoutesContext
 * @property {() => string} getCurrentCwd
 * @property {(workspacePath: string | null) => string} [workspaceDirForAgent]
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
  app.get('/api/chats/:chatId/files/read', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
      const chat = await getChatByIdAsync(req.params.chatId);
      if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
      const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
      if (!filePath) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
      const base = resolveExecutionFolderForChat(chat, ctx.workspaceDirForAgent);
      if (!base) return res.status(404).json({ ok: false, error: msg(req, 'files.noWorkspace') });
      // The signed-in user may opt in to this one read; never persist a wider root.
      const result = readChatFilePreview(base, filePath, { allowOutsideWorkspace: req.query.allowOutsideWorkspace === '1' });
      if (result.error) return res.status(result.status).json({ ok: false, code: result.error, error: msg(req, result.error) });
      return res.json({ ok: true, path: result.path, content: result.content });
    } catch {
      return res.status(500).json({ ok: false, error: msg(req, 'files.readError') });
    }
  });
  /** Directory listing (file tree). dir = path relative to cwd (empty = root). */
  app.get('/api/files/entries', (req, res) => {
    try {
      const includeHiddenRaw = String(req.query.includeHidden || '').trim().toLowerCase();
      const includeHidden = includeHiddenRaw === '1' || includeHiddenRaw === 'true';
      const result = listWorkspaceEntries({
        basePath: filesRoot(req, ctx),
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
      const basePath = resolveExistingDir(filesRoot(req, ctx));
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
