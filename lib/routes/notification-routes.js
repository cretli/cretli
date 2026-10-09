/**
 * HTTP API for the in-app notification centre.
 */

import { msg } from '../messages.js';
import {
  dismissNotifications,
  listNotifications,
  markNotificationsRead,
} from '../notifications/notification-store.js';
import { NOTIFICATION_CATEGORIES } from '../notifications/notification-preferences.js';

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   list?: typeof listNotifications,
 *   markRead?: typeof markNotificationsRead,
 *   dismiss?: typeof dismissNotifications,
 * }} [ctx]
 */
export function registerNotificationRoutes(app, ctx = {}) {
  const list = ctx.list || listNotifications;
  const markRead = ctx.markRead || markNotificationsRead;
  const dismiss = ctx.dismiss || dismissNotifications;

  app.get('/api/notifications', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const category = String(req.query?.category || '').trim();
    if (category && !NOTIFICATION_CATEGORIES.includes(category)) {
      return res.status(400).json({ ok: false, error: 'invalid_category' });
    }
    const snapshot = list(category ? { category } : {});
    return res.json({
      ok: true,
      revision: snapshot.revision,
      unreadCount: snapshot.unreadCount,
      preferences: snapshot.preferences,
      items: snapshot.items,
    });
  });

  app.post('/api/notifications/read', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const all = body.all === true;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!all && !id) {
      return res.status(400).json({ ok: false, error: 'missing_target' });
    }
    if (all && id) {
      return res.status(400).json({ ok: false, error: 'ambiguous_target' });
    }
    const result = await markRead({ all, id });
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found', revision: result.revision });
    }
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || 'invalid_request', revision: result.revision });
    }
    return res.json({ ok: true, revision: result.revision, changed: result.changed });
  });

  app.post('/api/notifications/dismiss', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const all = body.all === true;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!all && !id) {
      return res.status(400).json({ ok: false, error: 'missing_target' });
    }
    if (all && id) {
      return res.status(400).json({ ok: false, error: 'ambiguous_target' });
    }
    const result = await dismiss({ all, id });
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found', revision: result.revision });
    }
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || 'invalid_request', revision: result.revision });
    }
    return res.json({ ok: true, revision: result.revision, changed: result.changed });
  });
}
