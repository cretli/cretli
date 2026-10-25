import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpReadTools, getBuiltinMcpMutatingTools } from '../lib/mcp/mcp-policy.js';
import {
  buildChatContextManifest,
  buildDelegationContextManifest,
  compareContextManifests,
  describeBoundedField,
} from '../lib/context/delegation-context-manifest.ts';
import {
  resolveChatContextProfile,
  resolveDelegationContextProfile,
} from '../lib/context/delegation-context-profile.ts';
import { CONTEXT_LEGACY_LIMITS } from '../lib/context/context-budget.ts';
import { decorateHarnessPrompt } from '../lib/sdk/harness-plan-prompt.ts';
import { buildTruncationMarker } from '../lib/context/truncation-marker.ts';

test.after(() => removeIsolatedDataDir());

function makeWorkspace(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'alpha-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'alpha-skill', 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: Alpha helper\n---\nALPHA BODY\n',
  );
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'beta-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'beta-skill', 'SKILL.md'),
    '---\nname: beta-skill\ndescription: Beta helper\n---\nBETA BODY\n',
  );
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nRULE BODY\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-home-'));
  return { root, home, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
}

const FIXTURE = { homeDir: undefined, additionalDirs: [] };

function skillId(manifest, name) {
  return [...manifest.instructions.delivered, ...manifest.instructions.skipped]
    .find((row) => row.id.includes(name))?.id;
}

test('profile: review/implement/plan drop the global catalog, others have no profile', () => {
  assert.equal(resolveDelegationContextProfile({ assignment: 'review' }).skillsCatalog, false);
  assert.equal(resolveDelegationContextProfile({ assignment: 'implement' }).id, 'implement');
  assert.equal(resolveDelegationContextProfile({ assignment: 'implement', workRole: 'plan' }).id, 'plan');
  assert.equal(resolveChatContextProfile('no-such-chat'), null);
  assert.equal(resolveChatContextProfile(''), null);
});

test('manifest: separate fields, omitted catalog, explicit limits, no activation', () => {
  const ws = makeWorkspace('cr-dcm-');
  try {
    const chat = addChat('s1', 'parent', null, ws.root, 'm', { agentTransport: 'sdk', sdkMode: 'agent' });
    const row = createDelegationRecord({
      parentChatId: chat.id,
      workspaceFolder: ws.root,
      executor: { transport: 'claude', model: 'sonnet' },
      assignment: 'review',
      executionMode: 'agent',
      sourceKind: 'message',
      sourceText: 'Task text mentioning @beta-skill and use alpha-skill',
      selectedSkillIds: [],
    });
    const manifest = buildDelegationContextManifest(row, { ...FIXTURE, homeDir: ws.home, bundledRoot: ws.home });
    assert.equal(manifest.subject, 'delegation');
    assert.equal(manifest.instructions.profile, 'review');
    for (const field of ['instructions', 'task', 'handoff', 'reports', 'omitted', 'limits', 'activation']) {
      assert.ok(field in manifest, field);
    }
    assert.equal(manifest.task.length > 0, true);
    assert.equal(manifest.task.limit, CONTEXT_LEGACY_LIMITS.delegationTask.limit);
    assert.equal(manifest.handoff.present, false);
    assert.ok(manifest.omitted.some((item) => item.source === 'skills_catalog' && item.reason.includes('review')));
    assert.ok(manifest.omitted.some((item) => item.source === 'parent_transcript'));
    // Mentions in the task text must not activate anything; nothing was selected.
    assert.equal(manifest.instructions.delivered.some((item) => item.kind === 'skill'), false);
    assert.equal(manifest.activation.mentionsParsed, false);
    assert.equal(manifest.activation.reportsActivate, false);
    // Content-free: no body text or absolute paths.
    const text = JSON.stringify(manifest);
    assert.ok(!text.includes('ALPHA BODY'));
    assert.ok(!text.includes(ws.root));
    assert.ok(!text.includes('Task text mentioning'));
  } finally {
    ws.cleanup();
  }
});

test('manifest: only explicitly selected skills are delivered to the child', () => {
  const ws = makeWorkspace('cr-dcm-sel-');
  try {
    const chat = addChat('s2', 'parent', null, ws.root, 'm', { agentTransport: 'sdk', sdkMode: 'agent' });
    const parentManifest = buildChatContextManifest({
      chatId: chat.id, workspaceFolder: ws.root, transport: 'claude', homeDir: ws.home, bundledRoot: ws.home, additionalDirs: [],
    });
    const alphaId = skillId(parentManifest, 'alpha-skill');
    assert.ok(alphaId, 'alpha skill id is visible in the parent manifest');
    // Parent keeps the catalog entry as available; child gets it only when selected.
    const row = createDelegationRecord({
      parentChatId: chat.id,
      workspaceFolder: ws.root,
      executor: { transport: 'claude', model: 'sonnet' },
      assignment: 'implement',
      executionMode: 'agent',
      sourceKind: 'message',
      sourceText: 'do it',
      selectedSkillIds: [alphaId],
    });
    const child = buildDelegationContextManifest(row, { homeDir: ws.home, bundledRoot: ws.home, additionalDirs: [] });
    const delivered = child.instructions.delivered.filter((item) => item.kind === 'skill').map((item) => item.id);
    assert.deepEqual(delivered, [alphaId]);
    assert.ok(!skillId({ instructions: { delivered: child.instructions.delivered, skipped: [] } }, 'beta-skill'));
    const betaSkipped = child.instructions.skipped.find((item) => item.id.includes('beta-skill'));
    assert.equal(betaSkipped?.reason, 'omitted_by_profile');
    const comparison = compareContextManifests(parentManifest, child);
    assert.equal(comparison.sameWorkspace, true);
    assert.ok(comparison.omittedByChild.includes('skills_catalog'));
    assert.ok(comparison.omittedByChild.includes('parent_transcript'));
    assert.ok(comparison.entries.shared.includes(alphaId));
    assert.ok(comparison.entries.onlyParent.some((id) => id.includes('beta-skill')));
  } finally {
    ws.cleanup();
  }
});

