/**
 * Worktree record shape and state vocabulary.
 *
 * `executionState` / `integrationState` names and values come from the settled
 * §8.1 contract. O2 (stored vs derived, exact schema) and O12 (store format)
 * stay OPEN: this module only defines the minimal durable record the registry
 * needs, and never infers an integration decision from it.
 */

import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.js';
import { normalizeWorktreeResult } from './worktree-result.js';
import { isWorktreeRecordLive } from './worktree-record-live.js';

export { isWorktreeRecordLive };

export const WORKTREE_RECORD_VERSION = 1;

export const EXECUTION_STATES = Object.freeze(['none', 'preparing', 'active', 'execution_closed']);
export const INTEGRATION_STATES = Object.freeze(['not_applicable', 'pending', 'ready', 'integrated', 'rejected']);
/** `reserved` is a creation reservation, not an execution state (O2). */
export const CREATION_STATES = Object.freeze(['reserved', 'ready']);

const EXECUTION_STATE_SET = new Set(EXECUTION_STATES);
const INTEGRATION_STATE_SET = new Set(INTEGRATION_STATES);

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function readUniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = readString(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function readEnum(value, allowed, fallback) {
  const text = readString(value);
  return allowed.includes(text) ? text : fallback;
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
 * @param {unknown} value
 * @returns {{ code: string, message: string, at: string } | null}
 */
function readLastError(value) {
  if (!value || typeof value !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  const code = readString(source.code);
  const message = readString(source.message);
  const at = readTimestamp(source.at);
  if (!code && !message) return null;
  return { code: code || 'WORKTREE_ERROR', message, at: at || new Date(0).toISOString() };
}

/**
 * @param {unknown} value
 * @returns {{ readyAt: string|null, integratedAt: string|null, rejectedAt: string|null, reason: string } | null}
 */
function readIntegrationMeta(value) {
  if (!value || typeof value !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  const readyAt = readTimestamp(source.readyAt);
  const integratedAt = readTimestamp(source.integratedAt);
  const rejectedAt = readTimestamp(source.rejectedAt);
  const reason = readString(source.reason);
  if (!readyAt && !integratedAt && !rejectedAt && !reason) return null;
  return { readyAt, integratedAt, rejectedAt, reason };
}

/**
 * Normalize a stored record. Returns null when identity fields are missing:
 * a record that cannot be verified must not be trusted, and the manager's
 * path/branch checks still fail closed for the underlying directory.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorktreeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const todoId = readString(source.todoId);
  const workspaceFolder = readString(source.workspaceFolder);
  const worktreePath = readString(source.worktreePath);
  const branch = readString(source.branch);
  const baseCommit = readString(source.baseCommit);
  if (!todoId || !workspaceFolder || !worktreePath || !branch || !baseCommit) return null;
  const createdAt = readTimestamp(source.createdAt) || new Date(0).toISOString();
  /** @type {Record<string, object>} */
  const results = {};
  if (source.results && typeof source.results === 'object') {
    for (const value of Object.values(/** @type {Record<string, unknown>} */ (source.results))) {
      const result = normalizeWorktreeResult(value);
      if (result) results[result.cycleId] = result;
    }
  }
  return {
    version: WORKTREE_RECORD_VERSION,
    todoId,
    workspaceFolder,
    repoRoot: readString(source.repoRoot),
    worktreePath,
    branch,
    baseCommit,
    baseKind: readEnum(source.baseKind, ['clean', 'head', 'snapshot'], 'clean'),
    skippedPaths: readUniqueStrings(source.skippedPaths),
    snapshotOfHead: readString(source.snapshotOfHead),
    snapshotRef: readString(source.snapshotRef),
    mode: 'worktree',
    creationState: readEnum(source.creationState, CREATION_STATES, 'ready'),
    executionState: readEnum(source.executionState, EXECUTION_STATES, 'none'),
    integrationState: readEnum(source.integrationState, INTEGRATION_STATES, 'not_applicable'),
    cycles: readUniqueStrings(source.cycles),
    chats: readUniqueStrings(source.chats),
    results,
    integration: readIntegrationMeta(source.integration),
    createdAt,
    updatedAt: readTimestamp(source.updatedAt) || createdAt,
    cleanedAt: readTimestamp(source.cleanedAt),
    releasedAt: readTimestamp(source.releasedAt),
    lastError: readLastError(source.lastError),
  };
}

/**
 * Build a fresh, normalized record. `creationState` defaults to `reserved`
 * because a record is written before the Git worktree exists.
 *
 * @param {object} fields
 * @returns {object}
 */
export function createWorktreeRecord(fields) {
  const record = normalizeWorktreeRecord({
    ...fields,
    createdAt: fields.createdAt || new Date().toISOString(),
    updatedAt: fields.updatedAt || fields.createdAt || new Date().toISOString(),
  });
  if (!record) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      'A worktree record requires todoId, workspaceFolder, worktreePath, branch and baseCommit.',
    );
  }
  return record;
}

/**
 * @param {unknown} state
 * @returns {string}
 */
export function assertExecutionState(state) {
  const value = readString(state);
  if (!EXECUTION_STATE_SET.has(value)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Invalid executionState ${JSON.stringify(state)}; expected one of ${EXECUTION_STATES.join(', ')}.`,
    );
  }
  return value;
}

/**
 * @param {unknown} state
 * @returns {string}
 */
export function assertIntegrationState(state) {
  const value = readString(state);
  if (!INTEGRATION_STATE_SET.has(value)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Invalid integrationState ${JSON.stringify(state)}; expected one of ${INTEGRATION_STATES.join(', ')}.`,
    );
  }
  return value;
}
