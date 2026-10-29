/**
 * The rollout backfill of the server-owned `todo.review` snapshot:
 * `lib/todo-review-backfill.js` + `scripts/backfill-todo-review.js`
 * (`docs/todo-review-contract.md` §11, §16).
 *
 * Two layers are covered deliberately. The pure planner cases prove the
 * honest-history rules (retention-truncated verdicts, unattributable archived
 * jobs, a missing review subject, trimmed attempt history, never degrading a
 * stored snapshot). The store-backed cases prove the operator behaviour
 * (dry-run writes nothing, apply persists exactly what the dry run planned,
 * idempotency, the backup, the checkpoint and resume, and that a live sync after
 * archival does not degrade a backfilled snapshot).
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addTodo,
  loadTodosData,
  normalizeTodoReview,
  todosDocumentPath,
  writeTodoReview,
} from '../lib/persist/todos-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  listDelegationsForWorkspace,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { applyDelegationRetention } from '../lib/delegation-retention.js';
import { TODO_REVIEW_STATES } from '../lib/todo-review-state.js';
import { clearTodoReviewSyncRetries, syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';
import {
  assessTodoReviewHistory,
  planTodoReviewBackfillForTodo,
  resolveTodoReviewBackfillCheckpointPath,
  runTodoReviewBackfill,
} from '../lib/todo-review-backfill.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = '/tmp/backfill-review-workspace';
const LEAF = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_LEAF = 'bbbbbbbb-2222-4222-8222-222222222222';

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;
/** Minutes after 2026-01-01T00:00, so every fixture time is explicit. */
const t = (minute, second = 0) => `2026-01-01T00:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const NOW = Date.parse(t(50));

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function pureTodo(overrides = {}) {
  return {
    id: LEAF,
    workspaceFolder: WORKSPACE,
    title: 'Leaf from before the review field',
    status: 'done',
    createdAt: t(0),
    updatedAt: t(40),
    ...overrides,
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function materialRow(overrides = {}) {
  const queuedAt = overrides.queuedAt || t(1);
  return {
    id: nextId('impl'),
    workspaceFolder: WORKSPACE,
    leafId: LEAF,
    parentChatId: 'parent-a',
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    attemptId: nextId('att'),
    queuedAt,
    createdAt: queuedAt,
    startedAt: overrides.startedAt || queuedAt,
    finishedAt: overrides.finishedAt || t(2),
    executor: { transport: 'testfake', model: 'gpt-5' },
    report: 'TASK: implement\nVERDICT: PASS',
    ...overrides,
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function reviewRow(overrides = {}) {
  const queuedAt = overrides.queuedAt || t(10);
  return {
    id: nextId('rev'),
    workspaceFolder: WORKSPACE,
    leafId: LEAF,
    parentChatId: 'parent-a',
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    attemptId: nextId('att'),
    queuedAt,
    createdAt: queuedAt,
    startedAt: overrides.startedAt || queuedAt,
    finishedAt: overrides.finishedAt || queuedAt,
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    reportVerdict: 'PASS',
    verifyRequired: false,
    verifyResult: null,
    report: 'TASK: review\nVERDICT: PASS',
    ...overrides,
  };
}

/**
 * A job whose attribution is gone: retention archived it and cleared
 * `sourceText`, so it can no longer be tied to any leaf (§2.4, §11.1).
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function unattributedArchivedReview(overrides = {}) {
  const queuedAt = overrides.queuedAt || t(20);
  return reviewRow({
    leafId: '',
    archivedAt: t(45),
    sourceText: '',
    queuedAt,
    startedAt: queuedAt,
    finishedAt: overrides.finishedAt || queuedAt,
    ...overrides,
  });
}

/**
 * @param {{ todo?: object, rows?: object[] }} input
 * @returns {object}
 */
function planFor(input) {
  return planTodoReviewBackfillForTodo({
    todo: pureTodo(input.todo || {}),
    rows: input.rows || [],
    now: NOW,
  });
}

/**
 * A review block shaped exactly like one the live sync persisted, so a
 * preservation test compares against a real stored value and not a stub.
 *
 * @param {object[]} rows
 * @param {object} [todoOverrides]
 * @returns {object}
 */
function storedReviewAsLiveWroteIt(rows, todoOverrides = {}) {
  const plan = planFor({ rows, todo: todoOverrides });
  return normalizeTodoReview({ ...plan.payload, generation: 1 });
}

/** @param {string} name */
function makeProject(name) {
  const dir = path.join(ISOLATED_DATA_DIR, `backfill-ws-${name}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} project
 * @param {object} [overrides]
 * @returns {object}
 */
