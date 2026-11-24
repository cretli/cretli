import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeTempDir } from './helpers/temp-dir.js';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { addTodo, getTodo } from '../lib/persist/todos-store.js';
import { upsertWorkspaceWatcher, getWorkspaceWatcher, mutateWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';
import { createWatcherHumanDecision, OTHER_ANSWER_ID } from '../lib/decisions/decision-request.js';
import { getDecision, listDecisionEvents, annotateDecision, closeDecisionStores } from '../lib/decisions/decision-store.js';
import {
  applyDecisionContinuation, listPendingDecisionTodoIds, loadContinuationContext, markContinuationsResumed,
  presentDecision, reconcileDecisionContinuations,
} from '../lib/decisions/decision-continuation.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';
import { pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';

const cwd = makeTempDir('cretli-decision-cont-');
setPassword('decision-continuation-password');
const session = createSession();
const agentSession = createSession({ agentSession: true });
const headers = (token) => ({ cookie: `cr_session=${encodeURIComponent(token)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) });
const app = express();
app.use(express.json());
app.use(requireAuth);
registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => cwd });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(async () => { await new Promise((resolve) => server.close(resolve)); await closeDecisionStores(); });
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, url, token, body) {
  const response = await fetch(base + url, { method, headers: { ...(token ? headers(token) : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const options = (intent = 'resume') => [
  { id: 'go', label: 'Go on', effect: 'Resume the task', continuation: intent },
  { id: 'park', label: 'Park', effect: 'Defer the task', continuation: 'defer' },
];
async function report(todoIds, extra = {}) {
  const chatId = extra.chatId || `chat-${Math.random()}`;
  return createWatcherHumanDecision(dataDir, cwd, {
    chatId, cycleId: extra.cycleId || `cycle-${Math.random()}`, reportId: extra.reportId || `r-${Math.random()}`, todoIds,
    message: 'blocked', options: options(), recommended: 'go', why: 'because', blockerKey: 'db-choice', question: 'Which DB?', ...extra,
  });
}
const newTodo = async (title) => (await addTodo(dataDir, cwd, { title, status: 'ready' })).item;

test('same blockerKey across cycles keeps one card; another key or todo set is separate', async () => {
  const todo = await newTodo('dedupe');
  const a = (await report([todo.id])).decision;
  const b = (await report([todo.id])).decision;
  assert.equal(b.id, a.id);
  assert.equal(a.title, 'Which DB?');
  assert.equal(a.options[0].continuation, 'resume');
  const other = (await report([todo.id], { blockerKey: 'other' })).decision;
  assert.notEqual(other.id, a.id);
});

test('pending question blocks only its own todo', async () => {
  const blocked = await newTodo('blocked');
  const free = await newTodo('free');
  await report([blocked.id], { blockerKey: 'only-blocked' });
  const pending = [...await listPendingDecisionTodoIds(dataDir, cwd)];
  assert.ok(pending.includes(blocked.id));
  assert.ok(!pending.includes(free.id));
  const items = [blocked, free];
  const picked = pickNextWorkspaceReadyTodo({ items, readyLeaves: items, pendingDecisionTodoIds: [blocked.id] });
  assert.equal(picked.id, free.id);
  assert.equal(pickNextWorkspaceReadyTodo({ items: [blocked], readyLeaves: [blocked], pendingDecisionTodoIds: [blocked.id] }), null);
});

test('resolve persists answer + own text, is idempotent, and exposes waiting state with context', async () => {
  const todo = await newTodo('resume me');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot' }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({ blockedBackoff: { [todo.id]: { count: 3, until: new Date(Date.now() + 3_600_000).toISOString() } } }), { dataDir });
  const card = (await report([todo.id], { blockerKey: 'resume-flow' })).decision;
  assert.equal((await call('POST', `/api/decisions/${card.id}`, agentSession, { optionId: 'go', expectedRevision: card.revision })).status, 403);
  const body = { optionId: OTHER_ANSWER_ID, reason: 'Use Postgres 16', expectedRevision: card.revision };
  const first = await call('POST', `/api/decisions/${card.id}`, session, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.decision.continuationState.status, 'waiting');
  assert.equal(first.body.decision.continuationState.waitingFor, 'waiting_for_scheduler');
  assert.equal(first.body.decision.continuationState.answer.text, 'Use Postgres 16');
  // A repeated POST is a conflict, never a second decision.
  assert.equal((await call('POST', `/api/decisions/${card.id}`, session, body)).status, 409);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).blockedBackoff[todo.id], undefined);
  // The next cycle receives the answer and only a real start marks it resumed.
  const context = await loadContinuationContext(dataDir, cwd, todo.id);
  assert.deepEqual(context.decisionIds, [card.id]);
  assert.match(context.lines.join('\n'), /Use Postgres 16/);
  assert.equal((await listPendingDecisionTodoIds(dataDir, cwd)).has(todo.id), false);
  assert.equal((await getDecision(dataDir, card.id)).continuation.status, 'waiting');
  await markContinuationsResumed(dataDir, context.decisionIds, { cycleId: 'c1', chatId: 'chat1', todoId: todo.id });
  const resumed = await call('GET', `/api/decisions/${card.id}`, session);
  assert.equal(resumed.body.decision.continuationState.status, 'resumed');
  assert.equal(resumed.body.decision.continuationState.cycleId, 'c1');
  assert.deepEqual((await loadContinuationContext(dataDir, cwd, todo.id)).lines, []);
  const events = await call('GET', `/api/decisions/${card.id}/events?limit=2`, session);
  assert.deepEqual(events.body.items.map((e) => e.type), ['proposed', 'answered']);
  assert.ok(events.body.nextCursor);
  const more = await call('GET', `/api/decisions/${card.id}/events?cursor=${events.body.nextCursor}`, session);
  assert.deepEqual(more.body.items.map((e) => e.type), ['continuation_waiting', 'continuation_resumed']);
});

test('paused watcher: continuation waits with an explicit reason', async () => {
  const todo = await newTodo('paused');
  mutateWorkspaceWatcherRow(cwd, () => ({ paused: true }), { dataDir });
  const card = (await report([todo.id], { blockerKey: 'paused-flow' })).decision;
  const res = await call('POST', `/api/decisions/${card.id}`, session, { optionId: 'go', expectedRevision: card.revision });
  assert.equal(res.body.decision.continuationState.waitingFor, 'watcher_paused');
  mutateWorkspaceWatcherRow(cwd, () => ({ paused: false }), { dataDir });
});

test('defer parks the task; none does not touch it', async () => {
  const deferred = await newTodo('defer me');
  const dCard = (await report([deferred.id], { blockerKey: 'defer-flow' })).decision;
  const dRes = await call('POST', `/api/decisions/${dCard.id}`, session, { optionId: 'park', expectedRevision: dCard.revision });
  assert.equal(dRes.body.decision.continuationState.status, 'applied');
  assert.equal((await getTodo(dataDir, cwd, deferred.id)).status, 'deferred');
  const kept = await newTodo('keep me');
  const nCard = (await createWatcherHumanDecision(dataDir, cwd, { chatId: 'c', cycleId: 'x', reportId: 'y', todoIds: [kept.id], message: 'm',
    options: options('none'), recommended: 'go', why: 'w', blockerKey: 'none-flow' })).decision;
  const nRes = await call('POST', `/api/decisions/${nCard.id}`, session, { optionId: 'go', expectedRevision: nCard.revision });
  assert.equal(nRes.body.decision.continuationState.status, 'none');
  assert.equal((await getTodo(dataDir, cwd, kept.id)).status, 'ready');
});

test('partial write: a saved continuation is applied on reconcile; failure is visible and retryable', async () => {
  const todo = await newTodo('partial');
  const card = (await report([todo.id], { blockerKey: 'partial-flow' })).decision;
  // Simulate a crash between the decided write and the apply: the card is decided with a `saved` record.
  const { changeDecision } = await import('../lib/decisions/decision-store.js');
  const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding');
  await changeDecision(dataDir, card.id, claimed.revision, 'decided', { optionId: 'go', continuation: {
    status: 'saved', intent: 'resume', todoIds: [todo.id], scopeVersion: card.relations.scopeVersion, answer: { optionId: 'go' } } }, 'deciding');
  await reconcileDecisionContinuations(dataDir, cwd);
  assert.equal((await getDecision(dataDir, card.id)).continuation.status, 'waiting');
  // Re-applying a settled continuation is a no-op (no duplicate events).
  await applyDecisionContinuation(dataDir, card.id);
  const types = (await listDecisionEvents(dataDir, card.id)).items.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'continuation_waiting').length, 1);
});

test('changed scope fails the continuation, retry is human-only and keeps the choice', async () => {
  const todo = await newTodo('scope');
  const card = (await report([todo.id], { blockerKey: 'scope-flow' })).decision;
  const { changeDecision } = await import('../lib/decisions/decision-store.js');
  const { updateTodo } = await import('../lib/persist/todos-store.js');
  const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding');
  await changeDecision(dataDir, card.id, claimed.revision, 'decided', { optionId: 'go', continuation: {
    status: 'saved', intent: 'resume', todoIds: [todo.id], scopeVersion: card.relations.scopeVersion, answer: { optionId: 'go' } } }, 'deciding');
  await updateTodo(dataDir, cwd, todo.id, { plan: { markdown: 'new plan', updatedAt: new Date().toISOString() } });
  assert.equal((await call('POST', `/api/decisions/${card.id}/continuation/retry`, agentSession)).status, 403);
  const retry = await call('POST', `/api/decisions/${card.id}/continuation/retry`, session);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.decision.optionId, 'go');
  assert.equal(retry.body.decision.continuationState.status, 'failed');
  assert.equal(retry.body.decision.continuationState.error, 'scope_changed');
  assert.equal(retry.body.decision.continuationState.retryable, true);
  assert.equal((await listPendingDecisionTodoIds(dataDir, cwd)).has(todo.id), false);
});

test('superseding a pending card by a changed scope records relations; legacy cards read as unknown', async () => {
  const todo = await newTodo('supersede');
  const first = (await report([todo.id], { blockerKey: 'sup' })).decision;
  const { updateTodo } = await import('../lib/persist/todos-store.js');
  await updateTodo(dataDir, cwd, todo.id, { plan: { markdown: 'v2', updatedAt: new Date().toISOString() } });
  const second = (await report([todo.id], { blockerKey: 'sup' })).decision;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.relations.supersedes, [first.id]);
  const old = await getDecision(dataDir, first.id);
  assert.equal(old.status, 'stale');
  assert.equal(old.supersededBy, second.id);
  assert.equal(second.events[0].type, 'proposed');
  const legacy = await presentDecision(dataDir, { ...old, origin: undefined, relations: undefined, events: undefined, subject: { chatId: 'c', updatedAt: '1' } });
  assert.equal(legacy.origin.kind, 'unknown');
  assert.equal(legacy.origin.legacy, true);
  const missing = await presentDecision(dataDir, { ...second, relations: { ...second.relations, todoIds: ['gone-todo'] } });
  assert.equal(missing.todos[0].missing, true);
});

test('annotate refuses a lost compare-and-swap', async () => {
  const todo = await newTodo('cas');
  const card = (await report([todo.id], { blockerKey: 'cas' })).decision;
  assert.equal(await annotateDecision(dataDir, card.id, { status: 'failed' }), null); // not decided yet
});

test('F1: a legacy card (no continuation, no blocker_key) still delivers choice and text to the next cycle', async () => {
  const todo = await newTodo('legacy deliver');
  const card = (await createWatcherHumanDecision(dataDir, cwd, { chatId: 'legacy-chat', cycleId: `cy-${Math.random()}`, reportId: `r-${Math.random()}`,
    todoIds: [todo.id], message: 'm', options: [{ id: 'a', label: 'Option A', effect: 'Do A' }, { id: 'b', label: 'Option B', effect: 'Do B' }],
    recommended: 'a', why: 'w' })).decision;
  for (const [optionId, reason] of [['a', 'with a note'], [OTHER_ANSWER_ID, 'custom legacy text']]) {
    const t = optionId === 'a' ? todo : await newTodo('legacy other');
    const c = optionId === 'a' ? card : (await createWatcherHumanDecision(dataDir, cwd, { chatId: 'legacy-chat2', cycleId: `cy-${Math.random()}`, reportId: `r-${Math.random()}`,
      todoIds: [t.id], message: 'm', options: card.options, recommended: 'a', why: 'w' })).decision;
    const res = await call('POST', `/api/decisions/${c.id}`, session, { optionId, reason, expectedRevision: c.revision });
    assert.equal(res.status, 200);
    assert.equal(res.body.decision.continuationState.status, 'waiting');
    assert.equal(res.body.decision.continuationState.waitingFor, 'next_cycle');
    const context = await loadContinuationContext(dataDir, cwd, t.id);
    assert.deepEqual(context.decisionIds, [c.id]);
    assert.match(context.lines.join('\n'), new RegExp(reason));
    await markContinuationsResumed(dataDir, context.decisionIds, { cycleId: 'c', chatId: 'ch', todoId: t.id });
    assert.equal((await getDecision(dataDir, c.id)).continuation.status, 'resumed');
    assert.deepEqual((await loadContinuationContext(dataDir, cwd, t.id)).lines, []);
  }
});

test('F2: a multi-todo card is resumed only after every todo got its context', async () => {
  const a = await newTodo('multi A');
  const b = await newTodo('multi B');
  const card = (await report([a.id, b.id], { blockerKey: 'multi' })).decision;
  const res = await call('POST', `/api/decisions/${card.id}`, session, { optionId: 'go', expectedRevision: card.revision });
  assert.equal(res.body.decision.continuationState.status, 'waiting');
  const ctxA = await loadContinuationContext(dataDir, cwd, a.id);
  await markContinuationsResumed(dataDir, ctxA.decisionIds, { cycleId: 'cA', chatId: 'chA', todoId: a.id });
  const mid = await getDecision(dataDir, card.id);
  assert.equal(mid.continuation.status, 'waiting');
  assert.deepEqual(mid.continuation.resumedTodoIds, [a.id]);
  assert.deepEqual((await loadContinuationContext(dataDir, cwd, a.id)).lines, []);
  const ctxB = await loadContinuationContext(dataDir, cwd, b.id);
  assert.deepEqual(ctxB.decisionIds, [card.id]);
  await markContinuationsResumed(dataDir, ctxB.decisionIds, { cycleId: 'cB', chatId: 'chB', todoId: b.id });
  assert.equal((await getDecision(dataDir, card.id)).continuation.status, 'resumed');
  // A repeated mark is a no-op.
  await markContinuationsResumed(dataDir, ctxB.decisionIds, { cycleId: 'cB', chatId: 'chB', todoId: b.id });
});
