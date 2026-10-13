/**
 * Rollout backfill of the server-owned `todo.review` snapshot
 * (`docs/todo-review-contract.md` §11, §16).
 *
 * Leaves that predate the review field still have delegation history, but no
 * stored snapshot. This module rebuilds it from the retained records with the
 * SAME computation the live sync uses (`lib/todo-review-sync.js`), so a
 * backfilled leaf and a leaf watched live can never disagree.
 *
 * What it deliberately does not do:
 * - it never reads `data/` files to decide anything: jobs come from
 *   `listDelegationsForWorkspace` and todos from `loadTodosData` (the store is
 *   the only source of truth);
 * - it never writes from a read path. Only the operator CLI
 *   (`scripts/backfill-todo-review.js`) writes, only in `--apply` mode, and only
 *   through the dedicated `writeTodoReview` (workspace lock + `generation` +
 *   `decisionKey`), which keeps `item.updatedAt` — the agent CAS token — intact;
 * - it never fakes history. Verdicts come from the durable `reportVerdict`
 *   (§11.2), attribution only from the record `leafId` (§2.4), and a subject a
 *   legacy job never declared stays `other` (§3.2), so a retained legacy review
 *   can never produce `code: passed`.
 *
 * The one thing the live sync cannot express is how much of the history retention
 * left behind (§11.2). When a leaf has no attributable review job, `none` is only
 * honest if nothing that could have been that review was lost.
 * `assessTodoReviewHistory` decides that from evidence inside the logical
 * workspace — a review-relevant job with no `leafId` (optionally archived,
 * optionally with a trimmed attempt list) that overlaps the todo's lifetime — and
 * the backfill settles an incomplete history as `unknown` / `history_truncated`
 * instead of `none`. It applies that inference only where the leaf has no stored
 * subject yet: a `none` the live sync already wrote is that path's own §4.1
 * answer, and a later live recompute stays the authority.
 *
 * A backfill is also never a downgrade: a stored subject that already carries
 * evidence is left alone when the retained history now reads weaker than the
 * snapshot written while that evidence was still there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listDelegationsForWorkspace } from './persist/delegations-persist.js';
import {
  loadTodosData,
  normalizeTodoReview,
  todosDocumentPath,
  writeTodoReview,
} from './persist/todos-persist.js';
import { computeTodoReviewSnapshotForTodo } from './todo-review-sync.js';
import { normalizeTodoRefId } from './todo-ref.js';
import { delegationCycleRole } from './delegation-cycle-classify.js';
import { MAX_ATTEMPT_HISTORY } from './delegation-retention.js';
import {
  TODO_REVIEW_SCHEMA_VERSION,
  TODO_REVIEW_STATES,
  TODO_REVIEW_SUBJECTS,
} from './todo-review-state.js';
import { resolveDataPath } from './runtime-paths.js';

/** Version stamp of the checkpoint document. */
export const TODO_REVIEW_BACKFILL_CHECKPOINT_VERSION = 1;

/** Subjects the contract renders per-leaf states for (§4.1); `other` is audit-only. */
const BACKFILL_SUBJECTS = TODO_REVIEW_SUBJECTS;

/** States that carry review evidence a backfill must never destroy. */
const DECIDED_STATES = new Set(['passed', 'failed', 'manual', 'stale', 'pending']);

/** States that carry no evidence: writing one over a decided state is a downgrade. */
const WEAK_STATES = new Set(['none', 'unknown']);

/** §11.2 token, reused so the badge, the filters and the UI stay consistent. */
const HISTORY_INCOMPLETE_REASON = 'history_truncated';

/** Default checkpoint and backup locations, relative to the data directory. */
const CHECKPOINT_SEGMENTS = ['backfill', 'todo-review.checkpoint.json'];
const BACKUP_DIR_SEGMENTS = ['backups', 'todo-review-backfill'];

