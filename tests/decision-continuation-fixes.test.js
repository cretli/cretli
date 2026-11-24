import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers/temp-dir.js';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodo, updateTodo } from '../lib/persist/todos-store.js';
import { createWatcherHumanDecision, computeDecisionScopeVersion } from '../lib/decisions/decision-request.js';
import { changeDecision, getDecision, annotateDecision, listDecisionEvents, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { applyDecisionContinuation, loadContinuationContext, recordContinuationDeliveryError, markContinuationsResumed, linkDecisionDelegation, CONTINUATION_APPLY_LEASE_MS } from '../lib/decisions/decision-continuation.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';
import { decideWorkspaceWatcherAction } from '../lib/workspace-watcher.js';

const cwd = makeTempDir('cretli-decision-fixes-');
after(async () => { await closeDecisionStores(); });
const options = [
  { id: 'go', label: 'Go on', effect: 'Resume the task', continuation: 'resume' },
  { id: 'park', label: 'Park', effect: 'Defer the task', continuation: 'defer' },
];
const report = (todoIds, extra = {}) => createWatcherHumanDecision(dataDir, cwd, {
  chatId: 'chat-x', cycleId: `cycle-${Math.random()}`, reportId: `r-${Math.random()}`, todoIds, message: 'blocked',
  options, recommended: 'go', why: 'because', blockerKey: 'k', question: 'Which DB?', ...extra,
});
/** Decide a card the way the route does: claim, then `decided` with a stored continuation. */
async function decide(card, { text = '', status = 'saved', intent = 'resume' } = {}) {
  const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding');
  return changeDecision(dataDir, card.id, claimed.revision, 'decided', { optionId: 'go', continuation: {
    status, intent, todoIds: card.relations.todoIds, scopeVersion: card.relations.scopeVersion,
    answer: { optionId: 'go', label: 'Go on', effect: 'Resume the task', text } } }, 'deciding');
}

test('F1: resume restores a todo parked as idea by needs_human escalation; a plain idea is left alone', async () => {
  const parked = (await addTodo(dataDir, cwd, { title: 'parked', status: 'idea' })).item;
  await updateTodo(dataDir, cwd, parked.id, { blockedReason: 'needs_human: pick a DB' });
  const plain = (await addTodo(dataDir, cwd, { title: 'plain idea', status: 'idea' })).item;
  const card = (await report([parked.id], { blockerKey: 'f1' })).decision;
  const plainCard = (await report([plain.id], { blockerKey: 'f1b' })).decision;
  await decide(card);
  await decide(plainCard);
  await applyDecisionContinuation(dataDir, card.id);
  await applyDecisionContinuation(dataDir, plainCard.id);
  const after1 = await getTodo(dataDir, cwd, parked.id);
  assert.equal(after1.status, 'ready');
  assert.ok(!after1.blockedReason);
  assert.equal((await getTodo(dataDir, cwd, plain.id)).status, 'idea');
  assert.equal((await getDecision(dataDir, card.id)).continuation.status, 'waiting');
});

test('F2: a changed todo body changes the scope fingerprint and stops the answer reaching the next cycle', async () => {
  const todo = (await addTodo(dataDir, cwd, { title: 'scoped', status: 'ready', body: 'original body' })).item;
  const before = await computeDecisionScopeVersion(dataDir, cwd, [todo.id]);
  const card = (await report([todo.id], { blockerKey: 'f2' })).decision;
  await decide(card);
  await applyDecisionContinuation(dataDir, card.id);
  assert.equal((await loadContinuationContext(dataDir, cwd, todo.id)).decisionIds.length, 1);
  await updateTodo(dataDir, cwd, todo.id, { body: 'edited body after the answer' });
  assert.notEqual(await computeDecisionScopeVersion(dataDir, cwd, [todo.id]), before);
  const context = await loadContinuationContext(dataDir, cwd, todo.id);
  assert.deepEqual(context.decisionIds, []);
  const stored = await getDecision(dataDir, card.id);
  assert.equal(stored.continuation.status, 'failed');
  assert.equal(stored.continuation.error, 'scope_changed');
});

test('F3: a 4000-char human answer survives intact in the cycle prompt', async () => {
  const text = `${'x'.repeat(3990)}END-MARK`;
  const todo = (await addTodo(dataDir, cwd, { title: 'long', status: 'ready' })).item;
  const card = (await report([todo.id], { blockerKey: 'f3', question: 'Q'.repeat(1000) })).decision;
  await decide(card, { text });
  await applyDecisionContinuation(dataDir, card.id);
  const context = await loadContinuationContext(dataDir, cwd, todo.id);
  const plan = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: cwd, watcher: { policy: { requirePlanApproval: false }, reviewWaits: {} }, decision: { kind: 'start_cycle' },
    todo: { id: todo.id, title: 'long' }, orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' }, cycleId: 'c',
    decisionContext: context.lines,
  });
  assert.equal(plan.tooLong, false);
  assert.ok(plan.prompt.includes(`Human instruction: ${text}`));
});

