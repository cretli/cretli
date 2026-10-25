/**
 * adapter_no_verdict bounded fallback: real route starts for a code review.
 * Happy path plus the negative cases (real verdict, wrong subject, stale
 * material, manual/unfresh pick, second fallback, fallback chain).
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { getDelegationById, loadDelegations, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { snapshotDelegationAttempt } from '../lib/delegation-attempt.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { markDelegationAutomaticController } from '../lib/delegation-start-context.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
registerMockChatRunAdapter('codebuddy');

const workspace = ISOLATED_DATA_DIR;
const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });

async function invoke(method, route, req = {}) {
  let status = 200;
  let payload;
  const res = {
    status(code) { status = code; return this; },
    json(value) { payload = value; return this; },
  };
  await routes.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body: payload };
}

const FIRST = { transport: 'testfake', model: 'testfake/test' };
const SECOND = { transport: 'codebuddy', model: 'hy3' };
let seq = 0;
const makeParent = () => {
  seq += 1;
  const chat = addChat(randomUUID(), `nv-${seq}`, null, workspace, 'testfake/orchestrator', { agentTransport: 'testfake', sdkMode: 'agent' });
  markDelegationAutomaticController(chat.id, 'watcher_cycle');
  return chat;
};
const pickFor = (chatId, executor, role = 'review', extra = {}) => persistModelPickProposal({
  chatId,
  workspaceFolder: workspace,
  role,
  pickResult: { pick: { harness: executor.transport, model: executor.model }, picks: [{ harness: executor.transport, model: executor.model }] },
  ...extra,
});
const reviewBody = (parent, leafId, extra = {}) => ({
  executor: FIRST,
  sourceKind: 'text',
  taskText: 'Review the change.',
  executionMode: 'agent',
  assignment: 'review',
  reviewSubject: 'code',
  leafId,
  idempotencyKey: randomUUID(),
  pickId: pickFor(parent.id, FIRST).pickId,
  ...extra,
});
const post = (parent, b) => invoke('POST', '/api/chats/:id/delegations', { params: { id: parent.id }, body: b });
const fallbackBody = (parent, leafId, fromId, extra = {}) => reviewBody(parent, leafId, {
  executor: SECOND,
  pickFallbackFrom: fromId,
  pickId: pickFor(parent.id, SECOND).pickId,
  ...extra,
});

let leafSeq = 0;
/** Start a first code review and fail it with the given record fields. */
async function failedReview(parent, record = {}, startExtra = {}) {
  leafSeq += 1;
  const leafId = `cafe0000000010${String(leafSeq).padStart(2, '0')}`;
  const started = await post(parent, reviewBody(parent, leafId, startExtra));
  assert.ok([201, 202].includes(started.status), JSON.stringify(started.body));
  updateDelegationRecord(started.body.delegation.id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error: 'adapter_no_verdict: review produced no VERDICT line',
    report: 'Reviewed the change. No defects found.',
    ...record,
  });
  return { id: started.body.delegation.id, leafId };
}

// Happy path: a no-verdict failure allows exactly one audited replacement.
const parent = makeParent();
const base = await failedReview(parent);
const ok = await post(parent, fallbackBody(parent, base.leafId, base.id));
assert.equal(ok.status, 201, JSON.stringify(ok.body));
assert.equal(ok.body.delegation.pickOriginDetail, 'fallback');
assert.equal(ok.body.delegation.fallbackFailureClass, 'no_verdict');
assert.equal(ok.body.delegation.pickFallbackFrom, base.id);

// The proof is attempt-bound and survives a store reload (restart roundtrip).
const basePersisted = getDelegationById(base.id);
const okPersisted = loadDelegations().find((row) => row.id === ok.body.delegation.id);
assert.ok(basePersisted.attemptId);
assert.equal(okPersisted.pickFallbackFromAttemptId, basePersisted.attemptId);
assert.equal(okPersisted.pickFallbackAttemptId, okPersisted.attemptId);
assert.equal(snapshotDelegationAttempt(okPersisted).pickFallbackFromAttemptId, basePersisted.attemptId);
assert.equal(snapshotDelegationAttempt(okPersisted).pickFallbackAttemptId, okPersisted.attemptId);

// Single use, also across a different pick, and no chain from the fallback itself.
const second = await post(parent, fallbackBody(parent, base.leafId, base.id));
assert.equal(second.body.code, 'fallback_already_used');
updateDelegationRecord(ok.body.delegation.id, {
  status: 'failed', finishedAt: new Date().toISOString(), error: 'adapter_no_verdict',
});
const chained = await post(parent, fallbackBody(parent, base.leafId, ok.body.delegation.id, { executor: FIRST, pickId: pickFor(parent.id, FIRST).pickId }));
assert.equal(chained.body.code, 'fallback_not_allowed', 'a fallback never chains');