/** How many processed todos between checkpoint writes; a crash costs at most this. */
const DEFAULT_CHECKPOINT_EVERY = 25;

/** How many per-todo lines the report prints before it collapses the rest. */
const REPORT_LINE_LIMIT = 50;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toTime(value) {
  const ms = Date.parse(asText(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {unknown[]} values
 * @returns {number}
 */
function firstFiniteTime(values) {
  for (const value of values) {
    const ms = toTime(value);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function isoOrEmpty(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function resolveNow(value) {
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * @param {object} row
 * @returns {string}
 */
function rowLeafIdOf(row) {
  return normalizeTodoRefId(row?.leafId) || asText(row?.leafId);
}

/**
 * Can this job be a review of anything? A row that carries neither an assignment
 * nor a persisted role predates the vocabulary, so it can hide a review and is
 * treated as review-relevant.
 *
 * @param {object} row
 * @returns {boolean}
 */
function isReviewRelevantRow(row) {
  const assignment = asText(row?.assignment).toLowerCase();
  const role = delegationCycleRole(row);
  if (assignment === 'review' || role === 'review') return true;
  return !assignment && !role;
}

/**
 * The todo's lifetime: creation until the transition that closed it. An open
 * leaf never stops, so its window has no upper bound and a later evidence gap
 * still falls inside it — which is why an old open leaf cannot be claimed `none`.
 *
 * @param {object} todo
 * @returns {{ startMs: number, endMs: number, openEnded: boolean }}
 */
function todoLifetimeWindow(todo) {
  const startMs = toTime(todo?.createdAt);
  const closed = asText(todo?.status).toLowerCase() === 'done';
  // A review write never bumps `item.updatedAt` (§10.2), so for a done leaf this
  // is the closing transition, not a later snapshot refresh.
  const endMs = closed ? toTime(todo?.updatedAt) : NaN;
  return { startMs, endMs, openEnded: !Number.isFinite(endMs) };
}

/**
 * @param {object} row
 * @param {{ startMs: number, endMs: number, openEnded: boolean }} window
 * @returns {boolean}
 */
function rowOverlapsWindow(row, window) {
  const startMs = firstFiniteTime([row?.queuedAt, row?.createdAt, row?.startedAt]);
  const endMs = firstFiniteTime([
    row?.finishedAt,
    row?.lastTransitionAt,
    row?.startedAt,
    row?.queuedAt,
    row?.createdAt,
  ]);
  // A job that cannot be placed in time cannot be excluded either: assume overlap.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
  if (Number.isFinite(window.startMs) && endMs < window.startMs) return false;
  if (!window.openEnded && Number.isFinite(window.endMs) && startMs > window.endMs) return false;
  return true;
}

/**
 * Is the retained delegation history complete enough to state that this leaf has
 * no review at all?
 *
 * Only jobs with no `leafId` are evidence gaps: a job attributed to another leaf
 * says nothing about this one, and a job attributed to this leaf is already read
 * by the live builder, which settles its own trimmed attempt history as
 * `unknown` (`lib/todo-review-sync.js`).
 *
 * @param {{ todo?: object, rows?: object[] }} input
 * @returns {{ complete: boolean, window: object, signals: Array<{ code: string, delegationId: string, archived: boolean, attemptsTrimmed: boolean }> }}
 */
export function assessTodoReviewHistory(input = {}) {
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : {};
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const window = todoLifetimeWindow(todo);
  /** @type {Array<{ code: string, delegationId: string, archived: boolean, attemptsTrimmed: boolean }>} */
  const signals = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (rowLeafIdOf(row)) continue;
    if (!isReviewRelevantRow(row)) continue;
    if (!rowOverlapsWindow(row, window)) continue;
    const archived = !!asText(row.archivedAt);
    signals.push({
      // An archived job is unrecoverable: retention cleared `sourceText`, which
      // is where its attribution used to live (§11.1).
      code: archived ? 'archived_unattributed_review' : 'unattributed_review',
      delegationId: asText(row.id),
      archived,
      attemptsTrimmed: (Array.isArray(row.attempts) ? row.attempts.length : 0) >= MAX_ATTEMPT_HISTORY,
    });
  }
  return {
    complete: signals.length === 0,
    window: {
      startAt: isoOrEmpty(window.startMs),
      endAt: window.openEnded ? '' : isoOrEmpty(window.endMs),
      openEnded: window.openEnded,
    },
    signals,
  };
}

/**
 * The backfill's own merge rule, mirroring the writer's
 * `mergeTodoReviewSubjects` so a dry run predicts `changed` exactly: a subject
 * the payload omits keeps its stored snapshot.
 *
 * @param {Record<string, unknown>|null} stored
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function mergeReviewSubjects(stored, payload) {
  const merged = { ...payload };
  for (const key of [...BACKFILL_SUBJECTS, 'aggregate']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) continue;
    if (stored && stored[key] !== undefined) merged[key] = stored[key];
  }
  if (stored && Number.isInteger(stored.generation)
    && !Object.prototype.hasOwnProperty.call(payload, 'generation')) {
    merged.generation = stored.generation;
  }
  return merged;
}

/**
 * @param {Record<string, unknown>|null} stored
 * @param {string} subject
 * @returns {string}
 */
function storedSubjectState(stored, subject) {
  const snapshot = stored?.[subject];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return '';
  return asText(snapshot.state);
}

/**
 * Decide one todo: the snapshot the live function computes, the completeness gate
 * on top of it, and the subjects the writer may actually receive.
 *
 * @param {{
 *   todo?: object,
 *   rows?: object[],
 *   now?: number,
 * }} input
 * @returns {{
 *   todoId: string,
 *   title: string,
 *   status: string,
 *   action: 'write'|'unchanged'|'preserved',
 *   payload: Record<string, unknown>,
 *   review: Record<string, unknown>|null,
 *   states: Record<string, string>,
 *   subjects: Record<string, object>,
 *   forcedSubjects: string[],
 *   history: object,
 * }}
 */
export function planTodoReviewBackfillForTodo(input = {}) {
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : {};
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const now = resolveNow(input.now);
  const todoId = asText(todo.id);
  const stored = normalizeTodoReview(todo.review) || null;
  const snapshot = computeTodoReviewSnapshotForTodo({
    todo: { id: todoId, workspaceFolder: asText(todo.workspaceFolder) },
    rows,
    now,
    materialRevision: '',
    planBoundaryAt: asText(todo.plan?.markdownUpdatedAt || todo.plan?.updatedAt),
  });
  const history = assessTodoReviewHistory({ todo, rows });

  /** @type {Record<string, unknown>} */
  const payload = { schemaVersion: TODO_REVIEW_SCHEMA_VERSION, computedAt: snapshot.computedAt };
  /** @type {Record<string, object>} */
  const subjects = {};
  /** @type {string[]} */
  const forcedSubjects = [];
  for (const subject of BACKFILL_SUBJECTS) {
    const computed = snapshot[subject];
    const from = storedSubjectState(stored, subject);
    if (!computed) {
      // The live builder emits `other` only when it has evidence for it, and the
      // writer keeps a stored `other` when the payload omits it.
      subjects[subject] = { action: from ? 'kept' : 'absent', from, to: from };
      continue;
    }
    /** @type {Record<string, unknown>} */
    let next = computed;
    let forced = false;
    if (next.state === 'none' && !history.complete && !from) {
      // Never claim "nothing was ever reviewed" when something that could have
      // been that review is no longer attributable (§11.2). This is a rollout
      // inference about a gap the live path never had to answer, so it applies
      // only where no stored subject exists yet: a `none` the live sync already
      // wrote is its own decision (§4.1) and is left alone (contract §16).
      next = { ...next, state: 'unknown', stateReason: HISTORY_INCOMPLETE_REASON, truncated: true };
      forced = true;
      forcedSubjects.push(subject);
    }
    if (from && DECIDED_STATES.has(from) && WEAK_STATES.has(asText(next.state))) {
      // The retained history is now poorer than the snapshot written while the
      // evidence still existed: preserve the stored subject by leaving it out of
      // the payload (rollout rule, contract §11.2).
      subjects[subject] = { action: 'preserved', from, to: from };
      continue;
    }
    payload[subject] = next;
    subjects[subject] = {
      action: 'write',
      from,
      to: asText(next.state),
      stateReason: asText(next.stateReason),
      forcedByHistory: forced,
    };
  }

  // Predict the writer's own test: normalize the merged document and compare the
  // timestamp-free `decisionKey` it recomputes. Normalizing here (instead of
  // comparing the raw payload) is what makes a dry run and an apply agree,
  // because the persistence normalizer re-derives a few derived fields.
  const review = normalizeTodoReview(mergeReviewSubjects(stored, payload)) || null;
  const writable = BACKFILL_SUBJECTS.some((subject) => payload[subject] !== undefined);
  const preservedCount = BACKFILL_SUBJECTS.filter((subject) => subjects[subject]?.action === 'preserved').length;
  const decisionUnchanged = !!stored
    && !!review
    && !!asText(stored.decisionKey)
    && asText(stored.decisionKey) === asText(review.decisionKey);
  /** @type {'write'|'unchanged'|'preserved'} */
  let action = 'write';
  if (!writable) action = 'preserved';
  else if (decisionUnchanged) action = preservedCount > 0 ? 'preserved' : 'unchanged';

  /** @type {Record<string, string>} */
  const states = {};
  for (const subject of BACKFILL_SUBJECTS) {
    const snapshotRow = review?.[subject];
    states[subject] = snapshotRow && typeof snapshotRow === 'object'
      ? asText(/** @type {Record<string, unknown>} */ (snapshotRow).state)
      : '';
  }

  return {
    todoId,
    title: asText(todo.title),
    status: asText(todo.status),
    action,
    payload,
    review,
    states,
    subjects,
    forcedSubjects,
    history,
  };
}

/**
 * @param {string} checkpointPath
 * @param {{ workspaceFolder: string, dataDir: string }} scope
 * @returns {Record<string, unknown>|null}
 */
function readCheckpointDocument(checkpointPath, scope) {
  let raw;
  try {
    raw = fs.readFileSync(checkpointPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  if (doc.version !== TODO_REVIEW_BACKFILL_CHECKPOINT_VERSION) return null;
  // A checkpoint only resumes its own scope: another workspace or another data
  // directory must never inherit its processed ids.
  if (asText(doc.workspaceFolder) !== scope.workspaceFolder) return null;
  if (asText(doc.dataDir) !== scope.dataDir) return null;
  return doc;
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function resolveTodoReviewBackfillCheckpointPath(dataDir) {
  return path.join(asText(dataDir) || resolveDataPath(), ...CHECKPOINT_SEGMENTS);
}

/**
 * The ids an interrupted `--apply` already committed.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, checkpointPath?: string }} input
 * @returns {{ path: string, existed: boolean, processed: string[], backupPath: string, startedAt: string }}
 */
export function readTodoReviewBackfillCheckpoint(input = {}) {
  const dataDir = asText(input.dataDir) || resolveDataPath();
  const checkpointPath = asText(input.checkpointPath)
    || resolveTodoReviewBackfillCheckpointPath(dataDir);
  const doc = readCheckpointDocument(checkpointPath, {
    workspaceFolder: asText(input.workspaceFolder),
    dataDir,
  });
  if (!doc) {
    return { path: checkpointPath, existed: false, processed: [], backupPath: '', startedAt: '' };
  }
  return {
    path: checkpointPath,
    existed: true,
    processed: Array.isArray(doc.processed) ? doc.processed.map((id) => asText(id)).filter(Boolean) : [],
    backupPath: asText(doc.backupPath),
    startedAt: asText(doc.startedAt),
  };
}

/**
 * @param {{ checkpointPath?: string, document?: Record<string, unknown> }} input
 * @returns {boolean} written
 */
function writeCheckpointDocument(input = {}) {
  const checkpointPath = asText(input.checkpointPath);
  if (!checkpointPath) return false;
  try {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, `${JSON.stringify(input.document, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // A lost checkpoint costs a re-scan, never correctness: the run stays
    // idempotent because the writer compares `decisionKey`.
    return false;
  }
}

/**
 * @param {{ checkpointPath?: string }} input
 * @returns {boolean}
 */
export function clearTodoReviewBackfillCheckpoint(input = {}) {
  const checkpointPath = asText(input.checkpointPath);
  if (!checkpointPath) return false;
  try {
    fs.rmSync(checkpointPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the workspace's todos document before the first write of the run. This is
 * the rollback point: restoring it over the live document is the documented
 * recovery (`docs/todo-review-contract.md` §16).
 *
 * @param {{ dataDir: string, workspaceFolder: string, now: number, deps?: object }} input
 * @returns {string} absolute backup path, or '' when there is nothing to back up
 */
export function backupTodoReviewBackfillDocument(input = {}) {
  const dataDir = asText(input.dataDir) || resolveDataPath();
  const workspaceFolder = asText(input.workspaceFolder);
  const now = resolveNow(input.now);
  const resolveDocumentPath = typeof input.deps?.todosDocumentPath === 'function'
    ? input.deps.todosDocumentPath
    : todosDocumentPath;
  const documentPath = workspaceFolder ? resolveDocumentPath(dataDir, workspaceFolder) : null;
  if (!documentPath || !fs.existsSync(documentPath)) return '';
  const key = path.basename(documentPath, '.json');
  const directory = path.join(dataDir, ...BACKUP_DIR_SEGMENTS);
  fs.mkdirSync(directory, { recursive: true });
  const stamp = isoOrEmpty(now).replace(/[:.]/g, '-');
  let target = path.join(directory, `${key}.${stamp}.json`);
  for (let index = 2; fs.existsSync(target); index += 1) {
    target = path.join(directory, `${key}.${stamp}-${index}.json`);
  }
  fs.copyFileSync(documentPath, target);
  return target;
}

/**
 * @param {object[]} items
 * @returns {object[]}
 */
function inBackfillOrder(items) {
  // Oldest first, ids as the tie-breaker: a resumed run then sees the same prefix
  // it committed, and the report reads as a rollout over time.
  return [...items].sort((left, right) => {
    const leftTime = toTime(left?.createdAt);
    const rightTime = toTime(right?.createdAt);
    const leftValue = Number.isFinite(leftTime) ? leftTime : Infinity;
    const rightValue = Number.isFinite(rightTime) ? rightTime : Infinity;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
    const leftId = asText(left?.id);
    const rightId = asText(right?.id);
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return 0;
  });
}

/**
 * @returns {Record<string, number>}
 */
function emptyStateCounts() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const state of TODO_REVIEW_STATES) counts[state] = 0;
  return counts;
}

/**
 * @param {object[]} plans
 * @param {object[]} failures
 * @returns {object}
 */
function summarizePlans(plans, failures) {
  const summary = {
    considered: plans.length,
    resumed: 0,
    planned: 0,
    written: 0,
    unchanged: 0,
    preserved: 0,
    failed: failures.length,
    forcedByHistory: 0,
    bySubjectState: { code: emptyStateCounts(), plan: emptyStateCounts(), other: emptyStateCounts() },
    historySignals: {},
  };
  for (const plan of plans) {
    for (const signal of plan.history.signals) {
      summary.historySignals[signal.code] = (summary.historySignals[signal.code] || 0) + 1;
    }
    for (const subject of BACKFILL_SUBJECTS) {
      const state = asText(plan.states?.[subject]);
      if (!state || summary.bySubjectState[subject][state] === undefined) continue;
      summary.bySubjectState[subject][state] += 1;
    }
    summary.forcedByHistory += plan.forcedSubjects.length;
    if (plan.action === 'write' || plan.action === 'written') summary.planned += 1;
    if (plan.action === 'written') summary.written += 1;
    else if (plan.action === 'unchanged' || plan.action === 'deleted') summary.unchanged += 1;
    else if (plan.action === 'preserved') summary.preserved += 1;
  }
  return summary;
}

/**
 * @param {{
 *   version: number,
 *   workspaceFolder: string,
 *   dataDir: string,
 *   startedAt: string,
 *   backupPath: string,
 *   processed: string[],
 *   total: number,
 * }} input
 * @returns {Record<string, unknown>}
 */
function buildCheckpointDocument(input) {
  return {
    version: input.version,
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    startedAt: input.startedAt,
    backupPath: input.backupPath,
    processed: [...input.processed],
    total: input.total,
    complete: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Rollout run over one logical workspace. `apply` defaults to false, so the
 * operator always sees the plan before anything is written.
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder?: string,
 *   rows?: object[],
 *   apply?: boolean,
 *   now?: number,
 *   restart?: boolean,
 *   checkpointPath?: string,
 *   checkpointEvery?: number,
 *   deps?: {
 *     listRows?: Function,
 *     loadTodos?: Function,
 *     writeReview?: Function,
 *     todosDocumentPath?: Function,
 *   },
 * }} [input]
 * @returns {object}
 */
export function runTodoReviewBackfill(input = {}) {
  const workspaceFolder = asText(input.workspaceFolder);
  if (!workspaceFolder) {
    const err = new Error('Backfill needs an explicit workspace folder');
    err.code = 'VALIDATION';
    throw err;
  }
  const dataDir = asText(input.dataDir) || resolveDataPath();
  const apply = input.apply === true;
  const now = resolveNow(input.now);
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const listRows = typeof deps.listRows === 'function'
    ? deps.listRows
    : (folder, options) => listDelegationsForWorkspace(folder, options);
  const loadTodos = typeof deps.loadTodos === 'function'
    ? deps.loadTodos
    : (dir, folder) => loadTodosData(dir, folder).items;
  const writeReview = typeof deps.writeReview === 'function' ? deps.writeReview : writeTodoReview;
  const checkpointEvery = Math.max(
    1,
    Math.floor(Number(input.checkpointEvery) || DEFAULT_CHECKPOINT_EVERY),
  );

  const rows = Array.isArray(input.rows) ? input.rows : listRows(workspaceFolder, { dataDir });
  const loaded = loadTodos(dataDir, workspaceFolder);
  const items = inBackfillOrder(
    (Array.isArray(loaded) ? loaded : []).filter((row) => row && typeof row === 'object' && asText(row.id)),
  );

  const checkpointPath = asText(input.checkpointPath)
    || resolveTodoReviewBackfillCheckpointPath(dataDir);
  const resumed = readTodoReviewBackfillCheckpoint({ workspaceFolder, dataDir, checkpointPath });
  const resumedIds = input.restart ? [] : resumed.processed.filter((id) => id);
  const processed = [...resumedIds];
  const processedSet = new Set(processed);
  const startedAt = resumed.existed && resumedIds.length && !input.restart
    ? (resumed.startedAt || isoOrEmpty(now))
    : isoOrEmpty(now);
  const state = {
    backupPath: resumed.existed && !input.restart ? resumed.backupPath : '',
  };

  /** @type {object[]} */
  const plans = [];
  /** @type {object[]} */
  const failures = [];
  let checkpointWritten = false;
  let skippedByCheckpoint = 0;

  /**
   * @returns {void}
   */
  const flushCheckpoint = () => {
    if (!apply) return;
    checkpointWritten = writeCheckpointDocument({
      checkpointPath,
      document: buildCheckpointDocument({
        version: TODO_REVIEW_BACKFILL_CHECKPOINT_VERSION,
        workspaceFolder,
        dataDir,
        startedAt,
        backupPath: state.backupPath,
        processed,
        total: items.length,
      }),
    }) || checkpointWritten;
  };

  for (const todo of items) {
    const todoId = asText(todo.id);
    if (processedSet.has(todoId)) {
      skippedByCheckpoint += 1;
      continue;
    }
    let plan;
    try {
      plan = planTodoReviewBackfillForTodo({ todo, rows, now });
    } catch (error) {
      failures.push({
        todoId,
        stage: 'plan',
        code: asText(error?.code) || 'PLAN_ERROR',
        message: error instanceof Error ? error.message : String(error ?? 'plan_failed'),
      });
      continue;
    }

    if (!apply) {
      plans.push(plan);
      continue;
    }

    if (plan.action !== 'write') {
      plans.push(plan);
      processedSet.add(todoId);
      processed.push(todoId);
      continue;
    }

    if (!state.backupPath) {
      state.backupPath = backupTodoReviewBackfillDocument({
        dataDir,
        workspaceFolder,
        now,
        deps: { todosDocumentPath: deps.todosDocumentPath },
      });
    }
    try {
      const written = writeReview(dataDir, workspaceFolder, todoId, plan.payload);
      plan.action = written?.changed === true ? 'written' : 'unchanged';
      if (Number.isInteger(written?.generation)) plan.generation = written.generation;
    } catch (error) {
      const code = asText(error?.code) || 'WRITE_ERROR';
      if (code === 'NOT_FOUND') {
        // The leaf was deleted between the read and the write: nothing to
        // backfill, and not a failure.
        plan.action = 'deleted';
        plans.push(plan);
        processedSet.add(todoId);
        processed.push(todoId);
        continue;
      }
      plan.action = 'failed';
      failures.push({
        todoId,
        stage: 'write',
        code,
        message: error instanceof Error ? error.message : String(error ?? 'write_failed'),
      });
      // The leaf stays unprocessed so a later run retries it. Flush now: the
      // committed prefix must survive a process that dies on this error.
      flushCheckpoint();
      continue;
    }
    plans.push(plan);
    processedSet.add(todoId);
    processed.push(todoId);
    if (processed.length % checkpointEvery === 0) flushCheckpoint();
  }

  const complete = failures.length === 0 && processed.length >= items.length;
  let checkpointRemoved = false;
  if (apply && complete) {
    checkpointRemoved = clearTodoReviewBackfillCheckpoint({ checkpointPath });
  } else if (apply) {
    flushCheckpoint();
  }

  const summary = summarizePlans(plans, failures);
  summary.resumed = skippedByCheckpoint;

  return {
    ok: failures.length === 0,
    mode: apply ? 'apply' : 'dry-run',
    workspaceFolder,
    dataDir,
    todos: plans,
    summary,
    failures,
    backupPath: state.backupPath,
    todosDocumentPath: todosDocumentPath(dataDir, workspaceFolder) || '',
    checkpoint: {
      path: checkpointPath,
      existed: resumed.existed,
      resumedFrom: resumedIds.length,
      processed: processed.length,
      total: items.length,
      complete,
      written: checkpointWritten,
      removed: checkpointRemoved,
    },
  };
}

/**
 * @param {Record<string, number>} counts
 * @returns {string}
 */
function formatStateCounts(counts) {
  return TODO_REVIEW_STATES.map((state) => `${state}=${counts[state] || 0}`).join(' ');
}

/**
 * @param {object} plan
 * @returns {string}
 */
function describePlan(plan) {
  const parts = [];
  for (const subject of BACKFILL_SUBJECTS) {
    const entry = plan.subjects?.[subject];
    if (!entry || entry.action !== 'write') continue;
    parts.push(`${subject}:${entry.from || '-'}->${entry.to}`);
  }
  if (plan.forcedSubjects?.length) parts.push('[history incomplete]');
  return parts.join(' ');
}

/**
 * Operator-facing report: one line per subject with the state matrix, the action
 * tally, and the rollback instructions.
 *
 * @param {object} result
 * @returns {string}
 */
export function formatTodoReviewBackfillReport(result) {
  const summary = result?.summary || {};
  const mode = asText(result?.mode) || 'dry-run';
  const apply = mode === 'apply';
  const checkpoint = result?.checkpoint || {};
  const lines = [
    'todo review backfill',
    `  workspace: ${asText(result?.workspaceFolder) || '(none)'}`,
    `  data-dir:  ${asText(result?.dataDir) || '(none)'}`,
    `  mode:      ${mode}${apply ? '' : ' (nothing written)'}`,
  ];
  const counts = summary.bySubjectState || {};
  for (const subject of BACKFILL_SUBJECTS) {
    const subjectCounts = counts[subject];
    if (!subjectCounts) continue;
    lines.push(`  ${subject}: ${formatStateCounts(subjectCounts)}`);
  }
  lines.push(
    `  actions: considered=${summary.considered || 0}`
    + (apply ? ` written=${summary.written || 0}` : ` to-write=${summary.planned || 0}`)
    + ` unchanged=${summary.unchanged || 0}`
    + ` preserved=${summary.preserved || 0}`
    + ` resumed=${summary.resumed || 0}`
    + ` failed=${summary.failed || 0}`,
  );
  const signals = Object.entries(summary.historySignals || {})
    .map(([code, count]) => `${code}=${count}`)
    .join(' ');
  lines.push(`  history: subjects forced to unknown=${summary.forcedByHistory || 0}`
    + ` signals=${signals || 'none'}`);
  lines.push(`  checkpoint: ${asText(checkpoint.path) || '(none)'}`
    + ` existed=${checkpoint.existed === true}`
    + ` resumed=${checkpoint.resumedFrom || 0}`
    + ` processed=${checkpoint.processed || 0}/${checkpoint.total || 0}`
    + ` complete=${checkpoint.complete === true}`
    + (checkpoint.removed ? ' (removed after a complete pass)' : ''));

  const actionable = (Array.isArray(result?.todos) ? result.todos : [])
    .filter((plan) => plan.action === 'write' || plan.action === 'written' || plan.action === 'failed');
  if (actionable.length > 0) {
    lines.push(`  ${apply ? 'written' : 'to write'} (${actionable.length}):`);
    for (const plan of actionable.slice(0, REPORT_LINE_LIMIT)) {
      const detail = describePlan(plan);
      const title = plan.title ? ` ${plan.title}` : '';
      lines.push(`    ${asText(plan.todoId)}${title}${detail ? `: ${detail}` : ''}`.slice(0, 200));
    }
    if (actionable.length > REPORT_LINE_LIMIT) {
      lines.push(`    ... ${actionable.length - REPORT_LINE_LIMIT} more`);
    }
  }
  for (const failure of Array.isArray(result?.failures) ? result.failures : []) {
    lines.push(`  FAILED ${asText(failure.todoId)} [${asText(failure.stage)}/${asText(failure.code)}]: ${asText(failure.message)}`);
  }
  lines.push(`  rollback: ${asText(result?.backupPath) || '(no backup taken)'}`);
  lines.push(`  restore:  cp "${asText(result?.backupPath) || '<backup>'}" "${asText(result?.todosDocumentPath) || '<data-dir>/todos/<workspace-key>.json'}"`);
  return `${lines.join('\n')}\n`;
}
