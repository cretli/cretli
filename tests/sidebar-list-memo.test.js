import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarSearchService } from '../app_front/features/sidebar/services/sidebarSearchService.js';
import { createSidebarRenderPass } from '../app_front/features/sidebar/state/sidebarRenderPass.js';
import { createSidebarPatch } from '../app_front/features/sidebar/views/sidebarPatch.js';

const normalizePath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
const OLD = '2020-01-01T00:00:00.000Z';

function makeEnv(overrides = {}) {
  const env = {
    chats: [
      { id: 'a', workspaceFile: '/w1', workspaceFolder: '/w1', createdAt: '2024-01-03T00:00:00Z', title: 'Alpha' },
      { id: 'b', workspaceFile: '/w1', workspaceFolder: '/w1', createdAt: '2024-01-02T00:00:00Z', title: 'Beta' },
      { id: 'c', workspaceFile: '/w2', workspaceFolder: '/w2', createdAt: '2024-01-01T00:00:00Z', title: 'Gamma' },
    ],
    workspaces: [
      { sidebarKey: '/w1', workspaceFile: '/w1', name: 'one' },
      { sidebarKey: '/w2', workspaceFile: '/w2', name: 'two' },
    ],
    favorites: new Set(),
    order: [],
    counts: {},
    folders: {},
    worktreeFlag: false,
    activeChatId: '',
    ...overrides,
  };
  // The sort/filter under test is the real pipeline (orderedChats from the render pass).
  const pass = createSidebarRenderPass({
    getChats: () => env.chats,
    getActiveChatId: () => env.activeChatId,
    chatFavorites: { isFavorite: (id) => env.favorites.has(id) },
    state: {},
    isSubchatGroupExpanded: () => false,
    isSearchActive: () => false,
    visibleChatsForWorkspace: () => [],
  });
  env.service = createSidebarSearchService({
    getChats: () => env.chats,
    getWorkspaces: () => env.workspaces,
    getActiveChatId: () => env.activeChatId,
    getPreferredWorkspaceFolder: (key) => env.folders[key] ?? key,
    readSidebarOnlyWorktreeFlag: () => env.worktreeFlag,
    orderedChats: (list) => pass.orderedChats(list),
    getArchivedCounts: () => env.counts,
    normalizePath,
    isFavorite: (id) => env.favorites.has(id),
    readChatOrder: () => env.order,
  });
  env.ids = (ws) => env.service.visibleChatsForWorkspace(ws).map((c) => c.id);
  return env;
}

/** Independent oracle: a fresh service over deep copies of the inputs, no shared refs or memo. */
function uncached(env) {
  const fresh = makeEnv({
    chats: structuredClone(env.chats),
    workspaces: structuredClone(env.workspaces),
    favorites: new Set(env.favorites),
    order: [...env.order],
    folders: { ...env.folders },
    counts: structuredClone(env.counts),
    worktreeFlag: env.worktreeFlag,
    activeChatId: env.activeChatId,
  });
  fresh.service.setQuery(env.service.query);
  return (ws) => fresh.service.visibleChatsForWorkspace(structuredClone(ws)).map((c) => c.id);
}

const MATRIX = {
  'add chat': (e) => { e.chats = [...e.chats, { id: 'd', workspaceFile: '/w1', workspaceFolder: '/w1', createdAt: '2025-01-01T00:00:00Z', title: 'D' }]; },
  'remove chat': (e) => { e.chats = e.chats.filter((c) => c.id !== 'a'); },
  'workspaceFile move': (e) => { e.chats.find((c) => c.id === 'a').workspaceFile = '/w2'; },
  'workspaceFolder move': (e) => { e.chats.find((c) => c.id === 'b').workspaceFolder = '/w2'; e.chats.find((c) => c.id === 'b').workspaceFile = '/w2'; },
  'parent change': (e) => { e.chats.find((c) => c.id === 'b').forkParentChatId = 'a'; },
  archived: (e) => { e.chats.find((c) => c.id === 'a').archived = true; },
  favorite: (e) => { e.favorites.add('b'); },
  createdAt: (e) => { e.chats.find((c) => c.id === 'b').createdAt = '2030-01-01T00:00:00Z'; },
  'manual order': (e) => { e.order = ['b', 'a']; },
  title: (e) => { e.chats.find((c) => c.id === 'a').title = 'Changed'; },
  watcherPinned: (e) => { e.chats.find((c) => c.id === 'a').watcherPinned = true; },
  query: (e) => { e.service.setQuery('beta'); },
  'worktree filter': (e) => { e.worktreeFlag = true; e.activeChatId = 'a'; },
  'workspace list': (e) => { e.workspaces = [{ ...e.workspaces[0], name: 'renamed' }, e.workspaces[1]]; },
  'preferred folder': (e) => { e.folders['/w1'] = '/other'; },
  'clone list': (e) => { e.workspaces = [...e.workspaces, { sidebarKey: '/w1::c', workspaceFile: '/w1', isClone: true, name: 'clone' }]; e.folders['/w1::c'] = '/w1/clone'; e.chats.find((c) => c.id === 'b').workspaceFolder = '/w1/clone'; },
};