function storeTodo(project, overrides = {}) {
  return addTodo(ISOLATED_DATA_DIR, project, {
    title: 'Old leaf',
    status: 'doing',
    ...overrides,
  }).item;
}

/**
 * Fields a row can only receive through `updateDelegationRecord`: the store's
 * creation path keeps them empty because the real runner fills them at
 * finalization. A fixture that wants a finished review must patch them.
 */
const PATCHABLE_REVIEW_FIELDS = [
  'report',
  'reportVerdict',
  'reportSummary',
  'reportDegraded',
  'startedAt',
  'finishedAt',
  'lastTransitionAt',
  'archivedAt',
  'sourceText',
  'attempts',
  'taskOutcome',
  'error',
];

/**
 * A finished review job as the store holds it after finalization.
 *
 * @param {string} project
 * @param {object} todo
 * @param {object} [overrides]
 * @returns {object}
 */
function storeReviewRow(project, todo, overrides = {}) {
  const input = {
    report: 'TASK: review\nVERDICT: PASS',
    reportVerdict: 'PASS',
    ...overrides,
  };
  const at = new Date().toISOString();
  const create = {
    parentChatId: `store-parent-${nextId('p')}`,
    workspaceFolder: project,
    executor: input.executor || { transport: 'testfake', model: 'testfakeb-chat' },
    assignment: 'review',
    executionMode: 'agent',
    leafId: input.leafId === undefined ? todo.id : input.leafId,
    status: input.status || 'completed',
    reviewSubject: input.reviewSubject === undefined ? 'code' : input.reviewSubject,
    reviewSubjectSource: input.reviewSubjectSource === undefined ? 'explicit' : input.reviewSubjectSource,
  };
  if (input.queuedAt) create.queuedAt = input.queuedAt;
  if (input.verifyRequired !== undefined) create.verifyRequired = input.verifyRequired;
  if (input.reviewCanRunTests !== undefined) create.reviewCanRunTests = input.reviewCanRunTests;
  const row = createDelegationRecord(create);
  const patch = {
    startedAt: at,
    finishedAt: at,
    lastTransitionAt: at,
  };
  for (const key of PATCHABLE_REVIEW_FIELDS) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  updateDelegationRecord(row.id, patch);
  return getDelegationById(row.id);
}

/**
 * @param {string} project
 * @param {string} id
 * @returns {object|undefined}
 */
function readStoreTodo(project, id) {
  return loadTodosData(ISOLATED_DATA_DIR, project).items.find((row) => row.id === id);
}

/** @param {string} name */
function checkpointFor(name) {
  return path.join(ISOLATED_DATA_DIR, `cp-${name}.json`);
}

/**
 * @param {object[]} items
 * @returns {Record<string, Record<string, number>>}
 */
function tallyPersistedStates(items) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const subject of ['code', 'plan']) {
    out[subject] = {};
    for (const state of TODO_REVIEW_STATES) out[subject][state] = 0;
  }
  for (const item of items) {
    for (const subject of ['code', 'plan']) {
      const state = item?.review?.[subject]?.state;
      if (state && out[subject][state] !== undefined) out[subject][state] += 1;
    }
  }
  return out;
}

test.after(() => {
  clearTodoReviewSyncRetries();
  removeIsolatedDataDir();
});

// --- completeness of the retained history ------------------------------------

test('a complete history with no review job plans none, not unknown', () => {
  const plan = planFor({ rows: [materialRow()] });
  assert.equal(plan.history.complete, true);
  assert.deepEqual(plan.history.signals, []);
  assert.equal(plan.states.code, 'none');
  assert.equal(plan.states.plan, 'none');
  assert.equal(plan.action, 'write');
  assert.equal(plan.payload.code.state, 'none');
  assert.equal(plan.payload.code.stateReason, 'no_review');
});

