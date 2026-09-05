/**
 * Widget popup authorization: parse query, build postMessage payload, HTML page.
 */

import {
  createWidgetAccessToken,
  getWidgetInstallation,
} from './widget-installations.js';
import { isAuthConfigured, isAuthenticated } from '../auth.js';

/**
 * @param {Record<string, unknown>} [query]
 * @param {Record<string, unknown>} [body]
 * @returns {{ origin: string, pageSessionId: string } | null}
 */
export function parseWidgetAuthParams(query = {}, body = {}) {
  const origin = typeof query.origin === 'string'
    ? query.origin.trim()
    : typeof body.origin === 'string'
      ? body.origin.trim()
      : '';
  const pageSessionId = typeof query.pageSessionId === 'string'
    ? query.pageSessionId.trim()
    : typeof body.pageSessionId === 'string'
      ? body.pageSessionId.trim()
      : '';
  if (!pageSessionId || pageSessionId.length > 128) return null;
  return { origin, pageSessionId };
}

/**
 * @param {{ query?: Record<string, unknown>, body?: Record<string, unknown> }} req
 * @returns {boolean}
 */
export function isWidgetAuthRequest(req) {
  return req.query?.widgetAuth === '1'
    || req.body?.widgetAuth === true
    || req.body?.widgetAuth === '1';
}

/**
 * @param {string} installationId
 * @param {{ origin: string, pageSessionId: string }} params
 */
export function buildWidgetAuthorizationPayload(installationId, { origin, pageSessionId }) {
  const installation = getWidgetInstallation(installationId);
  const accessToken = createWidgetAccessToken({
    installationId: installation.id,
    origin,
    pageSessionId,
  });
  return {
    type: 'cretli-widget-authorized',
    installation,
    accessToken,
    pageSessionId,
  };
}

/**
 * @param {object} payload
 * @param {string} targetOrigin
 * @returns {string}
 */
export function renderWidgetAuthorizeHtml(payload, targetOrigin) {
  const payloadJson = JSON.stringify(payload).replaceAll('<', '\\u003c');
  const originJson = JSON.stringify(targetOrigin).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Cretli</title><script>
(function () {
  var payload = ${payloadJson};
  var targetOrigin = ${originJson};
  var target = null;
  if (window.opener && window.opener !== window) target = window.opener;
  else if (window.parent && window.parent !== window) target = window.parent;
  if (target) target.postMessage(payload, targetOrigin);
  try { window.close(); } catch (_) {}
})();
</script><p>Authorization complete. You can close this window.</p>`;
}

/**
 * @param {import('express').Express} app
 * @param {{ applyWidgetFrameHeaders: (res: import('express').Response, installationId: string) => boolean }} deps
 */
export function registerWidgetAuthorizePages(app, deps) {
  app.get('/api/widget-authorize/:installationId', (req, res) => {
    const params = parseWidgetAuthParams(req.query || {});
    if (!params) {
      return res.status(400).json({ ok: false, error: 'Invalid page session' });
    }
    try {
      const widgetAuth = buildWidgetAuthorizationPayload(req.params.installationId, params);
      return res.json({ ok: true, widgetAuth });
    } catch (error) {
      return res.status(403).json({ ok: false, error: String(error?.message || 'Widget authorization failed') });
    }
  });
  app.get('/widget-authorize/:installationId', (req, res) => {
    deps.applyWidgetFrameHeaders(res, req.params.installationId);
    const params = parseWidgetAuthParams(req.query || {});
    if (!isAuthConfigured() || !isAuthenticated(req)) {
      const next = encodeURIComponent(req.originalUrl || req.url || '/');
      return res.redirect(`/login?next=${next}&widgetAuth=1`);
    }
    if (!params) {
      return res.status(400).send('Invalid page session');
    }
    try {
      const html = renderWidgetAuthorizeHtml(
        buildWidgetAuthorizationPayload(req.params.installationId, params),
        params.origin,
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(html);
    } catch (error) {
      return res.status(403).send(String(error?.message || 'Widget authorization failed'));
    }
  });
}
