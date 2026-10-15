import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService, finishDelegation, releaseDelegationRunSlot } from '../lib/delegation-service.js';
import { findDelegationByChildChatId, getDelegationById } from '../lib/persist/delegations-persist.js';
import {
  getMockChatRun,
  listMockChatRunChatIds,
  patchMockChatRun,
  registerMockChatRunAdapter,
  setMockChatRunFailStart,
  setMockChatRunListener,
} from '../lib/chat-run/mock-adapter.js';
import { isTerminalDelegationStatus } from '../lib/delegation-status.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { recordPlanWindowReservation } from '../lib/plan-window-reservations.js';
import { clearPlanWindowReservationCache } from '../lib/plan-window-reservations.js';

const HARNESS = 'opencode';
const MODEL = 'opencode/test';
const MIN = 60 * 1000;
const RES_FILE = path.join(ISOLATED_DATA_DIR, 'plan-window-reservations.json');

const seedPlanLimits = () => {
  const now = Date.now();
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'harness-plan-limits.json'), JSON.stringify([{
    harness: HARNESS,
    rateLimitType: 'seven_day',
    utilization: 40,
    resetsAt: new Date(now + 3 * 60 * MIN).toISOString(),
    observedAt: new Date(now - MIN).toISOString(),
    utilizationObservedAt: new Date(now - MIN).toISOString(),
  }]));
};
const flush = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
const readEntries = () => {
  clearPlanWindowReservationCache();
  try {
    const store = JSON.parse(fs.readFileSync(RES_FILE, 'utf8'));
    return Object.values(store).flatMap((slot) => Object.keys(slot.entries));
  } catch {
    return [];
  }
};
const releaseActive = () => {
  for (const chatId of listMockChatRunChatIds()) {
    const row = findDelegationByChildChatId(chatId);
    if (row && !isTerminalDelegationStatus(row.status)) {
      finishDelegation(row, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS' });
    }
    const latest = row ? getDelegationById(row.id) : null;
    if (latest) releaseDelegationRunSlot(latest);
    patchMockChatRun(chatId, { busy: false, waitingForInput: false });
  }
};
const reset = () => {
  releaseActive();
  fs.rmSync(RES_FILE, { force: true });
  clearPlanWindowReservationCache();
  setMockChatRunListener(() => {});
  setMockChatRunFailStart(false);
};
const setup = () => {
  registerMockChatRunAdapter(HARNESS);
  seedPlanLimits();
  const parent = addChat(crypto.randomUUID(), 'Parent', null, ISOLATED_DATA_DIR, MODEL, {
    agentTransport: HARNESS, sdkMode: 'agent',
  });
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    dataDir: ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const start = (key, extra = {}) => service.createAndStart({
    parentChatId: parent.id, sourceKind: 'text', taskText: 'Do the work.',
    assignment: 'implement', executionMode: 'agent',
    executor: { transport: HARNESS, model: MODEL },
    idempotencyKey: key, ...extra,
  });
  return { service, start };
};

test('start reserves once per attempt; replay does not double count; retry counts', async () => {
  reset();
  const { service, start } = setup();
  const first = await start('pw-start');
  assert.equal(first.ok, true, JSON.stringify(first));
  await flush();
  const afterStart = readEntries();
  assert.equal(afterStart.length, 1);
  const replay = await start('pw-start');
  assert.equal(replay.ok, true);
  await flush();
  assert.equal(readEntries().length, 1, 'replay of the same key is not counted twice');
  finishDelegation(first.delegation, { status: 'failed', error: 'Transient interruption' });
  patchMockChatRun(first.delegation.childChatId, { busy: false, waitingForInput: false });
  releaseDelegationRunSlot(getDelegationById(first.delegation.id));
  const retry = await service.retry(first.delegation.id);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  await flush();
  assert.equal(readEntries().length, 2, 'a retry is a new attempt and counts');
  assert.equal(getMockChatRun(first.delegation.childChatId).busy, true);
});

test('a run that terminates before the start await returns still reserves', async () => {
  reset();
  const { start } = setup();
  setMockChatRunListener((event) => {
    if (event.type !== 'started') return;
    const row = findDelegationByChildChatId(event.chatId);
    if (row) finishDelegation(row, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS' });
  });
  const result = await start('pw-immediate');
  assert.equal(result.ok, true, JSON.stringify(result));
  await flush();
  assert.equal(readEntries().length, 1);
});

test('a rejected start writes nothing', async () => {
  reset();
  const { start } = setup();
  setMockChatRunFailStart(true);
  const result = await start('pw-rejected');
  assert.equal(result.ok, false);
  await flush();
  assert.equal(readEntries().length, 0);
});

test('D8: with plan-window disabled the history sees the pure measurement, not the overlay', () => {
  reset();
  const now = Date.now();
  const row = {
    harness: HARNESS,
    rateLimitType: 'seven_day',
    utilization: 88,
    resetsAt: new Date(now + 3 * 60 * MIN).toISOString(),
    observedAt: new Date(now - 5 * MIN).toISOString(),
    utilizationObservedAt: new Date(now - 5 * MIN).toISOString(),
  };
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'harness-plan-limits.json'), JSON.stringify([row]));
  const recorded = recordPlanWindowReservation({
    harness: HARNESS, model: MODEL, role: 'implement', idempotencyKey: 'd8:a',
    planLimits: [row], now, dataDir: ISOLATED_DATA_DIR,
  });
  assert.ok(recorded.recorded > 0);
  const find = (history) => history.planLimits.find((r) => r.rateLimitType === 'seven_day');
  const enabled = find(buildModelPickHistory({ role: 'implement', delegations: [], now }));
  assert.equal(enabled.utilization, 91);
  assert.equal(enabled.utilizationEstimated, true);
  const disabled = find(buildModelPickHistory({
    role: 'implement', delegations: [], now, planWindowConfig: { enabled: false },
  }));
  assert.equal(disabled.utilization, 88);
  assert.equal(disabled.utilizationEstimated, undefined);
  reset();
});
