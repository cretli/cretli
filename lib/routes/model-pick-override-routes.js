/**
 * Shared HTTP surface for audited model-selection overrides.
 *
 * Registered twice with two base paths and scopes:
 * - `Settings → Harness` mounts the global scope under
 *   `/api/harness-model-role-config/overrides`;
 * - the Workspace Watcher mounts the workspace scope under
 *   `/api/workspace-watcher/overrides`, resolving the folder from the request.
 *
 * Every mutation is a full-session + CSRF request (the global `requireAuth`
 * middleware owns that) and refuses widget/MCP callers. The server owns the
 * identity/time fields. A normal write needs `If-Match`; a stale ETag is a 409
 * and an invalid store is never overwritten except by the explicit reset, which
 * backs up first.
 */

import {
  createModelPickOverride,
  readModelPickOverrides,
  resetModelPickOverrides,
  revokeModelPickOverride,
} from '../persist/model-pick-overrides-persist.js';
import {
  MODEL_PICK_OVERRIDE_AUDIT_LIMIT,
  buildModelPickOverrideAuditEvent,
} from '../model-pick-overrides.js';
import { msg } from '../messages.js';

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
 * Project a snapshot onto the scope the caller is allowed to see.
 *
 * @param {ReturnType<typeof readModelPickOverrides>} snapshot
 * @param {'global' | 'workspace'} scope
 * @param {string} workspaceFolder
 * @returns {Record<string, any>}
 */
function publicSnapshot(snapshot, scope, workspaceFolder) {
  const overrides = snapshot.overrides.filter((/** @type {Record<string, any>} */ row) => (
    scope === 'workspace'
      ? row.scope === 'workspace' && row.workspaceFolder === workspaceFolder
      : row.scope === 'global'
  ));
  // The audit view also surfaces an already-expired row that was never
  // explicitly revoked, so the operator sees why it stopped applying.
  const now = Date.now();
  const derivedExpiry = overrides
    .filter((/** @type {Record<string, any>} */ row) => !row.revokedAt && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) <= now)
    .map((/** @type {Record<string, any>} */ row) => buildModelPickOverrideAuditEvent({
      type: 'expire',
      id: row.id,
      at: row.expiresAt,
      detail: 'expired before revocation',
    }));
  return {
    ok: true,
    scope,
    state: snapshot.state,
    error: snapshot.error,
    etag: snapshot.etag,
    overrides,
    audit: [...snapshot.audit, ...derivedExpiry].slice(-MODEL_PICK_OVERRIDE_AUDIT_LIMIT),
    unknownTopLevelKeys: snapshot.unknownTopLevelKeys,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   basePath: string,
 *   scope: 'global' | 'workspace',
 *   filePath?: string,
 *   resolveWorkspaceFolder?: (req: import('express').Request) => string,
 *   source?: string,
 * }} ctx
 */
export function registerModelPickOverrideRoutes(app, ctx) {
  const basePath = String(ctx.basePath || '').replace(/\/+$/, '');
  const scope = ctx.scope === 'workspace' ? 'workspace' : 'global';
  const source = String(ctx.source || (scope === 'workspace' ? 'workspace-watcher-ui' : 'settings-ui'));
  const filePath = ctx.filePath;
  /**
   * @param {import('express').Request} req
   * @returns {string}
   */
  const folderOf = (req) => String(
    ctx.resolveWorkspaceFolder ? ctx.resolveWorkspaceFolder(req) : req.query?.workspaceFolder || req.body?.workspaceFolder || '',
  ).trim();

  app.get(basePath, (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const snapshot = readModelPickOverrides({ filePath });
      const workspaceFolder = folderOf(req);
      if (scope === 'workspace' && !workspaceFolder) {
        return res.status(400).json({ ok: false, error: 'workspaceFolder is required' });
      }
      return res.json(publicSnapshot(snapshot, scope, workspaceFolder));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put(basePath, (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const workspaceFolder = folderOf(req);
    if (scope === 'workspace' && !workspaceFolder) {
      return res.status(400).json({ ok: false, error: 'workspaceFolder is required' });
    }
    if (!ifMatch) {
      const current = readModelPickOverrides({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    try {
      const override = scope === 'workspace'
        ? { ...body, scope: 'workspace', workspaceFolder }
        : { ...body, scope: 'global', workspaceFolder: '' };
      /** @type {Record<string, any>} */
      const result = createModelPickOverride({
        filePath,
        override,
        createdBy: 'operator',
        source,
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
      return res.json({ ok: true, state: result.state, etag: result.etag, override: result.record });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(`${basePath}/revoke`, (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!ifMatch) {
      const current = readModelPickOverrides({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    try {
      /** @type {Record<string, any>} */
      const result = revokeModelPickOverride({
        filePath,
        id: body.id,
        ifMatch,
        by: 'operator',
        reason: body.reason,
      });
      if (!result.ok) {
        return res.status(result.conflict ? 409 : 404).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
          code: result.code,
        });
      }
      return res.json({ ok: true, state: result.state, etag: result.etag, override: result.record });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(`${basePath}/reset`, (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const workspaceFolder = folderOf(req);
    if (scope === 'workspace' && !workspaceFolder) {
      return res.status(400).json({ ok: false, error: 'workspaceFolder is required' });
    }
    if (!ifMatch) {
      const current = readModelPickOverrides({ filePath });
      return res.status(428).json({
        ok: false,
        error: 'If-Match header is required',
        state: current.state,
        etag: current.etag,
      });
    }
    try {
      /** @type {Record<string, any>} */
      const result = resetModelPickOverrides({
        filePath,
        scope,
        workspaceFolder,
        ifMatch,
        by: 'operator',
      });
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
        removed: result.removed,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