test('an archived job without leafId is unattributable, so no-review becomes unknown', () => {
  const plan = planFor({ rows: [unattributedArchivedReview()] });
  assert.equal(plan.history.complete, false);
  assert.deepEqual(plan.history.signals.map((row) => row.code), ['archived_unattributed_review']);
  assert.equal(plan.states.code, 'unknown');
  assert.equal(plan.states.plan, 'unknown');
  assert.deepEqual(plan.forcedSubjects, ['code', 'plan']);
  assert.equal(plan.payload.code.stateReason, 'history_truncated');
  assert.equal(plan.payload.code.truncated, true);
});

test('an unattributed job outside the leaf lifetime is not an evidence gap', () => {
  const early = unattributedArchivedReview({
    queuedAt: '2025-12-31T23:50:00.000Z',
    startedAt: '2025-12-31T23:50:00.000Z',
    finishedAt: '2025-12-31T23:55:00.000Z',
    lastTransitionAt: '2025-12-31T23:55:00.000Z',
  });
  assert.equal(assessTodoReviewHistory({ todo: pureTodo(), rows: [early] }).complete, true);
  assert.equal(planFor({ rows: [early] }).states.code, 'none');
});

test('an open leaf has an unbounded lifetime, so a late gap still yields unknown', () => {
  const late = unattributedArchivedReview({
    queuedAt: '2027-06-01T00:00:00.000Z',
    startedAt: '2027-06-01T00:00:00.000Z',
    finishedAt: '2027-06-01T00:10:00.000Z',
    lastTransitionAt: '2027-06-01T00:10:00.000Z',
  });
  const plan = planFor({ todo: { status: 'doing', updatedAt: t(41) }, rows: [late] });
  assert.equal(plan.history.window.openEnded, true);
  assert.equal(plan.states.code, 'unknown');
});

test('only an unattributable job that could be a review is an evidence gap', () => {
  const attributedElsewhere = unattributedArchivedReview({ leafId: OTHER_LEAF });
  const unattributedImplement = materialRow({ leafId: '', queuedAt: t(20) });
  assert.equal(assessTodoReviewHistory({ todo: pureTodo(), rows: [attributedElsewhere] }).complete, true);
  assert.equal(assessTodoReviewHistory({ todo: pureTodo(), rows: [unattributedImplement] }).complete, true);
  // A row that carries neither an assignment nor a persisted role predates the
  // vocabulary, so it can hide a review.
  const legacy = {
    id: nextId('legacy'),
    workspaceFolder: WORKSPACE,
    leafId: '',
    parentChatId: 'parent-a',
    status: 'completed',
    attemptId: nextId('att'),
    queuedAt: t(21),
    createdAt: t(21),
    startedAt: t(21),
    finishedAt: t(21),
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
  };
  const assessment = assessTodoReviewHistory({ todo: pureTodo(), rows: [legacy] });
  assert.equal(assessment.complete, false);
  assert.deepEqual(assessment.signals.map((row) => row.code), ['unattributed_review']);
});

test('a job whose attribution lived only in sourceText never becomes attributable', () => {
  const plan = planFor({
    rows: [unattributedArchivedReview({ sourceText: `cretli-ref todo=${LEAF}\nTASK: review\nVERDICT: PASS` })],
  });
  // §2.4 attributes a job only by its persisted `leafId`, so this stays a gap.
  assert.equal(plan.states.code, 'unknown');
  assert.equal(plan.states.plan, 'unknown');
});

// --- verdicts and subjects ---------------------------------------------------

test('a report cut by retention keeps its verdict from the durable reportVerdict', () => {
  const body = `${'x'.repeat(2100)}\nTASK: review\nVERDICT: PASS`;
  const archived = reviewRow({
    report: body.slice(0, 2000),
    archivedAt: t(45),
    sourceText: '',
    reportVerdict: 'PASS',
  });
  assert.equal(archived.report.includes('VERDICT'), false, 'the retained body lost its verdict line');
  const plan = planFor({ rows: [materialRow(), archived] });
  assert.equal(plan.states.code, 'passed');
  assert.equal(plan.payload.code.stateReason, 'fresh_review');
});

test('a job without a durable verdict and a cut body is unknown, never passed', () => {
  const body = `${'x'.repeat(2100)}\nTASK: review\nVERDICT: PASS`;
  const archived = reviewRow({
    report: body.slice(0, 2000),
    archivedAt: t(45),
    sourceText: '',
    reportVerdict: '',
  });
  const plan = planFor({ rows: [materialRow(), archived] });
  assert.equal(plan.states.code, 'unknown');
  assert.equal(plan.payload.code.stateReason, 'no_verdict');
});

