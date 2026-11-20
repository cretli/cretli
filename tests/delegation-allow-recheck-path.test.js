/**
 * `allow_recheck` end to end on the local path: MCP handler -> API client body ->
 * REST route -> service -> recheck gate. Only the literal boolean `true` (snake or
 * camel) overrides the unchanged-material refusal; everything else still refuses.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { inspectReviewRecheckWithoutChange } from '../lib/delegation-review-recheck-gate.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const executor = { transport: 'testfake', model: 'rev-a' };

/** Seeds a terminal FAIL review of `leafId` by `executor`, reviewed at material `rev1`. */
function seedReview(parentChatId, leafId) {
  const row = createDelegationRecord({
    parentChatId, childChatId: `child-${randomUUID()}`, workspaceFolder: ISOLATED_DATA_DIR,
    executor, assignment: 'review', status: 'completed', leafId, reviewSubject: 'code',
    reviewedMaterialRevision: 'rev1',
  });
  updateDelegationRecord(row.id, { reportVerdict: 'FAIL', queuedAt: new Date(Date.now() - 60000).toISOString() });
}

test('gate: only literal true overrides an unchanged-material recheck; other gates stay', () => {
  const parentChatId = `p-${randomUUID()}`;
  const leafId = randomUUID();
  seedReview(parentChatId, leafId);
  const base = { parentChatId, assignment: 'review', reviewSubject: 'code', leafId, executor, materialRevision: 'rev1' };
  assert.equal(inspectReviewRecheckWithoutChange(base).ok, false, 'no flag refuses');
  for (const bad of [false, 'true', 'false', 1, 'yes', {}, null]) {
    const res = inspectReviewRecheckWithoutChange({ ...base, allowRecheck: bad });
    assert.equal(res.ok, false, `allowRecheck=${JSON.stringify(bad)} still refuses`);
    assert.match(res.error, /allow_recheck=true/);
  }
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, allowRecheck: true }).ok, true);
  // Independence: a different reviewer, a changed material and a non-review start never needed the flag.
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, executor: { transport: 'testfake', model: 'rev-b' } }).ok, true);
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, materialRevision: 'rev2' }).ok, true);
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, assignment: 'implement' }).ok, true);
});

test('MCP handler forwards only literal true from either spelling', async () => {
  const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
  const captured = [];
  const client = {
    async getChat() { return { id: 'chat-1', workspaceFolder: '/tmp/ws' }; },
    async startDelegation(args) {
      captured.push(args.allowRecheck);
      return { ok: true, delegation: { id: 'd1', status: 'starting', assignment: 'review', workRole: 'review', executor: { transport: 'testfake', model: 'rev-a' } } };
    },
  };
  const session = { chatId: 'chat-1', workspaceFolder: '/tmp/ws', mode: 'agent' };
  const base = { task_text: 't', harness: 'testfake', model: 'rev-a' };
  const variants = [{}, { allow_recheck: true }, { allowRecheck: true }, { allow_recheck: false }, { allow_recheck: 'false' }, { allowRecheck: 1 }];
  for (const [i, extra] of variants.entries()) await startTool.handler({ ...base, idempotency_key: `k${i}`, ...extra }, { client, session });
  assert.deepEqual(captured, [false, true, true, false, false, false]);
});

test('API client puts a strict boolean allowRecheck into the POST body', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const reply = (status, json, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(json)); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/api/login') return reply(200, { ok: true, csrfToken: 'c' }, { 'Set-Cookie': 'cr_session=t; Path=/' });
      if (req.url.endsWith('/delegations')) bodies.push(JSON.parse(raw));
      reply(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, password: 'x' });
    const call = (extra) => client.startDelegation({ chatId: 'c1', harness: 'testfake', model: 'm', ...extra });
    await call({});
    await call({ allow_recheck: true });
    await call({ allowRecheck: true });
    await call({ allow_recheck: 'true' });
    await call({ allowRecheck: false });
    assert.deepEqual(bodies.map((b) => b.allowRecheck), [false, true, true, false, false]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route + service: flag lost or non-boolean -> recheck refusal; true/camel/snake pass the gate', async () => {
  const workspace = ISOLATED_DATA_DIR;
  const routes = new Map();
  registerDelegationsRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn) }, { workspaceDirForAgent: () => workspace });
  const parent = addChat(randomUUID(), 'recheck-parent', null, workspace, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  const leafId = randomUUID();
  seedReview(parent.id, leafId);
  const post = async (extra) => {
    let status = 200;
    let body;
    const res = { status(c) { status = c; return this; }, json(p) { body = p; return this; } };
    await routes.get('POST /api/chats/:id/delegations')({
      params: { id: parent.id }, query: {},
      body: {
        executor, sourceKind: 'text', taskText: 'Review the change.', executionMode: 'agent', assignment: 'review',
        reviewSubject: 'code', leafId, idempotencyKey: randomUUID(), ...extra,
      },
    }, res);
    return { status, body };
  };
  const isRecheckRefusal = (r) => /allow_recheck=true/.test(String(r.body?.error || ''));
  for (const extra of [{}, { allowRecheck: 'true' }, { allow_recheck: 'false' }, { allowRecheck: 1 }, { allowRecheck: false }]) {
    assert.ok(isRecheckRefusal(await post(extra)), `refused for ${JSON.stringify(extra)}`);
  }
  for (const extra of [{ allowRecheck: true }, { allow_recheck: true }]) {
    const r = await post(extra);
    assert.ok(!isRecheckRefusal(r), `recheck gate passed for ${JSON.stringify(extra)}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
});
