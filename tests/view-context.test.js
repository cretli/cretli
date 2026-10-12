/**
 * Per-tab ViewContext (navigation plan stage 2) contract tests.
 *
 * Covers the load-bearing rules of the leaf: resolve the link's explicit
 * ws/folder into runtime paths BEFORE panels fetch; a rapid A→B scope switch
 * must never paint A's late answer; a missing/foreign id preserves the link
 * target instead of silently re-pointing; `/chat?chat=` ownership conflicts
 * are reported without any global settings write; the Git lock is applied
 * deterministically from the route and a pinned TODO scope survives refresh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_CONTEXT_STATUS,
  createViewContextStore,
  gitScopeFromViewContext,
  hasExplicitWorkspace,
  normalizeViewContext,
  sameViewContext,
  scopedAccessAllowedFor,
  validateResourceAgainstContext,
  viewContextFromLocation,
  viewContextQueryParams,
  viewContextRuntimeParams,
} from '../app_front/app/appShell/viewContext.js';
import {
  getGitScope,
  getGitScopeRevision,
  isGitScopeLocked,
  resetGitScopeForTests,
  setGitScope,
} from '../app_front/features/git/gitScope.js';
import {
  isViewContextScopedAccessAllowed,
  setSharedViewContextStore,
  withViewContextQuery,
} from '../app_front/app/appShell/viewContextBridge.js';

const WS_A = '0e6a6f32-2b8c-4921-9041-e5b230e7b793';
const WS_B = 'b80f72e5-42fe-4c7f-a0de-31f0c8ad4bd0';
const FOLDER_A = '3b8d2f1a-5a44-4a12-b1c8-2f4f0a1d9c33';
const CHAT_ID = '4fbef7c3-96cd-4451-b014-64d6c4e1ca03';
const TODO_ID = '85e13c57-ca2d-4e6f-8b1d-3458883f2243';

test.afterEach(() => {
  setSharedViewContextStore(null);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Store with an injectable location and resolver; records every applied
 * snapshot and canonicalization so ordering assertions stay declarative.
 */
function harness(options = {}) {
  const applied = [];
  const canonical = [];
  let location = { pathname: '/chat', search: '' };
  const resolvers = typeof options.resolveWorkspace === 'function'
    ? options.resolveWorkspace
    : async () => ({ workspaceFile: '/ws/default', workspaceFolder: '/ws/default' });
  const store = createViewContextStore({
    readLocation: () => location,
    resolveWorkspace: (context) => resolvers(context),
    canonicalize: (path) => canonical.push(path),
    onApplied: (state) => applied.push(state),
    getDefaultContext: async () => (options.defaultContext === undefined
      ? null
      : options.defaultContext),
    getContextKeysForRuntime: typeof options.getContextKeysForRuntime === 'function'
      ? options.getContextKeysForRuntime
      : null,
    readyTimeoutMs: options.readyTimeoutMs || 300,
  });
  return {
    store,
    applied,
    canonical,
    setLocation(pathname, search) { location = { pathname, search }; },
  };
}

