import { normalizeTodoActivity, recordTodoActivity } from '../todo-timeline.js';
/**
 * Todo list per workspace (CWD) — JSON in data/todos/<sha256-realpath>.json.
 * Shared logic for the HTTP API (UI and external clients).
 */

import { createHash, randomUUID } from 'crypto';
import fs, { mkdirSync, existsSync, realpathSync } from 'fs';
import path from 'path';
import { normalizePartialPhases } from '../watcher-phases.js';
import { isValidAgentTransport, normalizeAgentTransport } from '../agent-transport.js';
import { stripTitleJsonTrailer } from '../todo-changelog-text.js';
import {
  collectTodoSubtreeIds,
  decideDeferredMove,
  decideRestoreToTree,
  TODO_LATER_ROOT_TITLE,
  buildTodoIndex,
  isTodoBranchBlocked,
  readTodoParentId,
  renumberTodoSiblings,
  synchronizeTodoParentStatuses,
  TODO_MAX_DEPTH,
  todoNodeDepth,
  todoSubtreeHeight,
  wouldCreateTodoParentCycle,
} from '../todo-tree.js';
import { writeJsonAtomic } from './atomic-write.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';
import { normalizeWorktreeMode } from '../worktree/worktree-mode.ts';
import { isTodoIntegrationState, isTodoAwaitingIntegration } from '../todo-integration-state.js';
import {
  isTodoReviewIndependenceClass,
  isTodoReviewState,
  isTodoReviewSubject,
  isTodoReviewSubjectSource,
  summarizeTodoReviewIndependence,
  TODO_REVIEW_MAX_REVIEWERS,
  TODO_REVIEW_SCHEMA_VERSION,
  TODO_REVIEW_STATES,
  TODO_REVIEW_SUBJECTS,
  todoReviewDecisionKey,
} from '../todo-review-state.js';
import { handleTodoLeafMaterialOnStatusChange, normalizeTodoLeafMaterial } from '../todo-leaf-material.js';
import { normalizeFeedbackOrigin, stampFeedbackOrigins } from '../feedback-marker.js';

/** @typedef {import('../shared-types/persist-records.js').TodoRecord & Record<string, any>} TodoRecord */

/*
 * Store locking: every mutating function below performs load -> modify ->
 * save synchronously under the same cross-process lock as watcher state.
 * The lock is reentrant within this process, so a watcher transaction can
 * claim a todo without a second lock or an ordering deadlock. Every writer
 * uses it, including chat links that preserve the item's CAS revision.
 */

const DATA_VERSION = 3;
export const TODOS_MAX_ITEMS = 2000;
/** Max durable idempotency keys per workspace todos document (drop oldest when exceeded). */
export const TODOS_MAX_IDEMPOTENCY_ENTRIES = 4000;
/** Max length of an idempotency key string (trimmed before storage). */
export const TODOS_MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** Suppresses watcher autopilot nudges for internal claim/release writes. */
let todosWatcherNudgeSuppressDepth = 0;

/**
 * Normalized todo documents keyed by file path. A save replaces the entry with the written document.
 * Callers receive copies so an in-memory edit does not dirty the cache.
 *
 * @type {Map<string, { signature: string, doc: { version: number, updatedAt: string, items: Record<string, any>[], idempotency: Record<string, { hash: string, todoId: string }> } }>}
 */
const todosCache = new Map();

/**
 * Documents returned by a save, mapped to the file signature right after their
 * write. Lets a caller prove the file is untouched since (no other writer ran)
 * and reuse the returned document instead of re-parsing the file.
 *
 * @type {WeakMap<object, string>}
 */
const writtenDocSignatures = new WeakMap();

/**
 * @param {string} filePath
 * @returns {string}
 */
function readTodoFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * Cheap revision token of the todo file for a workspace (stat only, no parse).
 * Empty string when the file is missing; callers must not cache on empty.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @returns {string}
 */
export function getTodosFileRevision(dataDir, cwd) {
  const key = workspaceKeyFromCwd(cwd);
  if (!key) return '';
  const filePath = todosFilePath(dataDir, key);
  return filePath ? readTodoFileSignature(filePath) : '';
}

/**
 * @param {{ version: number, updatedAt: string, items: Record<string, any>[], idempotency?: Record<string, { hash: string, todoId: string }> }} doc
 * @returns {{ version: number, updatedAt: string, items: Record<string, any>[], idempotency: Record<string, { hash: string, todoId: string }> }}
 */
function copyTodoDoc(doc) {
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const idempotency = {};
  for (const [key, value] of Object.entries(doc.idempotency || {})) {
    idempotency[key] = { hash: value.hash, todoId: value.todoId };
  }
  return {
    version: doc.version,
    updatedAt: doc.updatedAt,
    items: doc.items.map((row) => ({ ...row })),
    idempotency,
  };
}

/**
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withTodosWatcherNudgeSuppressed(fn) {
  todosWatcherNudgeSuppressDepth += 1;
  try {
    return fn();
  } finally {
    todosWatcherNudgeSuppressDepth -= 1;
  }
}
const MAX_TITLE_LEN = 500;
export const MAX_BODY_LEN = 8000;
const MAX_PLAN_MARKDOWN_LEN = 32000;
const MAX_CHANGELOG_ENTRIES = 100;
const MAX_CHANGELOG_TEXT_LEN = 4000;
export const TODO_STATUSES = Object.freeze(['idea', 'ready', 'doing', 'done', 'deferred']);
const MAX_DEFERRED_REASON_LEN = 500;
const ALLOWED_STATUS = new Set(TODO_STATUSES);
const ALLOWED_CHANGELOG_KINDS = new Set(['plan', 'implement', 'note']);
/** Patch keys that only record which chat touched the todo (no revision bump). */
const LINK_ONLY_PATCH_KEYS = new Set(['linkedChatId', 'expectedUpdatedAt', 'strictStatus']);
const TODO_RUN_MODES = new Set(['parallel', 'sequential']);
const TODO_ASSIGNEE_ROLES = new Set(['plan', 'implement', 'review']);

/**
 * @param {string} cwd
 * @returns {string|null}
 */
export function workspaceKeyFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;
  try {
    const rp = realpathSync(trimmed);
    return createHash('sha256').update(rp, 'utf8').digest('hex');
  } catch {
    return createHash('sha256').update(path.resolve(trimmed), 'utf8').digest('hex');
  }
}

function todosDir(dataDir) {
  return path.join(dataDir, 'todos');
}

function todosFilePath(dataDir, key) {
  if (!key) return null;
  return path.join(todosDir(dataDir), `${key}.json`);
}

function ensureTodosDir(dataDir) {
  const dir = todosDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Absolute path of a workspace's todos document, or null when the folder does
 * not normalize. Exposed for operator tooling that must copy or restore the
 * document (the review backfill's rollback point) without re-deriving the
 * store's layout. It resolves the path only: it never reads or writes.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @returns {string|null}
 */
export function todosDocumentPath(dataDir, cwd) {
  const key = workspaceKeyFromCwd(cwd);
  return key ? todosFilePath(dataDir, key) : null;
}

/**
 * @param {any} t
 * @returns {string}
 */
function normalizeTitle(t) {
  const s = t != null ? String(t).trim() : '';
  if (!s) return '';
  return s.length > MAX_TITLE_LEN ? s.slice(0, MAX_TITLE_LEN) : s;
}

/**
 * Reports whether persisting `b` as a todo body would cut it. Callers surface
 * this so the truncation is never a silent success.
 * @param {any} b
 * @returns {{ truncated: boolean, truncated_chars: number, max_body_len: number }}
 */
export function describeBodyTruncation(b) {
  const len = b == null || b === '' ? 0 : String(b).length;
  const cut = Math.max(0, len - MAX_BODY_LEN);
  return { truncated: cut > 0, truncated_chars: cut, max_body_len: MAX_BODY_LEN };
}

/**
 * @param {any} b
 * @returns {string}
 */
function normalizeBody(b) {
  if (b == null || b === '') return '';
  const s = String(b);
  return s.length > MAX_BODY_LEN ? s.slice(0, MAX_BODY_LEN) : s;
}

/**
 * @param {any} s
 * @returns {'idea'|'ready'|'doing'|'done'|'deferred'}
 */
export function normalizeStatus(s) {
  const v = s != null ? String(s).trim().toLowerCase() : 'idea';
  return ALLOWED_STATUS.has(v) ? v : 'idea';
}

/**
 * Reject unknown statuses instead of coercing them to idea.
 *
 * @param {any} raw
 * @returns {'idea'|'ready'|'doing'|'done'|'deferred'}
 */
export function parseTodoStatus(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!ALLOWED_STATUS.has(value)) {
    /** @type {Error & { code?: any }} */
    const err = new Error(`Invalid todo status "${String(raw ?? '')}"`);
    err.code = 'VALIDATION';
    throw err;
  }
  return value;
}

/**
 * Optional ISO date of a deferred todo. Unparseable input is dropped.
 *
 * @param {any} value
 * @returns {string|undefined}
 */
function normalizeDeferredUntil(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && Number.isFinite(Date.parse(s)) ? s : undefined;
}

/**
 * @param {any} value
 * @returns {string|undefined}
 */
function normalizeDeferredReason(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, MAX_DEFERRED_REASON_LEN) : undefined;
}

/**
 * @param {any} value
 * @returns {string|undefined}
 */
function normalizeChatId(value) {
  if (value == null || value === '') return undefined;
  const s = String(value).trim();
  return s || undefined;
}

/**
 * @param {any} value
 * @returns {string|undefined}
 */
function normalizeLinkedChatId(value) {
  if (value == null || value === '') return undefined;
  const s = String(value).trim();
  return s || undefined;
}

/**
 * Opt-in `nonBlocking` flag: only an explicit true (or the string "true") counts,
 * so the default semantics (an open `idea` sibling blocks) never change by accident.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function normalizeNonBlocking(raw) {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

/**
 * @param {any} raw
 * @returns {'parallel'|'sequential'|undefined}
 */
function normalizeRunMode(raw) {
  const value = raw != null ? String(raw).trim().toLowerCase() : '';
  return TODO_RUN_MODES.has(value) ? value : undefined;
}

/**
 * Per-todo execution mode override. `inherit` (and an absent/empty value) is
 * stored as no field, so a watcher policy default applies; only an explicit
 * `worktree`/`project` is durable. Unknown values return `undefined` on load
 * and are rejected by create/update before they are written.
 *
 * @param {any} raw
 * @returns {'worktree' | 'project' | undefined}
 */
function normalizeExecutionMode(raw) {
  if (raw == null || String(raw).trim() === '') return undefined;
  const mode = normalizeWorktreeMode(raw);
  if (!mode || mode === 'inherit') return undefined;
  return mode;
}

