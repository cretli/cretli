/**
 * Durable parent-loop workflow state. This is not a server sequencer: the
 * parent still starts each child and writes role/round/verdict here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';
import {
  WORKFLOWS_JSON_SCHEMA_VERSION,
  assertWorkflowsJsonSchemaVersion,
} from './delegation-schema.js';

const DATA_FILE = resolveDataPath('delegation-workflows.json');
const SCHEMA_VERSION = WORKFLOWS_JSON_SCHEMA_VERSION;

export class DelegationWorkflowsCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'DelegationWorkflowsCorruptError';
    this.code = 'DELEGATION_WORKFLOWS_CORRUPT';
  }
}

/**
 * @returns {void}
 */
function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @returns {string}
 */
export function getDelegationWorkflowsDataPath() {
  return DATA_FILE;
}

/**
 * @returns {{ v: number, items: object[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    throw new DelegationWorkflowsCorruptError(
      `Could not read workflow store (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DelegationWorkflowsCorruptError(
      `Workflow file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DelegationWorkflowsCorruptError('Workflow file is not an object');
  }
  if (parsed.items != null && !Array.isArray(parsed.items)) {
    throw new DelegationWorkflowsCorruptError('Workflow file items must be an array');
  }
  const version = assertWorkflowsJsonSchemaVersion(parsed.v);
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    : [];
  return { v: version, items };
}

/**
 * @param {object[]} items
 */
function saveItems(items) {
  ensureDelegationOwnerLock();
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
}

/**
 * Durable key→fingerprint map. Legacy rows only stored the last pair.
 *
 * @param {object | null | undefined} row
 * @returns {Record<string, string>}
 */
function normalizeAppliedWorkflowPatches(row) {
  /** @type {Record<string, string>} */
  const next = {};
  const source = row?.appliedPatches;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, fingerprint] of Object.entries(source)) {
      const k = String(key || '').trim();
      const fp = String(fingerprint || '').trim();
      if (!k || !fp) continue;
      next[k] = fp;
    }
  }
  const lastKey = String(row?.lastIdempotencyKey || '').trim();
  const lastFp = String(row?.lastPatchFingerprint || '').trim();
  if (lastKey && lastFp && !next[lastKey]) next[lastKey] = lastFp;
  return next;
}

/**
 * Legacy FAIL rows omitted last-review snapshots. Seed from the live FAIL
 * fields so a later distinct FAIL still has a baseline.
 *
 * @param {object | null | undefined} row
 * @param {'lastReviewFindingsHash' | 'lastReviewMaterialRevision'} field
 * @param {'findingsHash' | 'materialRevision'} fallbackField
 * @returns {string}
 */
function readLastReviewSnapshotField(row, field, fallbackField) {
  if (row && Object.prototype.hasOwnProperty.call(row, field)) {
    return String(row[field] || '').trim();
  }
  if (String(row?.lastVerdict || '').trim() !== 'FAIL') return '';
  return String(row?.[fallbackField] || '').trim();
}

/**
 * @param {object} row
 * @returns {object}
 */
export function normalizeDelegationWorkflowRow(row) {
  const maxRoundsRaw = Number(row?.maxRounds);
  return {
    parentChatId: String(row?.parentChatId || '').trim(),
    leafId: String(row?.leafId || row?.leaf_id || row?.todoId || row?.todo_id || '').trim().toLowerCase(),
    workspaceFolder: String(row?.workspaceFolder || '').trim(),
    role: String(row?.role || '').trim(),
    round: Number.isFinite(Number(row?.round)) ? Math.max(0, Math.floor(Number(row.round))) : 0,
    maxRounds: Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? Math.floor(maxRoundsRaw) : 4,
    lastImplementer: String(row?.lastImplementer || '').trim(),
    lastModel: String(row?.lastModel || '').trim(),
    lastReviewer: String(row?.lastReviewer || '').trim(),
    findingsHash: String(row?.findingsHash || '').trim(),
    lastVerdict: String(row?.lastVerdict || 'unspecified').trim() || 'unspecified',
    consecutiveSameFail: Number.isFinite(Number(row?.consecutiveSameFail))
      ? Math.max(0, Math.floor(Number(row.consecutiveSameFail)))
      : 0,
    stopReason: String(row?.stopReason || '').trim(),
    deadlineAt: String(row?.deadlineAt || '').trim(),
    budgetTokens: Number.isFinite(Number(row?.budgetTokens)) && Number(row.budgetTokens) > 0
      ? Math.floor(Number(row.budgetTokens))
      : 0,
    budgetCostUsd: Number.isFinite(Number(row?.budgetCostUsd)) && Number(row.budgetCostUsd) > 0
      ? Number(row.budgetCostUsd)
      : 0,
    deadlineCancelKey: String(row?.deadlineCancelKey || row?.deadline_cancel_key || '').trim(),
    materialRevision: String(row?.materialRevision || '').trim(),
    lastReviewFindingsHash: readLastReviewSnapshotField(row, 'lastReviewFindingsHash', 'findingsHash'),
    lastReviewMaterialRevision: readLastReviewSnapshotField(row, 'lastReviewMaterialRevision', 'materialRevision'),
    lastIdempotencyKey: String(row?.lastIdempotencyKey || '').trim(),
    lastPatchFingerprint: String(row?.lastPatchFingerprint || '').trim(),
    appliedPatches: normalizeAppliedWorkflowPatches(row),
    reviewEventCount: Number.isFinite(Number(row?.reviewEventCount))
      ? Math.max(0, Math.floor(Number(row.reviewEventCount)))
      : 0,
    updatedAt: String(row?.updatedAt || '').trim(),
  };
}

/**
 * @returns {object[]}
 */
export function loadDelegationWorkflows() {
  return loadDocument().items.map((row) => normalizeDelegationWorkflowRow(row)).filter((row) => row.parentChatId);
}

/**
 * @param {unknown} parentChatId
 * @param {unknown} [leafId]
 * @returns {object | null}
 */
export function getDelegationWorkflow(parentChatId, leafId) {
  const id = String(parentChatId || '').trim();
  if (!id) return null;
  const leaf = String(leafId || '').trim().toLowerCase();
  return loadDelegationWorkflows().find((row) => {
    if (row.parentChatId !== id) return false;
    return String(row.leafId || '').trim().toLowerCase() === leaf;
  }) || null;
}

/**
 * @param {object} row
 * @returns {object}
 */
export function upsertDelegationWorkflow(row) {
  const next = normalizeDelegationWorkflowRow({
    ...row,
    updatedAt: new Date().toISOString(),
  });
  if (!next.parentChatId) {
    throw new DelegationWorkflowsCorruptError('parentChatId is required');
  }
  const items = loadDelegationWorkflows();
  const leaf = String(next.leafId || '').trim().toLowerCase();
  const index = items.findIndex((item) => {
    if (item.parentChatId !== next.parentChatId) return false;
    return String(item.leafId || '').trim().toLowerCase() === leaf;
  });
  if (index >= 0) items[index] = next;
  else items.push(next);
  saveItems(items);
  return next;
}
