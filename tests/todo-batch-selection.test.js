/**
 * Pure helpers for the bulk "integrate with agent" selection mode. These tests
 * feed raw list payload fixtures (no DOM), mirroring what `renderList` passes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchRequestIds,
  buildBatchSelection,
  canClearIntegrationLock,
  captureBatchScope,
  createLatestRequestGate,
  createOwnedPendingGuard,
  resolveResumeAgentNeed,
  describeBatchFailure,
  isBatchScopeCurrent,
  localizeBatchReason,
  resolveBatchControls,
  findBatchEntryForTodo,
  isActiveBatchStatus,
  isTerminalBatchStatus,
  parseBatchReason,
  pruneBatchSelection,
  resolveBatchToTrack,
  summarizeBatchEntries,
} from '../app_front/features/todo/todoBatchSelection.js';
import { isBatchSelectableItem } from '../app_front/features/todo/todoTreeView.js';

/** A small tree: p1 (ineligible) -> c1/c2 eligible, plus r2 (ineligible), r3 eligible. */
function fixture() {
  return [
    { id: 'p1', parentId: '', siblingIndex: 0, status: 'done', batchEligibility: { mode: 'none', reason: 'already_integrated' } },
    { id: 'c1', parentId: 'p1', siblingIndex: 0, batchEligibility: { mode: 'smart-merge', reason: '' } },
    { id: 'c2', parentId: 'p1', siblingIndex: 1, batchEligibility: { mode: 'verify', reason: '' } },
    { id: 'r2', parentId: '', siblingIndex: 1, batchEligibility: { mode: 'none', reason: 'busy' } },
    { id: 'r3', parentId: '', siblingIndex: 2, batchEligibility: { mode: 'verify', reason: '' } },
  ];
}

test('selectability follows the server batchEligibility mode only', () => {
  assert.equal(isBatchSelectableItem({ batchEligibility: { mode: 'smart-merge' } }), true);
  assert.equal(isBatchSelectableItem({ batchEligibility: { mode: 'verify' } }), true);
  assert.equal(isBatchSelectableItem({ batchEligibility: { mode: 'none', reason: 'busy' } }), false);
  assert.equal(isBatchSelectableItem({}), false);
  assert.equal(isBatchSelectableItem(null), false);
});

test('buildBatchSelection returns eligible visible rows in visible list order', () => {
  const { eligibleIds, eligibleSet } = buildBatchSelection({ items: fixture(), collapsedIds: [] });
  assert.deepEqual(eligibleIds, ['c1', 'c2', 'r3']);
  assert.deepEqual([...eligibleSet], ['c1', 'c2', 'r3']);
});

test('collapsed descendants are not part of the select-all set', () => {
  const { eligibleIds } = buildBatchSelection({ items: fixture(), collapsedIds: ['p1'] });
  assert.deepEqual(eligibleIds, ['r3']);
});

test('supports Set collapsed ids and missing items', () => {
  assert.deepEqual(buildBatchSelection({ items: fixture(), collapsedIds: new Set(['p1']) }).eligibleIds, ['r3']);
  assert.deepEqual(buildBatchSelection({}).eligibleIds, []);
  assert.deepEqual(buildBatchSelection().eligibleIds, []);
});

test('request ids follow visible list order, never click order', () => {
  const { eligibleIds } = buildBatchSelection({ items: fixture(), collapsedIds: [] });
  // Click order r3 -> c1 -> c2 must still be sent as c1, c2, r3.
  const selected = new Set(['r3', 'c1', 'c2']);
  assert.deepEqual(buildBatchRequestIds(selected, eligibleIds), ['c1', 'c2', 'r3']);
  assert.deepEqual(buildBatchRequestIds(new Set(['r3']), eligibleIds), ['r3']);
  assert.deepEqual(buildBatchRequestIds(null, eligibleIds), []);
});

