/**
 * Port exposure API. All routes sit behind requireAuth and act as the logged-in
 * operator; widget and MCP integration tokens are refused. Policy, hard blocks
 * and ownership checks are enforced by the service, not here.
 */

import { requireAuth } from '../auth.js';
import { getPortExposureService, getExposeConsentRegistry } from '../port-exposure/runtime.js';
import { loadPortExposurePolicy, normalizePortExposurePolicy } from '../port-exposure/policy.js';
import { loadSettings, saveSettings } from '../persist/settings.js';

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

/**
 * @param {import('express').Express} app
 * @param {{
 *   service?: ReturnType<typeof import('../port-exposure/service.js').createPortExposureService>,
 *   consent?: ReturnType<typeof import('../port-exposure/expose-consent.js').createExposeConsentRegistry>,
 * }} [ctx]
 */
export function registerPortExposureRoutes(app, ctx = {}) {
  const svc = () => ctx.service || getPortExposureService();
  const consent = () => ctx.consent || getExposeConsentRegistry();
  const operator = /** @type {{ kind: 'operator' }} */ ({ kind: 'operator' });

  const handle = (fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const result = await fn(req);
      if (result.ok) return res.json(result);
      const { status, ...body } = result;
      return res.status(status || 500).json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'internal-error', message: String(err?.message || err) });
    }
  };

  // Policy for the Settings -> Network tab. Values are clamped by normalizePortExposurePolicy before saving.
  app.get('/api/port-exposures/policy', requireAuth, handle(() => ({ ok: true, policy: loadPortExposurePolicy() })));
  app.put('/api/port-exposures/policy', requireAuth, handle((req) => {
    const raw = req.body && typeof req.body === 'object' ? req.body.policy : null;
    if (!raw || typeof raw !== 'object') return { ok: false, status: 400, error: 'policy-invalid', message: 'Missing policy object.' };
    const policy = normalizePortExposurePolicy(raw);
    saveSettings(/** @type {any} */ ({ ...loadSettings(), portExposure: policy }));
    return { ok: true, policy: loadPortExposurePolicy() };
  }));
  app.get('/api/port-exposures', requireAuth, handle((req) => svc().list({ refresh: req.query.refresh === '1' })));
  app.post('/api/port-exposures', requireAuth, handle((req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    return svc().expose({ port: b.port, reason: b.reason, ttlMs: b.ttlMs, owner: b.owner }, operator);
  }));
  app.delete('/api/port-exposures/:port', requireAuth, handle((req) => svc().close(Number(req.params.port), operator)));

  // Consent cards of agent port_expose calls (policy `ask`). Listed per chat so a reload or reconnect restores them.
  app.get('/api/port-exposures/consent', requireAuth, handle((req) => {
    const chatId = String(req.query?.chatId || '').trim();
    if (!chatId) return { ok: false, status: 400, error: 'invalid-chat', message: 'chatId required.' };
    return { ok: true, prompts: consent().list(chatId) };
  }));
  app.post('/api/port-exposures/consent/:id', requireAuth, handle((req) => {
    const chatId = String(req.body?.chatId || '').trim();
    const result = consent().resolve(req.params.id, String(req.body?.decision || ''), { chatId });
    if (result.ok) return { ok: true, port: result.port };
    const status = result.code === 'not-found' ? 404 : result.code === 'forbidden-chat' ? 403 : 400;
    return { ok: false, status, error: result.code, code: result.code };
  }));
}
