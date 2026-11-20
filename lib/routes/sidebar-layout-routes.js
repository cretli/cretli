/**
 * Shared sidebar layout for every device on this server.
 */

import { broadcastSidebarLayout } from '../chat-list-updates.js';
import { loadSidebarLayout, patchSidebarLayout } from '../persist/sidebar-layout.js';

/**
 * @param {import('express').Express} app
 * @returns {void}
 */
export function registerSidebarLayoutRoutes(app) {
  app.get('/api/sidebar-layout', (_req, res) => {
    res.json({ ok: true, ...loadSidebarLayout() });
  });
  app.patch('/api/sidebar-layout', (req, res) => {
    const result = patchSidebarLayout(req.body);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: 'Invalid sidebar layout' });
      return;
    }
    if (result.changed) broadcastSidebarLayout(result.layout);
    res.json({ ok: true, ...result.layout });
  });
}
