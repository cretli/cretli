import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-title-dispatch-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { addChat, updateChat, loadChats } = await import('../lib/persist/chats-persist.js');
const { appendChatHistoryEvents } = await import('../lib/persist/chat-history-persist.js');
const { saveSettings } = await import('../lib/persist/settings.js');
const { createAgentRoomKernel } = await import('../lib/agent-harness/room-kernel.js');
const { createChatTitleDispatcher, getAutoTitleSkipReason } = await import('../lib/chat-title-dispatcher.js');
const { createChatTitleService, __setChatTitleServiceForTest } = await import('../lib/chat-title-service.js');

const tick = () => new Promise((r) => setTimeout(r, 15));

try {
  // Real service with a fake generator wired as the process-wide service (what rooms use).
  const generated = [];
  __setChatTitleServiceForTest(
    createChatTitleService({
      generate: async () => {
        generated.push(1);
        return 'area: first turn title';
      },
      log: () => {},
    }),
  );

  // Every kernel-based harness: default title is replaced after the first finished turn.
  const harnesses = ['claude', 'codex', 'opencode', 'openrouter', 'deepseek', 'qwen', 'codebuddy'];
  for (const harness of harnesses) {
    const chat = addChat(`${harness}-sess`, `${harness} chat 7`, undefined, undefined, undefined, {
      agentTransport: harness === 'openrouter' ? 'openrouter' : harness,
    });
    appendChatHistoryEvents(chat.id, `${harness}-sess`, [{ rec: { kind: 'localUser', text: 'Zrób refaktor modułu X' } }]);
    const kernel = createAgentRoomKernel({ transport: harness, persistHistory: () => {}, recordUsage: () => {} });
    const room = kernel.createRoomState({ sessionKey: `${harness}-sess`, chatId: chat.id });
    kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'r1' });
    kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'r1', status: 'completed' });
    await tick();
    const after = loadChats().find((c) => c.id === chat.id);
    assert.equal(after.title, 'area: first turn title', harness);
    assert.equal(after.titleSource, 'auto', harness);
    assert.doesNotMatch(after.title, /chat \d+$/i);
    // idempotent: a second finished turn does not generate again
    const before = generated.length;
    kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'r2', status: 'completed' });
    await tick();
    assert.equal(generated.length, before, `${harness} second turn`);
  }
  assert.equal(generated.length, harnesses.length);

  // Skip rules (dispatcher level, with a recording service)
  const requested = [];
  const make = (extra = {}) =>
    createChatTitleDispatcher({
      service: { requestTitle: async (id, o) => requested.push([id, o]) },
      defer: (fn) => fn(),
      log: () => {},
      ...extra,
    });
  const d = make();
  const mk = (title, extras = {}) => addChat(`s-${Math.random()}`, title, undefined, undefined, undefined, extras);
  const manual = mk('My name');
  const temp = mk('[Temp] Chat title', { isTemporary: true, forkKind: 'title' });
  const deleg = mk('Claude chat 1', { delegationParentChatId: 'p', delegationId: 'd' });
  const archived = mk('Claude chat 2');
  updateChat(archived.id, { archived: true });
  const ok = mk('Claude chat 3');
  assert.equal(d.noteRunFinished(manual.id, { status: 'completed' }), false);
  assert.equal(d.noteRunFinished(temp.id, { status: 'completed' }), false);
  assert.equal(d.noteRunFinished(deleg.id, { status: 'completed' }), false);
  assert.equal(d.noteRunFinished(archived.id, { status: 'completed' }), false);
  assert.equal(d.noteRunFinished('missing', { status: 'completed' }), false);
  assert.equal(d.noteRunFinished(ok.id, { status: 'error' }), false);
  assert.equal(d.noteRunFinished(ok.id, { status: 'cancelled' }), false);
  assert.equal(requested.length, 0);
  assert.equal(d.noteRunFinished(ok.id, { status: 'finished' }), true);
  assert.deepEqual(requested, [[ok.id, { reason: 'first' }]]);
  assert.equal(getAutoTitleSkipReason(manual), 'not_default');
  assert.equal(getAutoTitleSkipReason(temp), 'temporary');

  // Server setting: off disables; default is 'first'
  saveSettings({ autoTitle: { mode: 'off' } });
  requested.length = 0;
  assert.equal(make().noteRunFinished(ok.id, { status: 'completed' }), false);
  saveSettings({ autoTitle: { mode: 'first' } });
  assert.equal(make().noteRunFinished(ok.id, { status: 'completed' }), true);

  // Rename between schedule and run: deferred re-check wins
  let deferred;
  const late = createChatTitleDispatcher({
    service: { requestTitle: async (id) => requested.push([id]) },
    defer: (fn) => { deferred = fn; },
    log: () => {},
  });
  const target = mk('Claude chat 9');
  requested.length = 0;
  assert.equal(late.noteRunFinished(target.id, { status: 'completed' }), true);
  updateChat(target.id, { title: 'Renamed in between' });
  deferred();
  assert.equal(requested.length, 0);

  // SDK room path is wired too
  const sdkSrc = fs.readFileSync(new URL('../lib/sdk/cursor-agent-sdk-ws.js', import.meta.url), 'utf8');
  assert.match(sdkSrc, /noteRoomRunFinishedForAutoTitle\(room, outgoingPayload\)/);

  console.log('chat-title-dispatcher.test.js OK');
} finally {
  __setChatTitleServiceForTest(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
