/**
 * `inputRequested`: the additive presence flag the car view reads. It marks every way an agent is
 * waiting for the person, including those hidden behind `busy` or an overridden `state`.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveChatAgentPresence, summarizeChatRunStates } from '../lib/agent-run-state.js';
import { setBrowserConsentPending } from '../lib/agent-presence-hooks.js';
import { closeRecoveryStore, getRun, openRecoveryStore, transitionRun, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';

const at = (s) => `2026-11-04T18:00:${String(s).padStart(2, '0')}.000Z`;

function writeDelegations(items) {
  fs.writeFileSync(
    path.join(ISOLATED_DATA_DIR, 'delegations.json'),
    JSON.stringify({ v: 2, items: items.map((row) => ({ revision: 1, createdAt: at(1), ...row })) })
  );
}

function seedRecoveryRun(chatId, to) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    chatId,
    sessionId: 's',
    harness: 'testfake',
  });
  let run = getRun(ids.logicalRunId);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }).run;
  transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to, reason: 'test' });
}

test('an unacknowledged waiting_for_input delegation sets the flag', () => {
  const row = resolveChatAgentPresence(null, { id: 'd', status: 'waiting_for_input', acknowledgedAt: '' });
  assert.equal(row.state, 'waiting');
  assert.equal(row.inputRequested, true);
  const acked = resolveChatAgentPresence(null, {
    id: 'd', status: 'waiting_for_input', acknowledgedAt: '2026-11-04T18:00:00.000Z',
  });
  assert.equal(acked.inputRequested, undefined);
});

test('a run waiting for input sets the flag with or without a delegation', () => {
  const alone = resolveChatAgentPresence({ waitingForInput: true }, null);
  assert.equal(alone.state, 'waiting');
  assert.equal(alone.inputRequested, true);
  // An active child delegation turns the state into busy; the run's own request must survive that.
  const withChild = resolveChatAgentPresence({ waitingForInput: true }, { id: 'c', status: 'running' });
  assert.equal(withChild.state, 'busy');
  assert.equal(withChild.inputRequested, true);
});

test('plain busy and idle rows carry no flag', () => {
  assert.equal(resolveChatAgentPresence({ busy: true }, null).inputRequested, undefined);
  assert.equal(resolveChatAgentPresence(null, null).inputRequested, undefined);
  assert.equal(resolveChatAgentPresence({ waitingForInput: false }, { id: 'c', status: 'running' }).inputRequested, undefined);
});

test('summaries keep the flag when sub-agents override the state', () => {
  writeDelegations([
    { id: 'child-run', parentChatId: 'parent', childChatId: 'child', status: 'running' },
    { id: 'wait', parentChatId: 'asker', childChatId: 'asker-child', status: 'waiting_for_input', acknowledgedAt: '' },
    { id: 'asker-sub', parentChatId: 'asker', controllerChatId: 'asker', childChatId: 'asker-sub-chat', status: 'running' },
  ]);
  const chats = ['parent', 'child', 'asker', 'asker-child'].map((id) => ({ id }));
  const out = summarizeChatRunStates(chats.map((c) => c.id), { chats });
  // Sub-agents but nobody asks for input: the flag stays false.
  assert.equal(out.parent.state, 'waiting');
  assert.equal(out.parent.waitingAgentCount, 1);
  assert.equal(out.parent.inputRequested, undefined);
  // The asking child keeps its flag.
  assert.equal(out['asker-child'].inputRequested, true);
});

test('browser consent sets the flag', () => {
  writeDelegations([]);
  setBrowserConsentPending('consent-chat', true);
  try {
    const out = summarizeChatRunStates(['consent-chat'], { chats: [{ id: 'consent-chat' }] });
    assert.equal(out['consent-chat'].state, 'waiting');
    assert.equal(out['consent-chat'].inputRequested, true);
  } finally {
    setBrowserConsentPending('consent-chat', false);
  }
});

test('recovery waiting sets the flag on idle, attention and waiting rows but not on busy', () => {
  writeDelegations([
    { id: 'att', parentChatId: 'p-att', childChatId: 'c-att', status: 'completed', acknowledgedAt: '' },
    { id: 'wt', parentChatId: 'p-wt', childChatId: 'c-wt', status: 'waiting_for_input', acknowledgedAt: '' },
    { id: 'bz', parentChatId: 'p-bz', childChatId: 'c-bz', status: 'running' },
  ]);
  openRecoveryStore();
  for (const id of ['c-idle', 'c-att', 'c-wt', 'c-bz']) seedRecoveryRun(id, 'waiting');
  try {
    const ids = ['c-idle', 'c-att', 'c-wt', 'c-bz'];
    const out = summarizeChatRunStates(ids, { chats: ids.map((id) => ({ id })) });
    assert.equal(out['c-idle'].recoveryStatus, 'waiting');
    assert.equal(out['c-idle'].inputRequested, true, 'idle');
    assert.equal(out['c-att'].inputRequested, true, 'attention');
    assert.equal(out['c-wt'].inputRequested, true, 'waiting');
    assert.equal(out['c-bz'].state, 'busy');
    assert.equal(out['c-bz'].inputRequested, undefined, 'busy is not marked');
  } finally {
    closeRecoveryStore();
  }
});
