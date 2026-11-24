import './helpers/isolated-data-dir.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addChatAsync, getChatByIdAsync, loadChatsAsync, saveChatsAsync, setChatClaudeSessionIdAsync, updateChatAsync } from '../lib/persist/chats-persist.js';
import { addChat, updateChat } from '../lib/persist/chats-legacy-store.js';
import { createChatsRuntime, setActiveChatsRuntime } from '../lib/persist/chats-runtime.js';
import { createSqliteChatsBackend } from '../lib/persist/chats-backend-sqlite.js';
import { createChatsStore } from '../lib/storage/chats-store.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { applyAgentTitle, __resetAgentTitleStateForTest } from '../lib/chat-title-agent.js';
import { createChatTitleDispatcher } from '../lib/chat-title-dispatcher.js';
import { saveSettings, loadSettings } from '../lib/persist/settings.js';
import { subscribeChatListUpdates, unsubscribeChatListUpdates } from '../lib/chat-list-updates.js';
import { runChatWrite, settleChatWrites } from '../lib/chat-write-async.js';
import { summarizeChatRunStatesAsync } from '../lib/agent-run-state.js';
import { runOnChatsBackends, seedChatRows } from './helpers/chats-backends.js';
import { tempDir } from './fixtures/storage-chats-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chats-handlers.js', import.meta.url));

// ---------------------------------------------------------------------------------------------------
// Scope contract: the files of the routes / lifecycle / titles groups
// ---------------------------------------------------------------------------------------------------

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(js|ts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const SCOPE_FILES = [
  ...walk('lib/routes'),
  ...walk('lib/claude'),
  ...walk('lib/codex'),
  ...fs.readdirSync(path.join(ROOT, 'harnesses')).filter((d) => fs.existsSync(path.join(ROOT, 'harnesses', d)) && fs.statSync(path.join(ROOT, 'harnesses', d)).isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(ROOT, 'harnesses', d)).filter((f) => f.endsWith('-agent-ws.js')).map((f) => path.join('harnesses', d, f))),
  'lib/agent-presence-bus.js',
  'lib/chat-run-service.js',
  'lib/agent-run-state.js',
  'lib/conversation-fork-execute.js',
  'lib/fork-chat-text.js',
  'lib/chat-message-guard.js',
  'lib/agent-harness/room-kernel.ts',
  'lib/chat-run/kernel-adapter.ts',
  'lib/chat-title-agent.js',
  'lib/chat-title-backfill.js',
  'lib/chat-title-dispatcher.js',
  'lib/chat-title-service.js',
  'lib/chat-write-async.js',
].filter((file, i, all) => all.indexOf(file) === i && fs.existsSync(path.join(ROOT, file)));

/** Pure helpers of chats-persist that stay synchronous by design (docs/storage-chats-b-caller-inventory.md). */
const PURE_HELPERS = new Set([
  'withTitleSource', 'inferChatTitleSource', 'createFreshSdkContextEntry', 'DEFAULT_CHAT_TITLE_RE', 'CHAT_TITLE_SOURCES',
  'setChatArchiveRejector', 'onChatArchived', 'getChatsReadStats', 'legacyChatsBackend',
]);

/**
 * Mixed-phase shim users: signatures that unconverted callers still invoke synchronously. The list may only shrink.
 */
const SYNC_COMPAT_USERS = ['lib/chat-message-guard.js', 'lib/chat-run-service.js', 'lib/chat-title-agent.js', 'lib/routes/recovery-resume-routes.js'];

/**
 * @param {string} source
 * @returns {string[]} the names imported from a `chats-persist.js` module (static, type-only and dynamic imports)
 */
