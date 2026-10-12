/**
 * View memory round-trip (navigation plan stage 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  buildViewKey,
  readViewMemorySlice,
  writeViewMemorySlice,
} from '../app_front/app/appShell/viewMemory.js';
import { parseSpaRoute } from '../lib/spa-routes.js';
import * as todoTreeView from '../app_front/features/todo/todoTreeView.js';
import * as worktreeListView from '../app_front/features/git/worktreeListView.js';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Minimal DOM node good enough for the two list renderers. */
function makeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    title: '',
    scrollTop: 0,
    value: '',
    style: { getPropertyValue: () => '', setProperty() {} },
    classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
    dataset: {},
    children: [],
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    insertBefore(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    remove() {},
    addEventListener() {},
    dispatchEvent() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const stripModuleSyntax = (source) => source
  .replace(/^import\b[\s\S]*?;\s*/gm, '')
  .replace(/^export /gm, '');

/**
 * Wraps a top-level function declaration of a vm script with a counting spy
 * while keeping the real body live, so the renderer's own tail call is the one
 * that re-enters the restore.
 */
function instrument(context, name) {
  vm.runInContext(`
    (function () {
      stats.${name}Count ??= 0;
      stats.${name}Depth ??= 0;
      stats.${name}MaxDepth ??= 0;
      const real = ${name};
      ${name} = function (...args) {
        stats.${name}Count += 1;
        stats.${name}Depth += 1;
        if (stats.${name}Depth > stats.${name}MaxDepth) stats.${name}MaxDepth = stats.${name}Depth;
        // Bail out instead of overflowing the stack when a slice is still
        // pending while the renderer retries the restore.
        if (stats.${name}Count > 8) { stats.${name}Depth -= 1; return undefined; }
        try { return real(...args); } finally { stats.${name}Depth -= 1; }
      };
      return true;
    })();
  `, context);
}

function makeTodoPanelHarness() {
  const stats = {};
  const list = makeElement();
  const scrollEl = makeElement();
  const byId = {
    'todo-panel': makeElement(),
    'todo-list': list,
  };
  const context = vm.createContext({
    console,
    stats,
    // The pure tree helpers (flatten, row meta, badges, statuses) drive row
    // painting; the real ones keep the renderer on its production path.
    ...todoTreeView,
    setTimeout: () => 0,
    clearTimeout: () => {},
    CSS: { escape: (value) => String(value) },
    // Row painting narrows every branch with `instanceof`; absent classes would
    // throw, so they resolve to unrelated empty constructors here.
    Element: class { },
    HTMLElement: class { },
    HTMLButtonElement: class { },
    HTMLInputElement: class { },
    localStorage: memoryStorage(),
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: (tag) => makeElement(tag),
      querySelector: (selector) => (selector === '#todo-panel .todo-scroll' ? scrollEl : null),
    },
    getTodoWorkspaceFolder: () => '/a',
    todoWorkspaceMatches: (candidate, active = '/a') => candidate === active,
    isViewContextScopedAccessAllowed: () => true,
    getViewContextState: () => null,
    reportViewContextResourceConflict: () => ({ ok: true }),
    navigateSpa: () => {},
    registerViewMemoryRestoreHandler: () => {},
    schedulePanelViewMemoryCapture: () => {},
    parseTodoRootStatusFilter: () => null,
    filterTodoItemsByRootStatus: (items) => items,
    parseReviewListFilter: () => '',
    filterTodoItemsByReviewState: (items) => items,
    filterTodoItemsBySearch: (items) => items,
    resolveTodoStatusIcon: () => '',
    isTodoAwaitingIntegration: () => false,
    formatTodoAssigneeBadge: () => '',
    formatTodoRef: (id) => String(id),
    isWatcherAutopilot: () => false,
    getChatsList: () => [],
    getTerminalStateMetaPublic: () => ({}),
    initDropdown: () => ({ api: { isOpen: () => false }, panel: makeElement(), list: makeElement() }),
    closeAllOpenDropdowns: () => {},
    refreshWatcherPanel: async () => {},
    t: (key) => key,
    api: {},
  });
  const source = stripModuleSyntax(readFileSync(new URL('../app_front/todoPanel.js', import.meta.url), 'utf8'));
  vm.runInContext(source, context);
  vm.runInContext('listEl = document.getElementById("todo-list");', context);
  instrument(context, 'renderList');
  instrument(context, 'applyTodoViewMemorySlice');
  return {
    context,
    stats,
    list,
    scrollEl,
    evaluate: (code) => vm.runInContext(code, context),
    run: (code) => vm.runInContext(code, context),
  };
}

