/**
 * Durable store for audited model-selection overrides
 * (`data/model-pick-overrides.json`).
 *
 * The store mirrors the strict model-role config store:
 * - a **missing** file is a valid starting point (no default is written);
 * - an **invalid** file is reported and never overwritten by a normal write —
 *   only the explicit reset, which first copies a byte-exact backup, may replace
 *   it;
 * - writes are atomic and guarded by a raw-content ETag (`If-Match`), so a
 *   concurrent edit is a conflict instead of a lost update;
 * - unknown top-level keys and unknown record fields are preserved verbatim.
 *
 * Global and workspace-scoped records share one file so the precedence rules in
 * `lib/model-pick-overrides.js` can read one consistent snapshot. A workspace
 * write must still pass the scope/folder validation and the caller's ETag.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ifMatchMatches } from '../model-role-config-store.js';
import {
  MODEL_PICK_OVERRIDE_AUDIT_LIMIT,
  ModelPickOverrideError,
  buildModelPickOverrideAuditEvent,
  normalizeModelPickOverride,
  normalizeOverrideWorkspaceFolder,
} from '../model-pick-overrides.js';

/** Top-level keys the store owns. */
export const MODEL_PICK_OVERRIDES_KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  'version',
  'overrides',
  'audit',
]);

/** Current on-disk schema version. */
export const MODEL_PICK_OVERRIDES_SCHEMA_VERSION = 1;

/**
 * @param {{ filePath?: string }} [input]
 * @returns {string}
 */
export function resolveModelPickOverridesPath(input = {}) {
  return String(input.filePath || '').trim() || resolveDataPath('model-pick-overrides.json');
}

/**
 * Content hash of the raw file (or of a stable marker when missing). Raw bytes
 * means any operator edit — even one this store would normalize away — is a
 * conflict.
 *
 * @param {string | null | undefined} rawText
 * @returns {string}
 */
