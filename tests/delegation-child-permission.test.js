import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { loadDelegations } from '../lib/persist/delegations-persist.js';
import { resolveChildDelegationGrant } from '../lib/delegation-tree.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const project = mkdtempSync(path.join(os.tmpdir(), 'cr-child-perm-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});
let seq = 0;

function chat(extras = {}) {
  seq += 1;
  const c = addChat(`sess-perm-${seq}`, `perm-${seq}`, null, project, 'm', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
  writeChatPlanFile({ cwd: project, chatId: c.id, title: 't', markdown: '# t\n\n- s', sourceTurnId: 'x' });
  return c;
}

function start(parent, key, extra = {}) {
  const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    planRevision: planDoc.revision,
    assignment: 'review',
    idempotencyKey: key,
    ...extra,
  });
}

async function withMaxDepth(value, fn) {
  const prev = process.env.CRETLI_DELEGATION_MAX_DEPTH;
  process.env.CRETLI_DELEGATION_MAX_DEPTH = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CRETLI_DELEGATION_MAX_DEPTH;
    else process.env.CRETLI_DELEGATION_MAX_DEPTH = prev;
  }
}

test('default deny: no grant stored, child chat cannot delegate', async () => {
  await withMaxDepth('3', async () => {
    const root = chat();
    const res = await start(root, 'perm-default-1');
    assert.equal(res.ok, true);
    const row = loadDelegations().find((r) => r.parentChatId === root.id);
    assert.equal(row.allowChildDelegations, false);
    const child = loadChats().find((c) => c.id === row.childChatId);
    assert.notEqual(child.delegationGrant, true);
    const nested = await start(child, 'perm-default-2');
    assert.equal(nested.ok, false);
    assert.equal(nested.code, 'nested_delegation_denied');
  });
});

test('grant allows a child to start a nested delegation, depth bound applies', async () => {
  await withMaxDepth('2', async () => {
    const root = chat();
    const res = await start(root, 'perm-grant-1', { allowChildDelegations: true });
    assert.equal(res.ok, true);
    const row = loadDelegations().find((r) => r.parentChatId === root.id);
    assert.equal(row.allowChildDelegations, true);
    const child = loadChats().find((c) => c.id === row.childChatId);
    assert.equal(child.delegationGrant, true);
    writeChatPlanFile({ cwd: project, chatId: child.id, title: 't', markdown: '# t\n\n- s', sourceTurnId: 'x' });
    const nested = await start(child, 'perm-grant-2', { allowChildDelegations: true });
    assert.equal(nested.ok, true);
    const nestedRow = loadDelegations().find((r) => r.parentChatId === child.id);
    assert.equal(nestedRow.depth, 2);
    assert.equal(nestedRow.allowChildDelegations, true);
    const grandchild = loadChats().find((c) => c.id === nestedRow.childChatId);
    writeChatPlanFile({ cwd: project, chatId: grandchild.id, title: 't', markdown: '# t\n\n- s', sourceTurnId: 'x' });
    const tooDeep = await start(grandchild, 'perm-grant-3');
    assert.equal(tooDeep.code, 'depth_exceeded');
  });
});

