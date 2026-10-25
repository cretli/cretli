/**
 * ViewContext boot wiring (navigation plan stage 2 acceptance).
 *
 * Runs the real `createWorkspaceContext` factory (same vm-source technique as
 * workspace-selection-race) against a fake tab: a deep link with explicit
 * ws/folder must resolve through the catalog / shared context API into the
 * local scope BEFORE panels read, must never PATCH /api/settings, must keep
 * the URL target when data is missing, and must report a foreign chat without
 * silently switching the global context. The shared bridge is the one-line
 * surface later panels and stages build on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../app_front/app/appShell/workspaceHelpers.js';
import {
  VIEW_CONTEXT_STATUS,
  createViewContextStore,
  hasExplicitWorkspace,
} from '../app_front/app/appShell/viewContext.js';
import {
  getViewContextState,
  hasExplicitViewContextTarget,
  isViewContextScopedAccessAllowed,
  reportViewContextResourceConflict,
  setSharedViewContextStore,
  whenViewContextReady,
  whenViewContextScopedAccessAllowed,
} from '../app_front/app/appShell/viewContextBridge.js';
import { setSharedSpaNavigation } from '../app_front/app/appShell/spaNavigationBridge.js';
import { buildSpaRoute, parseSpaRoute } from '../lib/spa-routes.js';
import { readChatSource } from './helpers/chatSource.js';
import { readAppShellSource } from './helpers/app-shell-source.js';

const WS_KEY = '0e6a6f32-2b8c-4921-9041-e5b230e7b793';
const FOLDER_KEY = '3b8d2f1a-5a44-4a12-b1c8-2f4f0a1d9c33';
const CHAT_ID = '4fbef7c3-96cd-4451-b014-64d6c4e1ca03';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeElements() {
  const message = { hidden: true, textContent: '', setAttribute() {}, removeAttribute() {} };
  const trigger = {
    dataset: { workspaceFile: '', workspaceFolder: '' },
    addEventListener() {},
    setAttribute() {},
  };
  const label = { textContent: '' };
  return { message, trigger, label };
}

function harness(options = {}) {
  const els = makeElements();
  const events = [];
  const listeners = new Map();
  const writes = [];
  const reads = [];
  const canonicalWrites = [];
  // A fully canonical stage-1 link: context ids first, then the panel resource.
  const location = { pathname: '/chat', search: `?ws=${WS_KEY}&folder=${FOLDER_KEY}&chat=${CHAT_ID}` };
  const win = {
    location,
    history: { state: null, replaceState() {} },
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  globalThis.window = win;
  const context = vm.createContext({
    ...helpers,
    VIEW_CONTEXT_STATUS,
    createViewContextStore,
    hasExplicitWorkspace,
    setSharedViewContextStore,
    replaceSpaCanonical: (url) => canonicalWrites.push(url),
    parseSpaRoute,
    buildSpaRoute,
    document: {
      getElementById: (id) => (
        {
          'header-workspace-trigger': els.trigger,
          'header-workspace-label': els.label,
          'header-workspace-popover': {},
          'header-workspace-message': els.message,
          'sidebar-workspace-bar': { hidden: true, dataset: {} },
        }[id] || null
      ),
    },
    window: win,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    t: (key) => key,
    probeSync: (_name, fn) => fn(),
    probeStart: () => ({}),
    probeEnd: () => {},
    initDropdown: () => ({}),
    createWorkspaceSettings: () => ({}),
    readChatLocalBootCacheForColdStart: () => null,
  });
  const source = fs.readFileSync(new URL('../app_front/app/appShell/workspaceContext.js', import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  const catalogRow = options.catalogRow === undefined
    ? {
      id: '/ws/alpha/app.code-workspace',
      kind: 'file',
      workspaceFile: '/ws/alpha/app.code-workspace',
      workspaceDir: '/ws/alpha',
      workspaceKey: WS_KEY,
      folders: [{ name: 'app', path: 'app', resolvedPath: '/ws/alpha/app', exists: true, folderKey: FOLDER_KEY }],
    }
    : options.catalogRow;
  const api = {
    patchSettings: (payload) => { const request = deferred(); writes.push({ ...request, payload }); return request.promise; },
    getSettings: () => { const request = deferred(); reads.push(request); return request.promise; },
    getWorkspace: async () => ({ ok: true, workspaceDir: '/ws/alpha', folders: [] }),
    getWorkspaces: async () => ({ ok: true, workspaces: catalogRow ? [catalogRow] : [] }),
    getWorkspaceContext: async (ids) => (options.contextApi
      ? options.contextApi(ids)
      : { ok: false, error: 'workspace-unknown' }),
  };
  const refreshes = { chats: 0, tasks: 0, workspaceInfo: 0 };
  const origGetWorkspace = api.getWorkspace;
  api.getWorkspace = async () => { refreshes.workspaceInfo += 1; return origGetWorkspace(); };
  const scopesSeenByPanels = [];
  const workspace = context.createWorkspaceContext({
    api,
    refreshChatListForWorkspace: () => { refreshes.chats += 1; },
    refreshTasksList: () => {
      refreshes.tasks += 1;
      scopesSeenByPanels.push(getViewContextState()?.runtime?.workspaceFolder || '');
    },
  });
  return { workspace, refreshes, scopesSeenByPanels, els, events, listeners, writes, reads, canonicalWrites, location, api };
}

test.afterEach(() => {
  setSharedViewContextStore(null);
  setSharedSpaNavigation(null);
});

test('boot with an explicit deep link resolves the catalog scope before panels fetch, without any settings write', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  // The gate behind which App.js runs the first panel fetches must open once
  // the route context settled — and only after it resolved to the link's ids.
  const ready = await whenViewContextReady();
  assert.equal(ready.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.equal(ready.context.workspaceKey, WS_KEY);
  assert.equal(ready.runtime.workspaceFolder, '/ws/alpha/app');
  assert.equal(h.els.trigger.dataset.workspaceFile, '/ws/alpha/app.code-workspace');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/ws/alpha/app');
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/other/global.code-workspace', workspaceFolder: '/ws/other' });
  await boot;
  // The global default from settings must NOT repaint the resolved explicit scope.
  assert.equal(h.els.trigger.dataset.workspaceFile, '/ws/alpha/app.code-workspace');
  assert.equal(h.writes.length, 0, 'boot/deep link never PATCHes /api/settings');
  // Fully canonical URL: nothing to rewrite.
  assert.deepEqual(h.canonicalWrites, []);
});

test('a legacy link canonicalizes to the resolved ids exactly once', async () => {
  const h = harness();
  h.location.pathname = '/';
  h.location.search = `?panel=chat&chat=${CHAT_ID}&ws=${WS_KEY}&folder=${FOLDER_KEY}`;
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  assert.equal(h.canonicalWrites.length, 1, 'canonicalized once after resolution');
  assert.equal(h.canonicalWrites[0], `/chat?ws=${WS_KEY}&folder=${FOLDER_KEY}&chat=${CHAT_ID}`);
  assert.equal(h.writes.length, 0);
});

test('a missing workspace id keeps the link target offline: no repaint, no rewrite, a message', async () => {
  const h = harness({ catalogRow: null });
  h.workspace.initWorkspacePopover();
  const state = await whenViewContextReady();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.MISSING_TARGET);
  assert.equal(state.conflict.code, 'workspace-unknown');
  assert.equal(state.target.workspaceKey, WS_KEY, 'the requested target is preserved');
  assert.equal(h.els.trigger.dataset.workspaceFile, '', 'nothing was silently re-pointed');
  assert.deepEqual(h.canonicalWrites, [], 'a target that did not resolve is never canonicalized');
  assert.equal(h.els.message.textContent, 'workspace.contextMissing');
  assert.equal(h.els.message.hidden, false);
  assert.equal(h.writes.length, 0);
  // The cold cache path (chatController.restoreHeaderWorkspaceContext) must also
  // skip while an explicit target is pending: the URL wins over the cache.
  assert.equal(hasExplicitViewContextTarget(), true);
});

test('the shared context API resolves cold links the catalog does not know yet', async () => {
  const h = harness({
    catalogRow: null,
    contextApi: async ({ workspaceKey, folderKey }) => ({
      ok: true,
      workspaceKey,
      folderKey,
      workspace: { id: `/cretli:ws:${workspaceKey}`, kind: 'folder', workspaceFile: '/srv/beta', workspaceDir: '/srv/beta', exists: true },
      folder: { name: 'beta', resolvedPath: '/srv/beta' },
    }),
  });
  h.workspace.initWorkspacePopover();
  const state = await whenViewContextReady();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.equal(h.els.trigger.dataset.workspaceFile, '/srv/beta');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/srv/beta');
  assert.equal(h.writes.length, 0);
});

test('a chat from another workspace than the pinned link conflicts loudly and switches nothing globally', async () => {
  const h = harness();
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  const result = reportViewContextResourceConflict('chat', {
    id: CHAT_ID,
    workspaceFile: '/ws/beta/beta.code-workspace',
    workspaceFolder: '/ws/beta/app',
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'workspace-mismatch');
  assert.equal(h.els.message.textContent, 'workspace.contextConflictChat');
  assert.equal(h.els.message.hidden, false);
  assert.equal(h.writes.length, 0, 'a conflict never mutates the global settings context');
  assert.equal(h.workspace.getViewContextState().runtime.workspaceFolder, '/ws/alpha/app', 'the explicit scope stays as linked');
  // A chat that belongs to the linked workspace reports no conflict.
  const ok = reportViewContextResourceConflict('chat', {
    id: '9d52a5a6-cf7b-43a1-9ecc-add237826818',
    workspaceFile: '/ws/alpha/app.code-workspace',
    workspaceFolder: '/ws/alpha/app',
  });
  assert.equal(ok.ok, true);
});

test('route re-apply after location change stays local without PATCH /api/settings', async () => {
  const h = harness();
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  assert.equal(h.writes.length, 0);
  h.location.pathname = '/git';
  h.location.search = `?ws=${WS_KEY}`;
  await h.workspace.applyRouteContext();
  await new Promise((resolve) => setImmediate(resolve));
  await whenViewContextReady();
  assert.equal(h.workspace.getViewContextState().context.workspaceKey, WS_KEY);
  assert.equal(h.els.trigger.dataset.workspaceFile, '/ws/alpha/app.code-workspace');
  assert.equal(h.writes.length, 0);
  assert.equal(h.listeners.has('popstate'), false, 'popstate is owned by SPA navigation, not workspaceContext');
});

test('ws-only on a file workspace resolves a default folder into runtime', async () => {
  const h = harness();
  h.location.pathname = '/git';
  h.location.search = `?ws=${WS_KEY}`;
  h.workspace.initWorkspacePopover();
  const state = await whenViewContextReady();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.equal(state.runtime.workspaceFolder, '/ws/alpha/app');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/ws/alpha/app');
});

test('a ws-only link honors the configured preferred folder over another enabled folder', async () => {
  const row = {
    id: '/ws/alpha/app.code-workspace',
    kind: 'file',
    workspaceFile: '/ws/alpha/app.code-workspace',
    workspaceDir: '/ws/alpha',
    workspaceKey: WS_KEY,
    folders: [
      { name: 'one', resolvedPath: '/ws/alpha/one', exists: true, enabled: true, folderKey: 'f-one' },
      { name: 'two', resolvedPath: '/ws/alpha/two', exists: true, enabled: true, folderKey: 'f-two' },
    ],
  };
  const h = harness({ catalogRow: row });
  h.location.pathname = '/git';
  h.location.search = `?ws=${WS_KEY}`;
  // The operator's sidebar choice for this row is authoritative everywhere
  // else in the app; a link that pins only `ws` must honor the same folder.
  h.workspace.setWorkspaceSidebarConfig({
    '/ws/alpha/app.code-workspace': {
      workspaceFile: '/ws/alpha/app.code-workspace',
      folder: '/ws/alpha/two',
    },
  });
  h.workspace.initWorkspacePopover();
  const state = await whenViewContextReady();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.equal(state.runtime.workspaceFolder, '/ws/alpha/two',
    'the canonical preferred folder wins over the first enabled catalog folder');
  assert.notEqual(state.runtime.workspaceFolder, row.workspaceDir,
    'and never the workspace-file parent directory');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/ws/alpha/two',
    'the header and the runtime scope agree');
});

test('popover workspace pick uses switchWorkspace and clears the route target', async () => {
  const other = {
    id: '/ws/other/other.code-workspace',
    kind: 'file',
    workspaceFile: '/ws/other/other.code-workspace',
    workspaceDir: '/ws/other',
    workspaceKey: 'other-key',
    folders: [{ name: 'other', resolvedPath: '/ws/other', folderKey: 'f-other' }],
  };
  const h = harness();
  h.api.getWorkspaces = async () => ({
    ok: true,
    workspaces: [
      {
        id: '/ws/alpha/app.code-workspace',
        kind: 'file',
        workspaceFile: '/ws/alpha/app.code-workspace',
        workspaceDir: '/ws/alpha',
        workspaceKey: WS_KEY,
        folders: [{ name: 'app', resolvedPath: '/ws/alpha/app', exists: true, folderKey: FOLDER_KEY }],
      },
      other,
    ],
  });
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  await h.workspace.switchWorkspace(other.workspaceFile, '/ws/other');
  assert.equal(hasExplicitViewContextTarget(), false);
  assert.equal(h.els.trigger.dataset.workspaceFile, other.workspaceFile);
  assert.equal(isViewContextScopedAccessAllowed(), true);
  assert.ok(h.canonicalWrites.some((url) => String(url).includes('ws=other-key')), 'operator switch rewrites stale ws/folder in the URL');
});

test('an operator switch retires the deep-link target and stays local', async () => {
  const h = harness();
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  const switched = h.workspace.switchWorkspace('/ws/other/other.code-workspace', '/ws/other');
  assert.equal(await switched, true);
  assert.equal(h.writes.length, 0, 'the view switch drives local context only');
  assert.equal(hasExplicitViewContextTarget(), false, 'the old link no longer owns the view');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/ws/other');
});

test('panels refetching during a switch already read the new workspace from the store', async () => {
  // Todo reads its folder from the view-context store; refreshing panels before
  // the store moved reloaded the previous workspace after a chat switch.
  const h = harness();
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  h.scopesSeenByPanels.length = 0;
  const switched = h.workspace.switchWorkspace('/ws/other/other.code-workspace', '/ws/other');
  assert.deepEqual(h.scopesSeenByPanels, ['/ws/other'], 'the synchronous panel refresh sees the new folder');
  assert.equal(await switched, true);
  assert.equal(getViewContextState().runtime.workspaceFolder, '/ws/other');
});

test('the Git badge keeps a pinned TODO scope across refreshes and only the route releases it', () => {
  const badge = fs.readFileSync(new URL('../app_front/features/git/gitContextBadge.js', import.meta.url), 'utf8');
  const refreshBody = badge.slice(badge.indexOf('export async function refreshGitContextBadge'));
  assert.match(refreshBody, /if \(isGitScopeLocked\(\)\) \{/, 'the refresh must respect the scope lock');
  assert.match(refreshBody, /locked\.todoId && scope\.todoId !== locked\.todoId/, 'a pinned TODO survives active-chat refresh');
  assert.match(refreshBody, /routeWorkspaceGit/, '/git without scope= must not infer active chat');
  const app = readAppShellSource();
  assert.match(app, /function applyRouteGitScope\(\)/, 'route applies are the deterministic lock owner');
  assert.match(app, /window\.addEventListener\('cretli-view-context-changed', \(\) => applyRouteGitScope\(\)\)/);
  assert.match(app, /setGitScope\(projected\.scope, \{ lock: projected\.lock \}\)/);
});

test('chat selection validates workspace ownership before opening the terminal', () => {
  const chat = readChatSource();
  const body = chat.slice(chat.indexOf('function performSelectChat(id)'), chat.indexOf('export function loadWorkspaces'));
  assert.match(body, /reportViewContextResourceConflict\('chat', chat\)/);
  assert.match(body, /if \(!ownership\.ok\) return;/);
  assert.doesNotMatch(body, /chatController\.selectChat\(id\);[\s\S]*reportViewContextResourceConflict/);
});

test('the context must be resolved before the visible panel fetches data on boot', () => {
  const app = readAppShellSource();
  assert.match(app, /const scopedBootPass = whenViewContextReady\(\)\.then\(\(\) => whenViewContextScopedAccessAllowed\(\)\)/,
    'the bounded boot wait is followed by the scoped-access gate: a timeout is not a fallback');
  assert.match(app, /scopedBootPass\.then\(\(\) => \{\s*void loadChatsFromServer\(\{ preferChatId: readRequestedChatId\(\) \}\)/,
    'the chat list load is gated behind the resolved context');
  assert.match(app, /scopedBootPass\.then\([\s\S]*spaNav\.bootApply\(/,
    'the first visible route applies only with a usable context');
});

test('a link slower than the boot wait parks the passes and shows the pending state', async () => {
  // The catalog row is unknown and the shared context API stalls, so the tab
  // stays PENDING with an explicit target: exactly the deep link a user clicks
  // while the server is slow. Nothing may be fetched or rewritten in that window.
  const gate = deferred();
  const h = harness({
    catalogRow: null,
    contextApi: () => gate.promise,
  });
  h.workspace.initWorkspacePopover();
  await new Promise((resolve) => setImmediate(resolve));

  const state = h.workspace.getViewContextState();
  assert.equal(state.status, VIEW_CONTEXT_STATUS.PENDING, 'slow is still pending, never missing');
  assert.equal(state.target.workspaceKey, WS_KEY, 'the requested target is kept');
  assert.equal(state.runtime.workspaceFolder, '', 'no runtime scope was invented');
  assert.equal(h.els.message.textContent, 'workspace.contextPending', 'the header shows the pending state');
  assert.equal(h.els.message.hidden, false);
  assert.equal(h.els.trigger.dataset.workspaceFile, '', 'the default workspace was not painted in');
  assert.deepEqual(h.canonicalWrites, [], 'a pending link never rewrites its own URL');
  assert.equal(h.writes.length, 0, 'no settings write in the pending window');

  const resumed = [];
  void whenViewContextScopedAccessAllowed().then((next) => {
    assert.ok(isViewContextScopedAccessAllowed(), 'the gate opened with the resolved snapshot');
    resumed.push(next.status);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumed, [], 'the parked scoped pass must not run on a pending target');

  gate.resolve({
    ok: true,
    workspaceKey: WS_KEY,
    folderKey: FOLDER_KEY,
    workspace: { id: WS_KEY, kind: 'file', workspaceFile: '/ws/alpha/app.code-workspace' },
    folder: { name: 'app', resolvedPath: '/ws/alpha/app' },
  });
  for (let hop = 0; hop < 4; hop += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumed, ['resolved'], 'the late resolve resumes the scoped pass exactly once');
  assert.equal(h.workspace.getViewContextState().runtime.workspaceFolder, '/ws/alpha/app');
  assert.equal(h.els.message.hidden, true, 'the pending notice is gone once resolved');
  assert.equal(h.els.trigger.dataset.workspaceFolder, '/ws/alpha/app');
  assert.equal(h.writes.length, 0, 'the resume still never writes settings');

  // A second settle must not re-run the pass that already ran.
  h.workspace.switchWorkspace('/ws/alpha/app.code-workspace', '/ws/alpha/app');
  for (let hop = 0; hop < 4; hop += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumed, ['resolved'], 'no duplicate resume race after the first one');
});

test('re-applying the route context for the workspace already shown does not refetch or repaint the shell', async () => {
  const h = harness();
  h.workspace.initWorkspacePopover();
  await whenViewContextReady();
  const activeChanged = () => h.events.filter((e) => e.type === 'cretli-active-workspace-changed').length;
  const before = { ...h.refreshes, changed: activeChanged() };
  assert.ok(before.chats >= 1, 'the first resolve takes the full apply path');
  // A tab switch re-resolves the same route: same workspace, nothing to refresh.
  await h.workspace.applyRouteContext();
  await h.workspace.applyRouteContext();
  assert.deepEqual({ ...h.refreshes, changed: activeChanged() }, before);
});
