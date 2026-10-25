/**
 * HTTP API for conversation export/import (B3).
 * Admin-equivalent only: widget and MCP-integration credentials are refused.
 * Docs: docs/backup/conversations-export-import.md.
 *
 * Long operations are jobs: the response carries a job id and the work continues
 * regardless of the connection. Downloads are addressed by job id, never by path.
 */

import express from 'express';
import { getConversationsBackupService } from '../backup/conversations-backup-service.js';
import { JOB_ID_PATTERN, BackupJobError } from '../backup/backup-jobs.js';
import { ConversationArchiveError, DEFAULT_MAX_IMPORT_BYTES } from '../backup/conversations-archive.js';
import { ConversationImportError } from '../backup/conversations-import.js';
import { ConversationStoreError } from '../backup/conversations-store.js';
import { ZipArchiveError } from '../backup/zip-store.js';
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
  const known = err instanceof ConversationArchiveError
    || err instanceof ConversationImportError
    || err instanceof BackupJobError
    || err instanceof ConversationStoreError
    || err instanceof ZipArchiveError;
  if (known) {
    const e = /** @type {any} */ (err);
    return res.status(e.status || 400).json({ ok: false, status: 'error', code: e.code, error: e.message, ...(e.extra || {}) });
  }
  const type = /** @type {any} */ (err)?.type;
  if (type === 'entity.too.large') return res.status(413).json({ ok: false, status: 'error', code: 'archive_size_exceeded', error: 'Archive too large' });
  return res.status(500).json({ ok: false, status: 'error', code: 'INTERNAL', error: /** @type {any} */ (err)?.message || 'Request failed' });
}

/**
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
function idempotencyKeyOf(req) {
  const header = req.get('Idempotency-Key');
  const bodyKey = req.body && typeof req.body === 'object' ? req.body.idempotencyKey : undefined;
  const value = header || bodyKey;
  return value === undefined || value === '' ? undefined : String(value);
}

/**
 * @param {import('express').Application} app
 * @param {{ service?: ReturnType<typeof getConversationsBackupService>, maxImportBytes?: number }} [deps]
 */
export function registerConversationsBackupRoutes(app, deps = {}) {
  const service = () => deps.service || getConversationsBackupService();
  const maxImportBytes = deps.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES;
  const guard = (handler) => async (req, res) => {
    if (rejectLimitedClients(req, res)) return undefined;
    try {
      return await handler(req, res);
    } catch (err) {
      return sendError(res, err);
    }
  };
  const base = '/api/conversations-backup';

  app.get(`${base}/capabilities`, guard((req, res) => res.json({
    ok: true,
    profile: 'conversations-v1',
    scopes: ['chat', 'selection', 'workspace', 'all'],
    formats: ['archive', 'markdown'],
    maxImportBytes,
    notes: [
      'Only the server-retained transcript is exported; trimmed events are not recreated.',
      'Unsynchronized queues of this or other devices are not part of the archive.',
      'Archives contain conversation content and attachments and are not anonymized.',
    ],
  })));

  app.post(`${base}/export/estimate`, guard(async (req, res) => res.json({ ok: true, estimate: await service().estimateExport(req.body) })));

  app.post(`${base}/export`, guard((req, res) => {
    const job = service().startExport(req.body, { idempotencyKey: idempotencyKeyOf(req) });
    return res.status(202).json({ ok: true, job });
  }));

  app.get(`${base}/jobs`, guard((req, res) => res.json({ ok: true, jobs: service().jobs.list() })));

  app.get(`${base}/jobs/:id`, guard((req, res) => {
    const job = JOB_ID_PATTERN.test(req.params.id) ? service().jobs.get(req.params.id) : null;
    if (!job) throw new BackupJobError('JOB_NOT_FOUND', 'Job not found', 404);
    return res.json({ ok: true, job });
  }));

  app.post(`${base}/jobs/:id/cancel`, guard((req, res) => {
    if (!JOB_ID_PATTERN.test(req.params.id)) throw new BackupJobError('JOB_NOT_FOUND', 'Job not found', 404);
    return res.json({ ok: true, job: service().jobs.cancel(req.params.id) });
  }));

  app.get(`${base}/jobs/:id/download`, guard((req, res) => {
    const id = req.params.id;
    const job = JOB_ID_PATTERN.test(id) ? service().jobs.get(id) : null;
    const file = job ? service().jobs.artifactPath(id) : null;
    if (!job || !file || !job.artifact) throw new BackupJobError('ARTIFACT_NOT_FOUND', 'No downloadable result for this job', 404);
    res.setHeader('Content-Type', job.artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${job.artifact.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-SHA256', job.artifact.sha256);
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(file);
  }));

  app.delete(`${base}/jobs/:id`, guard((req, res) => {
    if (!JOB_ID_PATTERN.test(req.params.id)) throw new BackupJobError('JOB_NOT_FOUND', 'Job not found', 404);
    service().jobs.delete(req.params.id);
    return res.json({ ok: true });
  }));

  // The archive is uploaded raw (application/zip); JSON bodies are not accepted here.
  app.post(
    `${base}/import/stage`,
    express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: maxImportBytes }),
    guard(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ConversationArchiveError('zip_invalid', 'Send the archive as an application/zip body');
      return res.json({ ok: true, staged: await service().stageImport(req.body) });
    }),
  );

  app.delete(`${base}/import/stage/:stageId`, guard((req, res) => {
    service().importer.discardStage(String(req.params.stageId));
    return res.json({ ok: true });
  }));

  app.post(`${base}/import/preview`, guard(async (req, res) => {
    const body = req.body || {};
    return res.json({ ok: true, preview: await service().previewImport({ stageId: body.stageId, options: body.options }) });
  }));

  app.post(`${base}/import/apply`, guard((req, res) => {
    const body = req.body || {};
    const job = service().startImportApply({ previewId: body.previewId });
    return res.status(202).json({ ok: true, job });
  }));
}
