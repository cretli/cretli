import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import {
  listActiveDelegationsForParent,
  listDelegationsForParent,
} from '../lib/persist/delegations-persist.js';
import { readDelegationReviewFanout } from '../lib/delegation-width.js';
import { toCretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../lib/mcp/builtin/errors.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-review-fanout-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

const previousFanout = process.env.CRETLI_DELEGATION_REVIEW_FANOUT;

function createParent(title) {
  const chat = addChat(`sess-${title}`, title, null, project, 'planner-model', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  writeChatPlanFile({
    cwd: project,
    chatId: chat.id,
    title,
    markdown: `# ${title}\n\n- step one`,
    sourceTurnId: 'turn-1',
  });
  return chat;
}

async function startReview(parent, key) {
  const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    planRevision: planDoc.revision,
    assignment: 'review',
    idempotencyKey: key,
  });
}

async function startImplement(parent, key) {
  const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    planRevision: planDoc.revision,
    assignment: 'implement',
    idempotencyKey: key,
  });
}

function restoreFanout() {
  if (previousFanout == null) delete process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
  else process.env.CRETLI_DELEGATION_REVIEW_FANOUT = previousFanout;
}

try {
  delete process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '0';
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = 'garbage';
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '2';
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '2garbage';
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '2.0';
  assert.equal(readDelegationReviewFanout(), 2);
  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '9';
  assert.equal(readDelegationReviewFanout(), 2);

  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '1';
  const flagOneParent = createParent('Fanout one');
  const firstReview = await startReview(flagOneParent, 'fanout-1-a');
  assert.equal(firstReview.ok, true);
  const secondReviewBlocked = await startReview(flagOneParent, 'fanout-1-b');
  assert.equal(secondReviewBlocked.ok, false);
  assert.equal(secondReviewBlocked.code, 'active_delegation_exists');
  const replaySame = await startReview(flagOneParent, 'fanout-1-a');
  assert.equal(replaySame.ok, true);
  assert.equal(replaySame.delegation.id, firstReview.delegation.id);

  process.env.CRETLI_DELEGATION_REVIEW_FANOUT = '2';
  const flagTwoParent = createParent('Fanout two');
  const reviewA = await startReview(flagTwoParent, 'fanout-2-a');
  const reviewB = await startReview(flagTwoParent, 'fanout-2-b');
  assert.equal(reviewA.ok, true);
  assert.equal(reviewB.ok, true);
  assert.notEqual(reviewA.delegation.id, reviewB.delegation.id);
  assert.equal(listActiveDelegationsForParent(flagTwoParent.id).length, 2);

  const reviewFull = await startReview(flagTwoParent, 'fanout-2-c');
  assert.equal(reviewFull.ok, false);
  assert.equal(reviewFull.code, 'review_fanout_full');

  const mixedParent = createParent('Fanout mixed');
  const mixedReview = await startReview(mixedParent, 'fanout-mix-r');
  assert.equal(mixedReview.ok, true);
  const mixedImplement = await startImplement(mixedParent, 'fanout-mix-i');
  assert.equal(mixedImplement.ok, false);
  assert.equal(mixedImplement.code, 'active_delegation_exists');

  const implementFirst = createParent('Fanout implement first');
  const implJob = await startImplement(implementFirst, 'fanout-impl');
  assert.equal(implJob.ok, true);
  const reviewAfterImpl = await startReview(implementFirst, 'fanout-impl-r');
  assert.equal(reviewAfterImpl.ok, false);
  assert.equal(reviewAfterImpl.code, 'active_delegation_exists');

  const nestedParent = createParent('Fanout nested parent');
  const childChat = addChat('sess-nested-child', 'Child', null, project, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    delegationParentChatId: nestedParent.id,
  });
  const nested = await service.createAndStart({
    parentChatId: childChat.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    taskText: 'grandchild',
    sourceKind: 'text',
    assignment: 'review',
    idempotencyKey: 'fanout-nested',
  });
  assert.equal(nested.ok, false);
  assert.equal(nested.code, 'nested_delegation_denied');

  const retryParent = createParent('Fanout retry');
  const doneReview = await startReview(retryParent, 'fanout-retry-done');
  assert.equal(doneReview.ok, true);
  finishDelegation(doneReview.delegation, { status: 'completed', report: 'first review done' });
  patchMockChatRun(doneReview.delegation.childChatId, { busy: false, waitingForInput: false });
  const otherReview = await startReview(retryParent, 'fanout-retry-live');
  assert.equal(otherReview.ok, true);
  const retried = await service.retry(doneReview.delegation.id);
  assert.equal(retried.ok, true);
  assert.equal(listActiveDelegationsForParent(retryParent.id).length, 2);

  const retryFull = await service.retry(doneReview.delegation.id);
  assert.equal(retryFull.ok, false);
  assert.equal(retryFull.code, 'still_active');

  const thirdFinished = createParent('Fanout retry full');
  const a = await startReview(thirdFinished, 'fanout-rf-a');
  const b = await startReview(thirdFinished, 'fanout-rf-b');
  assert.equal(a.ok && b.ok, true);
  finishDelegation(a.delegation, { status: 'completed', report: 'parked' });
  patchMockChatRun(a.delegation.childChatId, { busy: false, waitingForInput: false });
  const c = await startReview(thirdFinished, 'fanout-rf-c');
  assert.equal(c.ok, true);
  const retryWhileTwo = await service.retry(a.delegation.id);
  assert.equal(retryWhileTwo.ok, false);
  assert.equal(retryWhileTwo.code, 'review_fanout_full');
  assert.equal(listDelegationsForParent(thirdFinished.id).length, 3);

  const mapped = toCretliMcpToolError({
    code: 'review_fanout_full',
    message: 'Two review jobs are already running for this chat.',
  });
  assert.equal(mapped.code, MCP_BUILTIN_ERROR_CODES.CONFLICT);

  const centerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../app_front/features/delegations/delegationCenter.js',
  );
  const centerSrc = fs.readFileSync(centerPath, 'utf8');
  assert.match(centerSrc, /loadedRows\.map\(renderRow\)/);
  assert.match(centerSrc, /data-act="cancel"/);
  assert.match(centerSrc, /data-id="\$\{id\}"/);
  assert.match(centerSrc, /slotHeld/);
  assert.equal(/cancelAll|data-act="cancel-all"/.test(centerSrc), false);

  delete process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
  const defaultParent = createParent('Fanout default');
  const defaultA = await startReview(defaultParent, 'fanout-default-a');
  const defaultB = await startReview(defaultParent, 'fanout-default-b');
  assert.equal(defaultA.ok, true);
  assert.equal(defaultB.ok, true);
  const defaultFull = await startReview(defaultParent, 'fanout-default-c');
  assert.equal(defaultFull.ok, false);
  assert.equal(defaultFull.code, 'review_fanout_full');
} finally {
  restoreFanout();
}

console.log('delegation-review-fanout.test.js OK');