export function computeModelPickOverridesEtag(rawText) {
  const basis = rawText == null ? 'model-pick-overrides:missing' : String(rawText);
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/**
 * @param {string} filePath
 * @returns {{ state: 'missing' | 'valid' | 'invalid', rawText: string | null, document: object | null }}
 */
function readRawDocument(filePath) {
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') {
      return { state: 'missing', rawText: null, document: null };
    }
    return { state: 'invalid', rawText: null, document: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { state: 'invalid', rawText, document: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', rawText, document: null };
  }
  return { state: 'valid', rawText, document: parsed };
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Project one stored row without re-stamping it. Unknown fields are kept; the
 * known fields are read leniently so a hand-edited row still renders.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function readStoredModelPickOverride(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const id = String(source.id ?? '').trim();
  if (!id) return null;
  return {
    ...source,
    id,
    scope: String(source.scope ?? 'global').trim().toLowerCase() === 'workspace' ? 'workspace' : 'global',
    workspaceFolder: normalizeOverrideWorkspaceFolder(source.workspaceFolder),
    targetHarness: String(source.targetHarness ?? '').trim().toLowerCase(),
    targetModel: String(source.targetModel ?? '').trim(),
    targetRole: String(source.targetRole ?? '').trim().toLowerCase(),
    action: String(source.action ?? '').trim().toLowerCase(),
    reason: String(source.reason ?? '').trim(),
    createdBy: String(source.createdBy ?? '').trim(),
    source: String(source.source ?? '').trim(),
    createdAt: String(source.createdAt ?? '').trim(),
    expiresAt: String(source.expiresAt ?? '').trim(),
    revokedAt: String(source.revokedAt ?? '').trim() || null,
    revokedBy: String(source.revokedBy ?? '').trim() || null,
    revokeReason: String(source.revokeReason ?? '').trim(),
  };
}

/**
 * @param {object | null} document
 * @returns {object[]}
 */
function readStoredOverrides(document) {
  const rows = document && Array.isArray(document.overrides) ? document.overrides : [];
  return rows.map(readStoredModelPickOverride).filter((row) => row !== null);
}

/**
 * @param {object | null} document
 * @returns {object[]}
 */
function readStoredAudit(document) {
  const rows = document && Array.isArray(document.audit) ? document.audit : [];
  return rows
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => buildModelPickOverrideAuditEvent(/** @type {object} */ (row)));
}

/**
 * Full snapshot: structure state, ETag, records and the audit tail.
 *
 * @param {{ filePath?: string }} [input]
 * @returns {{
 *   path: string,
 *   state: 'missing' | 'valid' | 'invalid',
 *   error: string | null,
 *   etag: string,
 *   overrides: object[],
 *   audit: object[],
 *   unknownTopLevelKeys: string[],
 * }}
 */
export function readModelPickOverrides(input = {}) {
  const filePath = resolveModelPickOverridesPath(input);
  const raw = readRawDocument(filePath);
  const document = raw.document;
  const unknownTopLevelKeys = document
    ? Object.keys(document).filter((key) => !MODEL_PICK_OVERRIDES_KNOWN_TOP_LEVEL_KEYS.includes(key)).sort()
    : [];
  return {
    path: filePath,
    state: /** @type {'missing'|'valid'|'invalid'} */ (raw.state),
    error: raw.state === 'invalid' ? 'model-pick-overrides.json is not a valid JSON object' : null,
    etag: computeModelPickOverridesEtag(raw.rawText),
    overrides: readStoredOverrides(document),
    audit: readStoredAudit(document),
    unknownTopLevelKeys,
  };
}

/**
 * Build the next document preserving unknown top-level keys.
 *
 * @param {object | null} document
 * @returns {object}
 */
function baseDocument(document) {
  const doc = document && typeof document === 'object' && !Array.isArray(document)
    ? cloneJson(document)
    : {};
  if (!Array.isArray(doc.overrides)) doc.overrides = [];
  if (!Array.isArray(doc.audit)) doc.audit = [];
  doc.version = MODEL_PICK_OVERRIDES_SCHEMA_VERSION;
  return doc;
}

/**
 * @param {object} doc
 * @param {object} event
 * @returns {object}
 */
function withAudit(doc, event) {
  const audit = [...(Array.isArray(doc.audit) ? doc.audit : []), event];
  doc.audit = audit.slice(-MODEL_PICK_OVERRIDE_AUDIT_LIMIT);
  return doc;
}

/**
 * Create one override. The server owns `id`, `createdBy`, `source` and
 * `createdAt`; the caller supplies them through `context`, never the body.
 *
 * @param {{
 *   filePath?: string,
 *   override?: object,
 *   createdBy?: string,
 *   source?: string,
 *   ifMatch?: string | null,
 *   now?: number,
 *   generateId?: () => string,
 * }} input
 * @returns {{ ok: true, state: string, etag: string, record: object } | { ok: false, state: string, error: string, etag: string, conflict?: boolean, code?: string }}
 */
export function createModelPickOverride(input = {}) {
  const filePath = resolveModelPickOverridesPath(input);
  const current = readModelPickOverrides({ filePath });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error || 'invalid store', etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'overrides changed on disk', etag: current.etag, conflict: true };
  }
  let record;
  try {
    record = normalizeModelPickOverride(input.override, {
      now: input.now,
      createdBy: input.createdBy,
      source: input.source,
      generateId: input.generateId,
    });
  } catch (err) {
    if (err instanceof ModelPickOverrideError) {
      return { ok: false, state: current.state, error: err.message, etag: current.etag, code: err.code };
    }
    throw err;
  }
  const doc = baseDocument(readRawDocument(filePath).document);
  doc.overrides = [...(Array.isArray(doc.overrides) ? doc.overrides : []), record];
  withAudit(doc, buildModelPickOverrideAuditEvent({
    type: 'create',
    id: record.id,
    at: record.createdAt,
    actor: record.createdBy,
    detail: `${record.action} ${record.targetHarness || record.targetModel || ''}`.trim(),
  }));
  writeJsonAtomic(filePath, doc);
  const next = readModelPickOverrides({ filePath });
  return { ok: true, state: next.state, etag: next.etag, record };
}

/**
 * Revoke one record (kept on disk as an audit trail; it can never reactivate).
 *
 * @param {{
 *   filePath?: string,
 *   id?: string,
 *   ifMatch?: string | null,
 *   now?: number,
 *   by?: string,
 *   reason?: string,
 * }} input
 * @returns {{ ok: true, state: string, etag: string, record: object } | { ok: false, state: string, error: string, etag: string, conflict?: boolean, code?: string }}
 */
export function revokeModelPickOverride(input = {}) {
  const filePath = resolveModelPickOverridesPath(input);
  const id = String(input.id || '').trim();
  const current = readModelPickOverrides({ filePath });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error || 'invalid store', etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'overrides changed on disk', etag: current.etag, conflict: true };
  }
  const raw = readRawDocument(filePath).document;
  const doc = baseDocument(raw);
  const rows = Array.isArray(doc.overrides) ? doc.overrides : [];
  const index = rows.findIndex((row) => String(row?.id || '').trim() === id);
  if (index < 0) {
    return { ok: false, state: current.state, error: `override ${id} not found`, etag: current.etag, code: 'override_not_found' };
  }
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const revokedAt = new Date(now).toISOString();
  const by = String(input.by || '').trim() || 'operator';
  const reason = String(input.reason || '').trim();
  rows[index] = { ...rows[index], revokedAt, revokedBy: by, revokeReason: reason };
  doc.overrides = rows;
  withAudit(doc, buildModelPickOverrideAuditEvent({
    type: 'revoke',
    id,
    at: revokedAt,
    actor: by,
    detail: reason || 'revoked',
  }));
  writeJsonAtomic(filePath, doc);
  const next = readModelPickOverrides({ filePath });
  return { ok: true, state: next.state, etag: next.etag, record: readStoredModelPickOverride(rows[index]) };
}

