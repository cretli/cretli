import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterTodoItemsBySearch,
  filterTodoItemsByRootStatus,
  readTodoRowMark,
  readTodoRowBlockKind,
} from '../app_front/features/todo/todoTreeView.js';
import { isTodoBranchBlocked, listReadyTodoLeaves } from '../lib/todo-tree.js';
import { slimTodoForList } from '../lib/routes/todos-routes.js';

/**
 * Reference implementation: what readTodoRowMark did before the per-list cache
 * (a full rescan of the list for every row).
 */
function referenceMark(items, item) {
  if (isTodoBranchBlocked(items, item)) return 'blocked';
  return listReadyTodoLeaves(items).some((row) => row.id === item.id) ? 'ready' : '';
}

function buildTree() {
  return [
    { id: 'root', title: 'Root', status: 'doing', siblingIndex: 0 },
    { id: 'a', parentId: 'root', title: 'First', status: 'done', siblingIndex: 0 },
    { id: 'b', parentId: 'root', title: 'Second', status: 'ready', siblingIndex: 1 },
    { id: 'c', parentId: 'root', title: 'Third', status: 'ready', siblingIndex: 2 },
    { id: 'p', title: 'Parallel', status: 'ready', runMode: 'parallel', siblingIndex: 1 },
    { id: 'p1', parentId: 'p', title: 'P one', status: 'ready', siblingIndex: 0 },
    { id: 'p2', parentId: 'p', title: 'P two', status: 'ready', siblingIndex: 1 },
    { id: 'x', title: 'Blocked by reason', status: 'ready', blockedReason: 'needs input', siblingIndex: 2 },
    { id: 'idea', title: 'Only an idea', status: 'idea', siblingIndex: 3 },
  ];
}

test('cached row marks match the uncached reference for every item', () => {
  const items = buildTree();
  for (const item of items) {
    assert.equal(readTodoRowMark(items, item), referenceMark(items, item), item.id);
  }
});

test('sequential siblings: only the next open sibling is ready, later ones are blocked', () => {
  const items = buildTree();
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(readTodoRowMark(items, byId.get('b')), 'ready');
  assert.equal(readTodoRowMark(items, byId.get('c')), 'blocked');
  assert.equal(readTodoRowBlockKind(items, byId.get('c')), 'dependency');
  assert.equal(readTodoRowBlockKind(items, byId.get('x')), 'action');
});

test('the cache is keyed by the list: a new array is recomputed, not served stale', () => {
  const first = buildTree();
  const target = first.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(first, target), 'ready');
  const second = buildTree().map((item) => (item.id === 'a' ? { ...item, status: 'doing' } : item));
  const next = second.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(second, next), referenceMark(second, next));
  assert.equal(readTodoRowMark(second, next), 'blocked');
  // The first list keeps its own answer.
  assert.equal(readTodoRowMark(first, target), 'ready');
});

test('search matches title or id and keeps ancestors reachable', () => {
  const items = buildTree();
  assert.equal(filterTodoItemsBySearch(items, '  ').length, items.length);
  const hit = filterTodoItemsBySearch(items, 'second').map((item) => item.id);
  assert.deepEqual(hit.sort(), ['b', 'root']);
  const byId = filterTodoItemsBySearch(items, 'P2'.toLowerCase()).map((item) => item.id);
  assert.deepEqual(byId, ['p', 'p2']);
  assert.deepEqual(filterTodoItemsBySearch(items, 'no such task'), []);
});