function makeWorktreeListHarness(route) {
  const stats = {};
  const host = makeElement();
  const byId = {
    'git-worktrees-list': host,
    'git-worktrees-search': makeElement(),
    'git-worktrees-search-row': makeElement(),
    'git-worktrees-search-toggle': makeElement(),
    'git-worktrees-filter-label': makeElement(),
    'git-worktrees-filter-toggle': makeElement(),
  };
  const context = vm.createContext({
    console,
    stats,
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: memoryStorage(),
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: (tag) => makeElement(tag),
      querySelector: () => null,
    },
    window: { location: { pathname: '/git/worktrees', search: '' }, addEventListener() {} },
    Event: class { },
    getGitScope: () => ({ workspaceFolder: '/a' }),
    viewContextRuntimeParams: () => ({}),
    getViewContextState: () => null,
    isViewContextScopedAccessAllowed: () => true,
    initDropdown: () => ({ api: { isOpen: () => false }, panel: makeElement(), list: makeElement() }),
    closeAllOpenDropdowns: () => {},
    navigateSpa: () => {},
    registerViewMemoryRestoreHandler: () => {},
    schedulePanelViewMemoryCapture: () => {},
    resolveActiveRouteForViewMemory: () => route,
    ...worktreeListView,
    openTodoAgentChat: () => {},
    openTodoAgentStartModal: () => {},
    t: (key) => key,
    api: {},
  });
  const source = stripModuleSyntax(readFileSync(new URL('../app_front/features/git/worktreeList.js', import.meta.url), 'utf8'));
  vm.runInContext(source, context);
  instrument(context, 'renderRows');
  instrument(context, 'applyWorktreeViewMemorySlice');
  return {
    context,
    stats,
    host,
    evaluate: (code) => vm.runInContext(code, context),
    run: (code) => vm.runInContext(code, context),
  };
}

test('view memory survives a panel hop and reads back on return', () => {
  const storage = memoryStorage();
  const context = { workspaceKey: 'ws-a', folderKey: 'folder-a' };
  const todoRoute = parseSpaRoute('/todo');
  assert.ok(todoRoute);
  const chatRoute = parseSpaRoute('/chat');
  assert.ok(chatRoute);
  const todoKey = buildViewKey(todoRoute, context);
  const chatKey = buildViewKey(chatRoute, context);
  const slice = { search: 'regression', scrollTop: 120, collapsed: ['leaf-1'] };
  writeViewMemorySlice(storage, todoKey, slice);
  assert.equal(readViewMemorySlice(storage, chatKey), null);
  assert.deepEqual(readViewMemorySlice(storage, todoKey), slice);
  writeViewMemorySlice(storage, chatKey, { chatScroll: 4 });
  assert.deepEqual(readViewMemorySlice(storage, todoKey), slice);
  assert.deepEqual(readViewMemorySlice(storage, chatKey), { chatScroll: 4 });
});

