import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTodoListState } from '../app_front/state/todoListState.js';
import * as perfProbe from '../app_front/lib/perfProbe.js';
import * as api from '../app_front/core/api/index.js';
import { createTodoFieldSaver } from '../app_front/features/todo/todoFieldSaver.js';
import { createTodoListModel, offlineRetryDelay } from '../app_front/features/todo/todoOfflineState.js';
import {
  getTodoWorkspaceFolder,
  todoWorkspaceMatches,
} from '../app_front/features/todo/todoWorkspaceScope.js';
import {
  filterTodoItemsBySearch,
  matchesTodoIntegrationFilter,
  isBatchSelectableItem,
  parseTodoIntegrationFilter,
  TODO_INTEGRATION_PENDING_FILTERS,
} from '../app_front/features/todo/todoTreeView.js';
import { createBatchActions } from '../app_front/features/todo/todoBatchActions.js';
import {
  buildBatchRequestIds,
  buildBatchSelection,
  canClearIntegrationLock,
  captureBatchScope,
  createLatestRequestGate,
  createOwnedPendingGuard,
  describeBatchFailure,
  findBatchEntryForTodo,
  isActiveBatchStatus,
  isBatchScopeCurrent,
  isTerminalBatchStatus,
  localizeBatchReason,
  pruneBatchSelection,
  resolveBatchControls,
  resolveBatchToTrack,
  resolveResumeAgentNeed,
  summarizeBatchEntries,
} from '../app_front/features/todo/todoBatchSelection.js';