test('list payload slimming keeps full editor history and drops integration evidence', () => {
  const long = 'x'.repeat(1000);
  const item = {
    id: 't',
    title: 'Task',
    changelog: [
      { at: '2026-10-01T00:00:00Z', kind: 'note', text: 'short' },
      { at: '2026-10-02T00:00:00Z', kind: 'implement', text: long },
    ],
    integration: {
      state: 'integrated',
      branch: 'b',
      evidence: { targetCommit: 'abc' },
      changedFiles: ['a.js', 'b.js'],
    },
    integrationSummary: { state: 'integrated' },
  };
  const slim = slimTodoForList(item);
  assert.equal(slim.changelog.length, 2);
  assert.equal(slim.changelog[0].text, 'short');
  assert.equal(slim.changelog[1].text, item.changelog[1].text);
  assert.equal('evidence' in slim.integration, false);
  assert.equal('changedFiles' in slim.integration, false);
  assert.equal(slim.integration.state, 'integrated');
  assert.equal(slim.integration.branch, 'b');
  assert.deepEqual(slim.integrationSummary, { state: 'integrated' });
  // The stored object is never mutated.
  assert.equal(item.changelog[1].text.length, 1000);
  assert.ok('evidence' in item.integration);
});

test('list slimming tolerates items without changelog or integration', () => {
  assert.deepEqual(slimTodoForList({ id: 'x' }), { id: 'x' });
  assert.equal(slimTodoForList(null), null);
});

test('in-place edits of an item invalidate the cached marks', () => {
  const items = buildTree();
  const second = items.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(items, second), 'ready');
  items.find((item) => item.id === 'a').status = 'doing';
  assert.equal(readTodoRowMark(items, second), 'blocked');
  second.blockedReason = 'waiting';
  assert.equal(readTodoRowBlockKind(items, second), 'action');
});

test('status filter counts the visible subtree under matching roots', () => {
  const items = [{ id: 'root', status: 'doing' }, { id: 'leaf', parentId: 'root', status: 'ready' }];
  assert.equal(filterTodoItemsByRootStatus(items, new Set(['ready'])).length, 0);
  assert.equal(filterTodoItemsByRootStatus(items, new Set(['doing'])).length, 2);
});

test('lean list slimming previews body/plan, drops the changelog and keeps the source untouched', () => {
  const longText = 'x'.repeat(5000);
  const item = {
    id: 'lean',
    title: 'T',
    body: longText,
    changelog: [{ text: 'a' }],
    plan: { markdown: longText, approvedAt: '2026-01-01T00:00:00.000Z' },
  };
  const lean = slimTodoForList(item, { lean: true });
  assert.equal(lean.listSlim, true);
  assert.equal(lean.body.length, 80);
  assert.equal(lean.plan.markdown.length, 80);
  assert.equal(lean.plan.approvedAt, item.plan.approvedAt);
  assert.equal('changelog' in lean, false);
  assert.equal(item.body.length, 5000);
  assert.equal(item.plan.markdown.length, 5000);
  assert.equal(slimTodoForList(item).listSlim, undefined);
  const chatItem = {
    id: 'c',
    linkedChatIds: ['a', 'b'],
    chats: [{ id: 'a', title: 'Long chat title', harness: 'claude', roles: ['executor'], lastAt: '2026-01-01', deleted: false }],
  };
  const leanChats = slimTodoForList(chatItem, { lean: true });
  assert.equal('linkedChatIds' in leanChats, false);
  assert.equal('chats' in leanChats, false);
  assert.equal(leanChats.chatCount, 1);
  assert.equal(leanChats.chatLastAt, '2026-01-01');
  assert.deepEqual(leanChats.latestChat, { id: 'a', harness: 'claude' });
  assert.deepEqual(leanChats.agentChatIds, ['a']);
  assert.equal(chatItem.chats[0].title, 'Long chat title');
  assert.equal(slimTodoForList(chatItem).chats[0].title, 'Long chat title');
  const short = slimTodoForList({ id: 's', body: 'tiny', plan: { markdown: 'p' } }, { lean: true });
  assert.equal(short.body, 'tiny');
  assert.equal(short.plan.markdown, 'p');
});