test('select-all over eligible ids yields the eligible visible set verbatim', () => {
  const { eligibleIds, eligibleSet } = buildBatchSelection({ items: fixture(), collapsedIds: [] });
  assert.deepEqual(buildBatchRequestIds(eligibleSet, eligibleIds), eligibleIds);
});

test('pruneBatchSelection drops hidden or ineligible ids', () => {
  const { eligibleIds } = buildBatchSelection({ items: fixture(), collapsedIds: [] });
  const pruned = pruneBatchSelection(new Set(['c1', 'r2', 'gone', 'r3']), eligibleIds);
  assert.deepEqual([...pruned], ['c1', 'r3']);
  // Collapsing p1 removes c1/c2 from the eligible set and from the selection.
  const collapsed = buildBatchSelection({ items: fixture(), collapsedIds: ['p1'] });
  assert.deepEqual([...pruneBatchSelection(new Set(['c1', 'c2', 'r3']), collapsed.eligibleIds)], ['r3']);
});

test('findBatchEntryForTodo matches the selected todo or its target', () => {
  const batch = {
    entries: [
      { entryId: 'e1', todoId: 'c1', targetId: 'p1', state: 'running' },
      { entryId: 'e2', todoId: 'r3', targetId: 'r3', state: 'queued' },
    ],
  };
  assert.equal(findBatchEntryForTodo(batch, 'c1')?.entryId, 'e1');
  // A parent row aliased to the same target still resolves to its entry.
  assert.equal(findBatchEntryForTodo(batch, 'p1')?.entryId, 'e1');
  assert.equal(findBatchEntryForTodo(batch, 'nope'), null);
  assert.equal(findBatchEntryForTodo(null, 'c1'), null);
});

test('parseBatchReason splits known kinds from their payload', () => {
  assert.deepEqual(parseBatchReason('aliased:abc'), { kind: 'aliased', target: 'abc' });
  assert.deepEqual(parseBatchReason('blocked_by:e2'), { kind: 'blocked_by', target: 'e2' });
  assert.deepEqual(parseBatchReason('not_eligible'), { kind: 'not_eligible', target: '' });
  assert.deepEqual(parseBatchReason(''), { kind: '', target: '' });
});

test('summarizeBatchEntries counts entry states', () => {
  const batch = {
    entries: [
      { state: 'merged' },
      { state: 'merged' },
      { state: 'verified' },
      { state: 'failed' },
      { state: 'skipped' },
    ],
  };
  assert.deepEqual(summarizeBatchEntries(batch), {
    total: 5,
    counts: { merged: 2, verified: 1, failed: 1, skipped: 1 },
  });
  assert.deepEqual(summarizeBatchEntries(null), { total: 0, counts: {} });
});

test('batch status classifiers match the server record', () => {
  assert.equal(isActiveBatchStatus('running'), true);
  assert.equal(isActiveBatchStatus('paused'), true);
  assert.equal(isActiveBatchStatus('stalled'), true);
  assert.equal(isActiveBatchStatus('cancelling'), true);
  assert.equal(isActiveBatchStatus('completed'), false);
  assert.equal(isTerminalBatchStatus('completed'), true);
  assert.equal(isTerminalBatchStatus('cancelled'), true);
  assert.equal(isTerminalBatchStatus('abandoned'), true);
  assert.equal(isTerminalBatchStatus('running'), false);
});

test('resolveBatchToTrack keeps the tracked batch, else picks the newest active one', () => {
  const tracked = { id: 'b1', status: 'paused' };
  const batches = [{ id: 'b2', status: 'completed' }, { id: 'b1', status: 'paused' }];
  assert.equal(resolveBatchToTrack(batches, tracked)?.id, 'b1');
  assert.equal(resolveBatchToTrack([{ id: 'b3', status: 'running' }, { id: 'b4', status: 'paused' }], null)?.id, 'b3');
  assert.equal(resolveBatchToTrack([{ id: 'b3', status: 'completed' }], null), null);
  // A tracked batch that vanished from the list falls back to the newest active one.
  assert.equal(resolveBatchToTrack([{ id: 'b9', status: 'running' }], tracked)?.id, 'b9');
});

