/**
 * Absolute filesystem browsing routes for path pickers.
 * Directory listing plus single-level mkdir (no file content). Protected by
 * the global requireAuth middleware mounted in server.js.
 */

import { createBrowseFolder, listAbsoluteBrowseDir } from '../fs-browse.js';
import { msg } from '../messages.js';

const LIST_ERROR_MESSAGE_KEY = {
  'not-found': 'fs.notFound',
  'not-dir': 'fs.notDir',
  readdir: 'fs.readError',
};

const MKDIR_ERROR_MESSAGE_KEY = {
  'not-found': 'fs.notFound',
  'not-dir': 'fs.notDir',
  'invalid-name': 'fs.invalidName',
  exists: 'fs.exists',
  permission: 'fs.permission',
  mkdir: 'fs.mkdirError',
};

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ ok: boolean, error?: string }} result
 * @param {Record<string, string>} errorKeys
 * @param {string} fallbackKey
 */
function sendBrowseResult(req, res, result, errorKeys, fallbackKey) {
  if (result.ok) return res.json(result);
  const key = errorKeys[result.error || ''] || fallbackKey;
  return res.status(400).json({ ok: false, error: msg(req, key) });
}

/**
 * @param {import('express').Express} app
 */
export function registerFsBrowseRoutes(app) {
  app.get('/api/fs/entries', (req, res) => {
    const includeHidden = /^(1|true)$/i.test(String(req.query.includeHidden || '').trim());
    const rawPath = (req.query.path && String(req.query.path).trim()) || '~';
    try {
      const result = listAbsoluteBrowseDir(rawPath, { includeHidden });
      return sendBrowseResult(req, res, result, LIST_ERROR_MESSAGE_KEY, 'fs.readError');
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post('/api/fs/mkdir', (req, res) => {
    const rawPath = String(req.body?.path || '').trim() || '~';
    const name = String(req.body?.name || '').trim();
    try {
      const result = createBrowseFolder(rawPath, name);
      return sendBrowseResult(req, res, result, MKDIR_ERROR_MESSAGE_KEY, 'fs.mkdirError');
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });
}
