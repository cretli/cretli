/** Proactive planning must not treat ready leaves that wait for plan approval as runnable work. */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWorkspaceWatcherAction } from '../lib/workspace-watcher.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const idea = (id) => ({ id, status: 'idea', title: `Idea ${id}`, description: 'A sufficiently detailed proposal for a feature.', createdAt: '2026-01-01T00:00:00Z' });
const draftedLeaf = { id: 'draft-1', status: 'ready', title: 'Drafted', plan: { markdown: 'draft', approvedAt: '' } };
const policy = { requirePlanApproval: true, proactivePlanning: { enabled: true, maxPerDay: 2, maxParallel: 1, minBodyChars: 20 } };
const decide = (items, readyLeaves, watcher = {}) => decideWorkspaceWatcherAction({
  watcher: { mode: 'autopilot', policy, ...watcher },
  snapshot: { readyTodoCount: readyLeaves.length, readyLeaves, items, activeAgentCount: 0, errors: [] },
  now: NOW,
});

test('a ready leaf waiting for plan approval does not stop further drafts until maxPerDay', () => {
  const items = [draftedLeaf, idea('idea-2')];
  const first = decide(items, [draftedLeaf]);
  assert.equal(first.kind, 'plan_gate');
  assert.equal(first.proactivePlanning, true);
  assert.equal(first.nextTodoId, 'idea-2');
  const today = [new Date(NOW - 60_000).toISOString(), new Date(NOW - 30_000).toISOString()];
  const capped = decide(items, [draftedLeaf], { proactivePlanningRuns: today });
  assert.notEqual(capped.proactivePlanning, true);
  assert.equal(items[0].status, 'ready');
});

test('a ready leaf with an open gate still counts as runnable work', () => {
  const approved = { ...draftedLeaf, id: 'approved-1', plan: { markdown: 'plan', approvedAt: '2026-11-01' } };
  const result = decide([approved, idea('idea-2')], [approved]);
  assert.notEqual(result.proactivePlanning, true);
  assert.notEqual(result.kind, 'idle_no_work');
});

test('with only waiting leaves and no eligible idea the decision is not idle_no_work', () => {
  const result = decide([draftedLeaf], [draftedLeaf]);
  assert.notEqual(result.reason, 'no_ready_work');
});

test('a runnable ready leaf next to a waiting one is chosen over proactive planning', () => {
  const approved = { id: 'run-1', status: 'ready', title: 'Runnable', plan: { markdown: 'plan', approvedAt: '2026-11-01' } };
  const items = [draftedLeaf, approved, idea('idea-2')];
  const result = decide(items, [draftedLeaf, approved]);
  assert.notEqual(result.proactivePlanning, true);
  assert.notEqual(result.reason, 'proactive_planning');
});

test('with requirePlanApproval off a ready leaf is runnable work and never waiting', () => {
  const plain = { id: 'plain-1', status: 'ready', title: 'No plan needed' };
  const off = { ...policy, requirePlanApproval: false };
  const result = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', policy: off },
    snapshot: { readyTodoCount: 1, readyLeaves: [plain], items: [plain, idea('idea-2')], activeAgentCount: 0, errors: [] },
    now: NOW,
  });
  assert.notEqual(result.proactivePlanning, true);
});
