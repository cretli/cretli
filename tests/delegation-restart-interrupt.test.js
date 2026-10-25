/**
 * A running/cancelling delegation whose child died with a previous process
 * instance becomes `interrupted_restart` and frees its slot.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { finishDelegation } from '../lib/delegation-service.js';
import { closeRecoveryStore, openRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { beginRunLaunch } from '../lib/recovery/recovery-lifecycle.ts';
import { toRecoveryRequestId } from '../lib/chat-run/chat-run-recovery.ts';
import { getProcessInstance } from '../lib/recovery/recovery-shutdown.ts';
import { hasWorkspaceWatcherLeafRestartEvidence } from '../lib/workspace-watcher-restart-evidence.js';
import {
  interruptDelegationsWithRestartEvidence,
  resolveCancellingDeadline,
} from '../lib/delegation-cancelling-deadline.js';
import { isDelegationSlotOccupied } from '../lib/delegation-status.js';

function makeRow(status, assignment = 'review') {
  const row = createDelegationRecord({
    parentChatId: `parent-${crypto.randomUUID()}`,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment,
    status,
  });
  return getDelegationById(row.id);
}

const idle = () => ({ known: false, busy: false, reason: 'state_missing' });
const drained = [];
const deps = {
  finishDelegation,
  drainQueue: (r) => drained.push(r.id),
  hasInFlightDelegationStart: () => false,
};

const store = openRecoveryStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cr-deleg-restart-')) });
test.after(() => closeRecoveryStore());
let seq = 0;
function recordRun(chatId, instanceToken) {
  seq += 1;
  return beginRunLaunch({
    family: 'chat',
    owner: 'chat-run-service',
    requestId: toRecoveryRequestId(`deleg-restart-${seq}-${chatId}`),
    chatId,
    harness: 'claude',
    instanceToken,
  }, store);
}
const realEvidence = (chatId) => hasWorkspaceWatcherLeafRestartEvidence(chatId, { store });

test('restart with a running review: interrupted_restart and slot freed', () => {
  const row = makeRow('running');
  assert.equal(isDelegationSlotOccupied(row), true);
  const closed = interruptDelegationsWithRestartEvidence({
    rows: [row], ...deps, probe: idle, hasEvidence: () => true,
  });
  assert.deepEqual(closed, [row.id]);
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'interrupted_restart');
  assert.equal(isDelegationSlotOccupied(after), false);
});

test('no restart evidence or a busy child: row stays running', () => {
  const noEvidence = makeRow('running');
  const busy = makeRow('running');
  const closed = interruptDelegationsWithRestartEvidence({
    rows: [noEvidence], ...deps, probe: idle, hasEvidence: () => false,
  });
  const closedBusy = interruptDelegationsWithRestartEvidence({
    rows: [busy], ...deps, probe: () => ({ known: true, busy: true }), hasEvidence: () => true,
  });
  assert.deepEqual([...closed, ...closedBusy], []);
  assert.equal(getDelegationById(noEvidence.id).status, 'running');
  assert.equal(getDelegationById(busy.id).status, 'running');
});

test('cancelling without a live child closes without waiting for the deadline', () => {
  const row = makeRow('cancelling');
  const result = resolveCancellingDeadline(row, Date.now(), { busy: false, known: false, reason: 'state_missing', restartEvidence: true }, deps);
  assert.equal(result, 'released');
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'interrupted_restart');
  assert.equal(isDelegationSlotOccupied(after), false);
});

test('cancelling without evidence still waits for the deadline', () => {
  const row = makeRow('cancelling');
  const result = resolveCancellingDeadline(row, Date.now(), { busy: false, known: false }, deps);
  assert.equal(result, 'noop');
  assert.equal(getDelegationById(row.id).status, 'cancelling');
});

test('ambiguous probes are not proof of death: row stays running', () => {
  for (const reason of ['adapter_error', 'probe_failed', 'run_mismatch', 'adapter_missing', 'chat_missing']) {
    const row = makeRow('running');
    const closed = interruptDelegationsWithRestartEvidence({
      rows: [row], ...deps, probe: () => ({ known: false, busy: false, reason }), hasEvidence: () => true,
    });
    assert.deepEqual(closed, [], reason);
    assert.equal(getDelegationById(row.id).status, 'running', reason);
  }
  const cancelling = makeRow('cancelling');
  const result = resolveCancellingDeadline(cancelling, Date.now(),
    { busy: false, known: false, reason: 'adapter_error', restartEvidence: false }, deps);
  assert.equal(result, 'noop');
});

test('real evidence: foreign instanceToken closes, same instance and legacy run stay', () => {
  const foreign = makeRow('running');
  recordRun(foreign.childChatId, 'instance-old');
  const same = makeRow('running');
  recordRun(same.childChatId, getProcessInstance().instanceId);
  const legacy = makeRow('running');
  recordRun(legacy.childChatId, '');
  const closed = interruptDelegationsWithRestartEvidence({
    rows: [foreign, same, legacy], ...deps, probe: idle, hasEvidence: realEvidence,
  });
  assert.deepEqual(closed, [foreign.id]);
  assert.equal(getDelegationById(foreign.id).interruptCode, 'interrupted_restart');
  assert.equal(getDelegationById(same.id).status, 'running');
  assert.equal(getDelegationById(legacy.id).status, 'running');
});

test('closing a restarted delegation drains the controller queue', () => {
  const row = makeRow('running');
  drained.length = 0;
  interruptDelegationsWithRestartEvidence({
    rows: [row], ...deps, probe: idle, hasEvidence: () => true,
  });
  assert.deepEqual(drained, [row.id]);
  assert.equal(isDelegationSlotOccupied(getDelegationById(row.id)), false);
});