test('a job that never declared a subject is other and never yields code passed', () => {
  const legacy = reviewRow({ reviewSubject: undefined, reviewSubjectSource: undefined });
  const plan = planFor({ rows: [materialRow(), legacy] });
  assert.equal(plan.states.code, 'none');
  assert.equal(plan.states.other, 'passed');
  assert.equal(plan.payload.code.state, 'none');
  assert.equal(plan.payload.other.subjectSource, 'unknown');
  assert.equal(plan.payload.other.stateReason, 'fresh_review');
});

test('a retried job whose archived and current attempts all lost their verdicts is unknown', () => {
  const attempts = [
    {
      attemptId: 'legacy-att-1',
      status: 'completed',
      startedAt: t(3),
      finishedAt: t(4),
      reviewSubject: 'code',
      reviewSubjectSource: 'explicit',
      reportVerdict: '',
      report: '',
      model: 'testfakeb-chat',
      transport: 'testfake',
    },
    {
      attemptId: 'legacy-att-2',
      status: 'completed',
      startedAt: t(5),
      finishedAt: t(6),
      reviewSubject: 'code',
      reviewSubjectSource: 'explicit',
      reportVerdict: '',
      report: '',
      model: 'testfakeb-chat',
      transport: 'testfake',
    },
  ];
  // A later useful verdict of the same reviewer identity supersedes verdict-less attempts, so the
  // current attempt must be verdict-less too for the round to stay undecided.
  const current = reviewRow({
    attemptId: 'current', queuedAt: t(8), startedAt: t(8), attempts, reportVerdict: '', report: '',
  });
  const plan = planFor({ rows: [materialRow(), current] });
  assert.equal(plan.states.code, 'unknown');
  assert.equal(plan.payload.code.stateReason, 'no_verdict');
});

test('a retried job whose surviving attempts carry verdicts stays decided', () => {
  const attempts = [
    {
      attemptId: 'att-1',
      status: 'completed',
      startedAt: t(3),
      finishedAt: t(4),
      reportVerdict: 'PASS',
      reviewSubject: 'code',
      reviewSubjectSource: 'explicit',
      model: 'testfakeb-chat',
      transport: 'testfake',
    },
  ];
  const current = reviewRow({ attemptId: 'att-2', queuedAt: t(8), startedAt: t(8), attempts });
  const plan = planFor({ rows: [materialRow(), current] });
  assert.equal(plan.states.code, 'passed');
});

test('a trimmed attempt history settles unknown with the contract reason', () => {
  const archived = [];
  for (let index = 0; index < 20; index += 1) {
    archived.push({
      attemptId: `archived-${index}`,
      status: 'completed',
      queuedAt: t(index + 1),
      startedAt: t(index + 1),
      finishedAt: t(index + 1),
      reportVerdict: 'PASS',
      verifyRequired: false,
      reviewSubject: 'code',
      reviewSubjectSource: 'explicit',
      model: 'testfakeb-chat',
      transport: 'testfake',
    });
  }
  const current = reviewRow({ attemptId: 'current', queuedAt: t(30), startedAt: t(30), attempts: archived });
  const plan = planFor({ rows: [materialRow(), current] });
  assert.equal(plan.states.code, 'unknown');
  assert.equal(plan.payload.code.stateReason, 'history_truncated');
  assert.equal(plan.payload.code.truncated, true);
  assert.equal(plan.history.complete, true, 'the trimmed own-leaf history is the live builder\'s call');
});

test('a missing job and a job without a verdict are different states', () => {
  assert.equal(planFor({ rows: [materialRow()] }).states.code, 'none');
  const noVerdict = reviewRow({ reportVerdict: '', report: 'a one-liner' });
  assert.equal(planFor({ rows: [materialRow(), noVerdict] }).states.code, 'unknown');
});

// --- never a downgrade -------------------------------------------------------

test('a stored decided subject is preserved when the retained history reads poorer', () => {
  const stored = storedReviewAsLiveWroteIt([materialRow(), reviewRow()]);
  assert.equal(stored.code.state, 'passed');
  const plan = planFor({ todo: { review: stored }, rows: [unattributedArchivedReview()] });
  // The review is no longer attributable, so the poorer recomputation would say
  // `none`. The stored `passed` wins and is never sent to the writer.
  assert.equal(plan.payload.code, undefined);
  assert.equal(plan.subjects.code.action, 'preserved');
  assert.equal(plan.states.code, 'passed');
  assert.deepEqual(plan.forcedSubjects, []);
  // Only a subject that carries no claim of its own still refreshes.
  assert.equal(plan.payload.plan.state, 'none');
  assert.equal(plan.action, 'write');
});

