/**
 * Durable parent-loop workflow state. This is not a server sequencer: the
 * parent still starts each child and writes role/round/verdict here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';
import { normalizeCodeReviewPoolRound, normalizeCodeReviewPoolHistory } from '../delegation-pool-round.js';
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
 * @returns {{ v: number, items: Record<string, any>[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
  documentParseCount += 1;
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
 * @param {Record<string, any>[]} items
 */
function saveItems(items) {
  ensureDelegationOwnerLock();
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
  // Bump after the write so an in-process save never serves a stale cache even
  // when the file stat (mtime granularity, same size) did not change.
  writeRevision += 1;
  normalizedCache = null;
}

/** Bumped on every in-process save; part of the cache key. */
let writeRevision = 0;
/** @type {{ key: string, items: ReadonlyArray<Record<string, any>> } | null} */
let normalizedCache = null;
/** Count of real parses of the workflow file; exposed for tests. */
let documentParseCount = 0;

/** @returns {number} */
export function getDelegationWorkflowsParseCount() {
  return documentParseCount;
}

/** Drop the parsed/normalized cache (tests, external file rewrites). */
export function resetDelegationWorkflowsCache() {
  normalizedCache = null;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * @returns {string}
 */
function readCacheKey() {
  try {
    const stat = fs.statSync(DATA_FILE);
    return `${writeRevision}:${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return `${writeRevision}:missing`;
  }
}

/**
 * Durable key→fingerprint map. Legacy rows only stored the last pair.
 *
 * @param {Record<string, any> | null | undefined} row
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
 * @param {Record<string, any> | null | undefined} row
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
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
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
    findingsText: String(row?.findingsText || '').trim(),
    openFindingsText: String(row?.openFindingsText || '').trim(),
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
    treeBudgetTokens: Number.isFinite(Number(row?.treeBudgetTokens)) && Number(row.treeBudgetTokens) > 0
      ? Math.floor(Number(row.treeBudgetTokens))
      : 0,
    treeBudgetCostUsd: Number.isFinite(Number(row?.treeBudgetCostUsd)) && Number(row.treeBudgetCostUsd) > 0
      ? Number(row.treeBudgetCostUsd)
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
    codeReviewAuditDone: row?.codeReviewAuditDone === true,
    codeReviewClosureCount: Number.isFinite(Number(row?.codeReviewClosureCount))
      ? Math.max(0, Math.floor(Number(row.codeReviewClosureCount)))
      : 0,
    codeReviewAuditReviewer: String(row?.codeReviewAuditReviewer || row?.code_review_audit_reviewer || '').trim(),
    codeReviewLastClosureRoundKey: String(row?.codeReviewLastClosureRoundKey || '').trim(),
    codeReviewClosureEpoch: Number.isFinite(Number(row?.codeReviewClosureEpoch))
      ? Math.max(0, Math.floor(Number(row.codeReviewClosureEpoch)))
      : 0,
    codeReviewPoolRound: normalizeCodeReviewPoolRound(row?.codeReviewPoolRound),
    codeReviewPoolHistory: normalizeCodeReviewPoolHistory(row?.codeReviewPoolHistory),
    maxCodeReviewClosures: Number.isFinite(Number(row?.maxCodeReviewClosures))
      ? Math.max(0, Math.floor(Number(row.maxCodeReviewClosures)))
      : undefined,
    updatedAt: String(row?.updatedAt || '').trim(),
  };
}

/**
 * Rows are deep-frozen and shared between calls until the store changes (stat
 * or in-process save); callers must copy a row before editing it. The array
 * itself is fresh per call.
 *
 * @returns {Record<string, any>[]}
 */
export function loadDelegationWorkflows() {
  const key = readCacheKey();
  if (!normalizedCache || normalizedCache.key !== key) {
    const items = loadDocument().items
      .map((row) => normalizeDelegationWorkflowRow(row))
      .filter((row) => row.parentChatId);
    items.forEach((row) => deepFreeze(row));
    normalizedCache = { key, items: Object.freeze(items) };
  }
  return normalizedCache.items.slice();
}

/**
 * @param {unknown} parentChatId
 * @param {unknown} [leafId]
 * @returns {Record<string, any> | null}
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
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
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

/**
 * Move selected leaf workflow rows and preserve the chat-wide tree caps.
 * This must run inside delegation store work so readers never observe a
 * partially moved workflow set.
 * @param {string} fromChatId
 * @param {string} toChatId
 * @param {string[]} leafIds
 * @returns {number}
 */
export function reassignDelegationWorkflows(fromChatId, toChatId, leafIds) {
  const from = String(fromChatId || '').trim();
  const to = String(toChatId || '').trim();
  const leaves = new Set((Array.isArray(leafIds) ? leafIds : []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean));
  if (!from || !to || from === to) return 0;
  const items = loadDelegationWorkflows();
  const sourceWide = items.find((row) => row.parentChatId === from && !row.leafId);
  const targetWide = items.find((row) => row.parentChatId === to && !row.leafId);
  let changed = 0;
  const transferCap = (left, right) => {
    const values = [Number(left) || 0, Number(right) || 0].filter((value) => value > 0);
    return values.length ? Math.min(...values) : 0;
  };
  const next = items.map((row) => {
    if (row.parentChatId === from && leaves.has(String(row.leafId || '').toLowerCase())) {
      changed += 1;
      return normalizeDelegationWorkflowRow({ ...row, parentChatId: to, updatedAt: new Date().toISOString() });
    }
    return row;
  });
  if (sourceWide) {
    const destIndex = next.findIndex((row) => row.parentChatId === to && !row.leafId);
    if (destIndex < 0) {
      next.push(normalizeDelegationWorkflowRow({ ...sourceWide, parentChatId: to, updatedAt: new Date().toISOString() }));
    } else {
      const target = next[destIndex];
      next[destIndex] = normalizeDelegationWorkflowRow({
        ...target,
        treeBudgetTokens: transferCap(sourceWide.treeBudgetTokens, target.treeBudgetTokens),
        treeBudgetCostUsd: transferCap(sourceWide.treeBudgetCostUsd, target.treeBudgetCostUsd),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  if (changed || (sourceWide && !targetWide)) saveItems(next);
  else if (sourceWide && targetWide) saveItems(next);
  return changed;
}