/** Mimics the app `t()`: known keys translate, unknown keys echo the key. */
function fakeTranslate(key, params = {}) {
  const table = {
    'todo.batchPause_unmerged_paths': 'unmerged',
    'todo.batchPause_workspace_drift': 'drift',
    'todo.batchPause_boundary_unsafe': 'unsafe',
    'todo.batchPause_integration_locked': 'locked',
    'todo.batchPause_batch_cancelled': 'cancelled',
    'todo.batchEntryReason': 'Reason: {reason}',
    'todo.batchSkip_generic': 'Skipped ({reason})',
    'todo.batchError_integration_locked': 'Locked by another run.',
    'todo.batchFailed': 'Failed.',
  };
  const template = table[key];
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''));
}

test('resolveBatchToTrack prefers an active batch over a tracked terminal one', () => {
  const batches = [
    { id: 'new', status: 'running' },
    { id: 'old', status: 'completed' },
  ];
  assert.equal(resolveBatchToTrack(batches, { id: 'old', status: 'completed' }).id, 'new');
  assert.equal(resolveBatchToTrack(batches, { id: 'new', status: 'running' }).id, 'new');
  // A still-active tracked batch stays tracked over a newer active one.
  const two = [{ id: 'b', status: 'running' }, { id: 'a', status: 'paused' }];
  assert.equal(resolveBatchToTrack(two, { id: 'a' }).id, 'a');
  // Only terminal batches: keep the tracked one so the final banner stays.
  assert.equal(resolveBatchToTrack([{ id: 'old', status: 'completed' }], { id: 'old' }).id, 'old');
  assert.equal(resolveBatchToTrack([{ id: 'old', status: 'completed' }], null), null);
});

test('localizeBatchReason maps pause lists, prefixes and unknown tokens', () => {
  assert.equal(localizeBatchReason('unmerged_paths,workspace_drift', fakeTranslate, 'pause'), 'unmerged, drift');
  assert.equal(localizeBatchReason('boundary_unsafe:unmerged_paths,workspace_drift', fakeTranslate, 'pause'), 'unsafe: unmerged, drift');
  assert.equal(localizeBatchReason('integration_locked', fakeTranslate, 'skip'), 'locked');
  assert.equal(localizeBatchReason('batch_cancelled', fakeTranslate), 'cancelled');
  assert.equal(localizeBatchReason('mystery_reason', fakeTranslate, 'pause'), 'Reason: mystery_reason');
  assert.equal(localizeBatchReason('mystery', fakeTranslate, 'skip'), 'Skipped (mystery)');
  assert.equal(localizeBatchReason('', fakeTranslate), '');
});

test('describeBatchFailure localizes reasons and keeps sentence errors', () => {
  assert.equal(describeBatchFailure({ error: 'integration_locked' }, fakeTranslate), 'Locked by another run.');
  // sdk.noApiKey answers with the localized sentence in `error`.
  assert.equal(describeBatchFailure({ error: 'No Cursor API key configured.' }, fakeTranslate), 'No Cursor API key configured.');
  assert.equal(describeBatchFailure({}, fakeTranslate), 'Failed.');
  assert.equal(
    describeBatchFailure({ error: 'integration_locked', detail: { reasons: ['workspace_drift'] } }, fakeTranslate),
    'Locked by another run. (drift)',
  );
});

test('resolveBatchControls: cancel on paused, forced recovery on unknown liveness', () => {
  const paused = resolveBatchControls({ status: 'paused', liveness: { idle: true, known: true } });
  assert.equal(paused.canCancel, true);
  assert.equal(paused.canResume, true);
  assert.equal(paused.needsForce, false);
  const unknown = resolveBatchControls({ status: 'running', liveness: { idle: false, busy: false, known: false } });
  assert.equal(unknown.canResume, true);
  assert.equal(unknown.needsForce, true);
  assert.equal(unknown.livenessUnknown, true);
  assert.equal(unknown.canAbandon, true);
  const busy = resolveBatchControls({ status: 'running', liveness: { idle: false, busy: true, known: true } });
  assert.equal(busy.canResume, false);
  const done = resolveBatchControls({ status: 'completed' });
  assert.equal(done.canCancel, false);
  assert.equal(done.canDismiss, true);
  assert.equal(resolveBatchControls({ status: 'cancelling' }).cancelDisabled, true);
});