test('the route line carries only opaque ids into the view context', () => {
  const parsed = viewContextFromLocation({
    pathname: '/chat',
    search: `?chat=${CHAT_ID}&ws=${WS_A}&folder=${FOLDER_A}`,
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.context, { workspaceKey: WS_A, folderKey: FOLDER_A });
  assert.equal(parsed.route.panel, 'chat');
  assert.equal(parsed.route.resource.type, 'chat');
  assert.equal(parsed.route.resource.id, CHAT_ID);
  // Chat selection is a resource, not a Git scope: no lock from /chat.
  assert.deepEqual(parsed.scope, { type: '', id: '' });
  assert.equal(hasExplicitWorkspace(parsed.context), true);
  assert.deepEqual(viewContextQueryParams(parsed.context), { ws: WS_A, folder: FOLDER_A });
});

test('a Git link pins its scope while a plain path keeps the workspace context', () => {
  const pinned = viewContextFromLocation({
    pathname: '/git/worktrees',
    search: `?scope=todo&todo=${TODO_ID}&ws=${WS_A}`,
  });
  assert.deepEqual(pinned.scope, { type: 'todo', id: TODO_ID });
  assert.equal(pinned.route.subview, 'worktrees');

  const bare = viewContextFromLocation({ pathname: '/git', search: `?ws=${WS_A}` });
  assert.deepEqual(bare.scope, { type: '', id: '' });

  assert.deepEqual(
    normalizeViewContext({ workspaceKey: ` ${WS_A} `, folderKey: null }),
    { workspaceKey: WS_A, folderKey: '' },
  );
  assert.equal(sameViewContext({ workspaceKey: WS_A }, { workspaceKey: WS_A, folderKey: '' }), true);
  assert.equal(sameViewContext({ workspaceKey: WS_A }, { workspaceKey: WS_B }), false);
});

test('rapid A→B applies never paint the stale A answer', async () => {
  const applied = [];
  const location = { pathname: '/git', search: `?ws=${WS_A}` };
  const gateA = deferred();
  const store = createViewContextStore({
    readLocation: () => location,
    resolveWorkspace: (context) => (context.workspaceKey === WS_A
      ? gateA.promise
      : Promise.resolve({ workspaceFile: '/ws/b', workspaceFolder: '/ws/b' })),
    onApplied: (state) => applied.push(state),
    readyTimeoutMs: 300,
  });
  const firstApply = store.applyRouteContext(); // A in flight
  location.pathname = '/todo';
  location.search = `?ws=${WS_B}`;
  const secondApply = store.applyRouteContext(); // B settles fast
  const secondState = await secondApply;
  assert.equal(secondState.context.workspaceKey, WS_B);
  gateA.resolve({ workspaceFile: '/ws/a', workspaceFolder: '/ws/a' });
  const firstState = await firstApply;
  // The late A answer applies nothing and reports the newer current state.
  assert.deepEqual(
    applied.filter((s) => s.status === VIEW_CONTEXT_STATUS.RESOLVED).map((s) => s.context.workspaceKey),
    [WS_B],
  );
  assert.equal(firstState.context.workspaceKey, WS_B, 'stale callers see the newer state, never paint A');
  assert.equal(firstState.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.equal(store.getState().context.workspaceKey, WS_B);
});

test('a rejected route resolver for A after B already won leaves B intact and repaints nothing', async () => {
  const applied = [];
  const canonical = [];
  const location = { pathname: '/git', search: `?ws=${WS_A}` };
  const gateA = deferred();
  const store = createViewContextStore({
    readLocation: () => location,
    resolveWorkspace: (context) => (context.workspaceKey === WS_A
      ? gateA.promise
      : Promise.resolve({ workspaceFile: '/ws/b', workspaceFolder: '/ws/b' })),
    onApplied: (state) => applied.push(state),
    canonicalize: (path) => canonical.push(path),
    readyTimeoutMs: 300,
  });
  const firstApply = store.applyRouteContext(); // A in flight (pending)
  location.pathname = '/todo';
  location.search = `?ws=${WS_B}`;
  const secondApply = store.applyRouteContext(); // B settles fast and wins
  const secondState = await secondApply;
  assert.equal(secondState.context.workspaceKey, WS_B);
  assert.equal(secondState.status, VIEW_CONTEXT_STATUS.RESOLVED);
  // Only now does A's resolver REJECT — after B already owns the view.
  gateA.reject(new Error('offline'));
  const firstState = await firstApply;
  // The late failure of A must not overwrite the live B context, must not
  // mark this view missing-target, and must not canonicalize the stale A link.
  assert.equal(store.getState().context.workspaceKey, WS_B, 'B stays the live context');
  assert.equal(store.getState().status, VIEW_CONTEXT_STATUS.RESOLVED, 'no MISSING_TARGET from late A');
  assert.deepEqual(
    applied.filter((s) => s.status === VIEW_CONTEXT_STATUS.MISSING_TARGET).map((s) => s.context.workspaceKey),
    [],
    'no missing-target repaint of A',
  );
  assert.deepEqual(canonical, [], 'the stale A link is never canonicalized');
  assert.equal(firstState.context.workspaceKey, WS_B, 'stale A callers see the newer state, never A');
  assert.equal(firstState.status, VIEW_CONTEXT_STATUS.RESOLVED);
});

test('an unknown or offline id keeps the link target and never repaints the scope', async () => {
  const h = harness({
    resolveWorkspace: async () => ({ error: 'workspace-unknown' }),
  });
  h.setLocation('/git', `?ws=${WS_A}&folder=${FOLDER_A}`);
  const state = await h.store.applyRouteContext();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.MISSING_TARGET);
  assert.equal(state.conflict.code, 'workspace-unknown');
  assert.deepEqual(state.target, {
    workspaceKey: WS_A,
    folderKey: FOLDER_A,
    scope: { type: '', id: '' },
  });
  // The target is still pending: nothing was canonicalized, nothing applied to paths.
  assert.deepEqual(h.canonical, []);
  assert.ok(h.applied.some((s) => s.status === VIEW_CONTEXT_STATUS.MISSING_TARGET));
  assert.equal(h.applied.at(-1).status, VIEW_CONTEXT_STATUS.MISSING_TARGET);
  assert.deepEqual(h.applied[0].runtime, { workspaceFile: '', workspaceFolder: '' });
  // A rejected resolver (network) behaves the same: the view keeps the target.
  const h2 = harness({
    resolveWorkspace: async () => { throw new Error('offline'); },
  });
  h2.setLocation('/chat', `?chat=${CHAT_ID}&ws=${WS_A}`);
  const state2 = await h2.store.applyRouteContext();
  assert.equal(state2.status, VIEW_CONTEXT_STATUS.MISSING_TARGET);
  assert.equal(state2.target.workspaceKey, WS_A);
});

test('a resolved explicit link canonicalizes its address once', async () => {
  const h = harness({
    resolveWorkspace: async () => ({
      workspaceFile: '/ws/alpha',
      workspaceFolder: '/ws/alpha/app',
      workspaceKey: WS_A,
      folderKey: FOLDER_A,
    }),
  });
  // Legacy shape: panel travels as a query param and the folder id is not in
  // the link yet. After the resolve both are canonical in the address.
  h.setLocation('/', `?panel=git&ws=${WS_A}`);
  await h.store.applyRouteContext();
  assert.equal(h.canonical.length, 1, 'canonicalized exactly once after resolve');
  assert.equal(h.canonical[0], `/git?ws=${WS_A}&folder=${FOLDER_A}`);
  assert.equal(h.applied.at(-1).status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.deepEqual(h.applied.at(-1).runtime, { workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app' });
});

test('a fully canonical explicit link is not rewritten, a default link is not gated on network', async () => {
  const h = harness({
    resolveWorkspace: async () => ({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha' }),
  });
  const canonicalSearch = `?ws=${WS_A}`;
  h.setLocation('/git', canonicalSearch);
  await h.store.applyRouteContext();
  assert.deepEqual(h.canonical, [], 'same-as-current canonical must not fire a replace');

  // No ws/folder in the link: the local/default context applies without any resolve call.
  const d = harness({
    defaultContext: { workspaceFile: '/ws/home', workspaceFolder: '/ws/home/app' },
    getContextKeysForRuntime: async () => ({ workspaceKey: WS_A, folderKey: FOLDER_A }),
  });
  d.setLocation('/chat', `?chat=${CHAT_ID}`);
  const state = await d.store.applyRouteContext();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.deepEqual(state.runtime, { workspaceFile: '/ws/home', workspaceFolder: '/ws/home/app' });
  assert.equal(d.canonical.length, 1, 'a resolved default may be canonicalized with its keys');
  assert.equal(d.canonical[0], `/chat?ws=${WS_A}&folder=${FOLDER_A}&chat=${CHAT_ID}`);
});

test('explicit pending or missing targets block scoped panel access until resolved', async () => {
  const h = harness({
    resolveWorkspace: async () => ({ error: 'workspace-unknown' }),
  });
  setSharedViewContextStore(h.store);
  h.setLocation('/todo', `?ws=${WS_A}`);
  const pending = h.store.applyRouteContext();
  assert.equal(isViewContextScopedAccessAllowed(), false, 'pending explicit link blocks fetch');
  await pending;
  assert.equal(isViewContextScopedAccessAllowed(), false, 'missing target keeps the gate closed');
  assert.equal(h.store.getState().status, VIEW_CONTEXT_STATUS.MISSING_TARGET);
});

test('user workspace selection cancels a late route resolver answer', async () => {
  const gate = deferred();
  const h = harness({
    resolveWorkspace: (context) => (context.workspaceKey === WS_A ? gate.promise : Promise.resolve({
      workspaceFile: '/ws/b',
      workspaceFolder: '/ws/b',
    })),
  });
  h.setLocation('/git', `?ws=${WS_A}`);
  void h.store.applyRouteContext();
  h.store.applyUserWorkspaceSelection(
    { workspaceFile: '/ws/user', workspaceFolder: '/ws/user/app' },
    { workspaceKey: WS_B, folderKey: '' },
  );
  gate.resolve({ workspaceFile: '/ws/a', workspaceFolder: '/ws/a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.store.getState().context.workspaceKey, WS_B);
  assert.equal(h.store.getState().runtime.workspaceFolder, '/ws/user/app');
  assert.equal(h.applied.at(-1).source, 'user');
});

test('the boot gate resolves immediately for default links and on the bounded timeout otherwise', async () => {
  const gate = deferred();
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/git', search: `?ws=${WS_A}` }),
    resolveWorkspace: () => gate.promise,
    readyTimeoutMs: 40,
  });
  const applied = store.applyRouteContext();
  const ready = await store.whenReady();
  assert.equal(ready.status, VIEW_CONTEXT_STATUS.PENDING, 'ready fired by the timeout backstop');
  // A timeout is NOT a missing target: the link and its URL stay intact, the
  // status remains pending, and nothing was canonicalized.
  assert.equal(ready.target.workspaceKey, WS_A, 'the boot timeout keeps the requested target');
  gate.resolve({ workspaceFile: '/ws/a', workspaceFolder: '/ws/a' });
  const state = await applied;
  assert.equal(state.status, VIEW_CONTEXT_STATUS.RESOLVED);
});

test('a slow explicit link parks the scoped boot pass and resumes it exactly once', async () => {
  const gate = deferred();
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/git', search: `?ws=${WS_A}` }),
    resolveWorkspace: () => gate.promise,
    readyTimeoutMs: 30,
  });
  const applied = store.applyRouteContext();
  await store.whenReady();
  assert.equal(store.getState().status, VIEW_CONTEXT_STATUS.PENDING);

  // Two independent boot passes (chat list, visible panel) wait on the gate.
  const resumed = [];
  const first = store.whenScopedAccessAllowed().then((state) => { resumed.push(`first:${state.status}`); });
  const second = store.whenScopedAccessAllowed().then((state) => { resumed.push(`second:${state.status}`); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumed, [], 'the parked passes must not run on the unresolved target');

  gate.resolve({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app', workspaceKey: WS_A });
  await applied;
  await Promise.all([first, second]);
  assert.deepEqual(resumed, ['first:resolved', 'second:resolved'], 'each pass resumes once with the resolved context');

  // A later apply (another route, a user switch) must not re-run what already ran.
  store.applyUserWorkspaceSelection(
    { workspaceFile: '/ws/other', workspaceFolder: '/ws/other/app' },
    { workspaceKey: WS_B },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumed.length, 2, 'the resume is once-only, never a duplicate race');
});

test('a missing or conflicting target never releases the scoped boot pass', async () => {
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/git', search: `?ws=${WS_A}&folder=${FOLDER_A}` }),
    resolveWorkspace: async () => ({ error: 'workspace-unknown' }),
    readyTimeoutMs: 20,
  });
  await store.applyRouteContext();
  await store.whenReady();
  let ran = false;
  void store.whenScopedAccessAllowed().then(() => { ran = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false, 'offline keeps the panels closed instead of reading the global cwd');

  // The operator picking a workspace is a real resolution: the pass resumes.
  store.applyUserWorkspaceSelection({ workspaceFile: '/ws/picked', workspaceFolder: '/ws/picked' }, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true, 'a resolved context releases the parked pass once');

  // And a conflict on a resolved context closes the gate again.
  const other = createViewContextStore({
    readLocation: () => ({ pathname: '/chat', search: `?chat=${CHAT_ID}&ws=${WS_A}` }),
    resolveWorkspace: async () => ({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app' }),
    readyTimeoutMs: 20,
  });
  await other.applyRouteContext();
  assert.equal(other.getState().status, VIEW_CONTEXT_STATUS.RESOLVED);
  other.reportResourceConflict('chat', { workspaceFile: '/ws/beta' });
  assert.equal(other.getState().status, VIEW_CONTEXT_STATUS.CONFLICT);
  assert.equal(scopedAccessAllowedFor(other.getState()), true, 'a resource conflict keeps workspace-scoped lists open');
});

test('URL resources must belong to the explicit ws/folder; conflicts report, silence without a link target', async () => {
  const h = harness({
    resolveWorkspace: async () => ({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app' }),
  });
  h.setLocation('/chat', `?chat=${CHAT_ID}&ws=${WS_A}&folder=${FOLDER_A}`);
  await h.store.applyRouteContext();

  const foreign = h.store.reportResourceConflict('chat', {
    id: CHAT_ID,
    workspaceFile: '/ws/beta',
    workspaceFolder: '/ws/beta/app',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.detail, 'workspace-mismatch');
  assert.equal(h.store.getState().status, VIEW_CONTEXT_STATUS.CONFLICT);
  // The conflict never rewrote the scope: the resolved runtime still stands.
  assert.deepEqual(h.store.getState().runtime, { workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app' });

  const own = h.store.reportResourceConflict('todo', {
    id: TODO_ID,
    workspaceFile: '/ws/alpha',
    workspaceFolder: '/ws/alpha/app',
  });
  assert.equal(own.ok, true);

  // After the operator acts on their own, the retired link stops owning the view.
  h.store.clearRouteTarget();
  const silent = h.store.reportResourceConflict('chat', { workspaceFile: '/ws/beta' });
  assert.equal(silent.ok, true);
  assert.notEqual(h.store.getState().status, VIEW_CONTEXT_STATUS.CONFLICT);
});

test('ownership validation is inert when the link carries no explicit context', () => {
  const state = { context: { workspaceKey: '', folderKey: '' }, runtime: { workspaceFile: '', workspaceFolder: '' } };
  assert.deepEqual(validateResourceAgainstContext('chat', { workspaceFile: '/x' }, state), { ok: true });
  const missing = validateResourceAgainstContext('todo', null, {
    context: { workspaceKey: WS_A },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, 'resource-missing');
});

test('the Git scope projection pins route ids and releases on a scopeless route', () => {
  const pinned = gitScopeFromViewContext({
    scope: { type: 'todo', id: TODO_ID },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  assert.deepEqual(pinned.scope, { chatId: '', todoId: TODO_ID, workspaceFolder: '/ws/a/app' });
  assert.equal(pinned.lock, true);

  const viaChat = gitScopeFromViewContext({
    scope: { type: 'chat', id: CHAT_ID },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  assert.equal(viaChat.scope.chatId, CHAT_ID);
  assert.equal(viaChat.lock, true);

  const workspaceLevel = gitScopeFromViewContext({
    scope: { type: '', id: '' },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  assert.deepEqual(workspaceLevel.scope, { chatId: '', todoId: '', workspaceFolder: '/ws/a/app' });
  assert.equal(workspaceLevel.lock, false);
});

test('a pinned TODO scope survives refreshes and history/reset applies it deterministically', () => {
  resetGitScopeForTests();
  // Task chip pin (todoPanel behavior).
  setGitScope({ todoId: TODO_ID, workspaceFolder: '/ws/a/app' }, { lock: true });
  assert.equal(isGitScopeLocked(), true);

  // A scopeless route (history back to /git) releases it deterministically.
  const released = gitScopeFromViewContext({
    scope: { type: '', id: '' },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  setGitScope(released.scope, { lock: released.lock });
  assert.equal(isGitScopeLocked(), false);
  assert.equal(getGitScope().todoId, '');

  // Re-pinning through the same route keeps the id locked and stable.
  const pinnedAgain = gitScopeFromViewContext({
    scope: { type: 'todo', id: TODO_ID },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  const revisionBefore = getGitScopeRevision();
  setGitScope(pinnedAgain.scope, { lock: pinnedAgain.lock });
  assert.equal(isGitScopeLocked(), true);
  assert.equal(getGitScope().todoId, TODO_ID);
  assert.equal(getGitScopeRevision(), revisionBefore + 1, 'a new scope raises the revision once');
  // A redundant refresh of the same route scope raises nothing (no refetch churn).
  setGitScope(pinnedAgain.scope, { lock: pinnedAgain.lock });
  assert.equal(getGitScopeRevision(), revisionBefore + 1);
  resetGitScopeForTests();
});

test('an explicit unlock on the same pinned scope releases the lock', () => {
  resetGitScopeForTests();
  const pinned = gitScopeFromViewContext({
    scope: { type: 'chat', id: CHAT_ID },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  setGitScope(pinned.scope, { lock: pinned.lock });
  assert.equal(isGitScopeLocked(), true);
  setGitScope(pinned.scope, { lock: false });
  assert.equal(isGitScopeLocked(), false, 'badge unlock uses lock:false on the same key');
  resetGitScopeForTests();
});

test('clearRouteTarget bumps revision so a late route resolver cannot canonicalize', async () => {
  const gate = deferred();
  const h = harness({
    resolveWorkspace: () => gate.promise,
  });
  h.setLocation('/git', `?ws=${WS_A}`);
  void h.store.applyRouteContext();
  h.store.clearRouteTarget();
  const revisionAfterClear = h.store.getRevision();
  gate.resolve({ workspaceFile: '/ws/stale', workspaceFolder: '/ws/stale', workspaceKey: WS_A });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.canonical.length, 0, 'stale resolver must not rewrite the URL after the operator retires the target');
  assert.ok(h.store.getRevision() > revisionAfterClear || h.store.getRevision() === revisionAfterClear);
});

test('withViewContextQuery appends durable route keys for scoped API calls', async () => {
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/git', search: `?ws=${WS_A}&folder=${FOLDER_A}` }),
    resolveWorkspace: async () => ({ workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' }),
  });
  setSharedViewContextStore(store);
  await store.applyRouteContext();
  assert.equal(
    withViewContextQuery('/api/example'),
    `/api/example?ws=${WS_A}&folder=${FOLDER_A}`,
  );
  setSharedViewContextStore(null);
});

test('viewContextRuntimeParams carries the pinned id for panel requests', () => {
  const params = viewContextRuntimeParams({
    context: { workspaceKey: WS_A, folderKey: FOLDER_A },
    scope: { type: 'chat', id: CHAT_ID },
    runtime: { workspaceFile: '/ws/a', workspaceFolder: '/ws/a/app' },
  });
  assert.deepEqual(params, {
    workspaceFile: '/ws/a',
    workspaceFolder: '/ws/a/app',
    chatId: CHAT_ID,
    todoId: '',
  });
});