/**
 * Folder (a git repo of the workspace) a todo's work runs in; absent means the
 * workspace's todo home. Only absolute paths are kept, in posix form.
 *
 * @param {any} raw
 * @returns {string} '' when absent or not absolute
 */
export function normalizeExecutionFolder(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^(\/|[A-Za-z]:\/)/.test(value) ? value : '';
}

/**
 * Effective execution folder of a todo: its own value, else the nearest
 * ancestor's, else ''.
 *
 * @param {Array<{ id: string, parentId?: string, executionFolder?: string }>} items
 * @param {string} id
 * @returns {string}
 */
export function resolveTodoExecutionFolder(items, id) {
  const byId = new Map((Array.isArray(items) ? items : []).map((it) => [it.id, it]));
  const seen = new Set();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    if (cur.executionFolder) return cur.executionFolder;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return '';
}

/**
 * Per-todo reviewer pair override: `{ enabled?, members? }`. Members keep only
 * well-formed `{ harness, model }` entries (trimmed, at most 2). An empty or
 * invalid value normalizes to absence so behavior stays unchanged.
 *
 * @param {any} raw
 * @returns {{ enabled?: boolean, members?: Array<{ harness: string, model: string }> } | undefined}
 */
export function normalizeReviewerPair(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  /** @type {Record<string, any>} */
  const out = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const members = [];
  for (const m of Array.isArray(raw.members) ? raw.members : []) {
    const harness = typeof m?.harness === 'string' ? m.harness.trim() : '';
    const model = typeof m?.model === 'string' ? m.model.trim() : '';
    if (harness && model && members.length < 2) members.push({ harness, model });
  }
  if (members.length > 0) out.members = members;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Unknown harness or role drops the whole assignee. Load stays tolerant
 * (invalid stored data disappears); create/update reject beforehand.
 *
 * @param {any} raw
 * @returns {{ harness: string, model?: string, role: 'plan'|'implement'|'review' }|undefined}
 */
function normalizeAssignee(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const harness = typeof source.harness === 'string' ? source.harness.trim().toLowerCase() : '';
  if (!isValidAgentTransport(harness)) return undefined;
  const role = typeof source.role === 'string' ? source.role.trim().toLowerCase() : '';
  if (!TODO_ASSIGNEE_ROLES.has(role)) return undefined;
  const assignee = {
    harness: normalizeAgentTransport(harness),
    role: /** @type {'plan'|'implement'|'review'} */ (role),
  };
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  if (model) assignee.model = model;
  return assignee;
}

/**
 * MCP clients bound to the object schema cannot send null, so an assignee
 * with an empty harness also means "clear".
 *
 * @param {any} raw
 * @returns {boolean}
 */
function isAssigneeClear(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  return String(/** @type {Record<string, unknown>} */ (raw).harness ?? '').trim() === '';
}

/**
 * Strict API-side siblingIndex: integer >= 0 or throws.
 *
 * @param {any} raw
 * @returns {number|undefined}
 */
function parseSiblingIndex(raw) {
  if (raw == null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) {
    /** @type {Error & { code?: any }} */
    const err = new Error('siblingIndex must be an integer >= 0');
    err.code = 'VALIDATION';
    throw err;
  }
  return value;
}

/**
 * @param {any} planInput
 * @returns {{ markdown: string, updatedAt: string, markdownUpdatedAt?: string, sourceChatId?: string, approvedAt?: string, approvedBy?: { kind: 'mcp-operator', clientId: string, clientName: string } }|undefined}
 */
function normalizePlan(planInput) {
  if (!planInput || typeof planInput !== 'object') return undefined;
  const source = /** @type {Record<string, unknown>} */ (planInput);
  const markdownRaw = source.markdown != null ? String(source.markdown) : '';
  const markdown = markdownRaw.length > MAX_PLAN_MARKDOWN_LEN
    ? markdownRaw.slice(0, MAX_PLAN_MARKDOWN_LEN)
    : markdownRaw;
  if (!markdown.trim()) return undefined;
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.trim()
    ? source.updatedAt.trim()
    : new Date().toISOString();
  const plan = {
    markdown,
    updatedAt,
  };
  // Time of the last markdown change; unlike `updatedAt` it is not bumped by
  // approval or metadata patches, so plan reviews can be tied to a revision.
  if (typeof source.markdownUpdatedAt === 'string' && source.markdownUpdatedAt.trim()) {
    plan.markdownUpdatedAt = source.markdownUpdatedAt.trim();
  } else if (typeof source.updatedAt === 'string' && source.updatedAt.trim()) {
    // Legacy plans have only a combined content/metadata timestamp. Preserve
    // it as a conservative baseline until the next actual markdown edit.
    plan.markdownUpdatedAt = source.updatedAt.trim();
  }
  const sourceChatId = normalizeChatId(source.sourceChatId);
  if (sourceChatId) plan.sourceChatId = sourceChatId;
  if (typeof source.approvedAt === 'string' && source.approvedAt.trim()) {
    plan.approvedAt = source.approvedAt.trim();
    // Provenance only makes sense next to an approval; legacy plans have none.
    const by = source.approvedBy;
    if (by && typeof by === 'object' && /** @type {any} */ (by).kind === 'mcp-operator') {
      const clientId = String(/** @type {any} */ (by).clientId || '').trim().slice(0, 100);
      if (clientId) {
        plan.approvedBy = {
          kind: 'mcp-operator',
          clientId,
          clientName: String(/** @type {any} */ (by).clientName || '').trim().slice(0, 200),
        };
      }
    }
  }
  return plan;
}

/**
 * Durable integration pointer for a worktree-backed leaf (contract §8.1, O2).
 * `state` is the agreed field: `ready` means review passed and the worktree
 * result awaits a human integration. The remaining fields are the operator
 * view persisted next to the state so the UI does not have to read the Git
 * registry; the authoritative result record stays in the worktree registry.
 *
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
function normalizeTodoIntegration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const state = String(source.state ?? '').trim();
  if (!isTodoIntegrationState(state)) return undefined;
  const out = { state };
  for (const field of TODO_INTEGRATION_STRING_FIELDS) {
    const value = String(source[field] ?? '').trim();
    if (value) out[field] = value.slice(0, TODO_EXECUTION_FIELD_MAX);
  }
  if (source.changeScope === 'none' || source.changeScope === 'code') out.changeScope = source.changeScope;
  for (const field of ['noCodeReason', 'noCodeConfirmedAt', 'noCodeMaterialFingerprint']) {
    const value = String(source[field] ?? '').trim();
    if (value) out[field] = value.slice(0, TODO_EXECUTION_FIELD_MAX);
  }
  if (Array.isArray(source.changedFiles)) {
    const files = source.changedFiles
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, TODO_INTEGRATION_MAX_CHANGED_FILES);
    if (files.length) out.changedFiles = files;
  }
  if (source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence)) {
    const proof = /** @type {Record<string, unknown>} */ (source.evidence);
    /** @type {Record<string, unknown>} */
    const normalizedProof = {};
    for (const field of TODO_INTEGRATION_EVIDENCE_STRING_FIELDS) {
      const value = String(proof[field] ?? '').trim();
      if (value) normalizedProof[field] = value.slice(0, TODO_EXECUTION_FIELD_MAX);
    }
    normalizedProof.changeAttested = proof.changeAttested === true;
    normalizedProof.branchVerified = proof.branchVerified === true;
    if (proof.scope === 'tree') normalizedProof.scope = 'tree';
    if (proof.changeScope === 'none') normalizedProof.changeScope = 'none';
    if (Object.keys(normalizedProof).some((field) => field !== 'changeAttested' && field !== 'branchVerified')) {
      out.evidence = normalizedProof;
    }
  }
  out.updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.trim()
    ? source.updatedAt.trim()
    : new Date().toISOString();
  return out;
}

/** Bounded string length of the review text fields. */
const TODO_REVIEW_TEXT_MAX = 200;
/** Bounded string length of a review reason code. */
const TODO_REVIEW_REASON_MAX = 120;
/** Bounded string length of a review timestamp. */
const TODO_REVIEW_TIMESTAMP_MAX = 40;

/**
 * @param {any} value
 * @param {number} [max]
 * @returns {string}
 */
function normalizeReviewText(value, max = TODO_REVIEW_TEXT_MAX) {
  const text = value != null ? String(value).trim() : '';
  return text ? text.slice(0, max) : '';
}

/**
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
function normalizeReviewRound(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, unknown>} */
  const out = {
    index: Number.isInteger(source.index) && source.index >= 0 ? source.index : 0,
  };
  const id = normalizeReviewText(source.id);
  if (id) out.id = id;
  const openedAt = normalizeReviewText(source.openedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (openedAt) out.openedAt = openedAt;
  const invalidationAt = normalizeReviewText(source.invalidationAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (invalidationAt) out.invalidationAt = invalidationAt;
  return out;
}

/**
 * One reviewer entry. `delegationId` and `attemptId` are the durable identity
 * pair (`docs/todo-review-contract.md` §5.1); an entry without them is dropped.
 *
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
function normalizeReviewReviewer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const delegationId = normalizeReviewText(source.delegationId);
  const attemptId = normalizeReviewText(source.attemptId);
  if (!delegationId || !attemptId) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {
    delegationId,
    attemptId,
    usable: source.usable === true,
    verifyStatus: normalizeReviewText(source.verifyStatus, TODO_REVIEW_TIMESTAMP_MAX),
    independence: isTodoReviewIndependenceClass(source.independence)
      ? String(source.independence).trim()
      : 'unknown',
  };
  const preexisting = Math.floor(Number(source.verifyPreexisting));
  if (preexisting > 0) out.verifyPreexisting = Math.min(preexisting, 200);
  for (const field of ['leafId', 'harness', 'model', 'baseModel', 'status', 'verdict']) {
    const value = normalizeReviewText(source[field]);
    if (value) out[field] = value;
  }
  for (const field of ['queuedAt', 'startedAt', 'finishedAt']) {
    const value = normalizeReviewText(source[field], TODO_REVIEW_TIMESTAMP_MAX);
    if (value) out[field] = value;
  }
  return out;
}

/**
 * @param {any} raw
 * @returns {Record<string, unknown>|null}
 */
function normalizeReviewImplementer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const delegationId = normalizeReviewText(source.delegationId);
  const attemptId = normalizeReviewText(source.attemptId);
  if (!delegationId || !attemptId) return null;
  /** @type {Record<string, unknown>} */
  const out = {
    delegationId,
    attemptId,
    role: source.role === 'fix' ? 'fix' : 'implement',
  };
  for (const field of ['harness', 'model', 'baseModel']) {
    const value = normalizeReviewText(source[field]);
    if (value) out[field] = value;
  }
  const startedAt = normalizeReviewText(source.startedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (startedAt) out.startedAt = startedAt;
  return out;
}

/**
 * @param {any} raw
 * @param {Record<string, unknown>|null} implementer
 * @param {Array<Record<string, unknown>>} reviewers
 * @returns {{ independent: boolean, class: string, reference: string }}
 */
function normalizeReviewIndependence(raw, implementer, reviewers) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = /** @type {Record<string, unknown>} */ (raw);
    const cls = isTodoReviewIndependenceClass(source.class) ? String(source.class).trim() : 'unknown';
    return {
      independent: cls === 'different_base_model' || cls === 'same_model_other_harness',
      class: cls,
      reference: implementer ? 'implementer' : 'none',
    };
  }
  return summarizeTodoReviewIndependence(reviewers, implementer);
}

