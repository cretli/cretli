/**
 * Regression test for the shadow-only complexity level stored on a delegation
 * row (cost-proxy follow-up F1a).
 *
 * The linked `model_pick` record carries `complexity.level`; a start that links
 * that pick must journal the level on its delegation row so later token history
 * can bucket per `(model, role, level)`. A start without a linked pick (or with
 * an unknown level) must stay unchanged.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { getDelegationById, loadDelegations } from '../lib/persist/delegations-persist.js';
import { createModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';
import { collectTokenSamples } from '../lib/model-pick-cost-proxy.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-complexity-ws-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

const parent = addChat('sess-complexity', 'Complexity planner', null, project, 'planner-model', {
  agentTransport: 'testfake',
  sdkMode: 'plan',
});
writeChatPlanFile({
  cwd: project,
  chatId: parent.id,
  title: 'Complexity',
  markdown: '# Complexity\n\n- step one',
  sourceTurnId: 'turn-1',
});
const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });

const executor = { transport: 'testfake', model: 'testfake/test' };
const pick = createModelPickRecord({
  chatId: parent.id,
  workspaceFolder: project,
  purpose: 'model_pick',
  role: 'implement',
  complexity: { level: 'demanding', signals: ['explicit_heavy'] },
  candidates: [{ selectionSlot: 0, candidateId: 'testfake/testfake/test', harness: 'testfake', model: 'testfake/test' }],
  picks: [{ selectionSlot: 0, candidateId: 'testfake/testfake/test', harness: 'testfake', model: 'testfake/test' }],
});

const linked = await service.createAndStart({
  parentChatId: parent.id,
  executor,
  assignment: 'implement',
  executionMode: 'agent',
  planRevision: planDoc.revision,
  idempotencyKey: 'complexity-linked',
  pickId: pick.id,
});
assert.equal(linked.ok, true, JSON.stringify(linked).slice(0, 300));
const linkedRow = getDelegationById(linked.delegation.id);
assert.ok(linkedRow.complexity, 'the linked pick level is persisted on the row');
assert.equal(linkedRow.complexity.level, 'demanding');
// The persisted level reaches the token sampler, so the exact bucket fills.
const samples = collectTokenSamples(
  [{ ...linkedRow, metrics: { tokens_in: 10, tokens_out: 2 } }],
  (row) => row.assignment,
);
assert.ok(samples.byModelRoleLevel.has('testfake/test|implement|demanding'));

// A start without a linked pick has no level.
const plain = await service.createAndStart({
  parentChatId: parent.id,
  executor,
  assignment: 'implement',
  executionMode: 'agent',
  planRevision: planDoc.revision,
  idempotencyKey: 'complexity-plain',
});
assert.equal(plain.ok, true, JSON.stringify(plain).slice(0, 300));
const plainRow = loadDelegations().find((row) => row.id === plain.delegation.id);
assert.equal(plainRow.complexity, undefined, 'an unknown level leaves the field absent');

removeIsolatedDataDir();
console.log('delegation-complexity-persist.test.js OK');