for (const [name, mutate] of Object.entries(MATRIX)) {
  test(`memo input invalidates: ${name}`, () => {
    const env = makeEnv();
    if (name === 'worktree filter') {
      Object.assign(env.chats[0], { onWorktree: true, todoId: 'wt1' });
      Object.assign(env.chats[1], { onWorktree: true, todoId: 'wt2' });
    }
    const ws = env.workspaces[0];
    const initial = env.ids(ws);
    const before = env.service.stats.visibleChatsForWorkspace;
    mutate(env);
    const after = env.ids(env.workspaces[0]);
    if (name === 'worktree filter') {
      assert.deepEqual(initial, ['a', 'b']);
      assert.deepEqual(after, ['a'], 'filter really narrows the result');
    }
    assert.ok(env.service.stats.visibleChatsForWorkspace > before, 'recomputed');
    assert.deepEqual(after, uncached(env)(env.workspaces[0]), 'equals the unmemoised result');
  });
}

test('mutation between two calls inside one render pass is not missed', () => {
  const env = makeEnv();
  const ws = env.workspaces[0];
  const passState = { renderPass: { activeChatId: '', searching: false, map: new Map() } };
  assert.ok(passState.renderPass);
  assert.deepEqual(env.ids(ws), ['a', 'b']);
  const runs = env.service.stats.visibleChatsForWorkspace;
  env.chats.find((c) => c.id === 'a').archived = true;
  env.favorites.add('b');
  const after = env.ids(ws);
  assert.ok(env.service.stats.visibleChatsForWorkspace > runs);
  assert.deepEqual(after, uncached(env)(ws));
});

test('in-place todoId / onWorktree change with an unchanged filter id invalidates the memo', () => {
  const env = makeEnv();
  Object.assign(env.chats[0], { onWorktree: true, todoId: 'wt1' });
  Object.assign(env.chats[1], { onWorktree: true, todoId: 'wt1' });
  env.worktreeFlag = true;
  env.activeChatId = 'a';
  const ws = env.workspaces[0];
  assert.deepEqual(env.ids(ws), ['a', 'b']);
  // Same active filter id ('wt1'), but b leaves the worktree todo.
  env.chats[1].todoId = 'wt2';
  assert.deepEqual(env.ids(ws), uncached(env)(ws));
  assert.deepEqual(env.ids(ws), ['a']);
  // b regains the todo id but is no longer flagged: the filter id stays 'wt1'.
  env.chats[1].todoId = 'wt1';
  env.chats[1].onWorktree = false;
  assert.deepEqual(env.ids(ws), uncached(env)(ws));
  // Dropping onWorktree on the active chat clears the filter id, so all rows show.
  env.chats[0].onWorktree = false;
  assert.deepEqual(env.ids(ws), uncached(env)(ws));
  assert.deepEqual(env.ids(ws), ['a', 'b']);
});

test('archived counts object is parsed once per object', () => {
  const env = makeEnv({ counts: { '/w1\n/w1': 2, '/w2\n/w2': 3 } });
  assert.equal(env.service.archivedCountForWorkspace(env.workspaces[0]), 2);
  assert.equal(env.service.archivedCountForWorkspace(env.workspaces[1]), 3);
  assert.equal(env.service.stats.archivedParse, 1);
  env.counts = { '/w1\n/w1': 5 };
  assert.equal(env.service.archivedCountForWorkspace(env.workspaces[0]), 5);
  assert.equal(env.service.stats.archivedParse, 2);
});

function subchatEnv(childState) {
  const kids = Array.from({ length: 8 }, (_, i) => ({
    id: `k${i}`, workspaceFile: '/w1', workspaceFolder: '/w1', forkParentChatId: 'p',
    createdAt: OLD, updatedAt: OLD, title: `k${i}`, _serverRunState: { state: 'attention', delegationStatus: 'completed' },
  }));
  kids[0]._serverRunState = childState;
  return makeEnv({
    chats: [{ id: 'p', workspaceFile: '/w1', workspaceFolder: '/w1', createdAt: OLD, updatedAt: OLD, title: 'p' }, ...kids],
    workspaces: [{ sidebarKey: '/w1', workspaceFile: '/w1', name: 'one' }],
  });
}