/**
 * @param {any} raw
 * @returns {Record<string, unknown>|null}
 */
function normalizeReviewMaterial(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const kind = normalizeReviewText(source.kind, TODO_REVIEW_TIMESTAMP_MAX).toLowerCase();
  return {
    current: source.current === true,
    kind: kind === 'unavailable' ? 'unavailable' : 'trusted',
    reason: normalizeReviewText(source.reason, TODO_REVIEW_REASON_MAX),
    revision: normalizeReviewText(source.revision, TODO_REVIEW_TEXT_MAX),
  };
}

/**
 * @param {any} raw
 * @returns {Record<string, unknown>|null}
 */
function normalizeReviewAcceptance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const actor = normalizeReviewText(source.actor, TODO_REVIEW_TIMESTAMP_MAX);
  if (!actor) return null;
  /** @type {Record<string, unknown>} */
  const out = { actor };
  for (const field of ['at', 'delegationId', 'attemptId', 'expectedTodoRevision']) {
    const value = normalizeReviewText(source[field], field === 'at' ? TODO_REVIEW_TIMESTAMP_MAX : TODO_REVIEW_TEXT_MAX);
    if (value) out[field] = value;
  }
  return out;
}

/**
 * One per-subject snapshot (`docs/todo-review-contract.md` §5.4). A malformed
 * value or an unrecognized state/subject degrades to `unknown` — never to a
 * silent `passed`.
 *
 * @param {'code'|'plan'|'other'} subject
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
function normalizeReviewSnapshot(subject, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'unknown', subject, subjectSource: 'unknown' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, unknown>} */
  const out = {
    state: isTodoReviewState(source.state) ? String(source.state).trim() : 'unknown',
  };
  const rawSubject = normalizeReviewText(source.subject, TODO_REVIEW_TIMESTAMP_MAX);
  if (isTodoReviewSubject(rawSubject)) {
    out.subject = rawSubject;
    out.subjectSource = isTodoReviewSubjectSource(source.subjectSource)
      ? String(source.subjectSource).trim()
      : 'explicit';
  } else if (rawSubject) {
    out.subject = subject;
    out.subjectSource = 'unknown';
    out.state = 'unknown';
  } else {
    out.subject = subject;
    out.subjectSource = isTodoReviewSubjectSource(source.subjectSource)
      ? String(source.subjectSource).trim()
      : 'default';
  }
  const stateReason = normalizeReviewText(source.stateReason, TODO_REVIEW_REASON_MAX);
  if (stateReason) out.stateReason = stateReason;
  const round = normalizeReviewRound(source.round);
  if (round) out.round = round;
  /** @type {Array<Record<string, unknown>>} */
  const reviewers = [];
  let reviewersTruncated = false;
  if (Array.isArray(source.reviewers)) {
    for (const entry of source.reviewers) {
      const normalized = normalizeReviewReviewer(entry);
      if (!normalized) continue;
      if (reviewers.length >= TODO_REVIEW_MAX_REVIEWERS) {
        reviewersTruncated = true;
        break;
      }
      reviewers.push(normalized);
    }
  }
  out.reviewers = reviewers;
  out.reviewerCount = reviewers.length;
  out.truncated = source.truncated === true || reviewersTruncated;
  if (out.truncated) out.state = 'unknown';
  const implementer = normalizeReviewImplementer(source.implementer);
  out.implementer = implementer;
  out.independence = normalizeReviewIndependence(source.independence, implementer, reviewers);
  out.material = normalizeReviewMaterial(source.material);
  out.acceptance = normalizeReviewAcceptance(source.acceptance);
  const updatedAt = normalizeReviewText(source.updatedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/**
 * Derived container rollup (`docs/todo-review-contract.md` §12). Audit-only:
 * it never carries reviewers and never certifies the container.
 *
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
function normalizeTodoReviewAggregate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, unknown>} */
  const out = { source: 'children' };
  let hasCounts = false;
  for (const subject of ['code', 'plan']) {
    const counts = source[subject];
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
    const sourceCounts = /** @type {Record<string, unknown>} */ (counts);
    /** @type {Record<string, number>} */
    const normalized = {};
    for (const state of TODO_REVIEW_STATES) {
      normalized[state] = Number.isInteger(sourceCounts[state]) && sourceCounts[state] >= 0
        ? sourceCounts[state]
        : 0;
    }
    out[subject] = normalized;
    hasCounts = true;
  }
  if (!hasCounts) return undefined;
  out.truncated = source.truncated === true;
  const computedAt = normalizeReviewText(source.computedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (computedAt) out.computedAt = computedAt;
  return out;
}

/**
 * Normalized persisted `todo.review` snapshot. Returns `undefined` for a
 * missing or unusable value so old records load unchanged. The `decisionKey` is
 * always recomputed (timestamps excluded), which is what makes a review write
 * idempotent.
 *
 * @param {any} raw
 * @returns {Record<string, unknown>|undefined}
 */
export function normalizeTodoReview(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, unknown>} */
  const out = {
    schemaVersion: TODO_REVIEW_SCHEMA_VERSION,
    generation: Number.isInteger(source.generation) && source.generation >= 0 ? source.generation : 0,
  };
  let hasSnapshot = false;
  for (const subject of TODO_REVIEW_SUBJECTS) {
    const snapshot = normalizeReviewSnapshot(subject, source[subject]);
    if (!snapshot) continue;
    out[subject] = snapshot;
    hasSnapshot = true;
  }
  const aggregate = normalizeTodoReviewAggregate(source.aggregate);
  if (aggregate) out.aggregate = aggregate;
  if (!hasSnapshot && !aggregate) return undefined;
  const computedAt = normalizeReviewText(source.computedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (computedAt) out.computedAt = computedAt;
  const updatedAt = normalizeReviewText(source.updatedAt, TODO_REVIEW_TIMESTAMP_MAX);
  if (updatedAt) out.updatedAt = updatedAt;
  out.decisionKey = todoReviewDecisionKey(out);
  return out;
}

/**
 * Copy the stored subject snapshots the incoming write did not mention, so a
 * `code` write never drops the stored `plan` snapshot and vice versa (§3.4).
 *
 * @param {Record<string, unknown>|null} stored
 * @param {Record<string, unknown>} incoming
 * @returns {Record<string, unknown>}
 */
function mergeTodoReviewSubjects(stored, incoming) {
  const merged = { ...incoming };
  // The container `aggregate` is a stored rollup too: a per-subject write must
  // not drop it (`docs/todo-review-contract.md` §12). An explicit `null`/absent
  // incoming value still wins, so a caller can clear it deliberately.
  for (const key of [...TODO_REVIEW_SUBJECTS, 'aggregate']) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    if (stored && stored[key] !== undefined) merged[key] = stored[key];
  }
  return merged;
}

/**
 * @param {any} kind
 * @returns {'plan'|'implement'|'note'}
 */
function normalizeChangelogKind(kind) {
  const value = kind != null ? String(kind).trim().toLowerCase() : 'note';
  return ALLOWED_CHANGELOG_KINDS.has(value) ? value : 'note';
}

/**
 * @param {any} entry
 * @returns {{ at: string, kind: 'plan'|'implement'|'note', text: string, chatId?: string }|null}
 */
function normalizeChangelogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (entry);
  const textRaw = stripTitleJsonTrailer(source.text != null ? String(source.text) : '');
  const text = textRaw.length > MAX_CHANGELOG_TEXT_LEN
    ? textRaw.slice(0, MAX_CHANGELOG_TEXT_LEN)
    : textRaw;
  if (!text.trim()) return null;
  const at = typeof source.at === 'string' && source.at.trim()
    ? source.at.trim()
    : new Date().toISOString();
  const row = {
    at,
    kind: normalizeChangelogKind(source.kind),
    text,
  };
  const chatId = normalizeChatId(source.chatId);
  if (chatId) row.chatId = chatId;
  return row;
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function normalizeLinkedChatIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    const chatId = normalizeLinkedChatId(item);
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    out.push(chatId);
  }
  return out;
}

/**
 * @param {any} items
 * @returns {Array<{ at: string, kind: 'plan'|'implement'|'note', text: string, chatId?: string }>}
 */