test('batch scope guard drops responses after a workspace switch', () => {
  const scope = captureBatchScope('/ws/a', 3);
  const same = (folder) => folder === '/ws/a';
  assert.equal(isBatchScopeCurrent(scope, 3, same), true);
  assert.equal(isBatchScopeCurrent(scope, 4, same), false);
  assert.equal(isBatchScopeCurrent(scope, 3, (folder) => folder === '/ws/b'), false);
  assert.equal(isBatchScopeCurrent(null, 3, same), false);
});

test('createLatestRequestGate accepts only the newest token', () => {
  const gate = createLatestRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isLatest(first), false);
  assert.equal(gate.isLatest(second), true);
});

test('owned pending guard: late completion of A does not clear B', () => {
  const guard = createOwnedPendingGuard();
  const tokenA = guard.begin();
  guard.reset();
  const tokenB = guard.begin();
  assert.equal(guard.release(tokenA), false);
  assert.equal(guard.isPending(), true);
  assert.equal(guard.release(tokenB), true);
  assert.equal(guard.isPending(), false);
});

test('resume agent need: cancelling needs no picker, paused/stalled do', () => {
  assert.deepEqual(resolveResumeAgentNeed({ status: 'cancelling' }, null), { needsPicker: false, agent: null });
  assert.equal(resolveResumeAgentNeed({ status: 'paused' }, null).needsPicker, true);
  assert.equal(resolveResumeAgentNeed({ status: 'stalled' }, null).needsPicker, true);
  const known = { harness: 'sdk', model: 'auto' };
  assert.deepEqual(resolveResumeAgentNeed({ status: 'paused' }, known), { needsPicker: false, agent: known });
});

test('stale scope: picked agent is ignored via scope check', () => {
  const scope = captureBatchScope('/a', 1);
  assert.equal(isBatchScopeCurrent(scope, 2, () => true), false);
});

test('resume agent need: no picker when the server would open no chat', () => {
  const done = { status: 'stalled', entries: [{ id: 'e1', todoId: 't1', state: 'merged' }] };
  assert.equal(resolveResumeAgentNeed(done, null).needsPicker, false);
  const queued = { status: 'stalled', entries: [{ id: 'e1', todoId: 't1', state: 'queued' }] };
  assert.equal(resolveResumeAgentNeed(queued, null).needsPicker, true);
  const failed = { status: 'paused', pausedEntryId: 'e1', entries: [{ id: 'e1', todoId: 't1', state: 'failed' }] };
  assert.equal(resolveResumeAgentNeed(failed, null, 'retry').needsPicker, true);
  assert.equal(resolveResumeAgentNeed(failed, null, 'skip').needsPicker, false);
});

test('clear lock control: stranded single lock yes, tracked active batch lock no', () => {
  assert.equal(canClearIntegrationLock(null, null), false);
  assert.equal(canClearIntegrationLock({ owner: 'single', todoId: 't1' }, null), true);
  assert.equal(canClearIntegrationLock({ owner: 'single' }, { id: 'b1', status: 'running' }), true);
  assert.equal(canClearIntegrationLock({ owner: 'batch', batchId: 'b1' }, { id: 'b1', status: 'running' }), false);
  assert.equal(canClearIntegrationLock({ owner: 'batch', batchId: 'b1' }, { id: 'b1', status: 'completed' }), true);
  assert.equal(canClearIntegrationLock({ owner: 'batch', batchId: 'b1' }, null), true);
});
