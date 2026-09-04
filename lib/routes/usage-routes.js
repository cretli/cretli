/**
 * Usage ledger HTTP API. The client may report raw tokens; it may not set usd.
 */

import { loadUsageSummary, recordUsage } from '../usage/usage-ledger.js';
import { fromOpenAiRealtimeUsage } from '../usage/usage-normalize.js';

/**
 * @param {string} iso
 * @returns {string}
 */
export function monthStartIso(iso) {
  const raw = String(iso || new Date().toISOString());
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Date().toISOString().slice(0, 8) + '01';
  return `${day.slice(0, 7)}-01`;
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string }} [ctx]
 */
export function registerUsageRoutes(app, ctx = {}) {
  app.get('/api/usage/summary', (req, res) => {
    const to = String(req.query?.to || new Date().toISOString());
    const from = String(req.query?.from || monthStartIso(to));
    const summary = loadUsageSummary({ from, to, dataDir: ctx.dataDir });
    return res.json({ ok: true, from, to, summary });
  });

  app.post('/api/usage/events', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.usd != null) {
      return res.status(400).json({ ok: false, error: 'Client must not send usd' });
    }
    const provider = String(body.provider || '').trim();
    if (!provider) {
      return res.status(400).json({ ok: false, error: 'Missing provider' });
    }
    const tokens = body.usage
      ? fromOpenAiRealtimeUsage(body.usage)
      : body.tokens && typeof body.tokens === 'object'
        ? body.tokens
        : null;
    if (!tokens) {
      return res.status(400).json({ ok: false, error: 'Missing usage' });
    }
    const event = recordUsage(
      {
        provider,
        feature: body.feature || 'voice-live',
        model: body.model,
        tokens,
        source: 'client',
        chatId: body.chatId,
        workspaceFile: body.workspaceFile,
      },
      ctx
    );
    return res.json({
      ok: true,
      event: { id: event.id, usd: event.usd, tokens: event.tokens },
    });
  });
}