function normalizeChangelog(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => normalizeChangelogEntry(entry))
    .filter(Boolean)
    .slice(0, MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {Array<{ at: string, kind: string, text: string, chatId?: string }>} current
 * @param {Record<string, any>} entry
 * @returns {Array<{ at: string, kind: string, text: string, chatId?: string }>}
 */
function appendChangelogEntries(current, entry) {
  const normalized = normalizeChangelogEntry({
    ...entry,
    at: new Date().toISOString(),
  });
  if (!normalized) return current;
  const next = [...current, normalized];
  if (next.length <= MAX_CHANGELOG_ENTRIES) return next;
  return next.slice(next.length - MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {string[]} current
 * @param {string|undefined} chatId
 * @returns {string[]}
 */
function appendLinkedChatId(current, chatId) {
  const normalizedChatId = normalizeLinkedChatId(chatId);
  if (!normalizedChatId) return current;
  if (current.includes(normalizedChatId)) return current;
  return [normalizedChatId, ...current].slice(0, MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {string} raw
 * @returns {Record<string, any> | null}
 */
function parseDocument(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.items)) return null;
  return data;
}

/**
 * Migration + integrity pass (v2 -> v3 and stray links):
 * - parentId pointing at a missing item (or itself) makes the item a root;
 * - cyclic parent chains are cut;
 * - siblingIndex is renumbered 0..n-1 per sibling group (v2 roots follow
 *   the stored array order).
 * Mutates items in place and returns them.
 *
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeTodoTreeFields(items) {
  const known = new Set(items.map((row) => String(row.id)));
  // One index for the whole pass: rebuilding it per row made every save O(n²).
  // It holds the same row objects, so a parentId cut below is seen by later rows.
  const index = buildTodoIndex(items);
  items.forEach((row) => {
    const parentId = readTodoParentId(row);
    if (!parentId) return;
    if (!known.has(parentId) || parentId === String(row.id)
      || wouldCreateTodoParentCycle(items, String(row.id), parentId, index)) {
      delete row.parentId;
    }
  });
  return renumberTodoSiblings(items);
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @returns {{ version: number, updatedAt: string, items: TodoRecord[], idempotency: Record<string, any> }}
 */
export function loadTodosData(dataDir, cwd) {
  const key = workspaceKeyFromCwd(cwd);
  if (!key) {
    /** @type {Error & { code?: any }} */
    const err = new Error('No workspace folder');
    err.code = 'NO_WORKSPACE';
    throw err;
  }
  const filePath = todosFilePath(dataDir, key);
  if (!filePath || !existsSync(filePath)) {
    return {
      version: DATA_VERSION,
      updatedAt: new Date().toISOString(),
      items: [],
      idempotency: {},
    };
  }
  const signature = readTodoFileSignature(filePath);
  const cached = todosCache.get(filePath);
  if (cached && signature && cached.signature === signature) return copyTodoDoc(cached.doc);
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = parseDocument(raw);
  if (!doc) {
    return {
      version: DATA_VERSION,
      updatedAt: new Date().toISOString(),
      items: [],
      idempotency: {},
    };
  }
  const items = doc.items
    .filter((it) => it && typeof it === 'object' && it.id)
    .map((it) => {
      /** @type {TodoRecord} */
      const row = {
        id: String(it.id),
        title: normalizeTitle(it.title) || '(untitled)',
        body: normalizeBody(it.body),
        status: normalizeStatus(it.status),
        createdAt: typeof it.createdAt === 'string' ? it.createdAt : new Date().toISOString(),
        updatedAt: typeof it.updatedAt === 'string' ? it.updatedAt : new Date().toISOString(),
      };
      if (row.status === 'deferred') {
        const deferredUntil = normalizeDeferredUntil(it.deferredUntil);
        if (deferredUntil) row.deferredUntil = deferredUntil;
        const deferredReason = normalizeDeferredReason(it.deferredReason);
        if (deferredReason) row.deferredReason = deferredReason;
      }
      const chatId = normalizeChatId(it.chatId);
      if (chatId) row.chatId = chatId;
      const createdByChatId = normalizeChatId(it.createdByChatId);
      if (createdByChatId) row.createdByChatId = createdByChatId;
      const parentId = normalizeChatId(it.parentId);
      if (parentId) row.parentId = parentId;
      if (Number.isInteger(it.siblingIndex) && it.siblingIndex >= 0) {
        row.siblingIndex = it.siblingIndex;
      }
      const assignee = normalizeAssignee(it.assignee);
      if (assignee) row.assignee = assignee;
      const runMode = normalizeRunMode(it.runMode);
      if (runMode) row.runMode = runMode;
      if (normalizeNonBlocking(it.nonBlocking)) row.nonBlocking = true;
      const executionMode = normalizeExecutionMode(it.executionMode);
      if (executionMode) row.executionMode = executionMode;
      const executionFolder = normalizeExecutionFolder(/** @type {any} */ (it).executionFolder);
      if (executionFolder) row.executionFolder = executionFolder;
      const reviewerPair = normalizeReviewerPair(it.reviewerPair);
      if (reviewerPair) row.reviewerPair = reviewerPair;
      const orchestratorChatId = normalizeChatId(it.orchestratorChatId);
      if (orchestratorChatId) row.orchestratorChatId = orchestratorChatId;
      const sourceTodoId = normalizeChatId(it.sourceTodoId);
      if (sourceTodoId) row.sourceTodoId = sourceTodoId;
      const feedbackOrigin = normalizeFeedbackOrigin(it.feedbackOrigin);
      if (feedbackOrigin) row.feedbackOrigin = feedbackOrigin;
      const watcherPhases = normalizePartialPhases(it.watcherPhases);
      if (Object.keys(watcherPhases).length) row.watcherPhases = watcherPhases;
      const claimedByChatId = normalizeChatId(it.claimedByChatId);
      if (claimedByChatId) row.claimedByChatId = claimedByChatId;
      const claimedAt = typeof it.claimedAt === 'string' && it.claimedAt.trim()
        ? it.claimedAt.trim()
        : '';
      if (claimedAt) row.claimedAt = claimedAt;
      if (typeof it.claimLeaseUntil === 'string' && Number.isFinite(Date.parse(it.claimLeaseUntil))) row.claimLeaseUntil = it.claimLeaseUntil;
      if (typeof it.blockedReason === 'string' && it.blockedReason.trim()) row.blockedReason = it.blockedReason.trim();
      const execution = normalizeTodoExecution(it.execution);
      if (execution) row.execution = execution;
      const integration = normalizeTodoIntegration(it.integration);
      if (integration) row.integration = integration;
      const review = normalizeTodoReview(it.review);
      if (review) row.review = review;
      const leafMaterial = normalizeTodoLeafMaterial(it.leafMaterial);
      if (leafMaterial) row.leafMaterial = leafMaterial;
      const plan = normalizePlan(it.plan);
      if (plan) row.plan = plan;
      const activity = normalizeTodoActivity(it.activity);
      if (activity.length) row.activity = activity;
      const changelog = normalizeChangelog(it.changelog);
      if (changelog.length) row.changelog = changelog;
      const linkedChatIds = normalizeLinkedChatIds(it.linkedChatIds);
      if (linkedChatIds.length) row.linkedChatIds = linkedChatIds;
      const sourceHarness = typeof it.sourceHarness === 'string' ? it.sourceHarness.trim() : '';
      if (sourceHarness) row.sourceHarness = normalizeAgentTransport(sourceHarness);
      return row;
    });
  const treeItems = synchronizeTodoParentStatuses(stampFeedbackOrigins(normalizeTodoTreeFields(items)));
  const normalized = {
    version: DATA_VERSION,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    items: treeItems,
    idempotency: normalizeIdempotencyMap(
      doc.idempotency,
      new Set(treeItems.map((row) => String(row.id))),
    ),
  };
  if (signature) todosCache.set(filePath, { signature, doc: normalized });
  return copyTodoDoc(normalized);
}

/**
 * @param {Record<string, { hash: string, todoId: string }>} out
 * @param {number} maxEntries
 * @returns {Record<string, { hash: string, todoId: string }>}
 */
function capIdempotencyMap(out, maxEntries) {
  const keys = Object.keys(out);
  if (keys.length <= maxEntries) return out;
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const capped = {};
  for (const key of keys.slice(-maxEntries)) capped[key] = out[key];
  return capped;
}

/**
 * @param {any} raw
 * @param {Set<string>} [liveTodoIds] When set, drops entries whose todoId is missing.
 * @returns {Record<string, { hash: string, todoId: string }>}
 */
function normalizeIdempotencyMap(raw, liveTodoIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const out = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = String(rawKey ?? '').trim().slice(0, TODOS_MAX_IDEMPOTENCY_KEY_LENGTH);
    if (!key || !value || typeof value !== 'object') continue;
    const hash = String(value.hash || '').trim();
    const todoId = String(value.todoId || '').trim();
    if (!hash || !todoId) continue;
    if (liveTodoIds && !liveTodoIds.has(todoId)) continue;
    out[key] = { hash, todoId };
  }
  return capIdempotencyMap(out, TODOS_MAX_IDEMPOTENCY_ENTRIES);
}

/**
 * @param {string} dataDir
 * @param {string} key
 * @param {{ version: number, updatedAt: string, items: TodoRecord[], idempotency?: Record<string, any> }} doc
 */
function persist(dataDir, key, doc) {
  ensureTodosDir(dataDir);
  const filePath = todosFilePath(dataDir, key);
  const out = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    items: doc.items,
    idempotency: doc.idempotency && typeof doc.idempotency === 'object' ? doc.idempotency : {},
  };
  todosCache.delete(filePath);
  writeJsonAtomic(filePath, out, 'utf8', { compact: true });
  const signature = readTodoFileSignature(filePath);
  if (signature) {
    writtenDocSignatures.set(doc, signature);
    // Keep the cache coherent instead of dropping it: the saved document has
    // already been through the field normalizers and the tree sync, so the next
    // load (the route's reload, the next request) skips a full parse.
    todosCache.set(filePath, { signature, doc: copyTodoDoc(out) });
  }
}

/**
 * True when `doc` was produced by a save and the todos file has not been
 * written by anyone since, so `doc` still equals what a fresh load would return
 * (modulo the unserialized `idempotency` bookkeeping, which readers ignore).
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} doc
 * @returns {boolean}
 */
export function isTodosDocCurrent(dataDir, cwd, doc) {
  const expected = doc && typeof doc === 'object' ? writtenDocSignatures.get(doc) : '';
  if (!expected) return false;
  const key = workspaceKeyFromCwd(cwd);
  if (!key) return false;
  const filePath = todosFilePath(dataDir, key);
  return Boolean(filePath) && readTodoFileSignature(filePath) === expected;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: TodoRecord[], idempotency?: Record<string, any> }} doc
 */
export function saveTodosData(dataDir, cwd, doc) {
  return withWorkspaceWatchersFileLock(() => saveTodosDataUnlocked(dataDir, cwd, doc), { dataDir });
}

function saveTodosDataUnlocked(dataDir, cwd, doc) {
  const key = workspaceKeyFromCwd(cwd);
  if (!key) {
    /** @type {Error & { code?: any }} */
    const err = new Error('No workspace folder');
    err.code = 'NO_WORKSPACE';
    throw err;
  }
  if (doc.items.length > TODOS_MAX_ITEMS) {
    /** @type {Error & { code?: any }} */
    const err = new Error(`Limit of ${TODOS_MAX_ITEMS} items reached`);
    err.code = 'LIMIT';
    throw err;
  }
  let previousDoc = null;
  if (todosWatcherNudgeSuppressDepth === 0) {
    try {
      previousDoc = loadTodosData(dataDir, cwd);
    } catch {
      previousDoc = null;
    }
  }
  stampFeedbackOrigins(doc.items);
  normalizeTodoTreeFields(doc.items);
  stampFeedbackOrigins(doc.items);
  synchronizeTodoParentStatuses(doc.items, (item) => {
    const previous = Date.parse(String(item.updatedAt || ''));
    item.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  });
  if (previousDoc) {
    const previousItems = new Map(previousDoc.items.map((row) => [row.id, row]));
    for (const item of doc.items) {
      const previous = previousItems.get(item.id);
      if (!previous) continue;
      const activity = recordTodoActivity(previous, item);
      if (activity.length) item.activity = activity;
    }
  }
  const liveTodoIds = new Set(doc.items.map((row) => String(row.id)));
  doc.idempotency = normalizeIdempotencyMap(doc.idempotency, liveTodoIds);
  doc.version = DATA_VERSION;
  doc.updatedAt = new Date().toISOString();
  persist(dataDir, key, doc);
  if (todosWatcherNudgeSuppressDepth === 0) {
    void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterTodosSave }) => {
      maybeScheduleWorkspaceWatcherAfterTodosSave(dataDir, cwd, previousDoc, doc);
    }).catch(() => {});
  }
  return doc;
}