test('lean rows count only open chats and expose agent chat ids', () => {
  const lean = slimTodoForList({
    id: 't',
    chats: [
      { id: 'n', harness: 'codex', roles: ['linked'], lastAt: '2026-02-02' },
      { id: 'x', harness: 'claude', roles: ['delegate'], lastAt: '2026-03-03', deleted: true },
      { id: 'o', harness: 'claude', roles: ['orchestrator'], lastAt: '2026-01-01' },
    ],
  }, { lean: true });
  assert.equal(lean.chatCount, 2);
  assert.equal(lean.chatLastAt, '2026-02-02');
  assert.deepEqual(lean.latestChat, { id: 'n', harness: 'codex' });
  assert.deepEqual(lean.agentChatIds, ['o']);
  const none = slimTodoForList({ id: 'e', chats: [] }, { lean: true });
  assert.equal(none.chatCount, 0);
  assert.equal('latestChat' in none, false);
});

test('lean row consumers read the compact chat fields', async () => {
  const { countActiveTodoChats, resolveTodoLastActivityAt } = await import('../app_front/features/todo/todoTreeView.js');
  const { resolveTodoStatusIcon } = await import('../app_front/features/todo/todoStatusIcon.js');
  const lean = { id: 't', status: 'doing', listSlim: true, updatedAt: '2026-01-01', chatCount: 3, chatLastAt: '2026-05-05', agentChatIds: ['c1'] };
  assert.equal(countActiveTodoChats(lean), 3);
  assert.equal(resolveTodoLastActivityAt(lean), '2026-05-05');
  assert.equal(resolveTodoLastActivityAt({ ...lean, chatLastAt: undefined }), '2026-01-01');
  const icon = resolveTodoStatusIcon(lean, [lean], [{ id: 'c1' }], () => ({ tone: 'active' }));
  assert.equal(icon.spinning, true);
  assert.equal(resolveTodoStatusIcon(lean, [lean], [{ id: 'zz' }], () => ({ tone: 'active' })).spinning, false);
});

test('mergeCachedDetail restores detail on a match and stays lean on a chat mismatch', async () => {
  const { mergeCachedDetail } = await import('../app_front/features/todo/todoDetailCache.js');
  const detail = {
    updatedAt: 'u1', body: 'full body', plan: { markdown: 'p' }, changelog: ['c'], review: { generation: 2 },
    chats: [{ id: 'a', title: 'T', lastAt: '2026-01-01' }],
  };
  const lean = { id: 't', listSlim: true, updatedAt: 'u1', review: { generation: 2 }, chatCount: 1, latestChat: { id: 'a' }, chatLastAt: '2026-01-01', agentChatIds: [] };
  const merged = mergeCachedDetail(lean, detail);
  assert.equal(merged.listSlim, undefined);
  assert.equal(merged.body, 'full body');
  assert.equal(merged.chats[0].title, 'T');
  assert.equal('chatCount' in merged, false);
  assert.equal(mergeCachedDetail({ ...lean, chatLastAt: '2026-02-02' }, detail).listSlim, true);
  assert.equal(mergeCachedDetail({ ...lean, chatCount: 2 }, detail).listSlim, true);
  assert.equal(mergeCachedDetail({ ...lean, updatedAt: 'u2' }, detail).listSlim, true);
});

test('todo list cache: invalidateTodoListCache and cretli:todo-changed force a refetch', async () => {
  const listeners = {};
  globalThis.window = { addEventListener: (n, f) => { listeners[n] = f; }, location: { pathname: '/', search: '' } };
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, items: [], rev: String(calls) }), text: async () => '{}' }; };
  try {
    const api = await import('../app_front/core/api/index.js');
    await api.getTodos('/ws-a', { slim: true });
    await api.getTodos('/ws-a', { slim: true });
    assert.equal(calls, 1, 'second read is served from the cache');
    api.invalidateTodoListCache();
    await api.getTodos('/ws-a', { slim: true });
    assert.equal(calls, 2, 'explicit invalidation (Refresh) bypasses the cache');
    assert.equal(typeof listeners['cretli:todo-changed'], 'function');
    listeners['cretli:todo-changed']();
    await api.getTodos('/ws-a', { slim: true });
    assert.equal(calls, 3, 'a todo-changed event bypasses the cache');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
  }
});
