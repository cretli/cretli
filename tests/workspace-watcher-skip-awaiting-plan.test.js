import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideWorkspaceWatcherAction, tickWorkspaceWatcher } from '../lib/workspace-watcher.js';
import {
  evaluateWorkspaceWatcherGuardrails,
  isWorkspaceWatcherPlanAwaitingApproval,
  resolveWorkspaceWatcherPlanGateInputs,
} from '../lib/workspace-watcher-guardrails.js';
import { addTodo, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import {
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const APPROVED = { markdown: '# plan', approvedAt: '2025-12-31T00:00:00.000Z' };
const FEEDBACK = { kind: 'report', rootId: 'root', reportId: 'rep' };

/** @param {string} id @param {Record<string, any>} [extra] */
function leaf(id, extra = {}) {
  return { id, title: id, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra };
}

/** Feedback-derived leaf without an approved plan (gated, waits once requested); older, so it ranks first. */
const waiting = (/** @type {string} */ id, extra = {}) => leaf(id, { feedbackOrigin: FEEDBACK, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z', ...extra });

/** @param {Record<string, any>[]} items @param {Record<string, any>} [watcher] @param {Record<string, any>} [input] */
function decide(items, watcher = {}, input = {}) {
  const requests = Object.fromEntries(items.filter((i) => i.feedbackOrigin).map((i) => [i.id, new Date(NOW).toISOString()]));
  return decideWorkspaceWatcherAction({
    watcher: {
      mode: 'autopilot',
      enabled: true,
      policy: { maxParallel: 5, cooldownMs: 0, maxCyclesPerDay: 50, requirePlanApproval: true, ...watcher.policy },
      planRequests: requests,
      ...watcher,
    },
    snapshot: { readyTodoCount: items.length, readyLeaves: items, items, errors: [] },
    now: NOW,
    ...input,
  });
}

test('a waiting head candidate is skipped and the next eligible one starts', () => {
  const decision = decide([waiting('w1'), leaf('b1', { plan: APPROVED })]);
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'b1');
  assert.deepEqual(decision.rejections, [{ id: 'w1', filter: 'awaiting_plan_approval' }]);
});

test('every candidate waiting yields wait_plan_approval naming all of them', () => {
  const decision = decide([waiting('w1'), waiting('w2')]);
  assert.equal(decision.kind, 'wait_plan_approval');
  assert.equal(decision.reason, 'awaiting_plan_approval');
  assert.equal(decision.nextTodoId, 'w1');
  assert.deepEqual(decision.rejections.map((r) => r.id), ['w1', 'w2']);
});

test('a global guardrail refusal still ends the decision immediately', () => {
  const decision = decide([waiting('w1'), leaf('b1', { plan: APPROVED })], {
    lastCycleAt: new Date(NOW - 1000).toISOString(),
    policy: { cooldownMs: 600_000 },
  });
  assert.equal(decision.kind, 'wait_cooldown');
});

test('an eligible candidate behind more than 10 waiting todos still starts', () => {
  const items = Array.from({ length: 12 }, (_, i) => waiting(`w${i}`));
  items.push(leaf('b1', { plan: APPROVED }));
  const decision = decide(items);
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'b1');
  assert.equal(decision.rejections.length, 12);
});

test('many waiting todos and nothing else yields wait_plan_approval', () => {
  const decision = decide(Array.from({ length: 12 }, (_, i) => waiting(`w${i}`)));
  assert.equal(decision.kind, 'wait_plan_approval');
  assert.equal(decision.nextTodoId, 'w0');
});

test('a plan_rereview candidate at the head still wins and is not skipped', () => {
  const decision = decide([waiting('w1', { plan: { markdown: '# draft' } }), leaf('b1', { plan: APPROVED })], {}, {
    planReviewResolver: () => ({ state: 'stale', stateReason: 'plan_edited_after_review' }),
  });
  assert.equal(decision.kind, 'plan_gate');
  assert.equal(decision.reason, 'plan_rereview');
  assert.equal(decision.nextTodoId, 'w1');
  assert.equal(decision.rejections, undefined);
});

test('observe mode does not run the guardrail loop', () => {
  const decision = decide([waiting('w1'), leaf('b1', { plan: APPROVED })], { mode: 'observe' });
  assert.equal(decision.kind, 'observe_ready');
});

test('a candidate with a full pool is never evaluated or started', () => {
  const items = [
    waiting('w1', { executionMode: 'project' }),
    leaf('full', { plan: APPROVED, executionMode: 'worktree' }),
    leaf('free', { plan: APPROVED, executionMode: 'project' }),
  ];
  const policy = { maxParallelWorktree: 1, maxParallelProject: 1 };
  const full = decide(items, { policy }, { activeCycleCounts: { worktree: 1, project: 0 } });
  assert.equal(full.kind, 'start_cycle');
  assert.equal(full.nextTodoId, 'free');
  const allFull = decide([waiting('w1', { executionMode: 'project' }), leaf('full', { plan: APPROVED, executionMode: 'worktree' })],
    { policy }, { activeCycleCounts: { worktree: 1, project: 0 } });
  assert.equal(allFull.kind, 'wait_plan_approval');
  const nobodyWaits = decide([leaf('full', { plan: APPROVED, executionMode: 'worktree' })],
    { policy }, { activeCycleCounts: { worktree: 1, project: 0 } });
  assert.equal(nobodyWaits.kind, 'wait_active');
});

test('plan gate inputs, predicate and guardrail agree on every branch', () => {
  const base = { mode: 'autopilot', policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 50 } };
  const standing = (id) => ({ planRequests: { [id]: new Date(NOW).toISOString() } });
  const rows = [
    { name: 'gate off', watcher: { ...base, policy: { ...base.policy, requirePlanApproval: false } }, todo: leaf('t'), gated: false, awaiting: false, kind: 'allowed' },
    { name: 'approved', watcher: base, todo: leaf('t', { plan: APPROVED }), gated: true, awaiting: false, kind: 'allowed' },
    { name: 'missing', watcher: base, todo: leaf('t'), gated: true, awaiting: false, kind: 'plan_gate', reason: 'plan_missing' },
    { name: 'not approved', watcher: base, todo: leaf('t', { plan: { markdown: '# draft' } }), gated: true, awaiting: false, kind: 'plan_gate', reason: 'plan_not_approved' },
    { name: 'standing', watcher: { ...base, ...standing('t') }, todo: leaf('t', { plan: { markdown: '# draft' } }), gated: true, awaiting: true, kind: 'wait_plan_approval' },
    { name: 'feedback standing', watcher: { ...base, ...standing('t') }, todo: waiting('t'), gated: true, awaiting: true, kind: 'wait_plan_approval' },
  ];
  for (const row of rows) {
    const items = [row.todo];
    const gate = resolveWorkspaceWatcherPlanGateInputs({ watcher: row.watcher, items, todo: row.todo });
    assert.equal(gate.gated, row.gated, `${row.name}: gated`);
    assert.equal(isWorkspaceWatcherPlanAwaitingApproval({ watcher: row.watcher, items, todo: row.todo }), row.awaiting, `${row.name}: awaiting`);
    const guard = evaluateWorkspaceWatcherGuardrails({ watcher: row.watcher, pickedTodo: row.todo, items, now: NOW });
    assert.equal(guard.kind, row.kind, `${row.name}: kind`);
    if (row.reason) assert.equal(guard.reason, row.reason, `${row.name}: reason`);
  }
  const rereview = evaluateWorkspaceWatcherGuardrails({
    watcher: { ...base, ...standing('t') }, pickedTodo: leaf('t', { plan: { markdown: '# d' } }), items: [leaf('t', { plan: { markdown: '# d' } })], now: NOW,
    planReviewResolver: () => ({ state: 'stale', stateReason: 'plan_edited_after_review' }),
  });
  assert.equal(rereview.reason, 'plan_rereview');
  assert.equal(rereview.allowed, true);
  // planApprovalScope 'root': the standing request is looked up by the root id.
  const root = { id: 'root-1', status: 'doing', body: '## plan', plan: { markdown: '# p' } };
  const child = leaf('c1', { parentId: 'root-1' });
  const scoped = { ...base, policy: { ...base.policy, planApprovalScope: 'root' }, ...standing('root-1') };
  const scopedGate = resolveWorkspaceWatcherPlanGateInputs({ watcher: scoped, items: [root, child], todo: child });
  assert.equal(scopedGate.planTargetId, 'root-1');
  assert.equal(scopedGate.hasStandingRequest, true);
});

function freshWorkspace(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cr-skip-plan-${name}-`));
  const dataDir = path.join(root, 'data');
  const cwd = path.join(root, 'ws');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { dataDir, cwd };
}

test('plan_approval notifies once per waiting todo, including skipped ones', async () => {
  const { dataDir, cwd } = freshWorkspace('notify');
  const key = normalizeWorkspaceFolder(cwd);
  const first = addTodo(dataDir, cwd, { title: 'first', status: 'ready' }).item;
  const second = addTodo(dataDir, cwd, { title: 'second', status: 'ready' }).item;
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const stamp = new Date(NOW).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({ planRequests: { [first.id]: stamp, [second.id]: stamp } }), { dataDir });
  const seen = [];
  const notify = (input) => { seen.push(input); return true; };
  const t1 = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: NOW, token: 'skip-plan', notify });
  await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: NOW + 1000, token: 'skip-plan', notify });
  assert.equal(t1.decision.kind, 'wait_plan_approval');
  const pushes = seen.filter((row) => String(row.tag).startsWith(`cretli-watcher-plan_approval-${key}`));
  assert.equal(pushes.length, 2, 'one push per waiting todo, none repeated');
  const bodies = pushes.map((row) => row.body).join('\n');
  assert.ok(bodies.includes(first.id.slice(0, 8)) && bodies.includes(second.id.slice(0, 8)));
  // Approving the plan of one todo releases its slot in the set (no longer waiting).
  updateTodo(dataDir, cwd, first.id, { plan: { markdown: '# p', approvedAt: stamp } });
  await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: NOW + 2000, token: 'skip-plan', notify });
  assert.equal(seen.filter((row) => String(row.tag).startsWith(`cretli-watcher-plan_approval-${key}`)).length, 2);
});