// A report that carries a real verdict is an answer, not a gap.
for (const [label, record] of [
  ['FAIL', { report: 'TASK: review\nVERDICT: FAIL', reportVerdict: 'FAIL' }],
  ['BLOCKED', { report: 'TASK: review\nVERDICT: BLOCKED', reportVerdict: 'BLOCKED' }],
  ['PASS', { report: 'TASK: review\nVERDICT: PASS', reportVerdict: 'PASS' }],
  ['conflict', { report: 'VERDICT: PASS\nVERDICT: FAIL' }],
]) {
  const pred = await failedReview(parent, record);
  const res = await post(parent, fallbackBody(parent, pred.leafId, pred.id));
  assert.equal(res.body.code, 'fallback_not_allowed', `${label} verdict is not a no-verdict gap`);
}

// Empty report with the no-verdict code still qualifies (nothing contradicts it).
const empty = await failedReview(parent, { report: '' });
const emptyOk = await post(parent, fallbackBody(parent, empty.leafId, empty.id));
assert.equal(emptyOk.status, 201, JSON.stringify(emptyOk.body));

// Wrong review subject: a plan review never gets the code-review fallback.
const planPred = await failedReview(parent, {}, { reviewSubject: 'plan' });
const planRes = await post(parent, fallbackBody(parent, planPred.leafId, planPred.id, { reviewSubject: 'plan' }));
assert.equal(planRes.body.code, 'fallback_not_allowed');
const mixedPred = await failedReview(parent);
const mixedRes = await post(parent, fallbackBody(parent, mixedPred.leafId, mixedPred.id, { reviewSubject: 'plan' }));
assert.equal(mixedRes.body.code, 'fallback_not_allowed', 'subject must match the failed attempt');

// Wrong controller / leaf.
const other = makeParent();
const foreignPred = await failedReview(parent);
const foreignRes = await post(other, fallbackBody(other, foreignPred.leafId, foreignPred.id));
assert.notEqual(foreignRes.status, 201, 'another controller cannot reuse the failed attempt');
const leafPred = await failedReview(parent);
const leafRes = await post(parent, fallbackBody(parent, 'cafe00000000ffff', leafPred.id));
assert.notEqual(leafRes.status, 201, 'another leaf cannot reuse the failed attempt');

// Stale material: an implement queued after the failed review closes the round.
const stalePred = await failedReview(parent);
const implement = await post(parent, {
  executor: FIRST, sourceKind: 'text', taskText: 'Implement.', executionMode: 'agent', assignment: 'implement',
  leafId: stalePred.leafId, idempotencyKey: randomUUID(), pickId: pickFor(parent.id, FIRST, 'implement').pickId,
});
assert.ok([201, 202].includes(implement.status), JSON.stringify(implement.body));
updateDelegationRecord(implement.body.delegation.id, { status: 'completed', finishedAt: new Date().toISOString(), report: 'VERDICT: PASS' });
const staleRes = await post(parent, fallbackBody(parent, stalePred.leafId, stalePred.id));
assert.equal(staleRes.body.code, 'fallback_not_allowed');

// Manual / unrelated pick: the fallback needs a fresh pick of its own.
const manualPred = await failedReview(parent);
const noPick = await post(parent, fallbackBody(parent, manualPred.leafId, manualPred.id, { pickId: '' }));
assert.notEqual(noPick.status, 201);
const reusedPick = await post(parent, fallbackBody(parent, manualPred.leafId, manualPred.id, { pickId: manualPred.pickId || pickFor(parent.id, FIRST).pickId }));
assert.notEqual(reusedPick.status, 201, 'a pick that does not propose the new executor is rejected');

// Existing behavior for other classes is unchanged: auth still allows one fallback.
const authPred = await failedReview(parent, { error: '401 Unauthorized', report: '' });
const authRes = await post(parent, fallbackBody(parent, authPred.leafId, authPred.id));
assert.equal(authRes.status, 201, JSON.stringify(authRes.body));
assert.equal(authRes.body.delegation.fallbackFailureClass, 'auth');
const unknownPred = await failedReview(parent, { error: 'something odd happened' });
const unknownRes = await post(parent, fallbackBody(parent, unknownPred.leafId, unknownPred.id));
assert.equal(unknownRes.body.code, 'fallback_not_allowed');

removeIsolatedDataDir();
console.log('delegation-fallback-no-verdict.test.js OK');