/**
 * Reset the override store. Backs up whatever was on disk first; the only path
 * that may replace an invalid file. A scope-limited reset keeps the other scope.
 *
 * @param {{
 *   filePath?: string,
 *   scope?: 'global' | 'workspace' | '',
 *   workspaceFolder?: string,
 *   ifMatch?: string | null,
 *   now?: number,
 *   by?: string,
 * }} input
 * @returns {{ ok: true, state: string, etag: string, backupPath: string | null, removed: number } | { ok: false, state: string, error: string, etag: string, conflict?: boolean }}
 */
export function resetModelPickOverrides(input = {}) {
  const filePath = resolveModelPickOverridesPath(input);
  const current = readModelPickOverrides({ filePath });
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'overrides changed on disk', etag: current.etag, conflict: true };
  }
  const scope = String(input.scope || '').trim().toLowerCase();
  const workspaceFolder = normalizeOverrideWorkspaceFolder(input.workspaceFolder);
  const raw = readRawDocument(filePath);
  let backupPath = null;
  if (raw.state !== 'missing' && raw.rawText != null) {
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    backupPath = `${filePath}.bak-${stamp}`;
    writeTextAtomic(backupPath, raw.rawText);
  }
  let doc;
  let removed = 0;
  if (scope === 'global' || scope === 'workspace') {
    const base = baseDocument(raw.document);
    const before = Array.isArray(base.overrides) ? base.overrides : [];
    const kept = before.filter((row) => {
      const rowScope = String(row?.scope || 'global').trim().toLowerCase() === 'workspace' ? 'workspace' : 'global';
      if (rowScope !== scope) return true;
      if (scope === 'workspace' && normalizeOverrideWorkspaceFolder(row?.workspaceFolder) !== workspaceFolder) return true;
      return false;
    });
    removed = before.length - kept.length;
    base.overrides = kept;
    doc = withAudit(base, buildModelPickOverrideAuditEvent({
      type: 'reset',
      at: new Date(Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()).toISOString(),
      actor: String(input.by || '').trim() || 'operator',
      detail: scope,
    }));
  } else {
    removed = readStoredOverrides(raw.document).length;
    doc = withAudit(
      { version: MODEL_PICK_OVERRIDES_SCHEMA_VERSION, overrides: [], audit: [] },
      buildModelPickOverrideAuditEvent({
        type: 'reset',
        at: new Date(Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()).toISOString(),
        actor: String(input.by || '').trim() || 'operator',
        detail: 'all',
      }),
    );
  }
  writeJsonAtomic(filePath, doc);
  const next = readModelPickOverrides({ filePath });
  return { ok: true, state: next.state, etag: next.etag, backupPath, removed };
}

/**
 * Append an audit event (e.g. a refusal or an expiry observed at start time)
 * without touching the override records.
 *
 * @param {{ filePath?: string, event?: object }} input
 * @returns {{ ok: boolean, etag: string }}
 */
export function recordModelPickOverrideAudit(input = {}) {
  const filePath = resolveModelPickOverridesPath(input);
  const raw = readRawDocument(filePath);
  if (raw.state === 'invalid') return { ok: false, etag: computeModelPickOverridesEtag(raw.rawText) };
  const doc = baseDocument(raw.document);
  withAudit(doc, buildModelPickOverrideAuditEvent(input.event || {}));
  writeJsonAtomic(filePath, doc);
  return { ok: true, etag: readModelPickOverrides({ filePath }).etag };
}

/**
 * Active overrides matching a selection, loaded from disk. This is the one
 * loader every runtime path (picker, Watcher orchestrator, named start) uses,
 * so the same TTL and scope rules apply everywhere.
 *
 * @param {{ filePath?: string, workspaceFolder?: string, now?: number }} [input]
 * @returns {object[]}
 */
export function loadModelPickOverridesForSelection(input = {}) {
  try {
    return readModelPickOverrides({ filePath: input.filePath }).overrides;
  } catch {
    return [];
  }
}