test('real send path: a delegation child prompt has no catalog, a normal chat keeps it', () => {
  const ws = makeWorkspace('cr-dcm-send-');
  try {
    const parent = addChat('s3', 'parent', null, ws.root, 'm', { agentTransport: 'claude', sdkMode: 'agent' });
    const childChat = addChat('s4', 'child', null, ws.root, 'm', { agentTransport: 'claude', sdkMode: 'agent' });
    const row = createDelegationRecord({
      parentChatId: parent.id,
      childChatId: childChat.id,
      workspaceFolder: ws.root,
      executor: { transport: 'claude', model: 'sonnet' },
      assignment: 'review',
      executionMode: 'agent',
      sourceKind: 'message',
      sourceText: 'x',
    });
    assert.ok(row.id);
    const normal = decorateHarnessPrompt({ chatId: parent.id, cwd: ws.root, sdkMode: 'agent' }, 'hello', 'claude');
    const delegated = decorateHarnessPrompt({ chatId: childChat.id, cwd: ws.root, sdkMode: 'agent' }, 'hello', 'claude');
    assert.ok(normal.includes('alpha-skill'));
    assert.ok(!delegated.includes('alpha-skill'));
    assert.ok(delegated.includes('RULE BODY'), 'scope-matched rules still apply to the child');
  } finally {
    ws.cleanup();
  }
});

test('bounded fields keep known limits and mark truncation', () => {
  const marker = buildTruncationMarker({ kept: 10, total: 99 });
  const clipped = describeBoundedField(`${marker}\nrest`, CONTEXT_LEGACY_LIMITS.harnessHandoff);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.limit, 24000);
  const big = describeBoundedField('x'.repeat(8001), CONTEXT_LEGACY_LIMITS.delegationReport);
  assert.equal(big.overLimit, true);
  assert.equal(describeBoundedField('', CONTEXT_LEGACY_LIMITS.delegationReport).present, false);
});

test('MCP context_manifest: read-only, scoped to chat and workspace, never activates or acks', async () => {
  const wsA = makeWorkspace('cr-dcm-mcp-a-');
  const wsB = makeWorkspace('cr-dcm-mcp-b-');
  try {
    assert.ok(getBuiltinMcpReadTools().includes('context_manifest'));
    assert.ok(!getBuiltinMcpMutatingTools().includes('context_manifest'));
    const parentA = addChat('s5', 'pa', null, wsA.root, 'm', { agentTransport: 'opencode', sdkMode: 'agent' });
    const otherA = addChat('s6', 'oa', null, wsA.root, 'm', { agentTransport: 'opencode', sdkMode: 'agent' });
    const parentB = addChat('s7', 'pb', null, wsB.root, 'm', { agentTransport: 'opencode', sdkMode: 'agent' });
    const row = createDelegationRecord({
      parentChatId: parentA.id,
      workspaceFolder: wsA.root,
      executor: { transport: 'claude', model: 'sonnet' },
      assignment: 'implement',
      executionMode: 'agent',
      sourceKind: 'message',
      sourceText: 'work',
    });
    updateDelegationRecord(row.id, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS\n@alpha-skill' });
    const handlersFor = (chat, root) => {
      const client = createInProcessMcpClient({ harness: 'opencode', chatId: chat.id, workspaceFolder: root });
      return createCretliMcpToolHandlers(client, {
        chatId: chat.id, workspaceFolder: root, harness: 'opencode', mode: 'plan', builtinClient: client,
      });
    };
    const owner = await handlersFor(parentA, wsA.root).context_manifest({ delegation_id: row.id });
    assert.equal(owner.isError, false);
    const out = owner.structuredContent;
    assert.equal(out.manifest.subject, 'delegation');
    assert.equal(out.manifest.instructions.profile, 'implement');
    assert.equal(out.parent.subject, 'chat');
    assert.ok(out.comparison);
    // The report text (with a mention) did not activate a skill and was not marked delivered.
    assert.equal(out.manifest.instructions.delivered.some((item) => item.kind === 'skill'), false);
    assert.equal(JSON.stringify(out).includes('@alpha-skill'), false);
    const { getDelegationById } = await import('../lib/persist/delegations-persist.js');
    assert.ok(!getDelegationById(row.id).reportDeliveredAt);
    // Own chat manifest.
    const own = await handlersFor(parentA, wsA.root).context_manifest({});
    assert.equal(own.structuredContent.manifest.subject, 'chat');
    // A chat of the same workspace that is not part of the delegation: NOT_FOUND.
    const sibling = await handlersFor(otherA, wsA.root).context_manifest({ delegation_id: row.id });
    assert.equal(sibling.isError, true);
    assert.equal(sibling.structuredContent.code, 'NOT_FOUND');
    // Another workspace: NOT_FOUND, no existence leak.
    const foreign = await handlersFor(parentB, wsB.root).context_manifest({ delegation_id: row.id });
    assert.equal(foreign.isError, true);
    assert.equal(foreign.structuredContent.code, 'NOT_FOUND');
    // Workspace mismatch even for the right chat id.
    const wrongWs = await handlersFor(parentA, wsB.root).context_manifest({ delegation_id: row.id });
    assert.equal(wrongWs.isError, true);
  } finally {
    wsA.cleanup();
    wsB.cleanup();
  }
});