test('a leaf whose every subject is decided is not written again at all', () => {
  const stored = storedReviewAsLiveWroteIt([
    materialRow(),
    reviewRow(),
    reviewRow({ reviewSubject: 'plan', reviewSubjectSource: 'explicit', queuedAt: t(11), startedAt: t(11) }),
  ]);
  assert.equal(stored.code.state, 'passed');
  assert.equal(stored.plan.state, 'passed');
  const plan = planFor({ todo: { review: stored }, rows: [unattributedArchivedReview()] });
  assert.equal(plan.action, 'preserved');
  assert.equal(plan.payload.code, undefined);
  assert.equal(plan.payload.plan, undefined);
  assert.equal(plan.states.code, 'passed');
  assert.equal(plan.states.plan, 'passed');
});

test('a stored unknown subject is replaced by a recomputed passed', () => {
  const stored = storedReviewAsLiveWroteIt([materialRow(), reviewRow({ reportVerdict: '', report: '' })]);
  assert.equal(stored.code.state, 'unknown');
  const plan = planFor({ todo: { review: stored }, rows: [materialRow(), reviewRow()] });
  assert.equal(plan.action, 'write');
  assert.equal(plan.states.code, 'passed');
});

test('a none the live path already wrote is not rewritten by the rollout gate', () => {
  const stored = storedReviewAsLiveWroteIt([]);
  assert.equal(stored.code.state, 'none');
  const plan = planFor({ todo: { review: stored }, rows: [unattributedArchivedReview()] });
  assert.equal(plan.states.code, 'none');
  assert.equal(plan.states.plan, 'none');
  assert.equal(plan.action, 'unchanged');
  assert.deepEqual(plan.forcedSubjects, []);
});

// --- operator behaviour against the real store -------------------------------

test('dry-run writes nothing at all: not the document, not a checkpoint, not a backup', async () => {
  const project = makeProject('dry-run');
  const todo = storeTodo(project);
  storeReviewRow(project, todo);
  const documentPath = todosDocumentPath(ISOLATED_DATA_DIR, project);
  const before = fs.readFileSync(documentPath, 'utf8');

  const result = await runTodoReviewBackfill({ dataDir: ISOLATED_DATA_DIR, workspaceFolder: project });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.summary.planned, 1);
  assert.equal(result.todos[0].states.code, 'passed');
  assert.equal(fs.readFileSync(documentPath, 'utf8'), before);
  assert.equal(fs.existsSync(resolveTodoReviewBackfillCheckpointPath(ISOLATED_DATA_DIR)), false);
  assert.equal(fs.existsSync(path.join(ISOLATED_DATA_DIR, 'backups')), false);
  assert.equal(result.backupPath, '');
  assert.equal(readStoreTodo(project, todo.id).review, undefined);
});

test('apply persists exactly what the dry run planned, then stays idempotent', async () => {
  const project = makeProject('apply');
  const reviewed = storeTodo(project, { title: 'Reviewed leaf' });
  storeReviewRow(project, reviewed);
  const failedTodo = storeTodo(project, { title: 'Failed leaf' });
  storeReviewRow(project, failedTodo, { reportVerdict: 'FAIL', report: 'TASK: review\nVERDICT: FAIL' });
  const documentPath = todosDocumentPath(ISOLATED_DATA_DIR, project);

  const dry = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    checkpointPath: checkpointFor('apply-dry'),
  });
  assert.equal(dry.summary.considered, 2);
  assert.equal(dry.summary.bySubjectState.code.passed, 1);
  assert.equal(dry.summary.bySubjectState.code.failed, 1);

  const applied = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('apply'),
  });
  assert.equal(applied.summary.written, 2);
  assert.equal(applied.checkpoint.complete, true);
  assert.equal(fs.existsSync(checkpointFor('apply')), false, 'a complete pass clears the checkpoint');

  for (const plan of dry.todos) {
    const persisted = readStoreTodo(project, plan.todoId);
    for (const subject of ['code', 'plan']) {
      assert.equal(persisted.review[subject].state, plan.states[subject], `${plan.todoId} ${subject}`);
    }
  }

  const rerun = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('apply'),
  });
  assert.equal(rerun.summary.written, 0);
  assert.equal(rerun.summary.unchanged, 2);
  assert.deepEqual(rerun.summary.bySubjectState, dry.summary.bySubjectState);

  // What the dry run counted is what the store holds, and a no-op pass did not
  // rewrite the document again.
  const items = loadTodosData(ISOLATED_DATA_DIR, project).items;
  assert.deepEqual(tallyPersistedStates(items).code, dry.summary.bySubjectState.code);
  assert.deepEqual(tallyPersistedStates(items).plan, dry.summary.bySubjectState.plan);
  const afterFirstWrite = fs.readFileSync(documentPath, 'utf8');
  // Whitespace-insensitive: the todo store is written compact.
  assert.equal(/"state":\s*"passed"/.test(afterFirstWrite), true);
});

