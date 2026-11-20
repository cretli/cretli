/**
 * Resume bounded waits: HTTP deadline (202 pending), opt-in start-lock timeout, in-lock start timeout with late
 * cancel, the allowlisted error codes and the prefetched-row probe.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addChatAsync } from '../lib/persist/chats-persist.js';
import {
  registerChatRunAdapter,
  unregisterChatRunAdapter,
  startChatRun,
  withChatRunStartLock,
} from '../lib/chat-run-service.js';
import { registerRecoveryResumeRoutes } from '../lib/routes/recovery-resume-routes.js';
import { RESUME_ERROR_CODES } from '../lib/recovery/recovery-resume.ts';
import { withTimeout } from '../lib/with-timeout.js';
import { useChatsBackendFromEnv } from './helpers/chats-backends.js';

await useChatsBackendFromEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = { busy: false, waitingForInput: false };

function fakeRes() {
  const res = { calls: [] };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.calls.push(b); res.body = b; return res; };
  return res;
}

function getHandler(service, ctx = {}) {
  let handler;
  registerRecoveryResumeRoutes({ post: (_p, h) => { handler = h; } }, { service, ...ctx });
  return handler;
}

const req = { params: { id: 'c', logicalRunId: 'lr' }, body: { expectedState: 'interrupted', expectedRevision: 1, idempotencyKey: 'k' } };

test('withTimeout rejects with the code and clears its timer on success', async () => {
  await assert.rejects(withTimeout(sleep(50), 5, 'x_timeout'), (e) => e.code === 'x_timeout');
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x_timeout'), 7);
});

test('route: slow resume answers 202 pending once, detached work still finishes', async () => {
  let finished = false;
  const handler = getHandler(
    { resumeRun: async () => { await sleep(80); finished = true; return { status: 'resumed' }; } },
    { httpWaitMs: 20 },
  );
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.code, 202);
  assert.deepEqual(res.body, { status: 'pending', reason: 'resume_pending', logicalRunId: 'lr' });
  assert.equal('revision' in res.body, false);
  await sleep(120);
  assert.equal(finished, true);
  assert.equal(res.calls.length, 1, 'exactly one response');
});

test('route: a refusal arriving after the deadline does not produce a second response', async () => {
  const handler = getHandler(
    { resumeRun: async () => { await sleep(60); return { status: 'conflict' }; } },
    { httpWaitMs: 15 },
  );
  const res = fakeRes();
  await handler(req, res);
  await sleep(100);
  assert.equal(res.code, 202);
  assert.equal(res.calls.length, 1);
});

test('route: fast outcome keeps the status mapping; detached rejection is only logged', async () => {
  const fast = fakeRes();
  await getHandler({ resumeRun: async () => ({ status: 'launch_failed' }) }, { httpWaitMs: 1000 })(req, fast);
  assert.equal(fast.code, 502);
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    const res = fakeRes();
    await getHandler(
      { resumeRun: async () => { await sleep(40); throw new Error('boom'); } },
      { httpWaitMs: 10 },
    )(req, res);
    await sleep(80);
    assert.equal(res.code, 202);
    assert.equal(res.calls.length, 1);
    assert.ok(logged.some((l) => l.includes('detached resume failed')));
  } finally {
    console.warn = warn;
  }
});

test('error codes are allowlisted', () => {
  assert.ok(RESUME_ERROR_CODES.includes('start_lock_timeout'));
  assert.ok(RESUME_ERROR_CODES.includes('adapter_start_timeout'));
});

test('start lock: a timed-out waiter does not let a later waiter overtake the holder', async () => {
  const order = [];
  let releaseA;
  const a = withChatRunStartLock('lock-chat', async () => {
    order.push('A-in');
    await new Promise((r) => { releaseA = r; });
    order.push('A-out');
  });
  await sleep(5);
  const b = withChatRunStartLock('lock-chat', async () => { order.push('B-ran'); }, { timeoutMs: 20 });
  await assert.rejects(b, (e) => e.code === 'start_lock_timeout');
  const c = withChatRunStartLock('lock-chat', async () => { order.push('C-in'); });
  await sleep(40);
  assert.deepEqual(order, ['A-in'], 'C must wait for A');
  releaseA();
  await a;
  await c;
  assert.deepEqual(order, ['A-in', 'A-out', 'C-in']);
});

test('startChatRun: lock timeout throws start_lock_timeout without starting', async () => {
  let starts = 0;
  unregisterChatRunAdapter('codex');
  registerChatRunAdapter({
    transport: 'codex', capabilities: {}, lookupRequest: () => null,
    async start() { starts += 1; return { runId: 'r1', accepted: true }; },
    async cancel() {}, getState: () => idle,
  });
  const chat = await addChatAsync('sess-lock', 'Lock', null, '/tmp', 'm', { agentTransport: 'codex', sdkMode: 'agent' });
  let releaseHolder;
  const holder = withChatRunStartLock(chat.id, () => new Promise((r) => { releaseHolder = r; }));
  await sleep(5);
  await assert.rejects(
    startChatRun({ chatId: chat.id, prompt: 'p', timeouts: { lockMs: 20, startMs: 1000 } }),
    (e) => e.code === 'start_lock_timeout',
  );
  assert.equal(starts, 0);
  releaseHolder();
  await holder;
});

test('startChatRun: adapter.start timeout fails the start and cancels a late-accepted run exactly once', async () => {
  const cancels = [];
  let finishStart;
  unregisterChatRunAdapter('codex');
  registerChatRunAdapter({
    transport: 'codex', capabilities: {}, lookupRequest: () => null,
    start: () => new Promise((r) => { finishStart = () => r({ runId: 'late-run', accepted: true }); }),
    async cancel(input) { cancels.push(input); },
    getState: () => idle,
  });
  const chat = await addChatAsync('sess-start', 'Start', null, '/tmp', 'm', { agentTransport: 'codex', sdkMode: 'agent' });
  await assert.rejects(
    startChatRun({ chatId: chat.id, prompt: 'p', requestId: 'req-timeout', timeouts: { lockMs: 1000, startMs: 25 } }),
    (e) => e.code === 'adapter_start_timeout',
  );
  finishStart();
  await sleep(50);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].runId, 'late-run');
  // The lock was released: a following start proceeds.
  unregisterChatRunAdapter('codex');
  registerChatRunAdapter({
    transport: 'codex', capabilities: {}, lookupRequest: () => null,
    async start() { return { runId: 'ok', accepted: true }; },
    async cancel() {}, getState: () => idle,
  });
  const next = await startChatRun({ chatId: chat.id, prompt: 'p2', requestId: 'req-after' });
  assert.equal(next.runId, 'ok');
});
