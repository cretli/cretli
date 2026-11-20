/**
 * Start path of a learned fixed pair whose member can no longer be started
 * (removed from the enabled Settings favorites): the member is evicted on
 * read, the next distinct reviewer joins through `learning`, and the pair
 * never holds more than two members.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import { confirmDurableFinish } from './helpers/delegation-durable-finish.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadDelegations } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { readReviewerPairMembers } from '../lib/persist/reviewer-pairs-persist.js';
import { resolveReviewerPolicy } from '../lib/reviewer-policy.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
stopDelegationRuntimeWorker();

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
});
const newParent = () => addChat(randomUUID(), 'pair-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const setFavorites = (ids) => fs.writeFileSync(
  path.join(ISOLATED_DATA_DIR, 'config.json'),
  JSON.stringify({ opencodeChatEnabledModels: ids }),
);
const pairModels = (parentId) => readReviewerPairMembers(parentId, undefined, 'code').map((m) => m.model);

saveDelegationSettings(workspace, {
  reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'fresh' } },
}, { dataDir: workspace });

async function startReview(parent, model) {
  const result = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: `review ${model}`,
    executor: { transport: 'opencode', model },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    reviewSubject: 'code',
    returnWhenStarting: false,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}

async function finish(row) {
  patchMockChatRun(row.childChatId, { busy: false });
  return confirmDurableFinish(finishDelegation(row, { status: 'completed', report: 'TASK: review\nVERDICT: PASS\nok' }));
}

// Criteria 8 and 10: B leaves the favorites, C joins through learning, and a
// concurrent D stays outside the pair.
{
  setFavorites(['opencode/a', 'opencode/b', 'opencode/c', 'opencode/d']);
  const parent = newParent();
  await finish(await startReview(parent, 'opencode/a'));
  await finish(await startReview(parent, 'opencode/b'));
  assert.deepEqual(pairModels(parent.id), ['opencode/a', 'opencode/b']);
  setFavorites(['opencode/a', 'opencode/c', 'opencode/d']);
  const c = await startReview(parent, 'opencode/c');
  // Membership is decided from the re-read after the learning write, so the
  // reviewer that completes the pair is recorded as a `member` (eligible).
  assert.equal(c.reviewerPolicy.membership, 'member');
  assert.deepEqual(c.reviewerPolicy.members.map((m) => m.model), ['opencode/a', 'opencode/c']);
  assert.deepEqual(pairModels(parent.id), ['opencode/a', 'opencode/c']);
  const d = await startReview(parent, 'opencode/d');
  assert.equal(d.reviewerPolicy.membership, 'outside_pool');
  assert.deepEqual(pairModels(parent.id), ['opencode/a', 'opencode/c'], 'the pair never grows past two');
  await finish(c);
  await finish(d);
}

// Criteria 6 and 9 on the start path: C leaves the favorites while its review
// runs and is kept (in flight); once that review is terminal it is evicted.
// (The start gate itself refuses a model that is not a favorite, so the
// `keepMember` exemption of the re-read is covered by the policy tests.)
{
  setFavorites(['opencode/a', 'opencode/b', 'opencode/c']);
  const parent = newParent();
  await finish(await startReview(parent, 'opencode/a'));
  await finish(await startReview(parent, 'opencode/b'));
  setFavorites(['opencode/a', 'opencode/c']);
  const c = await startReview(parent, 'opencode/c');
  assert.equal(c.reviewerPolicy.membership, 'member');
  assert.deepEqual(c.reviewerPolicy.members.map((m) => m.model), ['opencode/a', 'opencode/c']);
  setFavorites(['opencode/a']);
  const read = () => resolveReviewerPolicy(workspace, {
    subject: 'code', parentChatId: parent.id, delegations: loadDelegations(), dataDir: workspace,
  }).known.map((m) => m.model);
  assert.deepEqual(read(), ['opencode/a', 'opencode/c'], 'a member with a review in flight is kept');
  await finish(c);
  assert.deepEqual(read(), ['opencode/a']);
}

console.log('reviewer-pair-unstartable-member: ok');