test('a backfill write never touches status, changelog, order or the item CAS token', async () => {
  const project = makeProject('untouched');
  const reviewed = storeTodo(project, { title: 'Has a review' });
  storeReviewRow(project, reviewed);
  const plain = storeTodo(project, { title: 'Never reviewed' });
  const fieldsOf = (item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    status: item.status,
    updatedAt: item.updatedAt,
    parentId: item.parentId || '',
    siblingIndex: item.siblingIndex,
    changelog: item.changelog || [],
  });
  const before = loadTodosData(ISOLATED_DATA_DIR, project).items.map(fieldsOf);

  const applied = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('untouched'),
  });
  assert.equal(applied.summary.written, 2);
  // The rollback point is a logical export of the pre-run todos, not a storage file copy.
  const backup = JSON.parse(fs.readFileSync(applied.backupPath, 'utf8'));
  assert.equal(backup.kind, 'cretli-todos-logical-snapshot');
  assert.equal(backup.workspaceFolder, project);
  assert.deepEqual(backup.document.items.map(fieldsOf), before);
  assert.equal(backup.document.items.find((row) => row.id === plain.id).review, undefined);
  assert.equal(applied.todosDocumentPath, undefined);

  const after = loadTodosData(ISOLATED_DATA_DIR, project);
  assert.deepEqual(after.items.map(fieldsOf), before);
  assert.deepEqual(after.items.map((row) => row.id), before.map((row) => row.id));
  assert.equal(after.items.find((row) => row.id === reviewed.id).review.code.state, 'passed');
  assert.equal(after.items.find((row) => row.id === plain.id).review.code.state, 'none');
  assert.equal(after.items.find((row) => row.id === plain.id).review.aggregate, undefined,
    'a leaf never gets a container rollup');
});

test('a rejected logical export prevents every backfill write', async () => {
  const project = makeProject('snapshot-failure');
  const todo = storeTodo(project);
  storeReviewRow(project, todo);
  const checkpointPath = checkpointFor('snapshot-failure');
  const documentPath = todosDocumentPath(ISOLATED_DATA_DIR, project);
  const before = fs.readFileSync(documentPath, 'utf8');
  let writes = 0;
  await assert.rejects(runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR, workspaceFolder: project, apply: true, checkpointPath,
    deps: {
      exportSnapshot: async () => { throw new Error('snapshot unavailable'); },
      writeReview: async () => { writes += 1; },
    },
  }), /snapshot unavailable/);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(documentPath, 'utf8'), before);
  assert.equal(fs.existsSync(checkpointPath), false);
});

