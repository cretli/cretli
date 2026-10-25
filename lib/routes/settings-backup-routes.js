/**
 * HTTP API for settings versions and portable import/export (B2).
 * Admin-equivalent only: widget and MCP-integration credentials are refused.
 * Docs: docs/settings-backup-design.md, docs/backup/settings-versions.md.
 */

import {
  DEVICE_PREFERENCE_ALLOWLIST,
  SNAPSHOT_NAME_MAX,
  SettingsBackupError,
  activatePending,
  applyImport,
  buildSettingsDocument,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  previewImport,
  readPending,
  readSnapshot,
} from '../backup/settings-backup-service.js';
import { SETTINGS_SECTION_IDS, MACHINE_SECTION_IDS } from '../backup/settings-classification.js';
import { msg } from '../messages.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was refused
 */
function rejectLimitedClients(req, res) {
  if (req.widgetAccess || req.mcpIntegration) {
    res.status(403).json({ ok: false, code: 'FORBIDDEN', error: msg(req, 'widget.endpointUnavailable') });
    return true;
  }
  return false;
}

/**
 * @param {import('express').Response} res
 * @param {unknown} err
 */
function sendError(res, err) {
  if (err instanceof SettingsBackupError) {
    return res.status(err.status).json({ ok: false, status: 'error', code: err.code, error: err.message, ...err.extra });
  }
  return res.status(500).json({ ok: false, status: 'error', code: 'INTERNAL', error: /** @type {any} */ (err)?.message || 'Request failed' });
}

/**
 * @param {import('express').Application} app
 */
export function registerSettingsBackupRoutes(app) {
  const guard = (handler) => async (req, res) => {
    if (rejectLimitedClients(req, res)) return undefined;
    try {
      return await handler(req, res);
    } catch (err) {
      return sendError(res, err);
    }
  };

  app.get('/api/settings-backup/capabilities', guard((req, res) => res.json({
    ok: true,
    sections: SETTINGS_SECTION_IDS,
    machineSections: MACHINE_SECTION_IDS,
    devicePreferenceAllowlist: DEVICE_PREFERENCE_ALLOWLIST,
    snapshotNameMax: SNAPSHOT_NAME_MAX,
    platform: process.platform,
    directoryFsyncExpected: process.platform !== 'win32',
  })));

  app.get('/api/settings-backup/snapshots', guard((req, res) => res.json({ ok: true, ...listSnapshots() })));

  app.post('/api/settings-backup/snapshots', guard((req, res) => {
    const body = req.body || {};
    const result = createSnapshot({
      name: body.name,
      includeMachine: body.includeMachine === true,
      devicePreferences: body.devicePreferences,
    });
    return res.json({ ok: true, ...result });
  }));

  app.get('/api/settings-backup/snapshots/:id', guard((req, res) => {
    const envelope = readSnapshot(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="cretli-settings-${envelope.id}.json"`);
    return res.json(envelope.document);
  }));

  app.delete('/api/settings-backup/snapshots/:id', guard((req, res) => res.json({ ok: true, ...deleteSnapshot(req.params.id) })));

  // Export builds the document on the fly; nothing is written on the server.
  app.post('/api/settings-backup/export', guard((req, res) => {
    const body = req.body || {};
    return res.json({
      ok: true,
      document: buildSettingsDocument({ includeMachine: body.includeMachine === true, devicePreferences: body.devicePreferences }),
    });
  }));

  app.post('/api/settings-backup/preview', guard((req, res) => {
    const body = req.body || {};
    const document = body.snapshotId ? readSnapshot(String(body.snapshotId)).document : body.document;
    return res.json({ ok: true, preview: previewImport({ document }) });
  }));

  app.post('/api/settings-backup/apply', guard(async (req, res) => {
    const body = req.body || {};
    const result = await applyImport({
      previewId: body.previewId,
      sections: body.sections,
      workspaceMapping: body.workspaceMapping && typeof body.workspaceMapping === 'object' ? body.workspaceMapping : {},
    });
    return res.status(result.ok ? 200 : 500).json({ ...result, status: result.ok ? 'saved' : 'error' });
  }));

  app.get('/api/settings-backup/pending', guard((req, res) => res.json({ ok: true, ...readPending() })));

  app.post('/api/settings-backup/pending/activate', guard(async (req, res) => {
    const body = req.body || {};
    return res.json({ ok: true, ...(await activatePending({ keys: body.keys, confirm: body.confirm === true })) });
  }));
}
