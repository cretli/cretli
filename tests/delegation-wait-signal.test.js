import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import {
  DELEGATION_WAIT_FALLBACK_MS,
  DELEGATION_WAIT_POLL_MS,
} from '../lib/mcp/builtin/delegation-wait.js';
import {
  countDelegationSignalChannelsForTests,
  waitForDelegationChange,
} from '../lib/delegation-change-signal.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const parent = addChat(crypto.randomUUID(), 'wait-signal-parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

function makeJob(status) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: crypto.randomUUID(),
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
  });
  updateDelegationRecord(row.id, { status, runStoppingAt: '' });
  return getDelegationById(row.id);
}

const innerClient = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
});

/** @type {number} */
let getDelegationReads = 0;

const client = {
  ...innerClient,
  async getDelegation(input) {
    getDelegationReads += 1;
    return innerClient.getDelegation(input);
  },
};

const handlers = createCretliMcpToolHandlers(client, {
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});

const holdMs = 1500;
const job = makeJob('running');
getDelegationReads = 0;

const waitPromise = handlers.delegation_wait({
  ids: [job.id],
  timeout_ms: 15000,
});

await new Promise((resolve) => setTimeout(resolve, holdMs));
updateDelegationRecord(job.id, { status: 'completed', runStoppingAt: '' });

const result = await waitPromise;
assert.equal(result.structuredContent.status, 'done');
assert.equal(result.structuredContent.items[0].slot_occupied, false);

const pollEstimate = Math.ceil(holdMs / DELEGATION_WAIT_POLL_MS) + 2;
assert.ok(
  pollEstimate >= getDelegationReads * 10,
  `expected at least 10x fewer reads than ~${pollEstimate} ms polling (got ${getDelegationReads})`,
);
assert.ok(
  getDelegationReads <= 4,
  `signal wait should re-read rarely (got ${getDelegationReads} getDelegation calls)`,
);

{
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  assert.equal(countDelegationSignalChannelsForTests(), 0);
  const abort = new AbortController();
  const pending = waitForDelegationChange(ids, {
    signal: abort.signal,
    timeoutMs: 5000,
    fallbackMs: 60000,
  });
  assert.ok(countDelegationSignalChannelsForTests() >= 1);
  abort.abort();
  await pending.catch(() => {});
  assert.equal(countDelegationSignalChannelsForTests(), 0);
}

console.log('delegation-wait-signal.test.js OK');