/**
 * @param {Record<string, any>} input
 * @returns {string}
 */
export function hashTodoCreateArgs(input) {
  const status = input.status == null || input.status === ''
    ? 'idea'
    : parseTodoStatus(input.status);
  return JSON.stringify({
    title: normalizeTitle(input.title),
    body: normalizeBody(input.body),
    status,
    parentId: normalizeChatId(input.parentId) || undefined,
    assignee: normalizeAssignee(input.assignee),
    siblingIndex: Number.isInteger(input.siblingIndex) ? input.siblingIndex : undefined,
    runMode: normalizeRunMode(input.runMode) || undefined,
    nonBlocking: normalizeNonBlocking(input.nonBlocking) || undefined,
    executionMode: normalizeExecutionMode(input.executionMode),
    reviewerPair: normalizeReviewerPair(input.reviewerPair),
    orchestratorChatId: normalizeChatId(input.orchestratorChatId) || undefined,
    sourceTodoId: normalizeChatId(input.sourceTodoId) || undefined,
  });
}

/**
 * First free position at the end of a sibling group.
 *
 * @param {Array<{ id: string, parentId?: string, siblingIndex?: number }>} items
 * @param {string} parentId
 * @returns {number}
 */
function nextSiblingIndex(items, parentId) {
  let max = -1;
  items.forEach((row) => {
    if (readTodoParentId(row) !== parentId) return;
    if (Number.isInteger(row.siblingIndex)) max = Math.max(max, row.siblingIndex);
  });
  return max + 1;
}

/**
 * Place `item` at `desiredIndex` inside its (possibly new) sibling group and
 * renumber that group 0..n-1. Out-of-range indexes clamp to the group size.
 *
 * @param {Array<{ id: string, parentId?: string, siblingIndex?: number }>} items
 * @param {{ id: string, parentId?: string, siblingIndex?: number }} item
 * @param {number} desiredIndex
 */
function placeTodoInSiblingGroup(items, item, desiredIndex) {
  const groupKey = readTodoParentId(item) || '';
  const others = items
    .filter((row) => row?.id && row.id !== item.id && (readTodoParentId(row) || '') === groupKey)
    .sort((a, b) => {
      const ai = Number.isInteger(a.siblingIndex) ? a.siblingIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.siblingIndex) ? b.siblingIndex : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  const target = Math.max(0, Math.min(desiredIndex, others.length));
  others.splice(target, 0, item);
  others.forEach((row, index) => {
    row.siblingIndex = index;
  });
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ title?: string, body?: string, status?: string, idempotencyKey?: string, strictStatus?: boolean, parentId?: string|null, siblingIndex?: number, assignee?: { harness: string, model?: string, role: 'plan'|'implement'|'review' }|null, runMode?: 'parallel'|'sequential'|null, nonBlocking?: boolean, executionMode?: 'inherit'|'worktree'|'project'|null, orchestratorChatId?: string|null, sourceTodoId?: string|null, createdByChatId?: string|null, sourceHarness?: string }} input
 */
export function addTodo(dataDir, cwd, input = {}) {
  return withWorkspaceWatchersFileLock(() => addTodoUnlocked(dataDir, cwd, input), { dataDir });
}

function addTodoUnlocked(dataDir, cwd, input) {
  const doc = loadTodosData(dataDir, cwd);
  if (doc.items.length >= TODOS_MAX_ITEMS) {
    /** @type {Error & { code?: any }} */
    const err = new Error(`Limit of ${TODOS_MAX_ITEMS} items reached`);
    err.code = 'LIMIT';
    throw err;
  }
  const now = new Date().toISOString();
  const title = normalizeTitle(input.title);
  if (!title) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Title is required');
    err.code = 'VALIDATION';
    throw err;
  }
  const status = input.strictStatus === true && input.status != null && input.status !== ''
    ? parseTodoStatus(input.status)
    : (input.strictStatus === true && (input.status == null || input.status === '')
      ? 'idea'
      : normalizeStatus(input.status));
  const idempotencyKey = String(input.idempotencyKey || '').trim().slice(0, TODOS_MAX_IDEMPOTENCY_KEY_LENGTH);
  const parentId = normalizeChatId(input.parentId);
  if (parentId) {
    const parent = doc.items.find((it) => it.id === parentId);
    if (!parent) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Parent todo not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (todoNodeDepth(doc.items, parentId) + 1 > TODO_MAX_DEPTH) {
      /** @type {Error & { code?: any }} */
      const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
      err.code = 'VALIDATION';
      throw err;
    }
  }
  const siblingIndex = parseSiblingIndex(input.siblingIndex);
  let assignee;
  if (input.assignee != null) {
    assignee = normalizeAssignee(input.assignee);
    if (!assignee) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Invalid todo assignee');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  let runMode;
  if (input.runMode != null && input.runMode !== '') {
    runMode = normalizeRunMode(input.runMode);
    if (!runMode) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Invalid todo runMode');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  let executionMode;
  if (input.executionMode != null && String(input.executionMode).trim() !== '') {
    const requested = normalizeWorktreeMode(input.executionMode);
    if (!requested) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Invalid todo executionMode');
      err.code = 'VALIDATION';
      throw err;
    }
    if (requested !== 'inherit') executionMode = requested;
  }
  const orchestratorChatId = normalizeChatId(input.orchestratorChatId);
  const sourceTodoId = normalizeChatId(input.sourceTodoId);
  const createdByChatId = normalizeChatId(input.createdByChatId);
  const sourceHarness = typeof input.sourceHarness === 'string' ? input.sourceHarness.trim() : '';
  const hash = hashTodoCreateArgs({
    title,
    body: input.body,
    status,
    parentId,
    assignee,
    siblingIndex,
    runMode,
    orchestratorChatId,
    sourceTodoId,
  });
  if (idempotencyKey) {
    const prior = doc.idempotency?.[idempotencyKey];
    if (prior) {
      if (prior.hash !== hash) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Idempotency key was reused with different arguments');
        err.code = 'CONFLICT';
        throw err;
      }
      const existing = doc.items.find((row) => row.id === prior.todoId);
      if (existing) {
        return { ...doc, replayed: true, item: existing };
      }
    }
  }
  const item = {
    id: randomUUID(),
    title,
    body: normalizeBody(input.body),
    status,
    createdAt: now,
    updatedAt: now,
  };
  if (status === 'deferred') {
    const deferredUntil = normalizeDeferredUntil(input.deferredUntil);
    if (deferredUntil) item.deferredUntil = deferredUntil;
    const deferredReason = normalizeDeferredReason(input.deferredReason);
    if (deferredReason) item.deferredReason = deferredReason;
  }
  if (parentId) item.parentId = parentId;
  // Default position: roots go first in their group (newest on top matches
  // the historical unshift), children append at the end of the parent group.
  item.siblingIndex = siblingIndex != null
    ? siblingIndex
    : (parentId ? nextSiblingIndex(doc.items, parentId) : 0);
  if (assignee) item.assignee = assignee;
  if (runMode) item.runMode = runMode;
  if (normalizeNonBlocking(input.nonBlocking)) item.nonBlocking = true;
  if (executionMode) item.executionMode = executionMode;
  const executionFolder = normalizeExecutionFolder(input.executionFolder);
  if (executionFolder) item.executionFolder = executionFolder;
  const reviewerPair = normalizeReviewerPair(input.reviewerPair);
  if (reviewerPair) item.reviewerPair = reviewerPair;
  if (orchestratorChatId) item.orchestratorChatId = orchestratorChatId;
  if (sourceTodoId) item.sourceTodoId = sourceTodoId;
  if (createdByChatId) {
    item.createdByChatId = createdByChatId;
    item.linkedChatIds = [createdByChatId];
  }
  if (sourceHarness) item.sourceHarness = normalizeAgentTransport(sourceHarness);
  doc.items.unshift(item);
  if (idempotencyKey) {
    doc.idempotency = {
      ...(doc.idempotency || {}),
      [idempotencyKey]: { hash, todoId: item.id },
    };
  }
  const saved = saveTodosData(dataDir, cwd, doc);
  return { ...saved, item, replayed: false };
}

/**
 * Callers forward optional fields as `undefined` when the client did not send
 * them; only a defined value (including null, which clears) is a change.
 *
 * @param {Record<string, any>} patch
 * @param {string} key
 * @returns {boolean}
 */
const TODO_EXECUTION_FIELDS = Object.freeze([
  'attemptId', 'key', 'todoRevision', 'source', 'chatId', 'cycleId', 'runId',
  'delegationId', 'phase', 'at', 'releasedAt', 'releaseReason',
  // Replay identity of the last recovery release (manual unknown release or
  // autopilot recover). Without these the normalizer drops the keys on write
  // and an idempotent retry can never match its recorded success.
  'lastRecoverIdempotencyKey', 'lastManualUnknownReleaseKey', 'lastRecoverSource',
]);
const TODO_EXECUTION_FIELD_MAX = 200;

/** String fields carried by the todo `integration` pointer (contract O2). */
const TODO_INTEGRATION_STRING_FIELDS = Object.freeze([
  'cycleId', 'resultPath', 'baseCommit', 'branch', 'worktreePath', 'appliedAt',
  'materialRevision', 'reviewOutcome', 'testOutcome', 'reason', 'recordedAt',
  'mergeMode', 'targetBranch',
]);
const TODO_INTEGRATION_EVIDENCE_STRING_FIELDS = Object.freeze([
  'targetBranch', 'targetCommit', 'sourceCommit', 'materialRevision', 'cycleId',
  'source', 'confirmedAt', 'confirmedBy', 'changeRef', 'verification', 'todoMaterialFingerprint',
  'scope', 'treeMaterialFingerprint',
]);
const TODO_INTEGRATION_MAX_CHANGED_FILES = 500;

/**
 * Durable identity of the current (or last) execution attempt of a todo. It is
 * written by the Workspace Watcher claim path only; `attemptId` is the fencing
 * id a late release or report of an older attempt is compared against.
 * `previous` keeps one earlier attempt so a resumed cycle can see what ran.
 *
 * @param {any} raw
 * @param {boolean} [allowPrevious]
 * @returns {Record<string, unknown> | null}
 */
export function normalizeTodoExecution(raw, allowPrevious = true) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of TODO_EXECUTION_FIELDS) {
    const value = typeof raw[field] === 'string' ? raw[field].trim().slice(0, TODO_EXECUTION_FIELD_MAX) : '';
    if (value) out[field] = value;
  }
  if (!out.attemptId) return null;
  const previous = allowPrevious ? normalizeTodoExecution(raw.previous, false) : null;
  if (previous) out.previous = previous;
  return out;
}

