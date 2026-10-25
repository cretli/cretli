import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import {
  resetReviewRoundResolutionState,
  subscribeReviewRoundResolved,
} from '../lib/review-round-resolution.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });

async function invoke(method, route, req) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)(req, res);
  return { status, body };
}

resetReviewRoundResolutionState();
let fired = 0;
subscribeReviewRoundResolved(() => { fired += 1; });

// Bridged path: POST /api/chats/:id/delegation-workflow.
{
  const parent = makeParent('route-parent');
  const leafId = crypto.randomUUID();
  makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  const res = await invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: { workspaceFolder: ISOLATED_DATA_DIR, leafId, lastVerdict: 'PASS', idempotencyKey: 'route-pass-1' },
  });
  assert.equal(res.status, 200);
  assert.equal(fired, 1);
  const replay = await invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: { workspaceFolder: ISOLATED_DATA_DIR, leafId, lastVerdict: 'PASS', idempotencyKey: 'route-pass-1' },
  });
  assert.equal(replay.body.replayed, true);
  assert.equal(fired, 1, 'replay does not fire');
}

// In-process client path.
{
  const parent = makeParent('inproc-parent');
  const leafId = crypto.randomUUID();
  makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR });
  const before = fired;
  const result = await client.updateDelegationWorkflow({
    chatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    lastVerdict: 'PASS',
    idempotencyKey: 'inproc-pass-1',
  });
  assert.equal(result.ok, true);
  assert.equal(fired, before + 1);
}

// Stats endpoint.
{
  const res = await invoke('GET', '/api/review-loop-stats', { params: {}, query: {}, body: {}, headers: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.workspaces));
  assert.ok(typeof res.body.generatedAt === 'string');
  assert.deepEqual(res.body.windows, ['7d', '30d', '90d']);
}

console.log('review-round-resolution-routes tests passed');
