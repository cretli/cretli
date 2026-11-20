import './helpers/isolated-data-dir.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTodo, getTodo, updateTodo } from '../lib/persist/todos-store.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import {
  PLAN_REVIEW_REQUIRED_REVIEWERS,
  TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS,
  blockTodoForInsufficientReviewers,
  clearInsufficientReviewersBlock,
  evaluatePlanReviewerAvailability,
  runPlanReviewerPreflight,
} from '../lib/plan-review-preflight.js';

const ready = (id) => ({ id, enabled: true, ready: true, can_delegate: true });
const favorites = (...ids) => ({
  favorites_configured: true,
  items: ids.map((id) => ({ id, roles: ['review'], cost_tier: 1, quality_tier: 3, speed_tier: 3, favorite: true })),
});

function availability({ harnesses, models, coordinatorModel }) {
  const list = harnesses.map(ready);
  return evaluatePlanReviewerAvailability({
    harnesses: list,
    modelsByHarness: models,
    coordinatorModel,
    history: buildModelPickHistory({ role: 'review', harnesses: list, delegations: [], lockouts: [], planLimits: [], now: Date.now() }),
  });
}

// Diagnosis (stage 1): `diverse` yields one reviewer per harness, so the number
// of qualifying reviewers equals the number of harnesses with an eligible
// review favorite. Rotation band ordering and the coordinator's harness do not
// change the count.
test('one ready harness yields one reviewer even with several favorites (diverse = one per harness)', () => {
  const out = availability({
    harnesses: ['testfake'],
    models: { testfake: favorites('fake-1', 'fake-2', 'fake-3') },
  });
  assert.equal(out.available, 1);
  assert.equal(out.required, PLAN_REVIEW_REQUIRED_REVIEWERS);
  assert.equal(out.satisfiable, false);
});

test('two ready harnesses yield two reviewers regardless of the coordinator harness', () => {
  const models = { testfake: favorites('fake-1'), testfakeb: favorites('fakeb-1') };
  const noCoordinator = availability({ harnesses: ['testfake', 'testfakeb'], models });
  assert.equal(noCoordinator.available, 2);
  assert.equal(noCoordinator.satisfiable, true);
  // Coordinator on harness A, then on harness B: its model is excluded, but the
  // other harness keeps its reviewer, so each side still has a candidate there;
  // when each harness has a second favorite the pair stays complete.
  const wide = { testfake: favorites('fake-1', 'fake-2'), testfakeb: favorites('fakeb-1', 'fakeb-2') };
  for (const coordinatorModel of ['fake-1', 'fakeb-1']) {
    const out = availability({ harnesses: ['testfake', 'testfakeb'], models: wide, coordinatorModel });
    assert.equal(out.available, 2, `coordinator ${coordinatorModel}`);
    assert.ok(!out.reviewers.some((row) => row.model === coordinatorModel), 'coordinator base model is the only exclusion');
  }
});

test('documented exclusion: a harness whose only favorite is the coordinator model drops out', () => {
  const models = { testfake: favorites('fake-1'), testfakeb: favorites('fakeb-1') };
  const out = availability({ harnesses: ['testfake', 'testfakeb'], models, coordinatorModel: 'fake-1' });
  assert.equal(out.available, 1);
  assert.equal(out.satisfiable, false);
  // `auto` is no exclusion.
  assert.equal(availability({ harnesses: ['testfake', 'testfakeb'], models, coordinatorModel: 'auto' }).available, 2);
});

