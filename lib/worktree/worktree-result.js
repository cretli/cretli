/**
 * Worktree execution result record (contract §9.1, §9.4, S14).
 *
 * One entry per watcher cycle, keyed by `cycleId`, stored under the worktree
 * registry record. The record is an artifact for manual integration: it never
 * commits anything and it is idempotent by cycle id, so a repeated report, a
 * restart or a lost claim can neither double-count nor lose it.
 *
 * `resultHash` is a content fingerprint of the durable fields (timestamps are
 * excluded). The store compares it before writing, so replaying the identical
 * report leaves the registry revision untouched.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';

export const WORKTREE_RESULT_VERSION = 1;
const RESULT_STRING_MAX = 400;
const RESULT_MAX_CHANGED_FILES = 2000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function readTimestamp(value) {
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * @param {unknown} raw
 * @returns {Array<{ path: string, status: string, additions: number | null, deletions: number | null }>}
 */
function normalizeChangedFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const files = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = /** @type {Record<string, unknown>} */ (item);
    const filePath = readString(source.path);
    if (!filePath) continue;
    const additions = Number.isFinite(Number(source.additions)) ? Math.max(0, Math.floor(Number(source.additions))) : null;
    const deletions = Number.isFinite(Number(source.deletions)) ? Math.max(0, Math.floor(Number(source.deletions))) : null;
    files.push({
      path: filePath,
      status: readString(source.status) || 'M',
      additions,
      deletions,
    });
    if (files.length >= RESULT_MAX_CHANGED_FILES) break;
  }
  return files;
}

/**
 * @param {unknown} raw
 * @returns {{ files: number, insertions: number, deletions: number }}
 */
function normalizeDiffStat(raw) {
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
  return {
    files: count(source.files),
    insertions: count(source.insertions),
    deletions: count(source.deletions),
  };
}

/**
 * Canonical payload that feeds `resultHash`. Timestamps and the patch location
 * are excluded so a repeated report of the same work hashes identically.
 *
 * @param {object} result
 * @returns {string}
 */
function resultHashPayload(result) {
  return JSON.stringify({
    v: WORKTREE_RESULT_VERSION,
    cycleId: result.cycleId,
    baseCommit: result.baseCommit,
    headCommit: result.headCommit,
    branch: result.branch,
    worktreePath: result.worktreePath,
    materialRevision: result.materialRevision,
    changedFiles: result.changedFiles,
    diffStat: result.diffStat,
    review: result.review,
    test: result.test,
    outcome: result.outcome,
    patchBytes: result.patchBytes,
  });
}

/**
 * Normalize a stored/created result record. Returns null without a cycle id or
 * base commit: an unidentifiable result must not look like evidence.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorktreeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const cycleId = readString(source.cycleId);
  const baseCommit = readString(source.baseCommit);
  if (!cycleId || !baseCommit) return null;
  const recordedAt = readTimestamp(source.recordedAt) || new Date(0).toISOString();
  const result = {
    version: WORKTREE_RESULT_VERSION,
    cycleId,
    todoId: readString(source.todoId),
    baseCommit,
    headCommit: readString(source.headCommit),
    branch: readString(source.branch).slice(0, RESULT_STRING_MAX),
    worktreePath: readString(source.worktreePath),
    materialRevision: readString(source.materialRevision).slice(0, RESULT_STRING_MAX),
    patchPath: readString(source.patchPath),
    patchSha256: readString(source.patchSha256),
    patchBytes: Number.isFinite(Number(source.patchBytes)) ? Math.max(0, Math.floor(Number(source.patchBytes))) : 0,
    changedFiles: normalizeChangedFiles(source.changedFiles),
    diffStat: normalizeDiffStat(source.diffStat),
    review: source.review && typeof source.review === 'object'
      ? {
        outcome: readString(/** @type {any} */ (source.review).outcome),
        reportedOutcome: readString(/** @type {any} */ (source.review).reportedOutcome),
        verified: /** @type {any} */ (source.review).verified === true,
      }
      : { outcome: '', reportedOutcome: '', verified: false },
    test: source.test && typeof source.test === 'object'
      ? {
        outcome: readString(/** @type {any} */ (source.test).outcome),
        evidence: readString(/** @type {any} */ (source.test).evidence).slice(0, RESULT_STRING_MAX),
      }
      : { outcome: '', evidence: '' },
    outcome: readString(source.outcome) || 'unknown',
    recordedAt,
  };
  result.resultHash = readString(source.resultHash) || hashWorktreeResult(result);
  return result;
}

/**
 * @param {object} result
 * @returns {string}
 */
export function hashWorktreeResult(result) {
  return createHash('sha256').update(resultHashPayload(result), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Build a normalized result and (re)compute its content hash.
 *
 * @param {object} fields
 * @returns {object}
 */
export function createWorktreeResult(fields) {
  const result = normalizeWorktreeResult({
    ...fields,
    recordedAt: fields.recordedAt || new Date().toISOString(),
  });
  if (!result) {
    throw new Error('A worktree result requires cycleId and baseCommit.');
  }
  result.resultHash = hashWorktreeResult(result);
  return result;
}

/**
 * Directory that holds generated patches for one todo, under the logical data
 * root — never inside the worktree or the main `data/` runtime state (§10.3).
 *
 * @param {string} dataDir
 * @param {string} todoId
 * @returns {string}
 */
export function worktreeResultDir(dataDir, todoId) {
  return path.join(String(dataDir || '.').trim() || '.', 'worktree-results', String(todoId || '').trim());
}

/**
 * Deterministic patch path for one cycle. The cycle id is sanitized so it can
 * never escape the result directory.
 *
 * @param {string} dataDir
 * @param {string} todoId
 * @param {string} cycleId
 * @returns {string}
 */
export function worktreeResultPatchPath(dataDir, todoId, cycleId) {
  const safeCycle = String(cycleId || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'cycle';
  return path.join(worktreeResultDir(dataDir, todoId), `${safeCycle}.patch`);
}