function fakeEl(attrs, classes = []) {
  const cls = new Set(classes);
  return {
    dataset: {},
    classList: { contains: (c) => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } },
    getAttribute: (n) => attrs[n] ?? null,
    setAttribute: (n, v) => { attrs[n] = String(v); },
    querySelector: () => null,
  };
}

test('status-only change on a memo hit refreshes groups, data-group-summary and active marker', () => {
  for (const expanded of [false, true]) {
    const env = subchatEnv({ state: 'busy' });
    env.activeChatId = 'k1';
    const state = { renderPass: null };
    const groupAttrs = { 'data-sidebar-key': '/w1', 'data-parent-id': 'p', 'data-group-summary': '' };
    const groupEl = fakeEl(groupAttrs, ['sidebar-subchat-group']);
    const activeRow = fakeEl({}, []);
    activeRow.dataset.chatId = 'k1';
    const otherRow = fakeEl({}, ['is-active']);
    otherRow.dataset.chatId = 'k2';
    const groups = [groupEl];
    const body = {
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.sidebar-subchat-group' ? groups : [activeRow, otherRow]),
    };
    const rp = createSidebarRenderPass({
      getChats: () => env.chats, getActiveChatId: () => env.activeChatId,
      chatFavorites: { isFavorite: () => false }, state,
      isSubchatGroupExpanded: () => expanded, isSearchActive: () => false,
      visibleChatsForWorkspace: (w) => env.service.visibleChatsForWorkspace(w),
    });
    const patch = createSidebarPatch({
      getWorkspaces: () => env.workspaces, getActiveWorkspaceFile: () => '',
      getActiveWorkspaceFolder: () => '', getActiveChatId: () => env.activeChatId,
      getPreferredWorkspaceFolder: () => '',
      getContainer: () => ({ hidden: false, querySelector: () => body }),
      workspaceModel: (w) => rp.workspaceModel(w), cssEscape: (x) => x, state,
    });
    const runPass = () => {
      state.renderPass = { activeChatId: env.activeChatId, searching: false, map: new Map() };
      const model = rp.workspaceModel(env.workspaces[0]);
      patch.patchTransientVisualStates();
      state.renderPass = null;
      return model;
    };
    env.chats[1]._serverRunState = { state: 'busy' };
    const before = runPass();
    const summaryBefore = groupAttrs['data-group-summary'];
    const runs = { ...env.service.stats };
    env.chats[1]._serverRunState = { state: 'attention', delegationStatus: 'failed' };
    const after = runPass();
    assert.deepEqual(env.service.stats, runs, 'no refilter/resort on status change');
    assert.notEqual(after.grouped, before.grouped);
    assert.equal(after.grouped.groups[0].expanded, expanded);
    assert.equal(after.grouped.groups[0].summary.failed, 1);
    assert.notEqual(groupAttrs['data-group-summary'], summaryBefore, 'data-group-summary refreshed');
    assert.match(groupAttrs['data-group-summary'], /\u2717/);
    assert.equal(activeRow.classList.contains('is-active'), true);
    assert.equal(activeRow.getAttribute('aria-selected'), 'true');
    assert.equal(otherRow.classList.contains('is-active'), false);
  }
});

test('patchTransientVisualStates builds models only for workspaces with a group on screen', () => {
  const built = [];
  const attrs = { 'data-sidebar-key': '/w1', 'data-parent-id': 'p', 'data-group-summary': '' };
  const groupEl = {
    getAttribute: (n) => attrs[n] ?? null,
    setAttribute: (n, v) => { attrs[n] = v; },
    querySelector: () => null,
  };
  const body = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.sidebar-subchat-group' ? [groupEl] : []),
  };
  groupEl.forEach = undefined;
  const list = [groupEl];
  list.forEach = Array.prototype.forEach;
  body.querySelectorAll = (sel) => (sel === '.sidebar-subchat-group' ? list : []);
  const summary = { total: 2, completed: 0, failed: 2, interrupted: 0, idle: 0 };
  const patch = createSidebarPatch({
    getWorkspaces: () => [
      { sidebarKey: '/w1', workspaceFile: '/w1' }, { sidebarKey: '/w2', workspaceFile: '/w2' },
    ],
    getActiveWorkspaceFile: () => '', getActiveWorkspaceFolder: () => '', getActiveChatId: () => 'x',
    getPreferredWorkspaceFolder: () => '',
    getContainer: () => ({ hidden: false, querySelector: () => body }),
    workspaceModel: (w) => {
      built.push(w.sidebarKey);
      return { grouped: { groups: [{ parentId: 'p', expanded: true, summary }] } };
    },
    cssEscape: (s) => s,
    state: { renderPass: { activeChatId: 'x' } },
  });
  patch.patchTransientVisualStates();
  assert.deepEqual(built, ['/w1']);
  assert.notEqual(attrs['data-group-summary'], '');
});
