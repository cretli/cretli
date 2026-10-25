import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { loadDelegations } from '../lib/persist/delegations-persist.js';
import {
  evaluateDelegationDepthGate,
  resolveDelegationMaxDepth,
  resolveRecordTreeFields,
} from '../lib/delegation-tree.js';
import { toCretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../lib/mcp/builtin/errors.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const project = mkdtempSync(path.join(os.tmpdir(), 'cr-tree-depth-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});
let seq = 0;

function chat(extras = {}) {
  seq += 1;
  const c = addChat(`sess-tree-${seq}`, `tree-${seq}`, null, project, 'm', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
  writeChatPlanFile({ cwd: project, chatId: c.id, title: 't', markdown: '# t\n\n- s', sourceTurnId: 'x' });
  return c;
}

function start(parent, key) {
  const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    planRevision: planDoc.revision,
    assignment: 'review',
    idempotencyKey: key,
  });
}

function withMaxDepth(value, fn) {
  const prev = process.env.CRETLI_DELEGATION_MAX_DEPTH;
  if (value === undefined) delete process.env.CRETLI_DELEGATION_MAX_DEPTH;
  else process.env.CRETLI_DELEGATION_MAX_DEPTH = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.CRETLI_DELEGATION_MAX_DEPTH;
    else process.env.CRETLI_DELEGATION_MAX_DEPTH = prev;
  });
}

test('max depth defaults to 1 and clamps invalid values', () => {
  assert.equal(resolveDelegationMaxDepth({}), 1);
  assert.equal(resolveDelegationMaxDepth({ CRETLI_DELEGATION_MAX_DEPTH: '3' }), 3);
  assert.equal(resolveDelegationMaxDepth({ CRETLI_DELEGATION_MAX_DEPTH: 'x' }), 1);
});

test('root child gets depth 1 with root fields; legacy rows backfill', async () => {
  const root = chat();
  const started = await start(root, 'tree-root-1');
  assert.equal(started.ok, true);
  const row = loadDelegations().find((r) => r.parentChatId === root.id);
  assert.equal(row.depth, 1);
  assert.equal(row.rootChatId, root.id);
  assert.equal(row.rootDelegationId, row.id);
  assert.deepEqual(
    resolveRecordTreeFields({ id: 'd1', parentChatId: 'p1' }),
    { depth: 1, rootChatId: 'p1', rootDelegationId: 'd1' },
  );
});

test('default depth: child chat is denied even with grant', async () => {
  const root = chat();
  const child = chat({ delegationParentChatId: root.id, delegationDepth: 1, delegationGrant: true });
  const res = await withMaxDepth(undefined, () => start(child, 'tree-default-1'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'depth_exceeded');
  const noGrant = chat({ delegationParentChatId: root.id, delegationDepth: 1 });
  const res2 = await withMaxDepth(undefined, () => start(noGrant, 'tree-default-2'));
  assert.equal(res2.code, 'nested_delegation_denied');
});

test('MAX_DEPTH=2: no grant blocks, grant allows, over limit is depth_exceeded', async () => {
  const root = chat();
  const noGrant = chat({ delegationParentChatId: root.id, delegationDepth: 1 });
  const granted = chat({
    delegationParentChatId: root.id,
    delegationDepth: 1,
    delegationRootChatId: root.id,
    delegationRootDelegationId: 'root-del',
    delegationGrant: true,
  });
  const tooDeep = chat({ delegationParentChatId: granted.id, delegationDepth: 2, delegationGrant: true });
  await withMaxDepth('2', async () => {
    assert.equal((await start(noGrant, 'tree-d2-a')).code, 'nested_delegation_denied');
    const ok = await start(granted, 'tree-d2-b');
    assert.equal(ok.ok, true);
    const row = loadDelegations().find((r) => r.parentChatId === granted.id);
    assert.equal(row.depth, 2);
    assert.equal(row.rootChatId, root.id);
    assert.equal(row.rootDelegationId, 'root-del');
    assert.equal((await start(tooDeep, 'tree-d2-c')).code, 'depth_exceeded');
  });
  const gate = evaluateDelegationDepthGate({
    parent: { id: 'x', delegationParentChatId: 'y', delegationDepth: 2, delegationGrant: true },
    maxDepth: 2,
  });
  assert.equal(gate.code, 'depth_exceeded');
});

test('depth_exceeded maps to MCP CONFLICT', () => {
  const err = toCretliMcpToolError({ ok: false, status: 409, code: 'depth_exceeded', error: 'x' });
  assert.equal(err.code, MCP_BUILTIN_ERROR_CODES.CONFLICT);
});
