/**
 * Route test for GET /api/delegations/stats (task 6 UI feed, no UI here).
 *
 * Uses the isolated data dir helper and registers the routes on a tiny fake
 * express app so the test stays free of HTTP and auth. Asserts the response
 * shape (`list` model x role outcomes + `unused_14d` enabled harnesses).
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(randomUUID(), 'stats-route-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });

async function invokeRoute(method, route, req = {}) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body };
}

// One implement -> review cycle on two harnesses + a completed duration.
const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const finishedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const implement = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: workspace,
  assignment: 'implement',
  executionMode: 'agent',
  status: 'completed',
  executor: { transport: 'opencode', model: 'opencode/test' },
});
updateDelegationRecord(implement.id, {
  status: 'completed',
  startedAt,
  finishedAt,
  runStoppingAt: '',
  report: 'TASK: implement\nVERDICT: PASS',
});
const review = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: workspace,
  assignment: 'review',
  executionMode: 'agent',
  status: 'completed',
  executor: { transport: 'claude', model: 'claude-sonnet-5' },
});
updateDelegationRecord(review.id, {
  status: 'completed',
  startedAt,
  finishedAt,
  runStoppingAt: '',
  report: 'TASK: review\nVERDICT: PASS',
});

const invoked = await invokeRoute('GET', '/api/delegations/stats');
assert.equal(invoked.status, 200);
const body = invoked.body;
assert.equal(body.ok, true);
assert.ok(Array.isArray(body.list), 'list is an array');
assert.ok(Array.isArray(body.unused_14d), 'unused_14d is an array');
assert.equal(body.unused_14d_error, false, 'a successful catalog read is not an error');
assert.equal(typeof body.generated_at, 'string');
assert.equal(body.min_jobs, 1);
assert.ok(body.roles && body.roles.implement && body.roles.review);
assert.ok(body.loop && Array.isArray(body.loop.leaves), 'loop.leaves is present');
assert.equal(typeof body.loop.generated_at, 'string');
assert.ok(body.loop.leaves.length >= 1, 'at least one leaf row for the parent jobs');

const implementRow = body.list.find((row) => row.role === 'implement' && row.harness === 'opencode');
assert.ok(implementRow, 'implement outcome present');
assert.equal(implementRow.model, 'opencode/test');
assert.equal(implementRow.n, 1);
assert.equal(implementRow.pass_rate, 1, 'the following review PASSed');
assert.equal(implementRow.infra_fail_rate, 0);
assert.equal(implementRow.median_min, 5);
assert.equal(typeof implementRow.p95_min, 'number');
assert.equal(implementRow.useful_rate, null, 'useful_rate is review-only');
assert.ok(
  Number.isFinite(Date.parse(implementRow.last_used_at)),
  'last_used_at is an ISO timestamp',
);

const reviewRow = body.list.find((row) => row.role === 'review' && row.harness === 'claude');
assert.ok(reviewRow, 'review outcome present');
assert.equal(reviewRow.pass_rate, 1, 'a PASS verdict is productive');
assert.equal(reviewRow.verdict_fail_rate, 0);

assert.equal(body.unused_14d.includes('opencode'), false, 'a harness with a job is not unused');
assert.equal(body.unused_14d.includes('claude'), false, 'the reviewer harness is not unused');
assert.ok(body.unused_14d.length > 0, 'enabled harnesses with no job stay listed');
assert.ok(
  body.unused_14d.every((id) => typeof id === 'string' && id === id.toLowerCase()),
  'unused_14d is a list of harness ids',
);

// --- Scope: aggregates only include rows the caller can see ------------------
const foreignWorkspace = `${workspace}-foreign`;
const foreignParent = addChat(randomUUID(), 'stats-route-foreign', null, foreignWorkspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
createDelegationRecord({
  parentChatId: foreignParent.id,
  workspaceFolder: foreignWorkspace,
  assignment: 'implement',
  executionMode: 'agent',
  status: 'completed',
  executor: { transport: 'codebuddy', model: 'hy3' },
});
const scoped = await invokeRoute('GET', '/api/delegations/stats', {
  query: { workspaceFolder: workspace },
});
assert.equal(scoped.status, 200);
assert.equal(
  scoped.body.list.some((row) => row.harness === 'codebuddy'),
  false,
  'a row from another workspace is excluded from the aggregates',
);
assert.ok(
  scoped.body.list.some((row) => row.role === 'implement' && row.harness === 'opencode'),
  'the in-workspace row survives the scope filter',
);
// A widget session whose installation does not own any chat sees an empty feed.
const widgetScoped = await invokeRoute('GET', '/api/delegations/stats', {
  widgetAccess: { installationId: 'inst-other', pageSessionId: 'page-other' },
});
assert.equal(widgetScoped.status, 200);
assert.deepEqual(widgetScoped.body.list, [], 'a widget session sees no cross-installation statistics');

// --- Catalog failure: a distinguishable error, not an empty success ----------
const failingRoutes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => failingRoutes.set(`GET ${p}`, fn),
  post: (p, fn) => failingRoutes.set(`POST ${p}`, fn),
}, {
  workspaceDirForAgent: () => workspace,
  listHarnessCatalog: async () => { throw new Error('catalog down'); },
});

let failStatus = 200;
let failBody;
await failingRoutes.get('GET /api/delegations/stats')({
  params: {},
  query: { workspaceFolder: workspace },
  body: {},
}, {
  status(code) { failStatus = code; return this; },
  json(payload) { failBody = payload; return this; },
});
assert.equal(failStatus, 200);
assert.equal(failBody.ok, true, 'the outcomes feed still succeeds');
assert.equal(failBody.unused_14d_error, true, 'a failed catalog is reported as an error state');
assert.deepEqual(failBody.unused_14d, [], 'the list stays empty for backward compatibility');
assert.ok(
  failBody.list.some((row) => row.role === 'implement' && row.harness === 'opencode'),
  'the stats table is unaffected by the unused-catalog failure',
);

removeIsolatedDataDir();
console.log('delegation-stats-routes.test.js OK');