test('F4: changed question/options for the same scope supersede the old card, even a decided one', async () => {
  const todo = (await addTodo(dataDir, cwd, { title: 'revised', status: 'ready' })).item;
  const first = (await report([todo.id], { blockerKey: 'f4' })).decision;
  assert.equal((await report([todo.id], { blockerKey: 'f4' })).decision.id, first.id); // identical proposal reuses the card
  await decide(first);
  await applyDecisionContinuation(dataDir, first.id);
  const second = (await report([todo.id], { blockerKey: 'f4', question: 'Which DB, now with a budget?' })).decision;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.relations.supersedes, [first.id]);
  assert.equal(second.relations.journeyId, first.relations.journeyId);
  const old = await getDecision(dataDir, first.id);
  assert.equal(old.supersededBy, second.id);
  // The superseded answer is not handed to a cycle as an answer to the new question.
  assert.deepEqual((await loadContinuationContext(dataDir, cwd, todo.id)).decisionIds, []);
  const changedOptions = (await report([todo.id], { blockerKey: 'f4', question: 'Which DB, now with a budget?',
    options: [{ id: 'go', label: 'Go', effect: 'Different effect', continuation: 'resume' }, options[1]] })).decision;
  assert.notEqual(changedOptions.id, second.id);
});

test('F5: proactive planning skips an idea todo waiting on a decision; another idea progresses', () => {
  const idle = (id) => ({ id, status: 'idea', title: id, description: 'x'.repeat(80), createdAt: `2026-01-0${id.length}` });
  const items = [idle('a'), idle('bb')];
  const watcher = { mode: 'autopilot', enabled: true, policy: { proactivePlanning: { enabled: true, minBodyChars: 10, maxPerDay: 3 }, requirePlanApproval: true } };
  const base = { items, readyLeaves: [], readyTodoIds: [], readyTodoCount: 0 };
  const run = (pending) => decideWorkspaceWatcherAction({ watcher, snapshot: { ...base, pendingDecisionTodoIds: pending }, now: Date.now() });
  const withBlock = run(['a']);
  assert.equal(withBlock.nextTodoId, 'bb');
  const allBlocked = run(['a', 'bb']);
  assert.notEqual(allBlocked.reason, 'proactive_planning');
});

test('F7: parallel lease takeover has one winner and a stale applier cannot overwrite the outcome', async () => {
  const todo = (await addTodo(dataDir, cwd, { title: 'lease', status: 'ready' })).item;
  const card = (await report([todo.id], { blockerKey: 'f7' })).decision;
  const old = new Date(Date.now() - CONTINUATION_APPLY_LEASE_MS - 5000).toISOString();
  await decide(card, { status: 'applying' });
  await annotateDecision(dataDir, card.id, { status: 'applying', applyingAt: old, claimToken: 'dead-owner' });
  const results = await Promise.all([applyDecisionContinuation(dataDir, card.id), applyDecisionContinuation(dataDir, card.id)]);
  assert.ok(results.every(Boolean));
  const stored = await getDecision(dataDir, card.id);
  assert.equal(stored.continuation.status, 'waiting');
  const events = (await listDecisionEvents(dataDir, card.id)).items.filter((e) => e.type === 'continuation_waiting');
  assert.equal(events.length, 1);
  // The dead owner's late write is fenced out.
  const late = await annotateDecision(dataDir, card.id, { status: 'failed', error: 'late' }, { expectToken: 'dead-owner' });
  assert.equal(late, null);
  assert.equal((await getDecision(dataDir, card.id)).continuation.status, 'waiting');
});

test('F6: refs are typed and validated, delegation links are idempotent', async () => {
  const todo = (await addTodo(dataDir, cwd, { title: 'refs', status: 'ready' })).item;
  const card = (await report([todo.id], { blockerKey: 'f6', sources: [{ type: 'scout_finding', id: 'f-1' }, { type: 'patch', id: 'p-1' }] })).decision;
  const types = card.relations.refs.map((r) => r.type).sort();
  assert.deepEqual(types, ['chat', 'cycle', 'patch', 'scout_finding', 'todo']);
  assert.equal(card.relations.schemaVersion, 2);
  await assert.rejects(report([todo.id], { blockerKey: 'f6bad', sources: [{ type: 'nonsense', id: 'x' }] }), /Invalid decision relation/);
  await decide(card);
  await applyDecisionContinuation(dataDir, card.id);
  await linkDecisionDelegation(dataDir, card.id, { delegationId: 'del-1', todoId: todo.id });
  await linkDecisionDelegation(dataDir, card.id, { delegationId: 'del-1', todoId: todo.id });
  const stored = await getDecision(dataDir, card.id);
  assert.deepEqual(stored.continuation.delegationIds, ['del-1']);
  assert.equal((await listDecisionEvents(dataDir, card.id)).items.filter((e) => e.type === 'delegation_linked').length, 1);
});

