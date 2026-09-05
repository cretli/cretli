/**
 * Public HTML routes: SPA shell, embed, login, favicon.
 */

import { getWidgetInstallation } from './widget/widget-installations.js';
import { isSpaShellPath } from './spa-routes.js';
import {
  applyWidgetFrameHeaders,
  resolveWidgetInstallationIdFromRequest,
} from './widget/widget-http.js';

/**
 * @param {import('express').Express} app
 * @param {{
 *   indexHtmlPath: string,
 *   loginHtmlPath: string,
 *   sendVersionedHtml: (res: import('express').Response, filePath: string) => unknown,
 * }} deps
 */
export function registerPublicPages(app, deps) {
  app.get('/embed/:installationId', (req, res) => {
    try {
      const installation = getWidgetInstallation(req.params.installationId);
      if (!installation.enabled) throw new Error('Widget installation unavailable');
      return deps.sendVersionedHtml(res, deps.indexHtmlPath);
    } catch {
      return res.status(404).send('Widget installation unavailable');
    }
  });
  app.get(['/', '/index.html'], (_req, res) => {
    return deps.sendVersionedHtml(res, deps.indexHtmlPath);
  });
  app.get(['/:panel', '/:panel/:settingsTab'], (req, res, next) => {
    if (!isSpaShellPath(req.path)) return next();
    return deps.sendVersionedHtml(res, deps.indexHtmlPath);
  });
  app.get('/login', (req, res) => {
    applyWidgetFrameHeaders(res, resolveWidgetInstallationIdFromRequest(req));
    return deps.sendVersionedHtml(res, deps.loginHtmlPath);
  });
  app.get('/favicon.ico', (_req, res) => {
    res.redirect(301, '/icon.svg');
  });
}
