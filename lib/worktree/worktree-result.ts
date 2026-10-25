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

export interface WorktreeResultChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface WorktreeResultDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface WorktreeResultReview {
  outcome: string;
  reportedOutcome: string;
  verified: boolean;
  delegationId: string;
  attemptId: string;
  implementerAttemptId: string;
  reviewerCount: number;
  independence: string;
  stateReason: string;
}

export interface WorktreeResultBody {
  version: number;
  cycleId: string;
  todoId: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  worktreePath: string;
  materialRevision: string;
  patchPath: string;
  patchSha256: string;
  patchBytes: number;
  changedFiles: WorktreeResultChangedFile[];
  diffStat: WorktreeResultDiffStat;
  review: WorktreeResultReview;
  test: { outcome: string; evidence: string };
  outcome: string;
  recordedAt: string;
}

export interface WorktreeResult extends WorktreeResultBody {
  resultHash: string;
}

function readString(value: unknown): string {
  return String(value ?? '').trim();
}

function readTimestamp(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeChangedFiles(raw: unknown): WorktreeResultChangedFile[] {
  if (!Array.isArray(raw)) return [];
  const files: WorktreeResultChangedFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
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

function normalizeDiffStat(raw: unknown): WorktreeResultDiffStat {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const count = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
  return {
    files: count(source.files),
    insertions: count(source.insertions),
    deletions: count(source.deletions),
  };
}

/**
 * Canonical payload that feeds `resultHash`. Timestamps and the patch location
 * are excluded so a repeated report of the same work hashes identically.
 */
function resultHashPayload(result: WorktreeResultBody): string {
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
 */
export function normalizeWorktreeResult(raw: unknown): WorktreeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
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
        outcome: readString((source.review as Record<string, unknown>).outcome),
        reportedOutcome: readString((source.review as Record<string, unknown>).reportedOutcome),
        verified: (source.review as Record<string, unknown>).verified === true,
        // Attempt-level evidence pinning the review to a concrete job attempt
        // (`docs/todo-review-contract.md` §8.1). Empty for legacy results.
        delegationId: readString((source.review as Record<string, unknown>).delegationId),
        attemptId: readString((source.review as Record<string, unknown>).attemptId),
        implementerAttemptId: readString((source.review as Record<string, unknown>).implementerAttemptId),
        reviewerCount: Number.isFinite(Number((source.review as Record<string, unknown>).reviewerCount))
          ? Math.max(0, Math.floor(Number((source.review as Record<string, unknown>).reviewerCount)))
          : 0,
        independence: readString((source.review as Record<string, unknown>).independence),
        stateReason: readString((source.review as Record<string, unknown>).stateReason),
      }
      : {
        outcome: '',
        reportedOutcome: '',
        verified: false,
        delegationId: '',
        attemptId: '',
        implementerAttemptId: '',
        reviewerCount: 0,
        independence: '',
        stateReason: '',
      },
    test: source.test && typeof source.test === 'object'
      ? {
        outcome: readString((source.test as Record<string, unknown>).outcome),
        evidence: readString((source.test as Record<string, unknown>).evidence).slice(0, RESULT_STRING_MAX),
      }
      : { outcome: '', evidence: '' },
    outcome: readString(source.outcome) || 'unknown',
    recordedAt,
  } as WorktreeResult;
  result.resultHash = readString(source.resultHash) || hashWorktreeResult(result);
  return result;
}

export function hashWorktreeResult(result: WorktreeResultBody): string {
  return createHash('sha256').update(resultHashPayload(result), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Build a normalized result and (re)compute its content hash.
 */
export function createWorktreeResult(fields: Record<string, unknown>): WorktreeResult {
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
 */
export function worktreeResultDir(dataDir: string, todoId: string): string {
  return path.join(String(dataDir || '.').trim() || '.', 'worktree-results', String(todoId || '').trim());
}

/**
 * Deterministic patch path for one cycle. The cycle id is sanitized so it can
 * never escape the result directory.
 */
export function worktreeResultPatchPath(dataDir: string, todoId: string, cycleId: string): string {
  const safeCycle = String(cycleId || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'cycle';
  return path.join(worktreeResultDir(dataDir, todoId), `${safeCycle}.patch`);
}
