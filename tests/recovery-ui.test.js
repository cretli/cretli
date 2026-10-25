import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  closeRecoveryStore,
  getRun,
  openRecoveryStore,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { describeRecoveryRun, keepRunStopped, listChatRecoveryViews } from '../lib/recovery/recovery-ui.ts';
import { registerRecoveryUiRoutes } from '../lib/routes/recovery-resume-routes.js';
import { resolveDelegationStatusKey } from '../app_front/features/chat/chatDelegations.js';
import { resolveHarnessChatStateMeta } from '../app_front/features/chat/chatStatusMeta.js';
import { seedInterruptedRuns } from './helpers/recovery-run-seed.js';
import { makeTempDir } from './helpers/temp-dir.js';

function setup(to = 'interrupted', reason = 'server_restart') {
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-ui-') });
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: 'chat-1', sessionId: 's', harness: 'claude',
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to, reason }, store).run;
  return { store, ids, run };
}

/**
 * Seed one interrupted run for an arbitrary chat without touching the default
 * chat fixture.
 *
 * @param {object} store
 * @param {string} chatId
 * @returns {object}
 */
function seedRunForChat(store, chatId) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
    family: 'chat', owner: 'chat-run-service', chatId, sessionId: 's', harness: 'claude',
  }, store);
  const run = getRun(ids.logicalRunId, store);
  return transitionRun({
    logicalRunId: ids.logicalRunId,
    expectedRevision: run.revision,
    to: 'interrupted',
    reason: 'server_restart',
  }, store).run;
}

test('describeRecoveryRun maps lifecycle states to status keys and actions', () => {
  assert.deepEqual(describeRecoveryRun({ state: 'interrupted', reason: 'server_restart' }),
    { status: 'interrupted_restart', canResume: true, canKeepStopped: true, needsConfirm: false });
  assert.equal(describeRecoveryRun({ state: 'interrupted', reason: 'process_gone' }).status, 'interrupted');
  assert.equal(describeRecoveryRun({ state: 'recovering' }).status, 'resuming');
  assert.equal(describeRecoveryRun({ state: 'recovering' }).canResume, false);
  assert.equal(describeRecoveryRun({ state: 'waiting' }).status, 'waiting');
  const unknown = describeRecoveryRun({ state: 'unknown' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.needsConfirm, true);
  assert.equal(describeRecoveryRun({ state: 'completed' }).status, '');
});

test('keepRunStopped persists, is idempotent and survives listing', () => {
  const { store, ids, run } = setup();
  assert.equal(listChatRecoveryViews('chat-1', store).length, 1);
  assert.equal(keepRunStopped({ chatId: 'other', logicalRunId: ids.logicalRunId, expectedRevision: run.revision }, store).status, 'not_found');
  assert.equal(keepRunStopped({ chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedRevision: run.revision + 5 }, store).status, 'conflict');
  const first = keepRunStopped({ chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedRevision: run.revision }, store);
  assert.equal(first.status, 'kept_stopped');
  const stored = getRun(ids.logicalRunId, store);
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.keptStopped, true);
  assert.equal(keepRunStopped({ chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedRevision: 1 }, store).replayed, true);
  assert.equal(listChatRecoveryViews('chat-1', store).length, 0);
  closeRecoveryStore(store);
});

test('a chat keeps its recovery item when the global state cap is already full', () => {
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-ui-') });
  try {
    // The store lists runs oldest-first. More than the former 500-row global
    // cap must not hide a newer chat behind unrelated interrupted runs.
    seedInterruptedRuns(store, { count: 505, chatId: (index) => `other-${index}` });
    seedRunForChat(store, 'chat-new');

    const views = listChatRecoveryViews('chat-new', store);
    assert.equal(views.length, 1);
    assert.equal(views[0].chatId, 'chat-new');
    assert.equal(views[0].status, 'interrupted_restart');
  } finally {
    closeRecoveryStore(store);
  }
});

test('keep-stopped refuses a recovering run', () => {
  const { store, ids, run } = setup();
  const rec = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'recovering' }, store).run;
  assert.equal(keepRunStopped({ chatId: 'chat-1', logicalRunId: ids.logicalRunId, expectedRevision: rec.revision }, store).status, 'not_resumable');
  assert.equal(listChatRecoveryViews('chat-1', store)[0].status, 'resuming');
  closeRecoveryStore(store);
});

test('routes: list and keep-stopped map to HTTP', () => {
  const { store, ids, run } = setup();
  const handlers = {};
  registerRecoveryUiRoutes({ get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } }, { store });
  let code = 200; let body;
  const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
  handlers['/api/chats/:id/recovery-runs']({ params: { id: 'chat-1' } }, res);
  assert.equal(body.runs[0].status, 'interrupted_restart');
  handlers['/api/chats/:id/runs/:logicalRunId/keep-stopped'](
    { params: { id: 'chat-1', logicalRunId: ids.logicalRunId }, body: { expectedRevision: run.revision } }, res);
  assert.equal(code, 200);
  assert.equal(body.status, 'kept_stopped');
  handlers['/api/chats/:id/runs/:logicalRunId/keep-stopped'](
    { params: { id: 'chat-1', logicalRunId: 'nope' }, body: {} }, res);
  assert.equal(code, 404);
  closeRecoveryStore(store);
});

test('client status mapping: restart interrupt gets its own label key', () => {
  assert.equal(resolveDelegationStatusKey({ status: 'interrupted', interruptCode: 'server_restart' }), 'interrupted_restart');
  assert.equal(resolveDelegationStatusKey({ status: 'interrupted', interruptCode: '' }), 'interrupted');
  assert.equal(resolveDelegationStatusKey({ status: 'failed', interruptCode: 'server_restart' }), 'failed');
  const meta = resolveHarnessChatStateMeta({
    connection: 'connected',
    serverRunState: { state: 'attention', delegationStatus: 'interrupted', interruptCode: 'server_restart' },
  });
  assert.equal(meta.label, 'Interrupted after restart');
});