import { filterTodoItemsByIntegrationState } from '../app_front/features/todo/services/todoIntegrationRules.js';
import { readTodoPanelScript } from './helpers/todoPanelSource.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('TODO reads and every mutation target the client workspace', async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const trigger = { dataset: { workspaceFolder: '/client workspace' } };
  globalThis.document = { getElementById: () => trigger };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await api.getTodos();
    await api.postTodo({ title: 'New' });
    await api.patchTodo('todo-1', { status: 'done' });
    await api.deleteTodo('todo-1');
    await api.postTodoStartAgent('todo-1', { agentTransport: 'claude' });
    assert.equal(calls[0].url, '/api/todos?workspaceFolder=%2Fclient%20workspace');
    for (const index of [1, 2, 4]) {
      assert.equal(JSON.parse(calls[index].init.body).workspaceFolder, '/client workspace');
    }
    assert.equal(calls[3].url, '/api/todos/todo-1?workspaceFolder=%2Fclient%20workspace');
    assert.equal(JSON.parse(calls[2].init.body).status, 'done');
    await api.patchTodo('todo-2', { workspaceFolder: '/explicit', title: 'Explicit' });
    assert.equal(JSON.parse(calls[5].init.body).workspaceFolder, '/explicit');
    await api.getTodos('/explicit');
    assert.equal(calls[6].url, '/api/todos?workspaceFolder=%2Fexplicit');

    delete globalThis.document;
    await api.getTodos();
    assert.equal(calls[7].url, '/api/todos', 'boot without a known workspace keeps the server default');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('in-flight TODO reads are coalesced per workspace', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url) => {
    const pending = deferred();
    calls.push({ url, pending });
    return pending.promise;
  };
  try {
    const a = api.getTodos('/a');
    const anotherA = api.getTodos('/a');
    const b = api.getTodos('/b');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].url, calls[1].url);
    for (const { pending } of calls) pending.resolve({ status: 200, json: async () => ({ ok: true }) });
    await Promise.all([a, anotherA, b]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// Exercise the panel itself without loading browser-only custom elements.
function makePanel() {
  let folder = '/a';
  // The panel reads the shared ViewContext bridge: a deep link that pins an
  // explicit ws/folder parks scoped fetches until it resolves. Tests flip this
  // flag to walk the pending → resolved transition.
  let scopedAccessAllowed = true;
  // The panel marks the list busy and drops the skeleton on settle, so the fake
  // row container needs those two DOM hooks (it was written before both existed).
  const list = {
    textContent: 'Old rows',
    innerHTML: '',
    replaceChildren() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector: () => null,
  };
  const hint = { textContent: '/a', hidden: false };
  const status = { textContent: '', classList: { toggle() {} } };
  const pending = [];
  let editorHidden = 0;
  const storage = new Map();
  const context = vm.createContext({
    createTodoListState,
    ...perfProbe,
    window: { dispatchEvent() {} },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document: {
      getElementById: (id) => {
        if (id === 'todo-panel') return { classList: { contains: () => true } };
        if (id === 'header-workspace-trigger') return { dataset: { workspaceFile: '', workspaceFolder: folder } };
        return null;
      },
      querySelector: () => null,
    },
    getTodoWorkspaceFolder: () => folder,
    todoWorkspaceMatches: (candidate, active = folder) => todoWorkspaceMatches(candidate, active),
    isViewContextScopedAccessAllowed: () => scopedAccessAllowed,
    getViewContextState: () => null,
    getViewContextRuntimeScope: () => ({ workspaceFile: '', workspaceFolder: folder }),
    reportViewContextResourceConflict: () => ({ ok: true }),
    api: {
      getTodos: (requestedFolder) => {
        const request = deferred();
        pending.push({ ...request, folder: requestedFolder });
        return request.promise;
      },
      getAgentSdkStatus: async () => ({ ready: true }),
      getIntegrateBatch: async () => ({ ok: true, batches: [] }),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    parseTodoRootStatusFilter: () => null,
    parseTodoIntegrationFilter,
    TODO_INTEGRATION_PENDING_FILTERS,
    createTodoFieldSaver,
    createTodoListModel,
    offlineRetryDelay,
    isBatchSelectableItem,
    buildBatchRequestIds,
    buildBatchSelection,
    canClearIntegrationLock,
    createBatchActions,
    captureBatchScope,
    createLatestRequestGate,
    createOwnedPendingGuard,
    describeBatchFailure,
    findBatchEntryForTodo,
    isActiveBatchStatus,
    isBatchScopeCurrent,
    isTerminalBatchStatus,
    localizeBatchReason,
    pruneBatchSelection,
    resolveBatchControls,
    resolveBatchToTrack,
    resolveResumeAgentNeed,
    summarizeBatchEntries,
    filterTodoItemsByRootStatus: (items) => items,
    countDeferredRoots: () => 0,
    parseReviewListFilter: () => '',
    filterTodoItemsByReviewState: (items) => items,
    filterTodoItemsBySearch,
    matchesTodoIntegrationFilter,
    filterTodoItemsByIntegrationState,
    showTodoError: () => {},
    createListSkeleton: () => ({}),
    createEmptyState: () => ({}),
    createSpan: () => ({ append() {}, setAttribute() {} }),
    refreshWatcherPanel: async () => {},
    t: (key) => key,
    list, hint, status,
    editor: { hide: () => { editorHidden += 1; } },
  });
  const source = readTodoPanelScript();
  vm.runInContext(`${source}\nS.listEl = list; S.hintEl = hint; S.statusEl = status; S.editorDialog = editor;`, context);
  return {
    pending, list, hint, status, storage,
    refresh: () => vm.runInContext('refreshTodoList()', context),
    workspaceChanged: () => vm.runInContext('onTodoWorkspaceChange()', context),
    switchTo: (next) => { folder = next; },
    setScopedAccess: (allowed) => { scopedAccessAllowed = allowed === true; },
    editorHidden: () => editorHidden,
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test('the TODO list waits for the tab\'s scoped context and reloads once it resolves', async () => {
  const panel = makePanel();
  panel.setScopedAccess(false);
  await panel.refresh();
  assert.deepEqual(panel.pending, [], 'no TODO read may target the server default while the link is unresolved');

  // The late resolve re-enters through the same path the resolved view context
  // uses (workspace change → panel refresh), and now the read goes out scoped.
  panel.setScopedAccess(true);
  const reloading = panel.workspaceChanged();
  assert.deepEqual(panel.pending.map((request) => request.folder), ['/a'],
    'the late resolve retriggers the TODO list exactly once');
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [] });
  await reloading;
});

test('workspace switch clears old rows and editor, and ignores a delayed response', async () => {
  const panel = makePanel();
  const a = panel.refresh();
  panel.switchTo('/b');
  const b = panel.refresh();
  assert.deepEqual(panel.pending.map((request) => request.folder), ['/a', '/b']);
  assert.equal(panel.list.textContent, '');
  assert.equal(panel.hint.textContent, '');
  assert.ok(panel.editorHidden() > 0);
  panel.pending[1].resolve({ ok: true, cwd: '/b', items: [] });
  await b;
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [{ id: 'foreign' }] });
  await a;
  assert.equal(panel.hint.textContent, '/b');
  assert.equal(panel.evaluate('S.latestItems.length'), 0);
});

