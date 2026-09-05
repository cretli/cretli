import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  isDelegationAttention,
  resolveChatAgentPresence,
  summarizeChatRunStates,
} from '../lib/agent-run-state.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  patchMockChatRun,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const waitingRow = {
  id: 'd1',
  status: 'waiting_for_input',
  acknowledgedAt: '',
  runId: 'r1',
};
assert.equal(isDelegationAttention(waitingRow), true);
assert.equal(isDelegationAttention({ ...waitingRow, acknowledgedAt: '2026-09-05T00:00:00.000Z' }), false);
assert.equal(isDelegationAttention({ id: 'd2', status: 'completed', acknowledgedAt: '' }), true);
assert.equal(isDelegationAttention({ id: 'd3', status: 'cancelled', acknowledgedAt: '' }), false);

const waitingPresence = resolveChatAgentPresence(null, waitingRow);
assert.equal(waitingPresence.state, 'waiting');
assert.equal(waitingPresence.attention, true);

const busyPresence = resolveChatAgentPresence({ busy: true, runId: 'r2' }, {
  id: 'd4',
  status: 'running',
  runId: 'r2',
});
assert.equal(busyPresence.state, 'busy');
assert.equal(busyPresence.attention, false);

const donePresence = resolveChatAgentPresence(null, {
  id: 'd5',
  status: 'completed',
  acknowledgedAt: '',
});
assert.equal(donePresence.state, 'attention');
assert.equal(donePresence.delegationStatus, 'completed');

const parent = addChat('sess-agent-state-parent', 'Planner', null, '/tmp/ws', 'model', {
  agentTransport: 'opencode',
});
const child = addChat('sess-agent-state-child', 'Executor', null, '/tmp/ws', 'model', {
  agentTransport: 'opencode',
});
const record = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: child.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  status: 'running',
  runId: 'run-1',
});
const started = await (await import('../lib/chat-run-service.js')).startChatRun({
  chatId: child.id,
  prompt: 'go',
});
assert.ok(started.runId);
updateDelegationRecord(record.id, { runId: started.runId, status: 'running' });

const states = summarizeChatRunStates([parent.id, child.id]);
assert.equal(states[child.id].state, 'busy');
assert.equal(states[parent.id].state, 'busy');
assert.equal(states[child.id].delegationId, record.id);

patchMockChatRun(child.id, { waitingForInput: true, busy: true });
updateDelegationRecord(record.id, { status: 'waiting_for_input' });
const waitingStates = summarizeChatRunStates([child.id]);
assert.equal(waitingStates[child.id].state, 'waiting');
assert.equal(waitingStates[child.id].attention, true);

updateDelegationRecord(record.id, { acknowledgedAt: new Date().toISOString() });
const openedWaiting = summarizeChatRunStates([child.id]);
assert.equal(openedWaiting[child.id].state, 'busy');

updateDelegationRecord(record.id, {
  status: 'completed',
  finishedAt: new Date().toISOString(),
});
patchMockChatRun(child.id, { busy: false, waitingForInput: false });
const doneStates = summarizeChatRunStates([child.id, parent.id]);
assert.equal(doneStates[child.id].state, 'attention');
assert.equal(doneStates[parent.id].state, 'attention');

updateDelegationRecord(record.id, { acknowledgedAt: new Date().toISOString(), unverified: false });
const ackedStates = summarizeChatRunStates([child.id]);
assert.equal(ackedStates[child.id].state, 'idle');
assert.equal(ackedStates[child.id].attention, false);

console.log('agent-run-state.test.js OK');
