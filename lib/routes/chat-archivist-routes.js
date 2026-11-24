import { createChatArchivist } from '../chat-archivist.js';

export function registerChatArchivistRoutes(app, deps = {}) {
  const service = deps.service || createChatArchivist();
  const route = (handler) => async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, code: 'session-required' });
    res.set?.('Cache-Control', 'no-store');
    try { return res.json({ ok: true, ...await handler(req) }); }
    catch (error) {
      const code = String(error?.code || 'archivist_failed');
      return res.status(code === 'invalid_request' ? 400 : 409).json({ ok: false, code, ...(error.action ? { action: error.action } : {}) });
    }
  };
  const days = (value) => {
    const n = value === undefined ? 7 : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw Object.assign(new Error(), { code: 'invalid_request' });
    return n;
  };
  const id = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw Object.assign(new Error(), { code: 'invalid_request' });
    return value.trim();
  };
  app.get('/api/chat-archivist', route(async (req) => ({ report: await service.report(days(req.query?.idleDays)) })));
  app.post('/api/chat-archivist/assess', route(async (req) => {
    const mode = req.body?.mode === undefined ? 'idle' : req.body.mode;
    if (!['idle', 'manual'].includes(mode)) throw Object.assign(new Error(), { code: 'invalid_request' });
    return { assessment: await service.assess(id(req.body?.chatId), { mode, idleDays: days(req.body?.idleDays) }) };
  }));
  app.post('/api/chat-archivist/archive-with-followups', route(async (req) => {
    if (req.body?.confirm !== true || !Array.isArray(req.body?.items) || !req.body.items.length) throw Object.assign(new Error(), { code: 'invalid_request' });
    return { action: await service.archiveWithFollowups(id(req.body?.assessmentId), req.body.items) };
  }));
  app.post('/api/chat-archivist/archive', route(async (req) => {
    if (req.body?.confirm !== true) throw Object.assign(new Error(), { code: 'invalid_request' });
    return { action: await service.archive(id(req.body?.assessmentId)) };
  }));
  app.post('/api/chat-archivist/restore', route(async (req) => ({ action: await service.restore(id(req.body?.actionId)) })));
}