test('attenuation: a child without the grant cannot grant or escalate', async () => {
  assert.equal(resolveChildDelegationGrant({ parent: { id: 'r' }, requested: true }), true);
  assert.equal(resolveChildDelegationGrant({ parent: { id: 'r' }, requested: false }), false);
  const noGrantChild = { id: 'c', delegationParentChatId: 'r', delegationDepth: 1 };
  assert.equal(resolveChildDelegationGrant({ parent: noGrantChild, requested: true }), false);
  const grantedChild = { ...noGrantChild, delegationGrant: true };
  assert.equal(resolveChildDelegationGrant({ parent: grantedChild, requested: true }), true);
  assert.equal(resolveChildDelegationGrant({ parent: grantedChild, requested: false }), false);
  await withMaxDepth('2', async () => {
    const root = chat();
    const child = chat({ delegationParentChatId: root.id, delegationDepth: 1 });
    const res = await start(child, 'perm-esc-1', { allowChildDelegations: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'nested_delegation_denied');
  });
});

test('replay: same key + same grant replays, different grant conflicts', async () => {
  await withMaxDepth('2', async () => {
    const root = chat();
    const first = await start(root, 'perm-replay-1', { allowChildDelegations: true });
    assert.equal(first.ok, true);
    const again = await start(root, 'perm-replay-1', { allowChildDelegations: true });
    assert.equal(again.ok, true);
    assert.equal(again.delegation.id, first.delegation.id);
    const changed = await start(root, 'perm-replay-1', { allowChildDelegations: false });
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'idempotency_conflict');
  });
});

test('prompt and card expose the grant', () => {
  const granted = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'do it',
    childDelegation: { allowed: true, depth: 1, remainingDepth: 2 },
  });
  assert.match(granted.prompt, /\[CHILD DELEGATION\]/);
  assert.match(granted.prompt, /2 level\(s\) remaining/);
  const plain = buildDelegationExecutorPrompt({ sourceKind: 'text', taskText: 'do it' });
  assert.doesNotMatch(plain.prompt, /CHILD DELEGATION/);
  assert.equal(buildDelegationCardModel({ status: 'running', allowChildDelegations: true }).allowChildDelegations, true);
  assert.equal(buildDelegationCardModel({ status: 'running' }).allowChildDelegations, false);
});

test('prompt drops the no-delegation prohibition only when nesting is possible', () => {
  const prohibition = /Do not create another Cretli delegation\./;
  for (const assignment of ['implement', 'review']) {
    for (const sourceKind of ['text', 'plan']) {
      const base = { sourceKind, taskText: 'do it', planMarkdown: '# p', assignment };
      const granted = buildDelegationExecutorPrompt({
        ...base,
        childDelegation: { allowed: true, depth: 1, remainingDepth: 1 },
      });
      assert.doesNotMatch(granted.prompt, prohibition, `${assignment}/${sourceKind} granted`);
      const exhausted = buildDelegationExecutorPrompt({
        ...base,
        childDelegation: { allowed: true, depth: 2, remainingDepth: 0 },
      });
      assert.match(exhausted.prompt, prohibition, `${assignment}/${sourceKind} exhausted`);
      assert.match(exhausted.prompt, /maximum delegation depth is reached/);
      const plain = buildDelegationExecutorPrompt(base);
      assert.match(plain.prompt, prohibition, `${assignment}/${sourceKind} plain`);
    }
  }
});

test('MCP delegation_start rejects a chat_id that differs from the session chat', async () => {
  const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
  const started = [];
  const client = {
    async getChat({ chatId }) {
      return { id: chatId, workspaceFolder: project };
    },
    async startDelegation(args) {
      started.push(args);
      return {
        ok: true,
        delegation: { id: 'd-1', status: 'starting', assignment: 'implement', executor: {} },
      };
    },
  };
  const args = { task_text: 'x', harness: 'testfake', model: 'testfake/test', idempotency_key: 'k-guard' };
  const childSession = { chatId: 'child-chat', workspaceFolder: project, mode: 'agent' };
  const forged = await startTool.handler({ ...args, chat_id: 'root-chat' }, { client, session: childSession })
    .then(() => null, (err) => err);
  assert.ok(forged, 'foreign chat_id is rejected');
  assert.match(String(forged.message), /calling chat/);
  assert.equal(started.length, 0);
  const own = await startTool.handler({ ...args, chat_id: 'child-chat' }, { client, session: childSession });
  assert.notEqual(own.isError, true);
  assert.equal(started.at(-1).chatId, 'child-chat');
  await startTool.handler(args, { client, session: childSession });
  assert.equal(started.at(-1).chatId, 'child-chat');
});
