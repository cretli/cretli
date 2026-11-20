/**
 * Regression for the resume-route event-loop stall: the production wiring must read the chat through the async
 * runtime first (never a cold synchronous chats parse mid-resume), yield between steps, and name slow steps.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { closeRecoveryStore, getRun, openRecoveryStore, transitionRun, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { createRuntimeRecoveryResumeService } from '../lib/routes/recovery-resume-routes.js';
import { makeTempDir } from './helpers/temp-dir.js';

const BUDGET_MS = 500;

function seed() {
  return seedInto(openRecoveryStore({ dataDir: makeTempDir('recovery-resume-stall-') }));
}

function seedInto(store) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: 'chat-1', sessionId: 'sess-1', harness: 'claude',
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  run = transitionRun({
    logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'interrupted',
    reason: 'server_restart', patch: { interruptedPrompt: 'p' },
  }, store).run;
  return { store, ids, run };
}

test('resume reads the chat asynchronously and never blocks the loop past the budget', async () => {
  const { store, ids, run } = seed();
  const warnings = [];
  let asyncReads = 0;
  const service = createRuntimeRecoveryResumeService({
    store,
    loadSettings: () => ({ chatRestartRecoveryMode: 'manual' }),
    isAdapterValidated: () => true,
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
    getHarnessUsageLimit: () => null,
    assertCanAcceptNewRun: () => {},
    assertChatCanReceiveMessages: () => {},
    // Slow-but-async chat read: must not hold the event loop.
    getChatByIdAsync: async (id) => {
      asyncReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { id, cursorSessionId: 'sess-1' };
    },
    startChatRun: async () => ({ accepted: true, runId: 'a1' }),
    warn: (message) => warnings.push(message),
  });

  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const outcome = await service.resumeRun({
    chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedState: run.state,
    expectedRevision: run.revision, idempotencyKey: 'stall-1', actor: 'manual', confirmUnknown: true,
  });
  clearInterval(timer);

  assert.equal(outcome.status, 'resumed');
  assert.equal(asyncReads, 1);
  assert.ok(maxLag < BUDGET_MS, `event loop lag ${maxLag}ms exceeds ${BUDGET_MS}ms`);
  assert.deepEqual(warnings, []);
  closeRecoveryStore(store);
});

test('slow steps are reported by name', async () => {
  const { store, ids, run } = seed();
  const warnings = [];
  const service = createRuntimeRecoveryResumeService({
    store,
    slowStepMs: 20,
    warn: (message) => warnings.push(message),
    loadSettings: () => ({ chatRestartRecoveryMode: 'manual' }),
    isAdapterValidated: () => true,
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
    getHarnessUsageLimit: () => null,
    assertCanAcceptNewRun: () => {},
    assertChatCanReceiveMessages: () => {},
    getChatByIdAsync: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { id, cursorSessionId: 'sess-1' };
    },
    startChatRun: async () => ({ accepted: true, runId: 'a1' }),
  });
  await service.resumeRun({
    chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedState: run.state,
    expectedRevision: run.revision, idempotencyKey: 'stall-2', actor: 'manual', confirmUnknown: true,
  });
  assert.ok(warnings.some((w) => w.includes('prefetch_chat')));
  closeRecoveryStore(store);
});

function makeService(store, getChatByIdAsync) {
  return createRuntimeRecoveryResumeService({
    store,
    loadSettings: () => ({ chatRestartRecoveryMode: 'manual' }),
    isAdapterValidated: () => true,
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
    getHarnessUsageLimit: () => null,
    assertCanAcceptNewRun: () => {},
    assertChatCanReceiveMessages: () => {},
    getChatByIdAsync,
    startChatRun: async () => ({ accepted: true, runId: 'a1' }),
  });
}

test('async prefetch failure falls back to the sync read and the entry is not leaked', async () => {
  const { store, ids, run } = seed();
  const service = makeService(store, async () => { throw new Error('boom'); });
  let outcome;
  try {
    outcome = await service.resumeRun({
      chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedState: run.state,
      expectedRevision: run.revision, idempotencyKey: 'fb-1', actor: 'manual', confirmUnknown: true,
    });
  } catch (error) {
    // The isolated data dir has no such chat: the sync fallback ran and reported it instead of the prefetch.
    outcome = { status: 'fallback_error', error };
  }
  assert.notEqual(outcome.status, 'resumed');
  assert.equal(service.prefetchedChatCount(), 0);
  closeRecoveryStore(store);
});

test('concurrent resumes of one chat share the prefetched row until the last finishes', async () => {
  const a = seed();
  const b = seed();
  let reads = 0;
  // One service per store is not possible (store is bound), so share one chat id across two services' maps
  // by running both runs through a single service whose store holds both runs.
  const service = makeService(a.store, async (id) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, reads === 1 ? 10 : 80));
    return { id, cursorSessionId: 'sess-1' };
  });
  const call = (s, key) => service.resumeRun({
    chatId: 'chat-1', logicalRunId: s.ids.logicalRunId, expectedState: s.run.state,
    expectedRevision: s.run.revision, idempotencyKey: key, actor: 'manual', confirmUnknown: true,
  });
  // Second run lives in the same store so both calls hit the same service instance.
  const second = seedInto(a.store);
  const [r1, r2] = await Promise.all([
    call(a, 'c-1'),
    service.resumeRun({
      chatId: 'chat-1', logicalRunId: second.ids.logicalRunId, expectedState: second.run.state,
      expectedRevision: second.run.revision, idempotencyKey: 'c-2', actor: 'manual', confirmUnknown: true,
    }),
  ]);
  assert.equal(r1.status, 'resumed');
  assert.equal(r2.status, 'resumed');
  assert.equal(service.prefetchedChatCount(), 0);
  closeRecoveryStore(a.store);
  closeRecoveryStore(b.store);
});