test('a delayed failure cannot clear the new workspace or display an error', async () => {
  const panel = makePanel();
  const a = panel.refresh();
  panel.switchTo('/b');
  const b = panel.refresh();
  panel.pending[1].resolve({ ok: true, cwd: '/b', items: [] });
  await b;
  panel.pending[0].reject(new Error('Old request failed'));
  await a;
  assert.equal(panel.hint.textContent, '/b');
  assert.equal(panel.status.textContent, '');
});

test('a workspace change while Todo is open clears and reloads the list for the new folder', async () => {
  const panel = makePanel();
  panel.switchTo('/acme');
  const changed = panel.workspaceChanged();
  assert.equal(panel.list.textContent, '');
  assert.equal(panel.pending[0].folder, '/acme');
  panel.pending[0].resolve({ ok: true, cwd: '/acme', items: [] });
  await changed;
  assert.equal(panel.hint.textContent, '/acme');
});

test('refresh restores the integration filter saved for the active workspace', async () => {
  const panel = makePanel();
  panel.storage.set('cretli-todo-integration-filter:/a', '["conflict","integrated"]');
  const refreshing = panel.refresh();
  assert.equal(panel.evaluate('[...todoList.integration.get()].join(",")'), 'conflict,integrated');
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [] });
  await refreshing;
});

test('integration filter defaults to the pending preset, and an explicit "All" survives a reload', async () => {
  const panel = makePanel();
  const refreshing = panel.refresh();
  assert.equal(panel.evaluate('[...todoList.integration.get()].join(",")'), TODO_INTEGRATION_PENDING_FILTERS.join(','));
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [] });
  await refreshing;

  const withAll = makePanel();
  withAll.storage.set('cretli-todo-integration-filter:/a', '[]');
  const reloading = withAll.refresh();
  assert.equal(withAll.evaluate('todoList.integration.get().size'), 0);
  withAll.pending[0].resolve({ ok: true, cwd: '/a', items: [] });
  await reloading;
});

test('cached lookups and mutation responses cannot restore another workspace', () => {
  const panel = makePanel();
  panel.evaluate("S.latestWorkspaceFolder = '/a'; S.latestItems = [{ id: 'old' }]");
  panel.switchTo('/b');
  assert.equal(panel.evaluate("findItem('old')"), null);
  panel.evaluate("renderList({ cwd: '/a', items: [{ id: 'foreign' }] })");
  assert.equal(panel.evaluate('S.latestItems[0].id'), 'old', 'foreign response was ignored');
});

test('workspace comparisons tolerate trailing separators', () => {
  assert.equal(todoWorkspaceMatches('/workspace/', '/workspace'), true);
  assert.equal(todoWorkspaceMatches('C:\\workspace\\', 'C:/workspace'), true);
  assert.equal(getTodoWorkspaceFolder(), '');
});


test('search finds a todo by an ID suffix despite integration filters and restores filters when cleared', () => {
  const panel = makePanel();
  panel.evaluate(`S.latestItems = [
    { id: 'parent', title: 'Parent', integrationSummary: { state: 'integrated' } },
    { id: 'f2173be9', parentId: 'parent', title: 'Review delegation', integrationSummary: { state: 'integrated' } },
    { id: 'pending', title: 'Another task', integrationSummary: { state: 'unconfirmed' } }
  ]; todoList.setCollapsed(['parent']);`);
  const visibleIds = () => panel.evaluate('getVisibleTodoItems().map((item) => item.id).join(",")');
  assert.equal(visibleIds(), 'pending');
  panel.evaluate('S.todoSearchQuery = "Be9"');
  assert.equal(visibleIds(), 'parent,f2173be9');
  assert.equal(panel.evaluate('effectiveCollapsedIds().size'), 0);
  panel.evaluate('S.todoSearchQuery = "Review delegation"');
  assert.equal(visibleIds(), 'parent,f2173be9');
  panel.evaluate('S.todoSearchQuery = "   "');
  assert.equal(visibleIds(), 'pending');
  assert.equal(panel.evaluate('effectiveCollapsedIds().has("parent")'), true);
  assert.equal(panel.evaluate('[...todoList.integration.get()].join(",")'), TODO_INTEGRATION_PENDING_FILTERS.join(','));
});