/**
 * Enforces the status transition matrix of `deferred`. Only transitions that
 * touch `deferred` or leave `done` are checked; everything else keeps the
 * historical free movement. Containers (nodes with children) have a derived
 * status: only their descendants are checked for live work.
 *
 * @param {any[]} items
 * @param {any} current stored row before the patch
 * @param {string} next requested status
 */
function assertTodoStatusTransition(items, current, next) {
  const from = String(current.status || '');
  const conflict = (/** @type {string} */ message) => {
    /** @type {Error & { code?: any }} */
    const err = new Error(message);
    err.code = 'CONFLICT';
    return err;
  };
  if (from === 'done' && next === 'deferred') throw conflict('A done todo cannot be deferred');
  if (from === 'deferred' && (next === 'doing' || next === 'done')) {
    throw conflict('A deferred todo must be restored to idea or ready first');
  }
  if (next !== 'deferred') return;
  const descendants = collectTodoSubtreeIds(items, String(current.id)).slice(1);
  if (descendants.length) {
    if (descendants.some((childId) => items.find((row) => row.id === childId)?.status === 'doing')) {
      throw conflict('Cannot defer a todo with a subtask that is in progress');
    }
    return;
  }
  if (from !== 'doing') return;
  const leaseUntil = Date.parse(String(current.claimLeaseUntil || ''));
  if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
    throw conflict('Cannot defer a todo with a live run (unexpired claim lease)');
  }
  if (isTodoAwaitingIntegration(current) || current.integration || current.leafMaterial) {
    throw conflict('Cannot defer a todo that has integration or leaf material');
  }
}

