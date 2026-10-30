import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  applyChatRetention, getChatRetentionSettings, isTechnicalChat, planChatRetention,
  reportChatRetention, restoreRetainedChat, updateChatRetentionSettings,
} from '../lib/chat-retention.js';

test.after(() => removeIsolatedDataDir());

const DAY = 86400000;
const NOW = Date.parse('2026-03-03T12:00:00.000Z');
const old = new Date(NOW - 10 * DAY).toISOString();
const fresh = new Date(NOW - DAY).toISOString();
const chat = (id, title, extra = {}) => ({ id, title, workspaceFolder: '/w', updatedAt: old, ...extra });

/** In-memory "temp copy" of the data with the injected store functions. */
function world(chats, { todos = [], delegations = {} } = {}) {
  const copy = () => chats.map((c) => ({ ...c }));
  const deps = {
    loadChats: () => chats,
    updateChat: (id, u) => { const c = chats.find((x) => x.id === id); if (!c) return null; Object.assign(c, u.archived ? { archived: true, archivedAt: 'x' } : { archived: false, archivedAt: '' }); return c; },
    listTodos: async () => ({ items: todos }),
    listDelegationsForController: (id) => delegations[id] || [],
    listDelegationsForChat: (id) => delegations[id] || [],
    isChatRunConfirmedIdle: ({ chatId }) => chatId !== 'busy',
    isDelegationSlotOccupied: (r) => r.slot === true,
    isTerminalDelegationStatus: (s) => s === 'completed',
    dataDir: '/tmp/x',
  };
  return { chats, deps, copy };
}
const cfg = { idleDays: 7, batchLimit: 50 };

test('defaults are disabled / 7 days', () => {
  assert.deepEqual(getChatRetentionSettings({}), { enabled: false, idleDays: 7, batchLimit: 50 });
  assert.equal(updateChatRetentionSettings({ idleDays: 0 }).ok, false);
});

test('active, open-todo and pending-delegation chats are kept; old unlinked is archived', async () => {
  const w = world([
    chat('old', '[Watcher] old'),
    chat('busy', '[Watcher] busy'),
    chat('young', '[Watcher] young', { updatedAt: fresh }),
    chat('linked', '[Merge] linked'),
    chat('deleg', '[Todo plan] deleg'),
    chat('child', 'review', { delegationParentChatId: 'deleg', forkParentChatId: 'deleg' }),
    chat('closed', '[Merge] closed'),
  ], {
    todos: [{ status: 'doing', linkedChatIds: ['linked'] }, { status: 'done', linkedChatIds: ['closed'] }],
    delegations: { deleg: [{ status: 'running', childChatId: 'child' }] },
  });
  const r = await applyChatRetention({ config: cfg, now: NOW, deps: w.deps });
  assert.deepEqual(r.archivedIds.sort(), ['closed', 'old']);
  assert.equal(r.skipped.open_todo, 1);
  assert.equal(r.skipped.active_or_pinned, 1);
  assert.ok(r.skipped.pending_delegation >= 1);
  assert.equal(r.skipped.not_old_enough, 1);
});

test('ordinary chats never qualify', async () => {
  const w = world([chat('u1', 'My refactor'), chat('u2', 'Watcher notes'), chat('u3', 'chat 4')]);
  assert.equal(isTechnicalChat(w.chats[1]), false);
  const r = await applyChatRetention({ config: cfg, now: NOW, deps: w.deps });
  assert.equal(r.archived, 0);
  assert.equal(r.technicalIdle, 0);
});

test('family with an ordinary fork child is not archived', async () => {
  const w = world([chat('p', '[Watcher] p'), chat('c', 'user fork', { forkParentChatId: 'p' })]);
  const r = await applyChatRetention({ config: cfg, now: NOW, deps: w.deps });
  assert.equal(r.archived, 0);
});

test('dry-run on a copy matches apply, and batch limit holds', async () => {
  const mk = () => world(Array.from({ length: 5 }, (_, i) => chat(`t${i}`, `[Watcher] ${i}`)));
  const dry = await reportChatRetention({ config: cfg, now: NOW, deps: mk().deps });
  const real = mk();
  const res = await applyChatRetention({ config: cfg, now: NOW, deps: real.deps });
  assert.equal(dry.dryRun, true);
  assert.equal(res.archived, dry.selected);
  assert.equal(res.archivedBytes, dry.estimatedBytes);
  assert.ok(dry.estimatedBytes > 0);
  assert.deepEqual(res.archivedIds.sort(), dry.chats.map((c) => c.id).sort());
  const limited = await planChatRetention({ config: cfg, now: NOW, limit: 2, deps: mk().deps });
  assert.equal(limited.selected, 2);
  assert.equal(limited.skipped.batch_limit, 3);
});

