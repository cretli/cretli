/**
 * Worktree record shape and state vocabulary.
 *
 * `executionState` / `integrationState` names and values come from the settled
 * §8.1 contract. O2 (stored vs derived, exact schema) and O12 (store format)
 * stay OPEN: this module only defines the minimal durable record the registry
 * needs, and never infers an integration decision from it.
 */

import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.ts';
import { normalizeWorktreeResult, type WorktreeResult } from './worktree-result.ts';
import { isWorktreeRecordLive } from './worktree-record-live.ts';

export { isWorktreeRecordLive };

export const WORKTREE_RECORD_VERSION = 1;

export const EXECUTION_STATES = Object.freeze(['none', 'preparing', 'active', 'execution_closed']);
export const INTEGRATION_STATES = Object.freeze(['not_applicable', 'pending', 'ready', 'integrated', 'rejected']);
/** `reserved` is a creation reservation, not an execution state (O2). */
export const CREATION_STATES = Object.freeze(['reserved', 'ready']);

const EXECUTION_STATE_SET = new Set(EXECUTION_STATES);
const INTEGRATION_STATE_SET = new Set(INTEGRATION_STATES);

export interface WorktreeRecordError {
  code: string;
  message: string;
  at: string;
}

export interface WorktreeIntegrationMeta {
  readyAt: string | null;
  integratedAt: string | null;
  rejectedAt: string | null;
  reason: string;
}

export interface WorktreeRecord {
  version: number;
  todoId: string;
  workspaceFolder: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  baseKind: string;
  skippedPaths: string[];
  snapshotOfHead: string;
  snapshotRef: string;
  mode: 'worktree';
  creationState: string;
  executionState: string;
  integrationState: string;
  cycles: string[];
  chats: string[];
  results: Record<string, WorktreeResult>;
  integration: WorktreeIntegrationMeta | null;
  createdAt: string;
  updatedAt: string;
  cleanedAt: string | null;
  releasedAt: string | null;
  lastError: WorktreeRecordError | null;
  /** Parent tree id when this is a per-leaf worktree branched from the tree branch; '' otherwise. */
  treeTodoId: string;
  /** Branch of the tree worktree the leaf is merged back into after PASS. */
  treeBranch: string;
}

function readString(value: unknown): string {
  return String(value ?? '').trim();
}

function readUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function readEnum(value: unknown, allowed: readonly string[], fallback: string): string {
  const text = readString(value);
  return allowed.includes(text) ? text : fallback;
}

function readTimestamp(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function readLastError(value: unknown): WorktreeRecordError | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const code = readString(source.code);
  const message = readString(source.message);
  const at = readTimestamp(source.at);
  if (!code && !message) return null;
  return { code: code || 'WORKTREE_ERROR', message, at: at || new Date(0).toISOString() };
}

function readIntegrationMeta(value: unknown): WorktreeIntegrationMeta | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
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
 */
export function normalizeWorktreeRecord(raw: unknown): WorktreeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const todoId = readString(source.todoId);
  const workspaceFolder = readString(source.workspaceFolder);
  const worktreePath = readString(source.worktreePath);
  const branch = readString(source.branch);
  const baseCommit = readString(source.baseCommit);
  if (!todoId || !workspaceFolder || !worktreePath || !branch || !baseCommit) return null;
  const createdAt = readTimestamp(source.createdAt) || new Date(0).toISOString();
  const results: Record<string, WorktreeResult> = {};
  if (source.results && typeof source.results === 'object') {
    for (const value of Object.values(source.results as Record<string, unknown>)) {
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
    treeTodoId: readString(source.treeTodoId),
    treeBranch: readString(source.treeBranch),
  };
}

/**
 * Build a fresh, normalized record. `creationState` defaults to `reserved`
 * because a record is written before the Git worktree exists.
 */
export function createWorktreeRecord(fields: Record<string, unknown>): WorktreeRecord {
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

export function assertExecutionState(state: unknown): string {
  const value = readString(state);
  if (!EXECUTION_STATE_SET.has(value)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Invalid executionState ${JSON.stringify(state)}; expected one of ${EXECUTION_STATES.join(', ')}.`,
    );
  }
  return value;
}

export function assertIntegrationState(state: unknown): string {
  const value = readString(state);
  if (!INTEGRATION_STATE_SET.has(value)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Invalid integrationState ${JSON.stringify(state)}; expected one of ${INTEGRATION_STATES.join(', ')}.`,
    );
  }
  return value;
}
