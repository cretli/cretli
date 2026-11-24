import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { beginHarnessRun, recordHarnessUsageSnapshot, recordHarnessRunFinished } from '../lib/usage/harness-usage.ts';
import { filterUsageEvents } from '../lib/usage/usage-insights.ts';
import { readUsageEvents } from '../lib/persist/usage-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { runOnChatsBackends, seedChatRows } from './helpers/chats-backends.js';
import { makeTempDir } from './helpers/temp-dir.js';
import { getActiveChatsRuntime, setActiveChatsRuntime } from '../lib/persist/chats-runtime.js';

const foldersId = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const fileId = 'cretli:ws:22222222-2222-4222-8222-222222222222';
const workspaceFile = '/work/acme.code-workspace';

test('production harness events retain the stored chat workspace through the ledger and Usage filter', async () => {
  await runOnChatsBackends(async (backend) => {
    saveSettings({
      workspaceFile: '/work/unrelated.code-workspace',
      workspaces: [
        { id: foldersId, kind: 'folders' },
        { id: fileId, kind: 'file', importedFrom: workspaceFile },
      ],
    });
    const cases = [
      { id: 'folders-chat', workspaceId: foldersId, workspaceFolder: '/work/acme', key: foldersId },
      { id: 'file-chat', workspaceId: fileId, workspaceFolder: '/work/acme', key: workspaceFile },
      { id: 'legacy-file-chat', workspaceFile, workspaceFolder: '/work/acme', key: workspaceFile },
      { id: 'folder-chat', workspaceFolder: '/work/standalone', key: '/work/standalone' },
      { id: 'missing-chat', key: undefined },
    ];
    await seedChatRows(cases.filter((row) => row.id !== 'missing-chat'));
    const dataDir = makeTempDir(`cretli-usage-scope-${backend}-`);
    const kernel = createAgentRoomKernel({ transport: 'codex', persistHistory: () => {}, usageDataDir: dataDir });
    for (const entry of cases) {
      const room = kernel.createRoomState({ sessionKey: entry.id, chatId: entry.id });
      const runId = `run-${entry.id}`;
      kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId });
      kernel.broadcastRoom(room, { type: 'sdkEvent', event: {
        type: 'usage', usage: { input_tokens: 100, output_tokens: 20 }, final: true,
      } });
      kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId, status: 'completed' });
    }
    // Broadcast handlers intentionally do not block the stream on metadata I/O.
    let events = [];
    const deadline = Date.now() + 5000;
    while (events.length < cases.length * 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events = readUsageEvents({ dataDir });
    }
    assert.equal(events.length, cases.length * 2);
    for (const entry of cases) {
      const rows = events.filter((row) => row.chatId === entry.id);
      assert.deepEqual(rows.map((row) => row.eventType).sort(), ['delta', 'run']);
      for (const row of rows) assert.equal(row.workspaceFile, entry.key);
      if (entry.key) {
        const scoped = filterUsageEvents(events, { workspaceFile: entry.key });
        assert.ok(scoped.some((row) => row.chatId === entry.id && row.eventType === 'delta'));
        assert.ok(scoped.some((row) => row.chatId === entry.id && row.eventType === 'run'));
        assert.ok(scoped.every((row) => row.workspaceFile === entry.key));
      }
    }
    assert.deepEqual(filterUsageEvents(events, { workspaceFile: '/work/unrelated.code-workspace' }), []);
  });
});

test('Cursor snapshot and run writers resolve workspace from chatId without room workspace fields', async () => {
  await runOnChatsBackends(async () => {
    await seedChatRows([{ id: 'sdk-workspace-chat', workspaceId: foldersId, workspaceFolder: '/work/acme' }]);
    const room = { chatId: 'sdk-workspace-chat', modelId: 'composer-2.5' };
    beginHarnessRun(room, { runId: 'sdk-workspace-run' });
    const delta = await recordHarnessUsageSnapshot(room, 'sdk', { inputTokens: 100, outputTokens: 20 });
    const run = await recordHarnessRunFinished(room, 'sdk', { status: 'completed' });
    assert.equal(delta.workspaceFile, foldersId);
    assert.equal(run.workspaceFile, foldersId);
    assert.equal(filterUsageEvents([delta, run], { workspaceFile: foldersId }).length, 2);
  });
});

test('a failed chat lookup keeps usage without attributing it to the global selection', async (t) => {
  const runtime = getActiveChatsRuntime();
  const lookup = t.mock.fn(async () => { throw new Error('metadata unavailable'); });
  setActiveChatsRuntime({ ...runtime, api: { ...runtime.api, getChatByIdAsync: lookup } });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const room = { chatId: 'unavailable-chat' };
  try {
    const delta = await recordHarnessUsageSnapshot(room, 'sdk', { inputTokens: 5 });
    assert.equal(delta.workspaceFile, undefined);
    assert.equal(delta.tokens.textInput, 5);
    assert.equal(lookup.mock.callCount(), 1);
    assert.ok(errors.some((line) => line.includes('workspace attribution failed')));
  } finally {
    setActiveChatsRuntime(runtime);
  }
});