test('restore is one action', async () => {
  const w = world([chat('t', '[Watcher] t')]);
  await applyChatRetention({ config: cfg, now: NOW, deps: w.deps });
  assert.equal(w.chats[0].archived, true);
  restoreRetainedChat('t', w.deps);
  assert.equal(w.chats[0].archived, false);
  const again = await reportChatRetention({ config: { idleDays: 7, batchLimit: 50 }, now: NOW, deps: w.deps });
  assert.equal(again.selected, 1); // eligible again only because it is still old
});

test('unreadable todos fail closed', async () => {
  const w = world([chat('t', '[Watcher] t')]);
  w.deps.listTodos = async () => { throw new Error('boom'); };
  const r = await applyChatRetention({ config: cfg, now: NOW, deps: w.deps });
  assert.equal(r.archived, 0);
  assert.equal(r.skipped.todos_unavailable, 1);
});

// ---- real persistence layer (temp data dir from isolated-data-dir.js) ----
import { saveChats, loadChats } from '../lib/persist/chats-persist.js';

const realDeps = () => ({
  isChatRunConfirmedIdle: () => true,
  listTodos: async () => ({ items: [] }),
  listDelegationsForController: () => [],
  listDelegationsForChat: () => [],
  dataDir: '/tmp/x',
});
const seed = (rows) => saveChats(rows.map((r) => ({ workspaceFolder: '/w', updatedAt: old, ...r })));

test('real store: dry-run numbers equal apply, cascade included', async () => {
  seed([
    { id: 'r1', title: '[Watcher] root' },
    { id: 'r1a', title: '[Merge] kid', forkParentChatId: 'r1' },
    { id: 'r1b', title: 'child', delegationParentChatId: 'r1', forkParentChatId: 'r1a' },
    { id: 'solo', title: '[Watcher] solo' },
    { id: 'user', title: 'my chat' },
  ]);
  const dry = await reportChatRetention({ config: cfg, now: NOW, deps: realDeps() });
  assert.equal(dry.selected, 4);
  const res = await applyChatRetention({ config: cfg, now: NOW, deps: realDeps() });
  assert.equal(res.archived, dry.selected);
  assert.deepEqual(res.archivedIds.sort(), dry.chats.map((c) => c.id).sort());
  assert.equal(res.archivedBytes, dry.estimatedBytes);
  assert.deepEqual(res.unexpected, []);
  const rows = loadChats();
  assert.equal(rows.find((c) => c.id === 'user').archivedAt, undefined);
  assert.ok(rows.find((c) => c.id === 'r1b').archivedAt);
});

test('real store: a family larger than the batch limit is skipped, never exceeds it', async () => {
  seed([
    { id: 'big', title: '[Watcher] big' },
    { id: 'big1', title: '[Merge] k1', forkParentChatId: 'big', updatedAt: old },
    { id: 'big2', title: '[Merge] k2', forkParentChatId: 'big' },
    { id: 'one', title: '[Watcher] one' },
  ]);
  const res = await applyChatRetention({ config: cfg, now: NOW, limit: 2, deps: realDeps() });
  assert.ok(res.archived <= 2);
  // Each child is also a standalone candidate; the 3-chat family is the one refused.
  assert.equal(res.skipped.batch_limit, 2);
  assert.ok(!res.archivedIds.includes('big'));
  assert.equal(res.archivedIds.length, 2);
  assert.equal(loadChats().find((c) => c.id === 'big').archivedAt, undefined);
});

test('real store: cascade reaching an ordinary fork child is refused', async () => {
  seed([
    { id: 'p', title: '[Watcher] p' },
    { id: 'u', title: 'user fork', forkParentChatId: 'p' },
  ]);
  const res = await applyChatRetention({ config: cfg, now: NOW, deps: realDeps() });
  assert.equal(res.archived, 0);
  assert.ok(loadChats().every((c) => !c.archivedAt));
});

test('family spanning two workspaces: open todo in the member own workspace blocks it', async () => {
  seed([
    { id: 'x', title: '[Watcher] x', workspaceFolder: '/w' },
    { id: 'x1', title: '[Merge] x1', forkParentChatId: 'x', workspaceFolder: '/other' },
  ]);
  const todosByCwd = { '/w': [], '/other': [{ status: 'doing', linkedChatIds: ['x1'] }] };
  const deps = () => ({ ...realDeps(), listTodos: async (_d, cwd) => ({ items: todosByCwd[cwd] || [] }) });
  const dry = await reportChatRetention({ config: cfg, now: NOW, deps: deps() });
  const res = await applyChatRetention({ config: cfg, now: NOW, deps: deps() });
  assert.equal(dry.selected, 0);
  assert.equal(res.archived, dry.selected);
  assert.equal(res.skipped.open_todo, 2); // root (via family) and the member itself
  assert.ok(loadChats().every((c) => !c.archivedAt));
  // The other workspace's todos being unreadable also fails closed.
  const bad = { ...deps(), listTodos: async (_d, cwd) => { if (cwd === '/other') throw new Error('x'); return { items: [] }; } };
  const r2 = await applyChatRetention({ config: cfg, now: NOW, deps: bad });
  assert.equal(r2.archived, 0);
});