test('R1C3-FALLBACK: a too-long contract for one todo keeps the answer waiting for the sibling and for a re-cycle', async () => {
  const a = (await addTodo(dataDir, cwd, { title: 'A long contract', status: 'ready' })).item;
  const b = (await addTodo(dataDir, cwd, { title: 'B fits', status: 'ready' })).item;
  const card = (await report([a.id, b.id], { blockerKey: 'r1c3' })).decision;
  await decide(card, { text: 'use sqlite' });
  await applyDecisionContinuation(dataDir, card.id);
  const ctxA = await loadContinuationContext(dataDir, cwd, a.id);
  assert.equal(ctxA.decisionIds.length, 1);
  // The cycle for A hits prompt_too_long: the delivery error is recorded, the card is NOT failed.
  await recordContinuationDeliveryError(dataDir, ctxA.decisionIds, { todoId: a.id, reason: 'prompt_too_long' });
  let stored = await getDecision(dataDir, card.id);
  assert.equal(stored.continuation.status, 'waiting');
  assert.equal(stored.continuation.deliveryErrors[a.id].reason, 'prompt_too_long');
  // B still receives the human instruction; A is not lost on a re-cycle.
  const ctxB = await loadContinuationContext(dataDir, cwd, b.id);
  assert.deepEqual(ctxB.decisionIds, [card.id]);
  assert.ok(ctxB.lines.some((line) => line.includes('use sqlite')));
  assert.deepEqual((await loadContinuationContext(dataDir, cwd, a.id)).decisionIds, [card.id]);
  await markContinuationsResumed(dataDir, ctxB.decisionIds, { cycleId: 'c1', chatId: 'ch1', todoId: b.id });
  stored = await getDecision(dataDir, card.id);
  assert.equal(stored.continuation.status, 'waiting', 'still waiting for A');
  await markContinuationsResumed(dataDir, [card.id], { cycleId: 'c2', chatId: 'ch2', todoId: a.id });
  stored = await getDecision(dataDir, card.id);
  assert.equal(stored.continuation.status, 'resumed');
  assert.equal(stored.continuation.deliveryErrors[a.id], undefined);
});

test('R1A1-F1: a rejecting chat notice write is recorded as failed and the answer + continuation survive', async () => {
  const { executeDecision } = await import('../lib/decisions/decision-adapters.js');
  const { setChatHistoryAdapterForTests } = await import('../lib/persist/chat-history-service.js');
  setChatHistoryAdapterForTests({ backendKind: 'test', appendChatNotice: async () => { throw new Error('history backend down'); } });
  const card = { id: 'd-f1', kind: 'needs_human', workspaceFolder: cwd, options, subject: { chatId: 'chat-f1', todoIds: ['t1'] }, relations: { todoIds: ['t1'] } };
  let result;
  try { result = await executeDecision(card, 'go', dataDir, null, 'text'); } finally { setChatHistoryAdapterForTests(null); }
  assert.equal(result.ok, true);
  assert.equal(result.response.chatNotice, 'failed');
  assert.ok(result.continuation);
});

test('R1A1-F2: reconcile and apply skip a superseded saved continuation without side effects', async () => {
  const { reconcileDecisionContinuations } = await import('../lib/decisions/decision-continuation.js');
  const todo = (await addTodo(dataDir, cwd, { title: 'superseded', status: 'ready' })).item;
  const a = (await report([todo.id], { blockerKey: 'f2', question: 'Which DB?' })).decision;
  await decide(a, { intent: 'defer' });
  // Report B for the same blocker changes the proposal; opCreate supersedes the decided card A.
  const b = (await report([todo.id], { blockerKey: 'f2', question: 'Which cache?' })).decision;
  assert.notEqual(b.id, a.id);
  assert.ok((await getDecision(dataDir, a.id)).supersededBy, 'card A is superseded');
  await reconcileDecisionContinuations(dataDir, cwd);
  await applyDecisionContinuation(dataDir, a.id);
  assert.equal((await getTodo(dataDir, cwd, todo.id)).status, 'ready');
  assert.equal((await getDecision(dataDir, a.id)).continuation.status, 'saved');
});
