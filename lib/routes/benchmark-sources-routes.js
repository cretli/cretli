/**
 * Settings → Harness: external benchmark source registry and snapshot import.
 *
 * `GET  /api/harness-benchmark-sources`              registry + local snapshots
 * `PUT  /api/harness-benchmark-sources/terms`        record terms verification
 * `PUT  /api/harness-benchmark-sources/import`       import bounded snapshot JSON
 * `PUT  /api/harness-benchmark-sources/source`       enable/disable a built-in source
 * `POST /api/harness-benchmark-sources/reset`        reset store to empty (writes .bak backup)
 *
 * Mutating routes require If-Match (428 when missing, 409 on stale ETag). Widget and MCP
 * integration callers receive 403. Reset is operator-only maintenance — not exposed in UI.
 *
 * Full session + CSRF (global requireAuth). Widget and MCP callers are denied.
 * Server owns timestamps on verification/import; request bodies must not carry them.
 */

import { msg } from '../messages.js';
import { buildBenchmarkSourceRegistryView } from '../benchmark-source-registry.js';
import {
  importBenchmarkSnapshot,
  pickLatestTermsVerification,
  readBenchmarkSnapshots,
  resetBenchmarkSnapshotsStore,
  setBenchmarkSourceEnabled,
  writeBenchmarkTermsVerification,
} from '../persist/benchmark-snapshots-persist.js';

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIfMatch(value) {
  const header = Array.isArray(value) ? value[0] : value;
  return String(header || '').trim();
}

/**
 * @param {ReturnType<typeof readBenchmarkSnapshots>} snapshot
 * @returns {object}
 */
function publicPayload(snapshot) {
  const registry = buildBenchmarkSourceRegistryView({
    sourcePreferences: snapshot.sourcePreferences,
  }).map((row) => {
    const pref = snapshot.sourcePreferences?.[row.id];
    const enabled = typeof pref?.enabled === 'boolean' ? pref.enabled : row.enabled;
    const latest = [...snapshot.snapshots]
      .filter((snap) => String(snap.sourceId || '').trim() === row.id)
      .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0] || null;
    const terms = pickLatestTermsVerification(row.id, snapshot.termsVerifications);
    return {
      ...row,
      enabled,
      termsVerification: terms,
      latestSnapshot: latest,
    };
  });
  return {
    ok: true,
    state: snapshot.state,
    error: snapshot.error,
    etag: snapshot.etag,
    localMode: { fetchEnabled: false, networkAttemptStatus: 'not_applicable', outgoingMetadata: 'none' },
    sources: registry,
    snapshots: snapshot.snapshots,
    unknownTopLevelKeys: snapshot.unknownTopLevelKeys,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ benchmarkSnapshotsFile?: string }} [ctx]
 */
export function registerBenchmarkSourcesRoutes(app, ctx = {}) {
  const filePath = String(ctx.benchmarkSnapshotsFile || '').trim() || undefined;

  app.get('/api/harness-benchmark-sources', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const snapshot = readBenchmarkSnapshots({ filePath });
      return res.json(publicPayload(snapshot));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/harness-benchmark-sources/terms', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!ifMatch) {
      const current = readBenchmarkSnapshots({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    const { verifiedAt: _ignoredAt, verifiedBy: _ignoredBy, ...verification } = body;
    try {
      const result = writeBenchmarkTermsVerification({
        filePath,
        verification,
        ifMatch,
        verifiedBy: 'operator',
      });
      if (!result.ok) {
        const status = result.conflict ? 409 : (result.code ? 400 : 409);
        return res.status(status).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
          code: result.code,
        });
      }
      return res.json({ ok: true, state: result.state, etag: result.etag, verification: result.verification });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/harness-benchmark-sources/import', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!ifMatch) {
      const current = readBenchmarkSnapshots({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    const { importedAt: _ignoredImportAt, importedBy: _ignoredImportBy, ...importBody } = body;
    try {
      const result = importBenchmarkSnapshot({
        filePath,
        importBody,
        ifMatch,
        importedBy: 'operator',
      });
      if (!result.ok) {
        const status = result.conflict ? 409 : (result.code ? 400 : 409);
        return res.status(status).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
          code: result.code,
        });
      }
      return res.json({ ok: true, state: result.state, etag: result.etag, snapshot: result.snapshot });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/harness-benchmark-sources/source', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!ifMatch) {
      const current = readBenchmarkSnapshots({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    try {
      const result = setBenchmarkSourceEnabled({
        filePath,
        sourceId: body.sourceId,
        enabled: body.enabled,
        ifMatch,
      });
      if (!result.ok) {
        const status = result.conflict ? 409 : (result.code ? 400 : 409);
        return res.status(status).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
          code: result.code,
        });
      }
      return res.json({
        ok: true,
        state: result.state,
        etag: result.etag,
        sourceId: result.sourceId,
        enabled: result.enabled,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/harness-benchmark-sources/reset', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    if (!ifMatch) {
      const current = readBenchmarkSnapshots({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    try {
      const result = resetBenchmarkSnapshotsStore({ filePath, ifMatch });
      if (!result.ok) {
        return res.status(result.conflict ? 409 : 500).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
        });
      }
      return res.json({
        ok: true,
        state: result.state,
        etag: result.etag,
        backupPath: result.backupPath,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
