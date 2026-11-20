import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveChatFamily,
  archiveFamilyMembers,
  buildChatFamilyIndex,
  createFamilyCollector,
} from '../lib/chat-archive-policy.js';
import { sweepClosedWorkspaceWatcherCycles } from '../lib/workspace-watcher-archive-sweep.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const OLD = '2026-10-01T00:00:00Z';
const chat = (id, extra = {}) => ({ id, updatedAt: OLD, createdAt: OLD, ...extra });

test('cascade mode writes one cover root and still reports every member, children first', async () => {
  const members = [chat('root'), chat('a', { forkParentChatId: 'root' }), chat('b', { forkParentChatId: 'a' })];
  const writes = [];
  const gates = [];
  const out = await archiveFamilyMembers(members, {
    cascade: true,
    updateChat: (id) => { writes.push(id); },
    beforeArchive: (m) => { gates.push(m.id); return true; },
  });
  assert.deepEqual(writes, ['root']);
  assert.deepEqual(gates, ['b', 'a', 'root']);
  assert.deepEqual(out.archived, ['b', 'a', 'root']);
});

test('cascade mode: a refusing gate stops before any write and keeps the prefix semantics', async () => {
  const members = [chat('root'), chat('a', { forkParentChatId: 'root' })];
  const writes = [];
  const out = await archiveFamilyMembers(members, {
    cascade: true,
    updateChat: (id) => { writes.push(id); },
    beforeArchive: (m) => m.id !== 'root',
  });
  assert.deepEqual(writes, ['a']);
  assert.deepEqual(out.archived, ['a']);
  assert.equal(out.skipped, 1);
});

test('cascade mode: a failed write aborts without reporting members as archived', async () => {
  const members = [chat('root'), chat('x'), chat('a', { forkParentChatId: 'root' })];
  const out = await archiveFamilyMembers(members, {
    cascade: true,
    updateChat: () => { throw new Error('boom'); },
  });
  assert.deepEqual(out.archived, []);
  assert.equal(out.skipped, 1);
});

test('createFamilyCollector reuses an index built from the same list and ignores one from another list', () => {
  const chats = [chat('p'), chat('c', { forkParentChatId: 'p' })];
  const index = buildChatFamilyIndex(chats);
  const input = { chatArchivable: () => true, listDelegationsForController: () => [] };
  const reused = createFamilyCollector({ ...input, chats, index });
  assert.equal(reused.byId, index.byId);
  const other = createFamilyCollector({ ...input, chats: [chat('z')], index });
  assert.notEqual(other.byId, index.byId);
  assert.deepEqual(reused.collect(chats[0]).map((m) => m.id), ['p', 'c']);
});

test('archiveChatFamily with an injected updateChat keeps one write per member', async () => {
  const chats = [chat('p'), chat('c', { forkParentChatId: 'p' })];
  const writes = [];
  const out = await archiveChatFamily('p', {
    now: NOW,
    index: buildChatFamilyIndex(chats),
    deps: {
      loadChats: () => chats,
      updateChat: (id) => { writes.push(id); },
      listDelegationsForController: () => [],
      isChatRunConfirmedIdle: () => true,
    },
  });
  assert.deepEqual(writes, ['c', 'p']);
  assert.equal(out.reason, 'archived');
});

test('sweep of many families shares the snapshot, never re-archives and yields to the event loop', async () => {
  const chats = [];
  const rows = [];
  const FAMILIES = 300;
  for (let i = 0; i < FAMILIES; i += 1) {
    chats.push(chat(`o${i}`), chat(`k${i}`, { forkParentChatId: `o${i}` }));
    rows.push({
      workspaceFolder: '/w',
      cycleChats: [{ id: `o${i}`, closedAt: OLD }],
    });
  }
  const writes = [];
  let loads = 0;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const started = Date.now();
  const result = await sweepClosedWorkspaceWatcherCycles({
    now: NOW,
    rows: [{ workspaceFolder: '/w', cycleChats: rows.flatMap((r) => r.cycleChats) }],
    yieldEvery: 8,
    deps: {
      loadChats: () => { loads += 1; return chats; },
      updateChat: (id) => { writes.push(id); },
      listDelegationsForController: () => [],
      isChatRunConfirmedIdle: () => true,
    },
  });
  clearInterval(timer);
  assert.ok(Date.now() - started < 2000);
  assert.ok(ticks > 0, 'timers ran while the sweep was in progress');
  assert.equal(new Set(writes).size, writes.length, 'no chat written twice');
  assert.equal(result.considered, FAMILIES);
  assert.equal(result.archived.length, FAMILIES * 2);
  assert.equal(writes.length, FAMILIES * 2, 'injected updateChat keeps one write per member');
  assert.equal(loads, FAMILIES + 1, 'one initial load plus one gate load per family');
});

test('sweep with a batch store flushes cover roots in few writes, children before parents, crediting only confirmed roots', async () => {
  const chats = [];
  const cycleChats = [];
  for (let i = 0; i < 40; i += 1) {
    chats.push(chat(`o${i}`), chat(`k${i}`, { forkParentChatId: `o${i}` }));
    cycleChats.push({ id: `o${i}`, closedAt: OLD });
  }
  const batches = [];
  const result = await sweepClosedWorkspaceWatcherCycles({
    now: NOW,
    rows: [{ workspaceFolder: '/w', cycleChats }],
    yieldEvery: 16,
    deps: {
      loadChats: () => chats,
      archiveChats: async (ids) => {
        batches.push(ids);
        // Pretend the store failed on the 5th root of the first batch.
        return batches.length === 1 ? { archived: ids.slice(0, 4), failed: true } : { archived: ids, failed: false };
      },
      listDelegationsForController: () => [],
      isChatRunConfirmedIdle: () => true,
    },
  });
  assert.ok(batches.length < 10, 'far fewer writes than families');
  assert.ok(batches.every((ids) => ids.every((id) => id.startsWith('o'))), 'only cover roots are written');
  const credited = new Set(result.archived);
  assert.ok(credited.has('o0') && credited.has('k0'));
  assert.ok(!credited.has(batches[0][4]), 'a root the store did not confirm is not reported');
});

test('archiveChatsAsync falls back to per-id updateChat and stops at the first failure', async () => {
  const { createChatsRuntime } = await import('../lib/persist/chats-runtime.js');
  const calls = [];
  const backend = new Proxy({
    updateChat: async (id) => { calls.push(id); return id === 'bad' ? null : { id }; },
  }, { get: (t, k) => (k === 'archiveChats' ? undefined : t[k] ?? (() => { throw new Error(`unexpected ${String(k)}`); })) });
  const runtime = createChatsRuntime({ backend, backendKind: 'sqlite' });
  const out = await runtime.api.archiveChatsAsync(['a', 'bad', 'c']);
  assert.deepEqual(out, { archived: ['a'], failed: true });
  assert.deepEqual(calls, ['a', 'bad']);
});