test('a write failure keeps the leaf pending and the next run resumes from the checkpoint', async () => {
  const project = makeProject('resume');
  const todos = [
    storeTodo(project, { title: 'First' }),
    storeTodo(project, { title: 'Second' }),
    storeTodo(project, { title: 'Third' }),
  ];
  for (const todo of todos) storeReviewRow(project, todo);
  const blocker = todos[1].id;
  const writtenIds = [];
  const failingWriter = (dataDir, workspaceFolder, id, snapshot) => {
    if (id === blocker) {
      const err = new Error('simulated store failure');
      err.code = 'IO_ERROR';
      throw err;
    }
    writtenIds.push(id);
    return writeTodoReview(dataDir, workspaceFolder, id, snapshot);
  };

  const interrupted = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('resume'),
    checkpointEvery: 1,
    deps: { writeReview: failingWriter },
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.summary.written, 2);
  assert.equal(interrupted.summary.failed, 1);
  assert.equal(interrupted.failures[0].todoId, blocker);
  assert.deepEqual([...writtenIds].sort(), todos.filter((todo) => todo.id !== blocker).map((todo) => todo.id).sort());
  assert.equal(fs.existsSync(checkpointFor('resume')), true);
  assert.ok(interrupted.backupPath && fs.existsSync(interrupted.backupPath), 'the first write took its backup');
  const checkpointDoc = JSON.parse(fs.readFileSync(checkpointFor('resume'), 'utf8'));
  assert.deepEqual([...checkpointDoc.processed].sort(), writtenIds.sort());
  assert.equal(checkpointDoc.processed.includes(blocker), false);
  assert.equal(checkpointDoc.workspaceFolder, project);

  const resumed = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('resume'),
  });
  assert.equal(resumed.summary.resumed, 2);
  assert.equal(resumed.summary.written, 1);
  assert.equal(resumed.checkpoint.complete, true);
  assert.equal(fs.existsSync(checkpointFor('resume')), false, 'a finished rollout drops the checkpoint');
  for (const todo of todos) {
    assert.equal(readStoreTodo(project, todo.id).review.code.state, 'passed');
  }
});

test('losing the attribution of a reviewed leaf preserves its stored passed', async () => {
  const project = makeProject('poorer-history');
  const todo = storeTodo(project);
  const review = storeReviewRow(project, todo);
  const first = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('poorer-history'),
  });
  assert.equal(first.todos[0].states.code, 'passed');

  // The archived job lost its `leafId`: the review is no longer attributable.
  updateDelegationRecord(review.id, {
    leafId: '',
    sourceText: '',
    archivedAt: new Date().toISOString(),
  });
  const rows = listDelegationsForWorkspace(project, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(rows.find((row) => row.id === review.id).leafId, '');

  const second = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('poorer-history'),
  });
  assert.equal(second.todos[0].subjects.code.action, 'preserved');
  assert.equal(second.todos[0].states.code, 'passed');
  assert.equal(second.summary.written, 0);
  assert.equal(second.summary.preserved, 1);
  assert.equal(second.checkpoint.removed, true);
  assert.equal(readStoreTodo(project, todo.id).review.code.state, 'passed');
});

test('retention archiving a backfilled leaf does not degrade it on the next live sync', async () => {
  const project = makeProject('post-archive');
  const todo = storeTodo(project);
  const at = new Date().toISOString();
  const impl = createDelegationRecord({
    parentChatId: `store-parent-${nextId('p')}`,
    workspaceFolder: project,
    executor: { transport: 'testfake', model: 'gpt-5' },
    assignment: 'implement',
    executionMode: 'agent',
    leafId: todo.id,
    status: 'completed',
  });
  updateDelegationRecord(impl.id, {
    startedAt: at,
    finishedAt: at,
    lastTransitionAt: at,
    report: 'TASK: implement\nVERDICT: PASS',
    reportVerdict: 'PASS',
  });
  const longBody = `${'detail '.repeat(600)}\nTASK: review\nVERDICT: PASS`;
  const review = storeReviewRow(project, todo, { report: longBody });
  assert.ok(longBody.length > 2000);

  const applied = await runTodoReviewBackfill({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    apply: true,
    checkpointPath: checkpointFor('post-archive'),
  });
  assert.equal(applied.todos[0].states.code, 'passed');
  const before = readStoreTodo(project, todo.id).review;
  assert.equal(before.code.state, 'passed');

  const retention = await applyDelegationRetention({ now: Date.now() + 45 * 24 * 60 * 60 * 1000 });
  assert.ok(retention.archived >= 2, `expected the run to archive its rows, got ${retention.archived}`);
  const archived = getDelegationById(review.id);
  assert.equal(archived.report.length, 2000);
  assert.equal(archived.report.includes('VERDICT'), false, 'the retained body lost the verdict line');
  assert.equal(archived.sourceText, '');
  assert.equal(archived.reportVerdict, 'PASS', 'the verdict itself is durable');
  assert.ok(getDelegationById(impl.id).archivedAt, 'the implement job is archived too');

  const sync = (await syncTodoReviewTarget({
    workspaceFolder: project,
    todoId: todo.id,
    dataDir: ISOLATED_DATA_DIR,
  }));
  assert.equal(sync.changed, false, 'a live sync after archival must not rewrite the snapshot');
  const after = readStoreTodo(project, todo.id);
  assert.equal(after.review.code.state, 'passed');
  assert.equal(after.review.generation, before.generation);
  assert.equal(after.updatedAt, todo.updatedAt);
});