function importedPersistNames(source) {
  const names = [];
  const patterns = [
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*\/chats-persist\.js'/g,
    /(?:const|let)\s+\{([^}]*)\}\s*=\s*await\s+import\(\s*'[^']*\/chats-persist\.js'\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

describe('B2 scope contract', () => {
  it('finds the converted files', () => {
    assert.ok(SCOPE_FILES.length > 40, `scope enumeration found only ${SCOPE_FILES.length} files`);
    for (const must of ['lib/routes/chats-routes.js', 'lib/chat-run-service.js', 'lib/claude/claude-agent-ws.ts', 'lib/codex/codex-agent-ws.ts', 'harnesses/qwen/qwen-agent-ws.js', 'lib/chat-title-service.js']) {
      assert.ok(SCOPE_FILES.includes(must), must);
    }
  });

  it('no file in scope imports a synchronous chats-persist export', () => {
    const offenders = [];
    for (const file of SCOPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const name of importedPersistNames(source)) {
        if (!name.endsWith('Async') && !PURE_HELPERS.has(name)) offenders.push(`${file}: ${name}`);
      }
      // Namespace / default style imports would bypass the named check.
      assert.doesNotMatch(source, /import\s+\*\s+as\s+\w+\s+from\s+'[^']*\/chats-persist\.js'/, `${file} imports the chats-persist namespace`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the sync compat shim is gone: no file in scope imports it', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'lib/persist/chats-sync-compat.js')), false);
    const users = SCOPE_FILES.filter((file) => /chats-sync-compat/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    assert.deepEqual(users, []);
  });

  it('holds no lock across an await: no blocking wait or file lock in the scope', () => {
    for (const file of SCOPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.doesNotMatch(source, /Atomics\.wait\(/, `${file} blocks the event loop`);
      assert.doesNotMatch(source, /\b(?:withChatsLock|acquireChatsLock|lockSync|withStoreLock)\b/, `${file} takes a chats lock`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// RMW scenarios on both backends
// ---------------------------------------------------------------------------------------------------

describe('B2 read-modify-write on legacy and sqlite', () => {
  it('two concurrent agent titles: exactly one applies (version-checked), the other is skipped', async () => {
    await runOnChatsBackends(async (kind) => {
      const previous = loadSettings();
      saveSettings({ ...previous, autoTitle: { mode: 'first', source: 'agent' } });
      try {
        __resetAgentTitleStateForTest();
        const chat = await addChatAsync(`sess-rmw-${kind}`, 'Claude chat 1', undefined, undefined, undefined, {});
        const results = await Promise.all([
          applyAgentTitle(chat.id, 'auth: fix token expiry'),
          applyAgentTitle(chat.id, 'auth: another idea'),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), ['applied', 'skipped'], kind);
        const stored = await getChatByIdAsync(chat.id);
        assert.equal(stored.titleSource, 'auto');
        assert.ok(['auth: fix token expiry', 'auth: another idea'].includes(stored.title));
      } finally {
        saveSettings(previous);
        __resetAgentTitleStateForTest();
      }
    });
  });

  it('a session-id write, a model write and a fire-and-forget write interleave without losing a field', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-fields-${kind}`, 'Fields', undefined, undefined, undefined, { agentTransport: 'claude' });
      // Two concurrent writers per row stay inside the adapter's CAS retry budget; more are serialized by the caller.
      runChatWrite('model', () => updateChatAsync(chat.id, { model: 'm-fire' }), chat.id);
      await setChatClaudeSessionIdAsync(chat.id, 'claude-session-1');
      await Promise.all([
        updateChatAsync(chat.id, { sdkMode: 'plan' }),
        updateChatAsync(chat.id, { summary: 'S', summaryTitle: 'T' }),
      ]);
      await settleChatWrites(chat.id);
      const stored = await getChatByIdAsync(chat.id);
      assert.equal(stored.claudeSessionId, 'claude-session-1', kind);
      assert.equal(stored.sdkMode, 'plan', kind);
      assert.equal(stored.model, 'm-fire', kind);
      assert.equal(stored.summaries.length, 1, kind);
    });
  });

  it('fire-and-forget session writes keep their call order', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-order-${kind}`, 'Order', undefined, undefined, undefined, { agentTransport: 'claude' });
      for (let i = 0; i < 12; i += 1) runChatWrite('claudeSessionId', () => setChatClaudeSessionIdAsync(chat.id, `s-${i}`), chat.id);
      await settleChatWrites(chat.id);
      assert.equal((await getChatByIdAsync(chat.id)).claudeSessionId, 's-11', kind);
    });
  });

  it('presence summary reads the rows through the runtime', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-pres-${kind}`, 'Presence', undefined, undefined, undefined, {});
      const states = await summarizeChatRunStatesAsync([chat.id]);
      assert.deepEqual(states, {}, 'an idle chat is omitted');
      assert.equal((await loadChatsAsync()).length, 1);
    });
  });

  it('seedChatRows replays raw rows on sqlite and on legacy alike', async () => {
    await runOnChatsBackends(async (kind) => {
      await seedChatRows([
        { id: 'p1', title: 'Parent', cursorSessionId: 'cs-p1', agentTransport: 'claude', workspaceFolder: '/w' },
        { id: 'c1', title: 'Child', cursorSessionId: 'cs-c1', agentTransport: 'claude', forkParentChatId: 'p1', archivedAt: '2026-01-01T00:00:00.000Z' },
      ]);
      const rows = await loadChatsAsync();
      assert.deepEqual(rows.map((r) => r.id).sort(), ['c1', 'p1'], kind);
      assert.ok((await getChatByIdAsync('c1')).archivedAt, kind);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Mixed phase: a converted group next to a not-yet-converted sync caller on the legacy runtime
// ---------------------------------------------------------------------------------------------------

describe('B2 mixed phase on the legacy runtime', () => {
  afterEach(async () => {
    setActiveChatsRuntime(null);
    await saveChatsAsync([]);
  });

  it('converted async writers and a sync caller share one adapter and lose no write', async () => {
    await saveChatsAsync([]);
    const base = addChat('sess-mixed', 'Mixed', undefined, undefined, undefined, { agentTransport: 'claude' });
    const pending = [];
    for (let i = 0; i < 20; i += 1) {
      // The not-yet-converted caller (sync) and the converted group (async) alternate without awaiting between.
      updateChat(base.id, { model: `sync-${i}` });
      pending.push(setChatClaudeSessionIdAsync(base.id, `async-${i}`));
      pending.push(addChatAsync(`sess-mixed-${i}`, `Async ${i}`, undefined, undefined, undefined, {}));
      addChat(`sess-mixed-sync-${i}`, `Sync ${i}`, undefined, undefined, undefined, {});
    }
    await Promise.all(pending);
    const stored = await getChatByIdAsync(base.id);
    assert.equal(stored.model, 'sync-19');
    assert.equal(stored.claudeSessionId, 'async-19');
    assert.equal((await loadChatsAsync()).length, 1 + 20 + 20, 'every row of both writers is present');
  });
});

// ---------------------------------------------------------------------------------------------------
// Ordering: effects after COMMIT, dispatch after the read
// ---------------------------------------------------------------------------------------------------

describe('B2 ordering: broadcast and dispatch only after the data is durable', () => {
  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];
  afterEach(async () => {
    setActiveChatsRuntime(null);
    while (cleanups.length) await cleanups.pop()();
  });

  async function gatedSqliteRuntime() {
    const dir = tempDir('chats-b2-order-');
    const host = createStorageWorkerHost({
      dbDir: dir, filename: 'chats.sqlite', handlersPath: HANDLERS_PATH,
      writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
    });
    await host.start();
    cleanups.push(async () => { await host.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
    const store = createChatsStore({ host, datasetGeneration: 'gen-order' });
    const log = [];
    let gate = null;
    // The store object is frozen, so the wrapper is a plain copy with the write methods replaced.
    const wrapped = { ...store };
    for (const name of ['update', 'updateMany', 'add', 'remove']) {
      const original = store[name];
      if (typeof original !== 'function') continue;
      wrapped[name] = async (...args) => {
        log.push(`${name}:start`);
        if (gate && name === 'update') await gate;
        const reply = await original.apply(store, args);
        log.push(`${name}:committed`);
        return reply;
      };
    }
    const runtime = createChatsRuntime({ backend: createSqliteChatsBackend({ store: wrapped }), backendKind: 'sqlite' });
    setActiveChatsRuntime(runtime);
    return { log, setGate: (promise) => { gate = promise; } };
  }

  it('the title list frame of an agent title leaves only after the update committed', async () => {
    const previous = loadSettings();
    saveSettings({ ...previous, autoTitle: { mode: 'first', source: 'agent' } });
    cleanups.push(async () => { saveSettings(previous); __resetAgentTitleStateForTest(); });
    const { log, setGate } = await gatedSqliteRuntime();
    __resetAgentTitleStateForTest();
    const chat = await addChatAsync('sess-order-title', 'Claude chat 1', undefined, undefined, undefined, {});
    const ws = Object.assign({ readyState: 1, send: (raw) => { log.push(`frame:${JSON.parse(raw).reason}`); }, once() {} });
    subscribeChatListUpdates(ws);
    cleanups.push(async () => unsubscribeChatListUpdates(ws));
    let release;
    setGate(new Promise((resolve) => { release = resolve; }));
    log.length = 0;
    const pending = applyAgentTitle(chat.id, 'auth: fix token expiry');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!log.some((entry) => entry.startsWith('frame:')), 'nothing is broadcast while the command is in flight');
    release();
    const result = await pending;
    assert.equal(result.status, 'applied');
    const commit = log.indexOf('update:committed');
    const frame = log.findIndex((entry) => entry.startsWith('frame:'));
    assert.ok(commit >= 0 && frame > commit, `frame after commit: ${JSON.stringify(log)}`);
  });

  it('the title job is dispatched only after the chat row was read', async () => {
    await runOnChatsBackends(async (kind) => {
      const chat = await addChatAsync(`sess-dispatch-${kind}`, 'Claude chat 1', undefined, undefined, undefined, {});
      const order = [];
      let release;
      const slowRead = new Promise((resolve) => { release = resolve; });
      const dispatcher = createChatTitleDispatcher({
        service: { requestTitle: async () => { order.push('dispatched'); return {}; } },
        loadChat: async (id) => { order.push('read:start'); await slowRead; order.push('read:done'); return getChatByIdAsync(id); },
        getSettings: () => ({ mode: 'first', source: 'server' }),
        defer: (fn) => fn(),
      });
      const pending = dispatcher.noteRunFinished(chat.id, { status: 'completed' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, ['read:start'], `${kind}: nothing dispatched before the row is read`);
      release();
      assert.equal(await pending, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order.slice(0, 3), ['read:start', 'read:done', 'read:start'], kind);
      assert.ok(order.includes('dispatched'), kind);
    });
  });
});
