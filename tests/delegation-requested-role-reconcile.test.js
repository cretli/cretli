/**
 * `requested_role` without `assignment` must not silently become an implement
 * start. Covers the pure helper, the HTTP route (manual + automatic with a real
 * pick) and the role_mismatch error text.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-legacy-store.js';
import { updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { markDelegationAutomaticController } from '../lib/delegation-start-context.js';
import { reconcileDelegationRoleAssignment as rec } from '../lib/delegation-assignment.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const workspace = ISOLATED_DATA_DIR;

// --- helper rules ------------------------------------------------------------
assert.deepEqual(rec({ requestedRole: 'review' }), { ok: true, assignment: 'review', requestedRole: 'review' });
assert.equal(rec({ requestedRole: 'implement' }).assignment, 'implement');
assert.equal(rec({ requestedRole: 'fix' }).assignment, 'implement');
assert.equal(rec({}).assignment, '');
assert.equal(rec({ requestedRole: 'plan' }).code, 'requested_role_requires_assignment');
assert.match(rec({ requestedRole: 'plan' }).error, /assignment=implement.*assignment=review/);
assert.equal(rec({ assignment: 'implement', requestedRole: 'review' }).code, 'requested_role_conflict');
assert.equal(rec({ assignment: 'fix', requestedRole: 'review' }).code, 'requested_role_conflict');
assert.equal(rec({ assignment: 'review', requestedRole: 'implement' }).code, 'requested_role_conflict');
assert.equal(rec({ assignment: 'review', requestedRole: 'fix' }).code, 'requested_role_conflict');
assert.equal(rec({ assignment: 'implement', requestedRole: 'plan' }).ok, true);
assert.equal(rec({ assignment: 'review', requestedRole: 'plan' }).assignment, 'review');
assert.equal(rec({ assignment: 'plan' }).assignment, 'review');
assert.equal(rec({ assignment: 'fix' }).assignment, 'implement');
assert.equal(rec({ assignment: 'fix', requestedRole: 'fix' }).ok, true);

// --- HTTP route ----------------------------------------------------------------
const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });
async function post(parent, body) {
  let status = 200;
  let payload;
  const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; } };
  await routes.get('POST /api/chats/:id/delegations')({ params: { id: parent.id }, query: {}, body }, res);
  return { status, body: payload };
}
const makeParent = () => addChat(randomUUID(), `rr-${randomUUID()}`, null, workspace, 'testfake/parent', {
  agentTransport: 'testfake', sdkMode: 'agent',
});
const body = (extra = {}) => ({
  executor: { transport: 'testfake', model: 'testfake/test' },
  sourceKind: 'text',
  taskText: 'Review the change.',
  idempotencyKey: randomUUID(),
  ...extra,
});
const finish = (id) => updateDelegationRecord(id, {
  status: 'completed', finishedAt: new Date().toISOString(), report: 'TASK: review\nVERDICT: PASS',
});
const pickFor = (chatId, role) => persistModelPickProposal({
  chatId,
  workspaceFolder: workspace,
  role,
  pickResult: {
    pick: { harness: 'testfake', model: 'testfake/test' },
    picks: [{ harness: 'testfake', model: 'testfake/test' }],
  },
});

// Manual context: a bare requested_role=review is a review, never an implementer.
const manual = makeParent();
const manualReview = await post(manual, body({ requestedRole: 'review', reviewSubject: 'code' }));
assert.equal(manualReview.status, 201, JSON.stringify(manualReview.body));
assert.equal(manualReview.body.delegation.assignment, 'review');
assert.equal(manualReview.body.delegation.workRole, 'review_code');
finish(manualReview.body.delegation.id);

const conflict = await post(manual, body({ assignment: 'implement', requestedRole: 'review' }));
assert.equal(conflict.status, 400);
assert.equal(conflict.body.code, 'requested_role_conflict');
const planAmbiguous = await post(manual, body({ requestedRole: 'plan' }));
assert.equal(planAmbiguous.status, 400);
assert.equal(planAmbiguous.body.code, 'requested_role_requires_assignment');

// Automatic context with a real review pick: the reported failing request.
const auto = makeParent();
markDelegationAutomaticController(auto.id, 'todo_start');
const reviewPick = pickFor(auto.id, 'review');
const autoReview = await post(auto, body({
  pickId: reviewPick.pickId, requestedRole: 'review', reviewSubject: 'code',
}));
assert.equal(autoReview.status, 201, JSON.stringify(autoReview.body));
const row = autoReview.body.delegation;
assert.equal(row.assignment, 'review');
assert.equal(row.workRole, 'review_code');
assert.equal(row.pickLinkStatus, 'linked');
assert.equal(row.pickOrigin, 'auto');
finish(row.id);

// A genuine mismatch (implement pick used for a review start) is still refused and names both roles.
const mismatch = await post(auto, body({
  pickId: pickFor(auto.id, 'implement').pickId, assignment: 'review', reviewSubject: 'code',
}));
assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
assert.equal(mismatch.body.code, 'automatic_pick_rejected');
assert.equal(mismatch.body.reason, 'role_mismatch');
assert.match(mismatch.body.error, /pick role implement, start role review/);

removeIsolatedDataDir();
console.log('delegation-requested-role-reconcile.test.js OK');
