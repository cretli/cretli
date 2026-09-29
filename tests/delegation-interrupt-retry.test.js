import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { assertReviewAdapterAllowed } from '../lib/delegation-adapter-capabilities.js';
import { summarizeDelegation as summarizeDelegationQuery } from '../lib/delegation-query.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

function newParent(title) {
  return addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

function seedInterrupted(parentChatId, interruptCode) {
  const child = addChat(crypto.randomUUID(), 'interrupt child', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const row = createDelegationRecord({
    parentChatId,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'interrupted',
    attemptId: 'a1',
    sourceKind: 'text',
    sourceText: 'retry this task',
  });
  updateDelegationRecord(row.id, {
    status: 'interrupted',
    interruptCode,
    finishedAt: new Date().toISOString(),
    runStoppingAt: '',
  });
  return getDelegationById(row.id);
}

// Legacy interrupted rows without an interrupt code are stop-only.
{
  const job = seedInterrupted(newParent('legacy interrupt').id, '');
  const refused = await service.retry(job.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'interrupted_no_retry');
}

// starting_timeout is stop-only.
{
  const job = seedInterrupted(newParent('starting timeout interrupt').id, 'starting_timeout');
  const refused = await service.retry(job.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'interrupted_no_retry');
}

// running_orphan is stop-only.
{
  const job = seedInterrupted(newParent('running orphan interrupt').id, 'running_orphan');
  const refused = await service.retry(job.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'interrupted_no_retry');
}

// server_restart may be continued exactly once; a later restart interrupt on
// the same record is refused.
{
  const job = seedInterrupted(newParent('server restart interrupt').id, 'server_restart');
  const retried = await service.retry(job.id);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const afterRetry = getDelegationById(job.id);
  assert.equal(afterRetry.status === 'running' || afterRetry.status === 'starting', true);
  assert.equal(afterRetry.interruptCode, '');
  assert.ok(String(afterRetry.interruptContinuedAt || '').trim());

  updateDelegationRecord(job.id, {
    status: 'interrupted',
    interruptCode: 'server_restart',
    finishedAt: new Date().toISOString(),
    runStoppingAt: '',
  });
  const second = await service.retry(job.id);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'interrupted_retry_exhausted');
}

// Review certification: default refusal, opt-in allows but flags uncertified,
// and a hard-guarantee adapter stays certified.
{
  delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
  const refused = assertReviewAdapterAllowed('codex');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review_uncertified');
  assert.equal(refused.reviewUncertified, true);

  process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED = '1';
  const allowed = assertReviewAdapterAllowed('codex');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reviewUncertified, true);

  const certified = assertReviewAdapterAllowed('opencode');
  assert.equal(certified.ok, true);
  assert.equal(certified.reviewUncertified, false);
}

// A review that only starts through the opt-in carries reviewUncertified on
// the service result.
{
  registerChatRunAdapter({
    transport: 'codex',
    getState: () => ({ runId: 'codex-run', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'codex-run' }),
  });
  process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED = '1';
  const parent = newParent('uncertified review');
  const started = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'review this change',
    assignment: 'review',
    executor: { transport: 'codex', model: 'codex/gpt-5' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.reviewUncertified, true);
  delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
  registerMockChatRunAdapter('opencode');
}

// delegation_start surfaces review_uncertified in structured content and a
// visible text warning.
{
  const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
  assert.ok(startTool);
  const fakeRow = {
    id: 'd-uncertified',
    status: 'starting',
    parentChatId: 'p-uncertified',
    childChatId: 'c-uncertified',
    executor: { transport: 'codex', model: 'codex/gpt-5' },
    assignment: 'review',
    attempts: [],
  };
  const client = {
    async getChat() {
      return { id: 'p-uncertified', workspaceFolder: ISOLATED_DATA_DIR };
    },
    async startDelegation() {
      return { delegation: fakeRow, replayed: false, reviewUncertified: true };
    },
  };
  const result = await startTool.handler(
    {
      task_text: 'review this change',
      harness: 'codex',
      model: 'codex/gpt-5',
      idempotency_key: 'uncertified-review-1',
      assignment: 'review',
      chat_id: 'p-uncertified',
    },
    { client, session: { chatId: 'p-uncertified', workspaceFolder: ISOLATED_DATA_DIR } },
  );
  assert.equal(result.structuredContent.review_uncertified, true);
  assert.match(result.content[0].text, /review_uncertified=true/);
}

// interrupt_code is surfaced by the query summary and delegation_show text.
{
  const job = seedInterrupted(newParent('surface interrupt').id, 'running_orphan');
  const row = getDelegationById(job.id);
  assert.equal(summarizeDelegationQuery(row).interruptCode, 'running_orphan');
  const showTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_show');
  assert.ok(showTool);
  const client = {
    async getDelegation() {
      return row;
    },
  };
  const result = await showTool.handler(
    { delegation_id: row.id },
    { client, session: { chatId: row.parentChatId, workspaceFolder: ISOLATED_DATA_DIR } },
  );
  assert.equal(result.structuredContent.interrupt_code, 'running_orphan');
  assert.match(result.content[0].text, /interrupt_code=running_orphan/);
}

console.log('delegation-interrupt-retry.test.js OK');