test('the CLI plans on dry-run, applies the same states, and refuses a missing workspace', () => {
  const project = makeProject('cli');
  const reviewed = storeTodo(project, { title: 'CLI reviewed' });
  storeReviewRow(project, reviewed);
  const legacySubject = storeTodo(project, { title: 'CLI legacy subject' });
  // The shape `delegation_start` gives a review whose subject was never declared.
  storeReviewRow(project, legacySubject, {
    reviewSubject: 'other',
    reviewSubjectSource: 'default',
  });
  const documentPath = todosDocumentPath(ISOLATED_DATA_DIR, project);
  const before = fs.readFileSync(documentPath, 'utf8');
  const script = path.join(PROJECT_ROOT, 'scripts', 'backfill-todo-review.js');
  const run = (extraArgs) => execFileSync(
    process.execPath,
    [script, '--workspace', project, '--data-dir', ISOLATED_DATA_DIR, ...extraArgs],
    { encoding: 'utf8', env: { ...process.env, CRETLI_DATA_DIR: ISOLATED_DATA_DIR } },
  );

  const dryText = run([]);
  assert.equal(fs.readFileSync(documentPath, 'utf8'), before, 'the default mode wrote nothing');
  assert.equal(fs.existsSync(resolveTodoReviewBackfillCheckpointPath(ISOLATED_DATA_DIR)), false);
  assert.match(dryText, /mode:\s+dry-run \(nothing written\)/);
  assert.match(dryText, /^ {2}code: none=1 pending=0 passed=1 failed=0 manual=0 stale=0 unknown=0$/m);
  assert.match(dryText, /^ {2}plan: none=2 pending=0 passed=0 failed=0 manual=0 stale=0 unknown=0$/m);
  assert.match(dryText, /actions: considered=2 to-write=2 unchanged=0/);
  assert.match(dryText, /rollback:/);

  const dryJson = JSON.parse(run(['--dry-run', '--json']));
  const applied = JSON.parse(run(['--apply', '--json']));
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.summary.written, dryJson.summary.planned);
  assert.ok(applied.backupPath.startsWith(ISOLATED_DATA_DIR));
  assert.equal(fs.existsSync(applied.backupPath), true);
  for (const plan of dryJson.todos) {
    const persisted = readStoreTodo(project, plan.todoId);
    for (const subject of ['code', 'plan']) {
      assert.equal(persisted.review[subject].state, plan.states[subject], `${plan.todoId} ${subject}`);
    }
  }
  // A job that never declared a subject can never certify a code review.
  assert.equal(readStoreTodo(project, legacySubject.id).review.code.state, 'none');
  assert.equal(readStoreTodo(project, legacySubject.id).review.other.state, 'passed');
  assert.equal(fs.existsSync(resolveTodoReviewBackfillCheckpointPath(ISOLATED_DATA_DIR)), false,
    'a complete pass leaves no checkpoint behind');

  const second = JSON.parse(run(['--apply', '--json']));
  assert.equal(second.summary.written, 0);
  assert.equal(second.summary.unchanged, 2);

  assert.equal(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    .includes('--workspace DIR'), true);
  assert.throws(
    () => execFileSync(process.execPath, [script, '--data-dir', ISOLATED_DATA_DIR], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, CRETLI_DATA_DIR: ISOLATED_DATA_DIR },
    }),
    (error) => {
      assert.equal(error.status, 2);
      return true;
    },
  );
});

test('the rollout ships no private paths or maintainer names', () => {
  // Only the shipped files: this test's own patterns quote the names it forbids.
  const relatives = [
    'scripts/backfill-todo-review.js',
    'lib/todo-review-backfill.js',
  ];
  for (const relative of relatives) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /\/home\/[a-z0-9_-]+\//i, relative);
    assert.doesNotMatch(source, /\b(Synology|Obsidian|cretli-worktrees)\b/, relative);
    assert.doesNotMatch(source, /\b(192\.168\.|10\.0\.)/, relative);
    assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/, relative);
  }
});
