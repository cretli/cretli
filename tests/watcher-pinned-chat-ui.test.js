/**
 * Pinned workspace chat UI helpers: slash-command parsing, REST mapping and the
 * sidebar pinned entry store.
 */
import assert from 'node:assert/strict';
import {
  WATCHER_PINNED_COMMANDS,
  isWatcherPinnedChat,
  parseWatcherCommand,
  runWatcherCommand,
  watcherCommandHelpLines,
} from '../app_front/features/chat/watcherPinnedChat.js';
import {
  __resetWorkspaceWatcherBadgeForTest,
  applyWorkspaceWatcherPresence,
  listWorkspaceWatcherPinnedChats,
} from '../app_front/features/sidebar/workspaceAutopilotBadge.js';

let failed = 0;
/** @type {Promise<void>[]} */
const pending = [];

function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => console.log('OK:', name), (err) => fail(name, err)));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    fail(name, err);
  }
}

function fail(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

runCase('parseWatcherCommand parses name and args, rejects plain text', () => {
  assert.deepEqual(parseWatcherCommand('/pause'), { command: 'pause', args: '', raw: '/pause' });
  assert.equal(parseWatcherCommand('/skip todo-123').command, 'skip');
  assert.equal(parseWatcherCommand('/skip todo-123').args, 'todo-123');
  assert.equal(parseWatcherCommand('/STOP because reasons').command, 'stop');
  assert.equal(parseWatcherCommand('hello'), null);
  assert.equal(parseWatcherCommand('   '), null);
});

runCase('watcherCommandHelpLines documents every command', () => {
  const lines = watcherCommandHelpLines((key) => key);
  assert.equal(lines.length, WATCHER_PINNED_COMMANDS.length);
  assert.ok(lines[0].includes('/help'));
});

runCase('isWatcherPinnedChat only matches the marker', () => {
  assert.equal(isWatcherPinnedChat({ watcherPinned: true }), true);
  assert.equal(isWatcherPinnedChat({ watcherPinned: false }), false);
  assert.equal(isWatcherPinnedChat(null), false);
});

runCase('runWatcherCommand maps commands onto existing endpoints', async () => {
  /** @type {Array<{ url: string, method: string, body: object }>} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      status: 200,
      async json() {
        if (String(url).startsWith('/api/workspace-watcher/tick')) {
          return { ok: true, tick: { action: 'observe_ready' } };
        }
        return { ok: true, watcher: { mode: 'autopilot', paused: false, activeCycles: [], stopReason: '' } };
      },
    };
  };

  const pause = await runWatcherCommand({ command: 'pause', workspaceFolder: '/w', fetchImpl });
  assert.equal(pause.ok, true);
  assert.equal(calls[0].url, '/api/workspace-watcher/pause');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.workspaceFolder, '/w');

  const stop = await runWatcherCommand({ command: 'stop', args: 'lunch', workspaceFolder: '/w', fetchImpl });
  assert.equal(stop.ok, true);
  assert.equal(calls[1].url, '/api/workspace-watcher');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].body.stopReason, 'lunch');

  const skip = await runWatcherCommand({ command: 'skip', args: 'todo-9', workspaceFolder: '/w', chatId: 'c1', fetchImpl });
  assert.equal(skip.ok, true);
  assert.equal(calls[2].url, '/api/todos/todo-9');
  assert.equal(calls[2].method, 'PATCH');
  assert.equal(calls[2].body.status, 'done');

  const tick = await runWatcherCommand({ command: 'tick', workspaceFolder: '/w', fetchImpl });
  assert.equal(tick.message, 'Tick: observe_ready');

  const unknown = await runWatcherCommand({ command: 'nope', workspaceFolder: '/w', fetchImpl });
  assert.equal(unknown.ok, false);
});

runCase('presence store exposes pinned chats for the sidebar section', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([
    { workspaceFolder: '/a', mode: 'autopilot', pinnedChatId: 'chat-a' },
    { workspaceFolder: '/b', mode: 'observe', pinnedChatId: '' },
    { workspaceFolder: '/c', mode: 'autopilot', pinnedChatId: 'chat-c' },
  ]);
  const entries = listWorkspaceWatcherPinnedChats();
  assert.deepEqual(entries.map((entry) => entry.pinnedChatId), ['chat-a', 'chat-c']);
});

await Promise.all(pending);
if (failed > 0) {
  console.error(`${failed} watcher pinned chat UI test(s) failed`);
  process.exit(1);
}
console.log('watcher pinned chat UI tests passed');