test('TODO restore applies once: renderList retrying the pending slice must not recurse', () => {
  const panel = makeTodoPanelHarness();
  panel.run('latestItems = [{ id: "leaf-1", title: "Leaf", status: "ready" }]');
  panel.run(`pendingTodoViewMemory = {
    search: '', searchInputValue: '', searchOpen: false, rootStatus: null,
    review: '', integration: [], collapsed: [], scrollTop: 240, focusId: ''
  };`);

  // The production restore handler: park the slice, then try to apply it.
  panel.run('tryApplyPendingTodoViewMemory()');

  assert.equal(panel.stats.applyTodoViewMemorySliceCount, 1,
    `the pending slice re-entered the restore ${panel.stats.applyTodoViewMemorySliceCount} times`);
  assert.equal(panel.stats.applyTodoViewMemorySliceMaxDepth, 1, 'the restore must never nest inside itself');
  assert.equal(panel.stats.renderListCount, 1, 'the real renderer has to run for the scroll/focus restore');
  assert.equal(panel.run('pendingTodoViewMemory'), null, 'the slice is consumed');
  assert.equal(panel.scrollEl.scrollTop, 240, 'the scroll position is restored after the repaint');
});

test('TODO restore still defers while the list has no rows', () => {
  const panel = makeTodoPanelHarness();
  panel.run(`pendingTodoViewMemory = {
    search: '', searchInputValue: '', searchOpen: false, rootStatus: null,
    review: '', integration: [], collapsed: [], scrollTop: 180, focusId: ''
  };`);
  panel.run('tryApplyPendingTodoViewMemory()');
  assert.equal(panel.stats.applyTodoViewMemorySliceCount, 0);
  assert.equal(panel.run('pendingTodoViewMemory') === null, false,
    'an empty list keeps the slice parked for the first data render');

  panel.run('renderList({ items: [{ id: "leaf-1", title: "Leaf", status: "ready" }] })');
  assert.equal(panel.stats.applyTodoViewMemorySliceCount, 1, 'the late render restores exactly once');
  assert.equal(panel.run('pendingTodoViewMemory'), null);
  assert.equal(panel.scrollEl.scrollTop, 180);
});

test('worktree restore applies once: renderRows retrying the pending slice must not recurse', () => {
  const panel = makeWorktreeListHarness({ panel: 'git', subview: 'worktrees', query: {} });
  panel.run('listedWorkspaceFolder = "/a"');
  panel.run('listedRows = [{ todoId: "todo-1", title: "Leaf", branch: "cretli/x", state: "active" }]');
  panel.run("pendingWorktreeViewMemory = { search: '', searchOpen: false, filterStates: [], scrollTop: 320 };");

  panel.run('tryApplyPendingWorktreeViewMemory()');

  assert.equal(panel.stats.applyWorktreeViewMemorySliceCount, 1,
    `the pending slice re-entered the restore ${panel.stats.applyWorktreeViewMemorySliceCount} times`);
  assert.equal(panel.stats.applyWorktreeViewMemorySliceMaxDepth, 1, 'the restore must never nest inside itself');
  assert.equal(panel.stats.renderRowsCount, 1, 'the real renderer has to run for the scroll restore');
  assert.equal(panel.run('pendingWorktreeViewMemory'), null, 'the slice is consumed');
  assert.equal(panel.host.scrollTop, 320, 'the scroll position is restored after the repaint');
});

test('worktree restore stays parked when the active route is not the worktrees subview', () => {
  const panel = makeWorktreeListHarness({ panel: 'git', subview: 'main', query: {} });
  panel.run('listedWorkspaceFolder = "/a"');
  panel.run('listedRows = [{ todoId: "todo-1", title: "Leaf", branch: "cretli/x", state: "active" }]');
  panel.run("pendingWorktreeViewMemory = { search: '', searchOpen: false, filterStates: [], scrollTop: 320 };");

  panel.run('tryApplyPendingWorktreeViewMemory()');

  assert.equal(panel.stats.applyWorktreeViewMemorySliceCount, 1);
  assert.equal(panel.stats.renderRowsCount, 0);
  assert.equal(panel.run('pendingWorktreeViewMemory') === null, false,
    'a route that is not /git/worktrees must not consume the slice');
});
