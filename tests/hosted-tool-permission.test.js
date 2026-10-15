import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHostedToolPermissionGate, handleHostedToolPermissionReply } from '../lib/approval/hosted-tool-permission.js';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import { runLlmToolLoop } from '../lib/agent-harness/llm-tool-loop.js';
import { HOSTED_PERMISSION_HARNESSES, PERMISSION_CONTROL_HARNESSES, GATED_PERMISSION_HARNESSES } from '../lib/approval/harness-permission-controls.js';
import { SPA_HARNESS_IDS, SPA_SETTINGS_TABS } from '../lib/spa-routes.js';

test('every harness has a permission tab and persisted settings; capabilities are explicit', () => {
  assert.deepEqual([...PERMISSION_CONTROL_HARNESSES].sort(), [...SPA_HARNESS_IDS].sort());
  for (const harness of SPA_HARNESS_IDS) assert.ok(SPA_SETTINGS_TABS.includes(`harness-${harness}-approvals`));
  for (const harness of ['codex', 'sdk', 'codebuddy', 'deepseek']) assert.ok(!GATED_PERMISSION_HARNESSES.includes(harness));
});

for (const harness of HOSTED_PERMISSION_HARNESSES) {
  test(`${harness}: write waits for human consent, rejection prevents side effects, disabled checks permit writes`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-permission-'));
    for (const name of ['result.txt', 'without-card.txt', 'plan.txt']) fs.writeFileSync(path.join(cwd, name), 'original');
    const room = { cwd, sdkMode: 'agent', abortController: new AbortController() };
    const events = [];
    const settings = { approvalBroker: { mode: 'local_reads' } };
    const checkPermission = createHostedToolPermissionGate({ harness, room, settings, broadcastRoom: (_room, event) => events.push(event) });
    try {
      const pending = executeTool('write_file', { path: 'result.txt', content: 'hello' }, { cwd, mode: 'agent', checkPermission });
      const card = events.find((event) => event.event?.type === 'opencode_permission').event;
      assert.equal(card.harness, harness);
      assert.equal(card.allowAlways, true);
      assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), 'original');
      assert.equal(handleHostedToolPermissionReply(room, { requestId: card.requestId, reply: 'reject' }), true);
      assert.equal((await pending).ok, false);
      assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), 'original');
      const allowed = executeTool('write_file', { path: 'result.txt', content: 'hello' }, { cwd, mode: 'agent', checkPermission });
      const [next] = room._pendingQuestions.values();
      handleHostedToolPermissionReply(room, { requestId: next.requestId, reply: 'once' });
      assert.equal((await allowed).ok, true);
      settings.harnessPermissionControls = { [harness]: { files: false } };
      assert.equal((await executeTool('write_file', { path: 'without-card.txt', content: 'hello' }, { cwd, mode: 'agent', checkPermission })).ok, true);
      assert.equal(room._pendingQuestions.size, 0);
      const guarded = await executeTool('write_file', { path: 'plan.txt', content: 'no' }, { cwd, mode: 'plan', checkPermission });
      assert.equal(guarded.ok, false);
      assert.equal(fs.readFileSync(path.join(cwd, 'plan.txt'), 'utf8'), 'original');
    } finally {
      room.abortController.abort();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('LLM loop passes the permission gate to tool execution and resumes after consent', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-permission-'));
  let calls = 0;
  let checked = 0;
  try {
    const result = await runLlmToolLoop({
      transport: 'mistral', model: 'test', cwd, mode: 'agent', messages: [{ role: 'user', content: 'write' }],
      checkPermission: async (name) => { checked += 1; assert.equal(name, 'write_file'); return { outcome: 'deny' }; },
      streamChatCompletion: async function* () {
        calls += 1;
        if (calls === 1) yield { toolCallDeltas: [{ index: 0, id: 'tool-1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'denied.txt', content: 'no' }) } }], finishReason: 'tool_calls' };
        else yield { deltaText: 'done', finishReason: 'stop' };
      },
      callbacks: { onEvent: () => {} },
    });
    assert.equal(result.ok, true);
    assert.equal(checked, 1);
    assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cancelling a hosted run denies its pending tool and closes the card', async () => {
  const room = { cwd: '/workspace', sdkMode: 'agent', abortController: new AbortController() };
  const events = [];
  const checkPermission = createHostedToolPermissionGate({
    harness: 'mistral', room,
    settings: { approvalBroker: { mode: 'local_reads' } },
    broadcastRoom: (_room, event) => events.push(event),
  });
  const pending = checkPermission('write_file', { path: 'result.txt' });
  assert.equal(room._pendingQuestions.size, 1);
  room.abortController.abort();
  assert.equal((await pending).outcome, 'deny');
  assert.equal(room._pendingQuestions.size, 0);
  assert.ok(events.some((event) => event.type === 'opencodePermissionResolved'));
});
