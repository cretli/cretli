/**
 * Part A of the server-owned `todo.review` contract: review subject on the job
 * and attempt, report/verify/ack evidence, retry reset and the acceptance actor
 * derived from the authenticated channel (`docs/todo-review-contract.md` §3,
 * §5, §7).
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  createDelegationService,
  finishDelegation,
  recordDelegationVerifyResult,
} from '../lib/delegation-service.js';
import { snapshotDelegationAttempt } from '../lib/delegation-attempt.js';
import {
  normalizeDelegationAckActor,
  resolveDelegationAckActorFromRequest,
} from '../lib/delegation-ack-actor.js';
import {
  normalizeDelegationReviewSubject,
  resolveDelegationReviewSubject,
} from '../lib/delegation-request.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { readDelegationMaterialRevision } from '../lib/delegation-material-revision.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';
import { createTempRepo, commitFile } from './helpers/temp-git-repo.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();

// --- subject resolution ------------------------------------------------------
assert.equal(normalizeDelegationReviewSubject('code'), 'code');
assert.equal(normalizeDelegationReviewSubject('PLAN'), 'plan');
assert.equal(normalizeDelegationReviewSubject('nonsense'), '');
assert.equal(normalizeDelegationReviewSubject(''), '');
assert.deepEqual(
  resolveDelegationReviewSubject({ requested: 'code' }),
  { subject: 'code', source: 'explicit' },
);
assert.deepEqual(
  resolveDelegationReviewSubject({ requested: 'garbage' }),
  { subject: 'other', source: 'unknown' },
);
assert.deepEqual(
  resolveDelegationReviewSubject({ assignment: 'review', executionMode: 'plan' }),
  { subject: 'plan', source: 'default' },
);
assert.deepEqual(
  resolveDelegationReviewSubject({ assignment: 'review', executionMode: 'agent' }),
  { subject: 'other', source: 'default' },
);
assert.deepEqual(
  resolveDelegationReviewSubject({ assignment: 'implement', executionMode: 'agent' }),
  { subject: 'other', source: 'default' },
);

// --- actor derivation (channel, never body) ----------------------------------
assert.equal(resolveDelegationAckActorFromRequest({}), 'human', 'session cookie card channel');
assert.equal(resolveDelegationAckActorFromRequest({ widgetAccess: { installationId: 'w' } }), 'agent');
assert.equal(resolveDelegationAckActorFromRequest({ mcpIntegration: { id: 'm' } }), 'agent');
assert.equal(
  resolveDelegationAckActorFromRequest({}, { remoteMcp: true }),
  'agent',
  'the remote-MCP route is an agent channel',
);
assert.equal(resolveDelegationAckActorFromRequest(null), 'unknown');
assert.equal(resolveDelegationAckActorFromRequest({}, { authenticated: false }), 'unknown');
assert.equal(resolveDelegationAckActorFromRequest({}, { system: true }), 'system');
assert.equal(normalizeDelegationAckActor('HUMAN'), 'human');
assert.equal(normalizeDelegationAckActor('spoofed'), '');

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
});
function newParent(title) {
  return addChat(randomUUID(), title, null, workspace, 'testfake/orchestrator', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
}
const parent = newParent('review-subject-parent');

async function startDelegation(overrides = {}) {
  // A fresh parent per job keeps the single workspace mutating slot free, and a
  // full await avoids a background start racing the assertions below.
  const owner = String(overrides.parentChatId || '').trim() || newParent('review-subject-owner').id;
  const result = await service.createAndStart({
    parentChatId: owner,
    sourceKind: 'text',
    taskText: 'review subject contract',
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    returnWhenStarting: false,
    ...overrides,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}

// Explicit subject is persisted on the job.
const explicit = await startDelegation({ reviewSubject: 'code' });
assert.equal(explicit.reviewSubject, 'code');
assert.equal(explicit.reviewSubjectSource, 'explicit');
assert.ok(String(explicit.queuedAt || '').trim());

// Missing subject on an agent review defaults to `other` (never `code`).
const defaulted = await startDelegation();
assert.equal(defaulted.reviewSubject, 'other');
assert.equal(defaulted.reviewSubjectSource, 'default');

// Plan-mode review defaults to `plan`.
const planDefault = await startDelegation({ executionMode: 'plan' });
assert.equal(planDefault.reviewSubject, 'plan');
assert.equal(planDefault.reviewSubjectSource, 'default');

// An unrecognized explicit value is stored as `other` with an unknown source.
const unknown = await startDelegation({ reviewSubject: 'not-a-subject' });
assert.equal(unknown.reviewSubject, 'other');
assert.equal(unknown.reviewSubjectSource, 'unknown');

// --- attempt snapshot evidence ----------------------------------------------
const snapshotJob = await startDelegation({ reviewSubject: 'code' });
updateDelegationRecord(snapshotJob.id, {
  status: 'completed',
  report: `${'x'.repeat(2400)}\nVERDICT: PASS`,
  reportVerdict: 'PASS',
  reportDegraded: true,
  reportSummary: 'a long review',
});
await recordDelegationVerifyResult({
  delegationId: snapshotJob.id,
  attemptId: snapshotJob.attemptId,
  result: { ok: true, dataDir: '/tmp/isolated-review-data' },
  verdict: 'PASS',
  source: 'delegation_verify',
});
const snapshotRow = getDelegationById(snapshotJob.id);
// Simulate retention: keep only the truncated body while the durable verdict
// survives independently of the 2000-char report cut.
updateDelegationRecord(snapshotRow.id, { report: snapshotRow.report.slice(0, 2000) });
const snap = snapshotDelegationAttempt(getDelegationById(snapshotRow.id));
assert.equal(snap.reportVerdict, 'PASS');
assert.equal(snap.reportDegraded, true);
assert.equal(snap.reportSummary, 'a long review');
assert.equal(snap.reviewSubject, 'code');
assert.equal(snap.reviewSubjectSource, 'explicit');
assert.equal(snap.verifyResult.status, 'passed');
assert.equal(snap.verifyResult.source, 'delegation_verify');
assert.ok(String(snap.queuedAt || '').trim());

// --- retry clears attempt evidence, keeps the job subject -------------------
// Build the completed job directly so no live child run is left occupying the
// parent slot (which would refuse the retry).
const retryParent = newParent('review-subject-retry-parent');
const retryChild = addChat(randomUUID(), 'review-subject-retry-child', null, workspace, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
  delegationParentChatId: retryParent.id,
});
const retryJob = createDelegationRecord({
  parentChatId: retryParent.id,
  childChatId: retryChild.id,
  workspaceFolder: workspace,
  executor: { transport: 'testfake', model: 'testfake/test' },
  sourceKind: 'text',
  sourceText: 'retry the review',
  assignment: 'review',
  executionMode: 'agent',
  reviewSubject: 'code',
  reviewSubjectSource: 'explicit',
});
updateDelegationRecord(retryJob.id, {
  status: 'completed',
  report: 'TASK: review\nVERDICT: PASS',
  reportVerdict: 'PASS',
  reportDegraded: true,
  reportSummary: 'old',
  acknowledgedAt: new Date().toISOString(),
  acknowledgedAttemptId: retryJob.attemptId,
  acknowledgedReason: 'accepted',
  acknowledgedActor: 'human',
});
await recordDelegationVerifyResult({
  delegationId: retryJob.id,
  attemptId: retryJob.attemptId,
  result: { ok: true, dataDir: '/tmp/old-verify' },
  verdict: 'PASS',
  source: 'delegation_verify',
});
const retried = await service.retry(retryJob.id);
assert.equal(retried.ok, true, retried.error || 'retry failed');
const afterRetry = getDelegationById(retryJob.id);
assert.equal(afterRetry.reportVerdict, '', 'retry resets the archived verdict');
assert.equal(afterRetry.reportDegraded, false);
assert.equal(afterRetry.reportSummary, '');
assert.equal(afterRetry.verifyResult, null, 'retry resets the archived verify result');
assert.equal(afterRetry.acknowledgedAt, '');
assert.equal(afterRetry.acknowledgedReason, '');
assert.equal(afterRetry.acknowledgedActor, '');
assert.equal(afterRetry.acknowledgedAttemptId, '');
assert.equal(afterRetry.reviewSubject, 'code', 'the job subject survives a retry');
const archivedAttempt = afterRetry.attempts[afterRetry.attempts.length - 1];
assert.equal(archivedAttempt.reportVerdict, 'PASS', 'the archived attempt keeps the old verdict');
assert.equal(archivedAttempt.acknowledgedActor, 'human');
assert.equal(archivedAttempt.verifyResult.status, 'passed');

// --- acceptance actors and expectation mismatches ---------------------------
const repo = createTempRepo({ file: 'notes.txt', content: 'one\n' });
const revision = readDelegationMaterialRevision(repo.dir);
assert.ok(revision, 'temp repo has a material revision');

function acceptJob(overrides = {}) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: workspace,
    executionFolder: repo.dir,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    ...overrides,
  });
  updateDelegationRecord(row.id, {
    status: 'completed',
    runStoppingAt: '',
    report: 'TASK: review\nVERDICT: PASS',
  });
  return getDelegationById(row.id);
}

const humanJob = acceptJob();
const humanAccept = await service.acknowledge(humanJob.id, {
  reason: 'accepted',
  actor: 'human',
  expectedAttemptId: humanJob.attemptId,
  expectedMaterialRevision: revision,
});
assert.equal(humanAccept.ok, true, humanAccept.error || 'human accept failed');
assert.equal(getDelegationById(humanJob.id).acknowledgedActor, 'human');
assert.equal(getDelegationById(humanJob.id).acknowledgedReason, 'accepted');

const staleAttempt = acceptJob();
const attemptMismatch = await service.acknowledge(staleAttempt.id, {
  reason: 'accepted',
  actor: 'human',
  expectedAttemptId: '00000000-0000-4000-8000-000000000000',
});
assert.equal(attemptMismatch.ok, false);
assert.equal(attemptMismatch.status, 409);
assert.equal(attemptMismatch.code, 'ack_attempt_mismatch');

const staleMaterial = acceptJob();
commitFile(repo.dir, 'second.txt', 'two\n');
const materialMismatch = await service.acknowledge(staleMaterial.id, {
  reason: 'accepted',
  actor: 'human',
  expectedMaterialRevision: revision,
});
assert.equal(materialMismatch.ok, false);
assert.equal(materialMismatch.status, 409);
assert.equal(materialMismatch.code, 'ack_material_mismatch');

// A service caller that omits the actor is an internal/unknown channel.
const noActor = acceptJob();
assert.equal((await service.acknowledge(noActor.id, { reason: 'accepted' })).ok, true);
assert.equal(getDelegationById(noActor.id).acknowledgedActor, 'unknown');

// --- HTTP accept endpoint ----------------------------------------------------
const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace, dataDir: workspace });

async function invokeRoute(method, route, req) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)(req, res);
  return { status, body };
}

const routeJob = acceptJob();
const routeRevision = readDelegationMaterialRevision(repo.dir);
const acceptContext = await invokeRoute('GET', '/api/delegations/:id', {
  params: { id: routeJob.id },
  query: { workspaceFolder: workspace, field: 'accept' },
  body: {},
});
assert.equal(acceptContext.status, 200);
assert.equal(acceptContext.body.attemptId, routeJob.attemptId);
assert.equal(acceptContext.body.materialRevision, routeRevision);
const missing = await invokeRoute('POST', '/api/delegations/:id/accept', {
  params: { id: routeJob.id },
  query: { workspaceFolder: workspace },
  body: {},
});
assert.equal(missing.status, 400);
assert.equal(missing.body.code, 'accept_expectation_required');

const routeAccepted = await invokeRoute('POST', '/api/delegations/:id/accept', {
  params: { id: routeJob.id },
  query: { workspaceFolder: workspace },
  body: { attemptId: routeJob.attemptId, materialRevision: routeRevision },
});
assert.equal(routeAccepted.status, 200, JSON.stringify(routeAccepted.body));
assert.equal(getDelegationById(routeJob.id).acknowledgedActor, 'human', 'card session is the human channel');

const widgetParent = addChat(randomUUID(), 'review-subject-widget-parent', null, workspace, 'testfake/orchestrator', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
  widgetInstallationId: 'widget-install',
});
const widgetRouteJob = createDelegationRecord({
  parentChatId: widgetParent.id,
  workspaceFolder: workspace,
  executionFolder: repo.dir,
  executor: { transport: 'testfake', model: 'testfake/test' },
  assignment: 'review',
  executionMode: 'agent',
});
updateDelegationRecord(widgetRouteJob.id, { status: 'completed', report: 'VERDICT: PASS' });
const widgetAccepted = await invokeRoute('POST', '/api/delegations/:id/accept', {
  params: { id: widgetRouteJob.id },
  query: { workspaceFolder: workspace },
  body: {
    attemptId: getDelegationById(widgetRouteJob.id).attemptId,
    materialRevision: readDelegationMaterialRevision(repo.dir),
  },
  widgetAccess: { installationId: 'widget-install' },
});
assert.equal(widgetAccepted.status, 200, JSON.stringify(widgetAccepted.body));
assert.equal(widgetAccepted.body.delegation.acknowledgedActor, 'agent', 'a widget token is never human');
assert.equal(getDelegationById(widgetRouteJob.id).acknowledgedActor, 'agent');

// --- generic ack must not create an unbounded acceptance --------------------
// M1: the plain card ack is for dismissing a card. An `accepted` reason without
// the displayed attempt and material must not write a `manual` acceptance; the
// explicit `/accept` route is the only normal path (`docs/todo-review-contract.md`
// §7.3).
const ackGuardJob = acceptJob();
const ackAccepted = await invokeRoute('POST', '/api/delegations/:id/ack', {
  params: { id: ackGuardJob.id },
  query: { workspaceFolder: workspace },
  body: { reason: 'accepted' },
});
assert.equal(ackAccepted.status, 400, JSON.stringify(ackAccepted.body));
assert.equal(ackAccepted.body.code, 'accept_expectation_required');
assert.equal(getDelegationById(ackGuardJob.id).acknowledgedReason, '', 'the rejected ack wrote nothing');
assert.equal(getDelegationById(ackGuardJob.id).acknowledgedActor, '');

const ackReviewed = await invokeRoute('POST', '/api/delegations/:id/ack', {
  params: { id: ackGuardJob.id },
  query: { workspaceFolder: workspace },
  body: { reason: 'reviewed' },
});
assert.equal(ackReviewed.status, 200, JSON.stringify(ackReviewed.body));
assert.equal(getDelegationById(ackGuardJob.id).acknowledgedReason, 'reviewed');

// An `accepted` ack that carries the expectations is still allowed through the
// generic route (the guard is conditional, not a hard rejection).
const ackBoundJob = acceptJob();
const ackBound = await invokeRoute('POST', '/api/delegations/:id/ack', {
  params: { id: ackBoundJob.id },
  query: { workspaceFolder: workspace },
  body: {
    reason: 'accepted',
    attemptId: ackBoundJob.attemptId,
    materialRevision: readDelegationMaterialRevision(repo.dir),
  },
});
assert.equal(ackBound.status, 200, JSON.stringify(ackBound.body));
assert.equal(getDelegationById(ackBoundJob.id).acknowledgedReason, 'accepted');

removeIsolatedDataDir();
console.log('delegation-review-subject.test.js OK');
