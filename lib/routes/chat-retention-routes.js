/**
 * Chat retention routes (operator report/config):
 *  GET   /api/chat-retention          config + dry-run report
 *  PATCH /api/chat-retention/config   { enabled?, idleDays?, batchLimit? }
 *  POST  /api/chat-retention/apply    { confirm: true, limit? } archives one batch
 *  POST  /api/chat-retention/restore  { chatId } one-action restore
 */
import {
  applyChatRetention,
  getChatRetentionSettings,
  reportChatRetention,
  restoreRetainedChat,
  updateChatRetentionSettings,
} from '../chat-retention.js';

export function registerChatRetentionRoutes(app, deps = {}) {
  const fail = (res, error) => res.status(500).json({ ok: false, error: String(error?.message || error) });

  app.get('/api/chat-retention', async (_req, res) => {
    try {
      res.json({ ok: true, config: getChatRetentionSettings(), report: await reportChatRetention({ deps: deps.retention }) });
    } catch (error) { fail(res, error); }
  });

  app.patch('/api/chat-retention/config', (req, res) => {
    const result = /** @type {any} */ (updateChatRetentionSettings(req.body));
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json({ ok: true, config: result.config });
  });

  app.post('/api/chat-retention/apply', async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm:true is required; run the dry-run report first' });
    }
    try {
      const limit = req.body.limit === undefined ? undefined : Number(req.body.limit);
      res.json({ ok: true, result: await applyChatRetention({ limit, deps: deps.retention }) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/chat-retention/restore', (req, res) => {
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId is required' });
    const chat = restoreRetainedChat(chatId, deps.retention);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found' });
    return res.json({ ok: true, chatId });
  });
}
