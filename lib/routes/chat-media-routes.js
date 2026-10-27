import fs from 'node:fs';
import path from 'node:path';
import { loadChats } from '../persist/chats-persist.js';
import { CHAT_ID_RE, CHAT_MEDIA_FILE_RE, chatMediaDir } from '../chat-media.js';

/** SVG is deliberately absent: it can carry script. */
const CONTENT_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' });

/**
 * GET /api/chats/:chatId/media/:file — serves a durable chat image. Scope is the
 * same as GET /api/chats/:id/history, minus widget and MCP-integration callers.
 * @param {import('express').Express} app
 */
export function registerChatMediaRoutes(app) {
  app.get('/api/chats/:chatId/media/:file', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const { chatId, file } = req.params;
    if (!CHAT_ID_RE.test(chatId) || !CHAT_MEDIA_FILE_RE.test(file)) {
      return res.status(400).json({ ok: false, error: 'Invalid media path' });
    }
    if (!loadChats().some((c) => c.id === chatId)) {
      return res.status(404).json({ ok: false, error: 'Chat not found' });
    }
    const dir = chatMediaDir(chatId);
    if (!dir) return res.status(404).json({ ok: false, error: 'Media not found' });
    const full = path.join(dir, file);
    let st;
    try { st = fs.lstatSync(full); } catch { return res.status(404).json({ ok: false, error: 'Media not found' }); }
    let real;
    try { real = fs.realpathSync(full); } catch { return res.status(404).json({ ok: false, error: 'Media not found' }); }
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { return res.status(404).json({ ok: false, error: 'Media not found' }); }
    if (st.isSymbolicLink() || !st.isFile() || path.dirname(real) !== realDir) {
      return res.status(400).json({ ok: false, error: 'Invalid media path' });
    }
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(real);
  });
}