test('search reaches tasks before status and review filters can hide them', () => {
  const panel = makePanel();
  panel.evaluate(`S.latestItems = [{ id: 'target', title: 'Find me' }];
    filterTodoItemsByRootStatus = () => [];
    filterTodoItemsByReviewState = () => [];
    todoList.setRootStatus(['done']); todoList.setReview('stale');`);
  assert.equal(panel.evaluate('getVisibleTodoItems().length'), 0);
  panel.evaluate('S.todoSearchQuery = "Find me"');
  assert.equal(panel.evaluate('getVisibleTodoItems()[0].id'), 'target');
  panel.evaluate('S.todoSearchQuery = ""');
  assert.equal(panel.evaluate('getVisibleTodoItems().length'), 0);
  assert.equal(panel.evaluate('todoList.rootStatus.get().has("done") && todoList.review.get() === "stale"'), true);
});

test('search can opt into list filters without changing the saved selection', () => {
  const panel = makePanel();
  panel.evaluate(`S.latestItems = [
    { id: 'pending', title: 'Match', integrationSummary: { state: 'unconfirmed' } },
    { id: 'integrated', title: 'Match', integrationSummary: { state: 'integrated' } },
    { id: 'other', title: 'Other', integrationSummary: { state: 'unconfirmed' } }
  ]; S.todoSearchQuery = 'Match';`);
  const visibleIds = () => panel.evaluate('getVisibleTodoItems().map((item) => item.id).join(",")');
  assert.equal(visibleIds(), 'pending,integrated');
  panel.evaluate('S.todoSearchUseFilters = true');
  assert.equal(visibleIds(), 'pending');
  assert.equal(panel.evaluate('buildTodoViewMemorySlice().searchUseFilters'), true);
  panel.evaluate('S.todoSearchUseFilters = false');
  assert.equal(visibleIds(), 'pending,integrated');
  assert.equal(panel.evaluate('[...todoList.integration.get()].join(",")'), TODO_INTEGRATION_PENDING_FILTERS.join(','));
});

test('filters follow the fetched folder even while a link conflict clears the header trigger', async () => {
  const panel = makePanel();
  // CONFLICT empties the trigger dataset; the store still names the folder the list comes from.
  panel.evaluate(`document.getElementById = (id) => (id === 'todo-panel'
    ? { classList: { contains: () => true } }
    : (id === 'header-workspace-trigger' ? { dataset: {} } : null))`);
  panel.storage.set('cretli-todo-integration-filter:/a', '[]');
  const refreshing = panel.refresh();
  assert.equal(panel.evaluate('todoList.integration.get().size'), 0, 'no fallback to the shared "default" key');
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [] });
  await refreshing;
});

test('per-list UI state is keyed by workspace and migrates the legacy folder key once', () => {
  const panel = makePanel();
  panel.evaluate("getWorkspaceContext = () => ({ workspaceFile: '/w/one.code-workspace', workspaceFolder: '/a' })");
  panel.storage.set('cretli-todo-integration-filter:/a', '["conflict"]');
  panel.evaluate('loadIntegrationFilter()');
  assert.equal(panel.evaluate('[...todoList.integration.get()].join(",")'), 'conflict');
  assert.equal(panel.storage.get('cretli-todo-integration-filter:/w/one.code-workspace'), '["conflict"]');
  // A second workspace sharing the folder keeps its own scope after the migration.
  assert.equal(panel.evaluate('integrationFilterStorageKey()'), 'cretli-todo-integration-filter:/w/one.code-workspace');
});

test('a list answer whose cwd is the workspace home is accepted when the requested folder matches', async () => {
  const panel = makePanel();
  const refreshing = panel.refresh();
  panel.pending[0].resolve({ ok: true, cwd: '/home-of-workspace', requestedFolder: '/a', items: [] });
  await refreshing;
  assert.equal(panel.hint.textContent, '/home-of-workspace');
});