function hasPatchValue(patch, key) {
  return Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @param {{ title?: string, body?: string, status?: string, expectedUpdatedAt?: string, strictStatus?: boolean, chatId?: string|null, sourceHarness?: string, plan?: { markdown?: string, sourceChatId?: string, approvedAt?: string|null, approvedBy?: { kind: 'mcp-operator', clientId: string, clientName: string }, updatedAt?: string }, appendChangelog?: { kind?: string, text?: string, chatId?: string }, linkedChatId?: string, parentId?: string|null, siblingIndex?: number|null, assignee?: { harness: string, model?: string, role: 'plan'|'implement'|'review' }|null, runMode?: 'parallel'|'sequential'|null, nonBlocking?: boolean|null, executionMode?: 'inherit'|'worktree'|'project'|null, orchestratorChatId?: string|null, claimedByChatId?: string|null, claimedAt?: string|null }} patch
 */
export function updateTodo(dataDir, cwd, id, patch = {}) {
  return withWorkspaceWatchersFileLock(() => updateTodoUnlocked(dataDir, cwd, id, patch), { dataDir });
}

function updateTodoUnlocked(dataDir, cwd, id, patch) {
  if (!id || typeof id !== 'string') {
    /** @type {Error & { code?: any }} */
    const err = new Error('Missing id');
    err.code = 'VALIDATION';
    throw err;
  }
  const doc = loadTodosData(dataDir, cwd);
  const idx = doc.items.findIndex((it) => it.id === id);
  if (idx < 0) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  /** @type {TodoRecord} */
  const cur = { ...doc.items[idx] };
  const previousStatus = cur.status;
  const expectedUpdatedAt = String(patch.expectedUpdatedAt || '').trim();
  if (expectedUpdatedAt && expectedUpdatedAt !== String(cur.updatedAt || '')) {
    /** @type {Error & { code?: any, currentUpdatedAt?: any }} */
    const err = new Error('Todo was updated by another request');
    err.code = 'CONFLICT';
    err.currentUpdatedAt = cur.updatedAt;
    throw err;
  }
  // Adding a chat link is bookkeeping: when it is the only change it must not
  // bump updatedAt, so a concurrent agent's expected_updated_at stays valid.
  const linkOnlyPatch = String(patch.linkedChatId || '').trim() !== ''
    && Object.keys(patch)
      .filter((key) => patch[key] !== undefined)
      .every((key) => LINK_ONLY_PATCH_KEYS.has(key));
  if (patch.title != null) {
    const t = normalizeTitle(patch.title);
    if (!t) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Title cannot be empty');
      err.code = 'VALIDATION';
      throw err;
    }
    cur.title = t;
  }
  if (patch.body != null) cur.body = normalizeBody(patch.body);
  if (patch.status != null) {
    cur.status = patch.strictStatus === true ? parseTodoStatus(patch.status) : normalizeStatus(patch.status);
    if (cur.status !== previousStatus) assertTodoStatusTransition(doc.items, doc.items[idx], cur.status);
  }
  if (hasPatchValue(patch, 'deferredUntil') && cur.status === 'deferred') {
    const raw = patch.deferredUntil;
    if (raw == null || String(raw).trim() === '') delete cur.deferredUntil;
    else {
      const until = normalizeDeferredUntil(raw);
      if (!until) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Invalid deferredUntil date');
        err.code = 'VALIDATION';
        throw err;
      }
      cur.deferredUntil = until;
    }
  }
  if (hasPatchValue(patch, 'deferredReason') && cur.status === 'deferred') {
    const reason = normalizeDeferredReason(patch.deferredReason);
    if (reason) cur.deferredReason = reason;
    else delete cur.deferredReason;
  }
  // Deferral metadata only lives on a deferred todo; leaving the status drops it.
  if (cur.status !== 'deferred') {
    delete cur.deferredUntil;
    delete cur.deferredReason;
  }
  if (hasPatchValue(patch, 'chatId')) {
    const nextChatId = normalizeChatId(patch.chatId);
    if (nextChatId) cur.chatId = nextChatId;
    else delete cur.chatId;
  }
  const previousParentId = readTodoParentId(cur) || '';
  if (hasPatchValue(patch, 'parentId')) {
    const nextParentId = normalizeChatId(patch.parentId);
    if (nextParentId) {
      const parent = doc.items.find((it) => it.id === nextParentId);
      if (!parent) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Parent todo not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (wouldCreateTodoParentCycle(doc.items, String(cur.id), nextParentId)) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Todo move would create a cycle');
        err.code = 'VALIDATION';
        throw err;
      }
      // Depth check covers the whole moved subtree, not just this node.
      if (todoNodeDepth(doc.items, nextParentId) + todoSubtreeHeight(doc.items, String(cur.id)) > TODO_MAX_DEPTH) {
        /** @type {Error & { code?: any }} */
        const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
        err.code = 'VALIDATION';
        throw err;
      }
      cur.parentId = nextParentId;
    } else {
      delete cur.parentId;
    }
  }
  const parentChanged = (readTodoParentId(cur) || '') !== previousParentId;
  const explicitSiblingIndex = hasPatchValue(patch, 'siblingIndex')
    ? parseSiblingIndex(patch.siblingIndex)
    : undefined;
  if (parentChanged || explicitSiblingIndex != null) {
    // Explicit index places the item exactly; a move without an index
    // appends at the end of the (new) sibling group.
    placeTodoInSiblingGroup(doc.items, cur, explicitSiblingIndex != null ? explicitSiblingIndex : Number.MAX_SAFE_INTEGER);
  }
  if (hasPatchValue(patch, 'assignee')) {
    if (isAssigneeClear(patch.assignee)) delete cur.assignee;
    else {
      const nextAssignee = normalizeAssignee(patch.assignee);
      if (!nextAssignee) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Invalid todo assignee');
        err.code = 'VALIDATION';
        throw err;
      }
      cur.assignee = nextAssignee;
    }
  }
  if (hasPatchValue(patch, 'nonBlocking')) {
    if (normalizeNonBlocking(patch.nonBlocking)) cur.nonBlocking = true;
    else delete cur.nonBlocking;
  }
  if (hasPatchValue(patch, 'runMode')) {
    if (patch.runMode == null || patch.runMode === '') delete cur.runMode;
    else {
      const nextRunMode = normalizeRunMode(patch.runMode);
      if (!nextRunMode) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Invalid todo runMode');
        err.code = 'VALIDATION';
        throw err;
      }
      cur.runMode = nextRunMode;
    }
  }
  if (hasPatchValue(patch, 'executionMode')) {
    const rawMode = patch.executionMode;
    if (rawMode == null || String(rawMode).trim() === '') delete cur.executionMode;
    else {
      const nextExecutionMode = normalizeWorktreeMode(rawMode);
      if (!nextExecutionMode) {
        /** @type {Error & { code?: any }} */
        const err = new Error('Invalid todo executionMode');
        err.code = 'VALIDATION';
        throw err;
      }
      if (nextExecutionMode === 'inherit') delete cur.executionMode;
      else cur.executionMode = nextExecutionMode;
    }
  }
  if (hasPatchValue(patch, 'executionFolder')) {
    const nextFolder = normalizeExecutionFolder(/** @type {any} */ (patch).executionFolder);
    if (nextFolder) /** @type {any} */ (cur).executionFolder = nextFolder;
    else delete (/** @type {any} */ (cur)).executionFolder;
  }
  if (hasPatchValue(patch, 'reviewerPair')) {
    // Invalid or empty value clears the override (back to workspace behavior).
    const nextPair = normalizeReviewerPair(patch.reviewerPair);
    if (nextPair) cur.reviewerPair = nextPair;
    else delete cur.reviewerPair;
  }
  if (hasPatchValue(patch, 'watcherPhases')) {
    // Partial per-todo phase override; an empty object clears it.
    const nextPhases = normalizePartialPhases(patch.watcherPhases);
    if (Object.keys(nextPhases).length) cur.watcherPhases = nextPhases;
    else delete cur.watcherPhases;
  }
  if (hasPatchValue(patch, 'orchestratorChatId')) {
    const nextOrchestratorChatId = normalizeChatId(patch.orchestratorChatId);
    if (nextOrchestratorChatId) cur.orchestratorChatId = nextOrchestratorChatId;
    else delete cur.orchestratorChatId;
  }
  if (hasPatchValue(patch, 'sourceTodoId')) {
    const nextSourceTodoId = normalizeChatId(patch.sourceTodoId);
    if (nextSourceTodoId) cur.sourceTodoId = nextSourceTodoId;
    else delete cur.sourceTodoId;
  }
  if (hasPatchValue(patch, 'moveToLater') && patch.moveToLater !== false && cur.status === 'deferred') {
    // `true` parks under the shared "later" root, a string names another root.
    const decision = decideDeferredMove(doc.items, cur, patch.moveToLater === true ? '' : String(patch.moveToLater));
    if (decision.action === 'move') {
      let targetId = decision.targetId;
      if (decision.createRoot) {
        const nowIso = new Date().toISOString();
        const root = {
          id: randomUUID(),
          title: TODO_LATER_ROOT_TITLE,
          body: '',
          status: 'deferred',
          createdAt: nowIso,
          updatedAt: nowIso,
          siblingIndex: nextSiblingIndex(doc.items, ''),
        };
        // Appended (not unshifted) so the index of the todo being updated stays valid.
        doc.items.push(root);
        targetId = root.id;
      }
      if (todoNodeDepth(doc.items, targetId) + 1 > TODO_MAX_DEPTH) {
        /** @type {Error & { code?: any }} */
        const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
        err.code = 'VALIDATION';
        throw err;
      }
      cur.parentId = targetId;
      cur.sourceTodoId = decision.fromParentId;
      placeTodoInSiblingGroup(doc.items, cur, Number.MAX_SAFE_INTEGER);
      const origin = doc.items.find((row) => row.id === decision.fromParentId);
      cur.changelog = appendChangelogEntries(Array.isArray(cur.changelog) ? cur.changelog : [], {
        kind: 'note',
        text: `Moved to later from "${String(origin?.title || decision.fromParentId).slice(0, 120)}" (${decision.fromParentId}).`,
      });
    }
  }
  if (patch.restoreToTree === true) {
    const decision = decideRestoreToTree(doc.items, cur);
    if (decision.action === 'restore') {
      if (todoNodeDepth(doc.items, decision.parentId) + 1 > TODO_MAX_DEPTH) {
        /** @type {Error & { code?: any }} */
        const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
        err.code = 'VALIDATION';
        throw err;
      }
      cur.parentId = decision.parentId;
      delete cur.sourceTodoId;
      placeTodoInSiblingGroup(doc.items, cur, Number.MAX_SAFE_INTEGER);
      cur.changelog = appendChangelogEntries(Array.isArray(cur.changelog) ? cur.changelog : [], {
        kind: 'note',
        text: 'Restored to the original tree.',
      });
    } else {
      /** @type {Error & { code?: any }} */
      const err = new Error(`Cannot restore to tree: ${decision.reason}`);
      err.code = 'CONFLICT';
      throw err;
    }
  }
  // Claim fields ride the normal CAS path: they are written together with the
  // status flip and bump updatedAt, so a competing claim sees a stale token.
  if (hasPatchValue(patch, 'claimedByChatId')) {
    const nextClaimedByChatId = normalizeChatId(patch.claimedByChatId);
    if (nextClaimedByChatId) cur.claimedByChatId = nextClaimedByChatId;
    else delete cur.claimedByChatId;
  }
  if (hasPatchValue(patch, 'claimedAt')) {
    const nextClaimedAt = typeof patch.claimedAt === 'string' && patch.claimedAt.trim()
      ? patch.claimedAt.trim()
      : '';
    if (nextClaimedAt) cur.claimedAt = nextClaimedAt;
    else delete cur.claimedAt;
  }
  if (hasPatchValue(patch, 'claimLeaseUntil')) {
    const until = String(patch.claimLeaseUntil || '').trim();
    if (until && !Number.isFinite(Date.parse(until))) {
      const err = new Error('Invalid claim lease expiry'); err.code = 'VALIDATION'; throw err;
    }
    if (until) cur.claimLeaseUntil = until;
    else delete cur.claimLeaseUntil;
  }
  if (patch.status != null) delete cur.blockedReason;
  if (hasPatchValue(patch, 'blockedReason')) {
    if (String(patch.blockedReason || '').trim()) cur.blockedReason = String(patch.blockedReason).trim();
    else delete cur.blockedReason;
  }
  if (hasPatchValue(patch, 'execution')) {
    const nextExecution = normalizeTodoExecution(patch.execution);
    if (nextExecution) cur.execution = nextExecution;
    else delete cur.execution;
  }
  if (hasPatchValue(patch, 'integration')) {
    const nextIntegration = normalizeTodoIntegration(patch.integration);
    if (nextIntegration) cur.integration = nextIntegration;
    else delete cur.integration;
  }
  if (hasPatchValue(patch, 'leafMaterial')) {
    const nextLeafMaterial = normalizeTodoLeafMaterial(patch.leafMaterial);
    if (nextLeafMaterial) cur.leafMaterial = nextLeafMaterial;
    else delete cur.leafMaterial;
  }
  // A claim belongs to a `doing` execution. Moving a todo back to `ready` or
  // `idea` without a new claimant ends that execution; keeping the old claim
  // would leave a `ready` row the Watcher can never start (`already_claimed`).
  const releasedByStatus = hasPatchValue(patch, 'status')
    && (cur.status === 'ready' || cur.status === 'idea' || cur.status === 'deferred')
    && !hasPatchValue(patch, 'claimedByChatId');
  if (cur.status === 'done' || releasedByStatus || (hasPatchValue(patch, 'claimedByChatId') && !cur.claimedByChatId)) {
    delete cur.claimedByChatId;
    delete cur.claimedAt;
    delete cur.claimLeaseUntil;
  }
  if (patch.plan != null) {
    const previousPlan = cur.plan && typeof cur.plan === 'object' ? cur.plan : {};
    const previousMarkdown = String(previousPlan.markdown || '');
    const mergedPlan = {
      ...previousPlan,
      ...patch.plan,
      updatedAt: new Date().toISOString(),
    };
    if (!String(mergedPlan.markdown || '').trim() && previousMarkdown) {
      mergedPlan.markdown = previousMarkdown;
    }
    // Only a real markdown change opens a new plan revision (review rounds).
    if (String(mergedPlan.markdown || '') !== previousMarkdown) {
      mergedPlan.markdownUpdatedAt = mergedPlan.updatedAt;
    } else if (previousPlan.markdownUpdatedAt) {
      mergedPlan.markdownUpdatedAt = previousPlan.markdownUpdatedAt;
    } else {
      delete mergedPlan.markdownUpdatedAt;
    }
    // Approval binds to plan content: editing the markdown drops a stored
    // approvedAt unless the same patch re-approves it explicitly.
    const reapproved = patch.plan.approvedAt != null && String(patch.plan.approvedAt).trim() !== '';
    if (!reapproved && previousPlan.approvedAt && String(mergedPlan.markdown || '') !== previousMarkdown) {
      delete mergedPlan.approvedAt;
    }
    // A fresh approval without provenance (UI, sync) must not inherit a stale approver.
    if (reapproved && patch.plan.approvedBy == null) delete mergedPlan.approvedBy;
    const normalizedPlan = normalizePlan(mergedPlan);
    if (normalizedPlan) cur.plan = normalizedPlan;
    else delete cur.plan;
  }
  if (patch.appendChangelog && typeof patch.appendChangelog === 'object') {
    const currentChangelog = Array.isArray(cur.changelog) ? cur.changelog : [];
    cur.changelog = appendChangelogEntries(currentChangelog, patch.appendChangelog);
  }
  let linkedChatChanged = false;
  if (patch.linkedChatId) {
    const currentLinked = Array.isArray(cur.linkedChatIds) ? cur.linkedChatIds : [];
    const nextLinked = appendLinkedChatId(currentLinked, patch.linkedChatId);
    if (nextLinked !== currentLinked) {
      cur.linkedChatIds = nextLinked;
      linkedChatChanged = true;
    }
  }
  if (patch.sourceHarness != null) {
    const harness = String(patch.sourceHarness || '').trim();
    if (harness) cur.sourceHarness = normalizeAgentTransport(harness);
    else delete cur.sourceHarness;
  }
  if (linkOnlyPatch && !linkedChatChanged) {
    // Duplicate link: no file write, no revision bump.
    return doc;
  }
  if (linkOnlyPatch) {
    doc.items[idx] = cur;
    return saveTodosData(dataDir, cwd, doc);
  }
  // CAS tokens must advance even when two updates occur in the same millisecond.
  const previousUpdatedAt = Date.parse(String(cur.updatedAt || ''));
  cur.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)).toISOString();
  doc.items[idx] = cur;
  if (cur.status === 'doing' && previousStatus !== 'doing' && patch.status != null
    && isTodoBranchBlocked(doc.items, cur)) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Complete earlier subtasks and approve the parent plan before starting this task');
    err.code = 'VALIDATION';
    throw err;
  }
  if (patch.status != null && cur.status === 'done') {
    const descendants = collectTodoSubtreeIds(doc.items, id).slice(1);
    if (descendants.some((childId) => doc.items.find((row) => row.id === childId)?.status !== 'done')) {
      /** @type {Error & { code?: any }} */
      const err = new Error('Complete all subtasks before completing their parent');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  // Deferring a container postpones its open descendants; restoring it brings
  // the deferred ones back as drafts (even those that were ready before).
  /** @type {Set<string>} */
  const restoredIds = new Set();
  if (patch.status != null && cur.status !== previousStatus
    && (cur.status === 'deferred' || previousStatus === 'deferred')) {
    const bumpAt = Date.now();
    for (const childId of collectTodoSubtreeIds(doc.items, id).slice(1)) {
      const child = doc.items.find((row) => row.id === childId);
      if (!child) continue;
      let next = '';
      if (cur.status === 'deferred' && (child.status === 'idea' || child.status === 'ready')) next = 'deferred';
      else if (previousStatus === 'deferred' && cur.status !== 'deferred' && child.status === 'deferred') next = 'idea';
      if (!next) continue;
      child.status = next;
      if (next === 'idea') {
        restoredIds.add(childId);
        delete child.deferredUntil;
        delete child.deferredReason;
      }
      delete child.claimedByChatId;
      delete child.claimedAt;
      delete child.claimLeaseUntil;
      const previous = Date.parse(String(child.updatedAt || ''));
      child.updatedAt = new Date(Math.max(bumpAt, Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
  }
  // A container has no status of its own. "Ready" means every idea draft in
  // the subtree is now claimable; doing and done stay as they are.
  if (patch.status != null && cur.status === 'ready') {
    const promotedAt = Date.now();
    for (const childId of collectTodoSubtreeIds(doc.items, id).slice(1)) {
      const child = doc.items.find((row) => row.id === childId);
      if (!child || child.status !== 'idea' || restoredIds.has(childId)) continue;
      child.status = 'ready';
      const previous = Date.parse(String(child.updatedAt || ''));
      child.updatedAt = new Date(Math.max(promotedAt, Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
  }
  const saved = saveTodosData(dataDir, cwd, doc);
  if (patch.status != null && cur.status === 'done' && previousStatus !== 'done') {
    handleTodoLeafMaterialOnStatusChange({
      dataDir,
      workspaceFolder: cwd,
      todo: cur,
      previousStatus,
    });
  }
  return saved;
}

/**
 * Dedicated writer for the server-owned `todo.review` snapshot
 * (`docs/todo-review-contract.md` §5.5, §10.2-§10.3).
 *
 * It deliberately does NOT go through `updateTodo`: that path always bumps
 * `item.updatedAt`, which is the CAS token an agent sends as
 * `expected_updated_at`, so a background review write would turn a concurrent
 * agent edit stale. Concurrency is guarded by the review `generation` plus the
 * same cross-process workspace lock every other todos write takes.
 *
 * Side effects that are covered by design:
 * - `doc.updatedAt` advances (document revision, not the per-item CAS token);
 * - the tree normalization and parent-status sync run but change nothing while
 *   the status is untouched;
 * - the Workspace Watcher nudge is suppressed, because a review refresh is not
 *   a scheduling change.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @param {Record<string, any>} snapshot partial or full review snapshot; absent subject keys
 *   keep their stored snapshot
 * @param {{ expectedGeneration?: number, expectedUpdatedAt?: string }} [options]
 * @returns {{ changed: boolean, item: Record<string, any>, doc: Record<string, any>, review: Record<string, any>, generation: number }}
 */
export function writeTodoReview(dataDir, cwd, id, snapshot, options = {}) {
  return withWorkspaceWatchersFileLock(
    () => writeTodoReviewUnlocked(dataDir, cwd, id, snapshot, options),
    { dataDir },
  );
}

function writeTodoReviewUnlocked(dataDir, cwd, id, snapshot, options) {
  const doc = loadTodosData(dataDir, cwd);
  const applied = applyTodoReviewToDoc(doc, id, snapshot, options);
  if (!applied.changed) {
    // Decision-identical: no file write and no doc.updatedAt bump.
    return { changed: false, item: applied.item, doc, review: applied.review, generation: applied.generation };
  }
  const saved = withTodosWatcherNudgeSuppressed(() => saveTodosData(dataDir, cwd, doc));
  return {
    changed: true,
    item: saved.items.find((row) => row.id === applied.item.id) || applied.item,
    doc: saved,
    review: applied.review,
    generation: applied.generation,
  };
}

/**
 * Validate and merge one review snapshot into an in-memory todos document.
 * Mutates `doc.items` only when the decision changed; never saves.
 *
 * @param {Record<string, any>} doc
 * @param {string} id
 * @param {Record<string, any>} snapshot
 * @param {{ expectedGeneration?: number, expectedUpdatedAt?: string }} options
 * @returns {{ changed: boolean, item: Record<string, any>, review: Record<string, any>, generation: number }}
 */
function applyTodoReviewToDoc(doc, id, snapshot, options) {
  const todoId = String(id || '').trim();
  if (!todoId) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Missing id');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    /** @type {Error & { code?: any }} */
    const err = new Error('review snapshot must be an object');
    err.code = 'VALIDATION';
    throw err;
  }
  const idx = doc.items.findIndex((it) => it.id === todoId);
  if (idx < 0) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  /** @type {TodoRecord} */
  const cur = { ...doc.items[idx] };
  if (options.expectedUpdatedAt && options.expectedUpdatedAt !== String(cur.updatedAt || '')) {
    const error = Object.assign(new Error('Todo changed while computing review'), { code: 'CONFLICT' });
    throw error;
  }
  const stored = normalizeTodoReview(cur.review) || null;
  const storedGeneration = stored ? stored.generation : 0;
  const hasExpected = Number.isInteger(options.expectedGeneration) && options.expectedGeneration >= 0;
  const expectedGeneration = hasExpected ? options.expectedGeneration : storedGeneration;
  if (hasExpected && storedGeneration > expectedGeneration) {
    /** @type {Error & { code?: any, currentGeneration?: any }} */
    const err = new Error('Todo review snapshot is stale');
    err.code = 'CONFLICT';
    err.currentGeneration = storedGeneration;
    throw err;
  }
  const incoming = /** @type {Record<string, unknown>} */ (snapshot);
  const merged = mergeTodoReviewSubjects(stored, incoming);
  const next = normalizeTodoReview(merged);
  if (!next) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Invalid review snapshot');
    err.code = 'VALIDATION';
    throw err;
  }
  if (stored && stored.decisionKey && stored.decisionKey === next.decisionKey) {
    return { changed: false, item: cur, review: stored, generation: storedGeneration };
  }
  next.generation = Math.max(storedGeneration, expectedGeneration) + 1;
  if (!next.computedAt) next.computedAt = new Date().toISOString();
  cur.review = next;
  doc.items[idx] = cur;
  return { changed: true, item: cur, review: next, generation: next.generation };
}

/**
 * Batch variant of `writeTodoReview`: applies several snapshots to one
 * workspace under a single lock and writes the todos file ONCE, only when at
 * least one decision changed. Per-entry failures (NOT_FOUND, VALIDATION,
 * CONFLICT) are returned in the result and do not affect the other entries;
 * a failed save is thrown and means nothing was persisted.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {Array<{ id: string, snapshot: Record<string, any>, expectedGeneration?: number, expectedUpdatedAt?: string }>} entries
 * @returns {Array<{ id: string, changed: boolean, generation?: number, error?: Error & { code?: any } }>}
 */
export function writeTodoReviewBatch(dataDir, cwd, entries) {
  return withWorkspaceWatchersFileLock(() => {
    const doc = loadTodosData(dataDir, cwd);
    /** @type {Array<{ id: string, changed: boolean, generation?: number, error?: any }>} */
    const results = [];
    let anyChanged = false;
    for (const entry of entries) {
      try {
        const applied = applyTodoReviewToDoc(doc, entry.id, entry.snapshot, {
          expectedGeneration: entry.expectedGeneration,
          expectedUpdatedAt: entry.expectedUpdatedAt,
        });
        if (applied.changed) anyChanged = true;
        results.push({ id: entry.id, changed: applied.changed, generation: applied.generation });
      } catch (error) {
        results.push({ id: entry.id, changed: false, error });
      }
    }
    if (anyChanged) withTodosWatcherNudgeSuppressed(() => saveTodosData(dataDir, cwd, doc));
    return results;
  }, { dataDir });
}

/**
 * Close a leaf (`doing` -> `done`) when `guard` approves it. The guard runs and
 * the status write happens under the same workspace lock (§10.2), so two
 * concurrent attempts produce exactly one transition. Never touches a parent:
 * its status stays derived from its children.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @param {(input: { todo: Record<string, any>, items: Record<string, any>[] }) => { eligible: boolean, reason: string }} guard
 * @returns {{ closed: boolean, reason: string, item: Record<string, any> | null }}
 */
export function closeTodoLeafIfEligible(dataDir, cwd, id, guard) {
  return withWorkspaceWatchersFileLock(() => {
    const doc = loadTodosData(dataDir, cwd);
    const todo = doc.items.find((row) => row.id === id) || null;
    const verdict = guard({ todo, items: doc.items });
    if (!verdict.eligible) return { closed: false, reason: verdict.reason, item: todo };
    const saved = updateTodoUnlocked(dataDir, cwd, id, {
      status: 'done',
      appendChangelog: { kind: 'note', text: 'Auto-closed after code review PASS (CRETLI_TODO_LEAF_AUTO_CLOSE).' },
    });
    return {
      closed: true,
      reason: verdict.reason,
      item: saved.items.find((row) => row.id === id) || null,
    };
  }, { dataDir });
}

/**
 * Record that a chat worked on a todo without touching the item revision.
 * Idempotent: a chat already in `linkedChatIds` writes nothing.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} todoId
 * @param {string} chatId
 * @returns {{ changed: boolean, item: Record<string, any>|null, doc: Record<string, any>|null }}
 */
export function linkTodoChat(dataDir, cwd, todoId, chatId) {
  return withWorkspaceWatchersFileLock(() => linkTodoChatUnlocked(dataDir, cwd, todoId, chatId), { dataDir });
}

function linkTodoChatUnlocked(dataDir, cwd, todoId, chatId) {
  const id = String(todoId || '').trim();
  const linkId = String(chatId || '').trim();
  if (!id || !linkId) return { changed: false, item: null, doc: null };
  const doc = loadTodosData(dataDir, cwd);
  const idx = doc.items.findIndex((it) => it.id === id);
  if (idx < 0) return { changed: false, item: null, doc };
  const cur = doc.items[idx];
  const currentLinked = Array.isArray(cur.linkedChatIds) ? cur.linkedChatIds : [];
  const nextLinked = appendLinkedChatId(currentLinked, linkId);
  if (nextLinked === currentLinked) return { changed: false, item: cur, doc };
  const updated = { ...cur, linkedChatIds: nextLinked };
  doc.items[idx] = updated;
  return { changed: true, item: updated, doc: saveTodosData(dataDir, cwd, doc) };
}

/**
 * Removes the item and its whole subtree. Returns every removed item so
 * callers can clean up per-item links (chat.todoId).
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @returns {{ doc: Record<string, any>, removed: Record<string, any>, removedItems: Record<string, any>[] }}
 */
export function deleteTodo(dataDir, cwd, id) {
  return withWorkspaceWatchersFileLock(() => deleteTodoUnlocked(dataDir, cwd, id), { dataDir });
}

function deleteTodoUnlocked(dataDir, cwd, id) {
  if (!id || typeof id !== 'string') {
    /** @type {Error & { code?: any }} */
    const err = new Error('Missing id');
    err.code = 'VALIDATION';
    throw err;
  }
  const doc = loadTodosData(dataDir, cwd);
  const doomed = doc.items.find((it) => it.id === id);
  if (!doomed) {
    /** @type {Error & { code?: any }} */
    const err = new Error('Item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const removedIds = new Set(collectTodoSubtreeIds(doc.items, id));
  const removedItems = doc.items.filter((it) => removedIds.has(it.id));
  doc.items = doc.items.filter((it) => !removedIds.has(it.id));
  return { doc: saveTodosData(dataDir, cwd, doc), removed: doomed, removedItems };
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @returns {{ id: string, title: string, body: string, status: string, chatId?: string, createdAt: string, updatedAt: string } | null}
 */
export function getTodoById(dataDir, cwd, id) {
  if (!id || typeof id !== 'string') return null;
  const doc = loadTodosData(dataDir, cwd);
  return doc.items.find((it) => it.id === id) || null;
}

/**
 * Move already-built items from one workspace document to another in a single
 * call. Legacy JSON semantics (documented in docs/storage-callers.md): the
 * target document is written first, then the source. A failure while writing
 * the source leaves the items in BOTH workspaces (a duplicate, never a loss);
 * a failure writing the target changes nothing. The caller holds the watcher lock.
 *
 * @param {string} dataDir
 * @param {{ cwd: string, doc: any }} target document that gains the items
 * @param {{ cwd: string, doc: any }} source document that loses the items
 * @param {{ saveDoc?: (dataDir: string, cwd: string, doc: any) => any }} [options] test seam for failure injection
 */
export function moveTodoDocuments(dataDir, target, source, options = {}) {
  const save = options.saveDoc || saveTodosData;
  save(dataDir, target.cwd, target.doc);
  save(dataDir, source.cwd, source.doc);
}

// Private legacy-adapter names; the plain exports above stay as aliases until leaf 3f.
export {
  loadTodosData as legacyLoadTodosData,
  saveTodosData as legacySaveTodosData,
  addTodo as legacyAddTodoSync,
  updateTodo as legacyUpdateTodoSync,
};