test('insufficient reviewers: blockedReason set once, one notification, status change clears it', async () => {
  const folder = ISOLATED_DATA_DIR;
  const created = await addTodo(ISOLATED_DATA_DIR, folder, { title: 'plan review target', status: 'idea' });
  const todo = created.item || created;
  const notifications = [];
  const input = {
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: folder,
    todoId: todo.id,
    available: 1,
    required: 2,
    notify: (payload) => notifications.push(payload),
    noticeDeps: {},
  };
  assert.equal(await blockTodoForInsufficientReviewers(input), true);
  assert.equal(await blockTodoForInsufficientReviewers(input), false, 'repeat does not rewrite or notify');
  const blocked = await getTodo(ISOLATED_DATA_DIR, folder, todo.id);
  assert.equal(blocked.blockedReason, TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /only 1 qualify/);
  assert.equal(blocked.review, undefined, 'todo.review is never written here');

  // A status change clears the block.
  await updateTodo(ISOLATED_DATA_DIR, folder, todo.id, { expectedUpdatedAt: blocked.updatedAt, status: 'ready' });
  assert.equal((await getTodo(ISOLATED_DATA_DIR, folder, todo.id)).blockedReason || '', '');

  // A successful review start clears it without a status change.
  await blockTodoForInsufficientReviewers({ ...input, notify: () => {} });
  assert.equal((await getTodo(ISOLATED_DATA_DIR, folder, todo.id)).blockedReason, TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS);
  assert.equal(await clearInsufficientReviewersBlock({ dataDir: ISOLATED_DATA_DIR, workspaceFolder: folder, todoId: todo.id }), true);
  assert.equal((await getTodo(ISOLATED_DATA_DIR, folder, todo.id)).blockedReason || '', '');
});

test('a picker exception is an unknown result, not a conclusive zero (fail open)', () => {
  const out = evaluatePlanReviewerAvailability({
    harnesses: [ready('testfake')],
    modelsByHarness: { testfake: favorites('fake-1') },
    pick: () => { throw new Error('transient selector failure'); },
  });
  assert.equal(out.unknown, true);
  assert.equal(out.satisfiable, null);
  assert.match(out.error, /transient/);
  const refused = evaluatePlanReviewerAvailability({
    harnesses: [ready('testfake')],
    modelsByHarness: { testfake: favorites('fake-1') },
    pick: () => ({ ok: false, code: 'override_conflict', error: 'conflict' }),
  });
  assert.equal(refused.unknown, true, 'a non-"no candidate" refusal is not conclusive');
  const none = evaluatePlanReviewerAvailability({
    harnesses: [ready('testfake')],
    modelsByHarness: { testfake: favorites('fake-1') },
    pick: () => ({ ok: false, code: 'MODEL_UNAVAILABLE', error: 'none' }),
  });
  assert.equal(none.satisfiable, false, 'no candidate at all is conclusive');
  assert.equal(none.available, 0);
});

// End-to-end through runPlanReviewerPreflight, the way operator_plan_review_start
// calls it: `coordinatorModel` is `text(args.model)`, so an omitted model is ''
// and `auto` is the harness-default marker; both exclude nothing (upper bound).
test('runPlanReviewerPreflight: coordinator model comes from args.model; harness A vs B is irrelevant', async () => {
  const catalog = [ready('testfake'), ready('testfakeb')];
  const catalogModels = { testfake: favorites('fake-1', 'fake-2'), testfakeb: favorites('fakeb-1', 'fakeb-2') };
  const history = buildModelPickHistory({ role: 'review', harnesses: catalog, delegations: [], lockouts: [], planLimits: [], now: Date.now() });
  const run = (coordinatorModel) => runPlanReviewerPreflight({
    workspaceFolder: ISOLATED_DATA_DIR,
    coordinatorModel,
    deps: {
      listHarnessCatalog: async () => catalog,
      listHarnessModels: async ({ harness }) => catalogModels[harness],
      history,
    },
  });
  for (const omitted of ['', 'auto', 'AUTO']) {
    const out = await run(omitted);
    assert.equal(out.available, 2, `coordinator model "${omitted}"`);
    assert.equal(out.satisfiable, true);
  }
  const onA = await run('fake-1');
  const onB = await run('fakeb-1');
  assert.equal(onA.available, 2);
  assert.equal(onB.available, 2);
  assert.ok(!onA.reviewers.some((row) => row.model === 'fake-1'));
  assert.ok(!onB.reviewers.some((row) => row.model === 'fakeb-1'));
  assert.deepEqual(onA.reviewers.map((row) => row.harness).sort(), onB.reviewers.map((row) => row.harness).sort());
  // Harnesses with a single favorite: excluding the coordinator model drops that harness.
  catalogModels.testfake = favorites('fake-1');
  assert.equal((await run('fake-1')).available, 1);
  assert.equal((await run('')).available, 2, 'omitted model excludes nothing');
});
