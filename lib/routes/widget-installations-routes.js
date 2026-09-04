import {
  createWidgetInstallation,
  deleteWidgetInstallation,
  listWidgetInstallations,
  updateWidgetInstallation,
} from '../widget/widget-installations.js';

/**
 * @param {import('express').Express} app
 */
export function registerWidgetInstallationsRoutes(app) {
  app.get('/api/widget-installations', (_req, res) => {
    try {
      res.json({ ok: true, installations: listWidgetInstallations() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || 'Failed to list widget installations' });
    }
  });
  app.post('/api/widget-installations', (req, res) => {
    try {
      const installation = createWidgetInstallation(req.body);
      res.status(201).json({ ok: true, installation });
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || 'Failed to create widget installation' });
    }
  });
  app.patch('/api/widget-installations/:installationId', (req, res) => {
    try {
      const installation = updateWidgetInstallation(req.params.installationId, req.body);
      res.json({ ok: true, installation });
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || 'Failed to update widget installation' });
    }
  });
  app.delete('/api/widget-installations/:installationId', (req, res) => {
    try {
      const installation = deleteWidgetInstallation(req.params.installationId);
      res.json({ ok: true, installation });
    } catch (error) {
      res.status(404).json({ ok: false, error: error?.message || 'Widget installation not found' });
    }
  });
}
