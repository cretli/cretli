import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../app_front/app/appShell/workspaceHelpers.js';
import { resolveWorkspaceTargetForChat } from '../app_front/features/sidebar/workspaceChatMatch.js';
import { scopeWatcherRequestToWorkspace } from '../app_front/features/watcher/watcherWorkspaceScope.js';
import {
  VIEW_CONTEXT_STATUS,
  createViewContextStore,
  hasExplicitWorkspace,
} from '../app_front/app/appShell/viewContext.js';
import { buildSpaRoute, parseSpaRoute } from '../lib/spa-routes.js';
import { readChatSource } from './helpers/chatSource.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const trigger = {
    dataset: { workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/backend' },
    addEventListener() {},
    setAttribute() {},
  };
  const label = { textContent: '' };
  const events = [];
  const listeners = new Map();
  const writes = [];
  const reads = [];
  const context = vm.createContext({
    ...helpers,
    VIEW_CONTEXT_STATUS,
    createViewContextStore,
    hasExplicitWorkspace,
    setSharedViewContextStore: () => {},
    replaceLocationCanonical: () => {},
    getSharedSpaNavigation: () => null,
    parseSpaRoute,
    buildSpaRoute,
    document: { getElementById: (id) => ({
      'header-workspace-trigger': trigger,
      'header-workspace-label': label,
      'header-workspace-popover': {},
      'header-workspace-message': { hidden: true, textContent: '', setAttribute() {}, removeAttribute() {} },
      'sidebar-workspace-bar': { hidden: true, dataset: {} },
    })[id] || null },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      dispatchEvent: (event) => events.push(event),
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
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
  const api = {
    patchSettings: (payload) => { const request = deferred(); writes.push({ ...request, payload }); return request.promise; },
    getSettings: () => { const request = deferred(); reads.push(request); return request.promise; },
    getWorkspace: async () => ({ ok: true }),
  };
  const workspace = context.createWorkspaceContext({ api });
  // A stale/incomplete catalog must not erase a folder explicitly stored on a chat.
  workspace.seedWorkspacesList([{ workspaceFile: '/ws/acme.code-workspace', workspaceDir: '/ws/projects', folders: [] }]);
  return { workspace, trigger, label, writes, reads, events, listeners };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('opening a legacy esystent chat scopes Scout writes to esystent with a local-only switch', async () => {
  const h = harness();
  const file = '/ws/esystent.code-workspace';
  const target = resolveWorkspaceTargetForChat(
    { workspaceFile: file, workspaceFolder: '/ws' }, h.trigger.dataset,
    h.workspace.getWorkspacesList(), () => '/ws/esystent',
  );
  const switched = h.workspace.switchWorkspace(target.workspaceFile, target.workspaceFolder);
  const enable = scopeWatcherRequestToWorkspace('/api/workspace-watcher',
    { method: 'PATCH', body: { policy: { scoutEnabled: true } } }, h.trigger.dataset.workspaceFolder);
  const run = scopeWatcherRequestToWorkspace('/api/workspace-watcher/scout',
    { method: 'POST', body: { action: 'run' } }, h.trigger.dataset.workspaceFolder);
  assert.equal(enable.options.body.workspaceFolder, '/ws/esystent');
  assert.equal(run.options.body.workspaceFolder, '/ws/esystent');
  await settle();
  assert.equal(await switched, true);
  assert.equal(h.writes.length, 0, 'opening a chat never writes the global settings workspace');
});

test('direct chat alignment shares the sidebar project and clone lookup', async () => {
  const source = readChatSource();
  const alignment = source.slice(source.indexOf('function alignActiveWorkspaceWithChat('),
    source.indexOf('\n/**\n * The user is looking at this chat'));
  const file = '/projects/esystent.code-workspace';
  const catalog = [{ workspaceFile: file, workspaceDir: '/projects' }];
  let active = { workspaceFile: '/projects/other.code-workspace', workspaceFolder: '/other' };
  const switches = [];
  const context = vm.createContext({
    resolveWorkspaceTargetForChat,
    isEmbedWidgetMode: () => false,
    getWorkspaceContextForChat: () => active,
    chatShell: {
      listWorkspaceContextsForChat: () => catalog,
      getPreferredWorkspaceFolderForChat: (key) => key.includes('#clone') ? '/projects' : '/esystent',
      workspaceRefreshPreserveDepth: 0,
    },
    reportViewContextResourceConflict: () => ({ ok: true }),
    applyVoiceWorkspaceSwitch: (workspaceFile, workspaceFolder) => {
      switches.push({ workspaceFile, workspaceFolder });
      active = { workspaceFile, workspaceFolder };
      return Promise.resolve(true);
    },
  });
  vm.runInContext(alignment, context);
  context.alignActiveWorkspaceWithChat({ workspaceFile: file, workspaceFolder: '/projects' });
  await settle();
  assert.equal(switches[0].workspaceFolder, '/esystent');
  context.alignActiveWorkspaceWithChat({ workspaceFile: file, workspaceFolder: '/projects' });
  assert.equal(switches.length, 1, 'no second switch back to projects after sidebar selection');
  catalog.push({ workspaceFile: file, sidebarKey: `${file}#clone-projects`, isClone: true });
  context.alignActiveWorkspaceWithChat({ workspaceFile: file, workspaceFolder: '/projects' });
  await settle();
  assert.equal(switches[1].workspaceFolder, '/projects', 'explicit clone scope stays exact');
});

test('opening a watcher scopes Todo immediately and keeps its explicit folder despite a stale catalog', async () => {
  const h = harness();
  const switched = h.workspace.switchWorkspace('/ws/acme.code-workspace', '/ws/acme');
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/acme');
  assert.equal(h.events.at(-1).detail.workspaceFolder, '/ws/acme');
  await settle();
  assert.equal(await switched, true);
  assert.equal(h.writes.length, 0, 'a normal view switch never writes the global settings workspace');
});

test('a rapid A→B switch leaves the header on B and never paints A afterwards', async () => {
  const h = harness();
  const first = h.workspace.switchWorkspace('/ws/fresh.code-workspace', '/ws/shop');
  const second = h.workspace.switchWorkspace('/ws/acme.code-workspace', '/ws/acme');
  assert.equal(h.trigger.dataset.workspaceFile, '/ws/acme.code-workspace');
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/acme');
  assert.equal(h.writes.length, 0, 'no settings writes for local switches');
  await settle();
  assert.equal(await second, true);
  assert.equal(await first, false, 'the superseded A keys pass must not rewrite the URL or store');
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/acme', 'the late A answer never repaints the header');
  const lastWorkspaceEvent = [...h.events].reverse().find((event) => event.type === 'cretli-active-workspace-changed');
  assert.equal(lastWorkspaceEvent?.detail?.workspaceFolder, '/ws/acme');
});

test('a late boot settings answer cannot overwrite the workspace selected by the operator', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  const switched = h.workspace.switchWorkspace('/ws/acme.code-workspace', '/ws/acme');
  await settle();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/backend' });
  await boot;
  await switched;
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/acme');
  assert.equal(h.writes.length, 0);
});

test('background settings refresh preserves this client selection instead of the global server folder', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/acme.code-workspace', workspaceFolder: '/ws/acme' });
  await boot;
  h.listeners.get('cretli-workspace-updated')();
  h.reads[1].resolve({ ok: true, workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/shop' });
  await settle();
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/acme');
});

test('the global default workspace is a separate setting: persistGlobal still writes and restores on failure', async () => {
  const h = harness();
  const switched = h.workspace.switchWorkspace('/ws/acme.code-workspace', '/ws/acme', { persistGlobal: true });
  await settle();
  h.writes[0].reject(new Error('Network failure'));
  assert.equal(await switched, false);
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/backend', 'a failed global write restores the previous label');
  const kept = h.workspace.switchWorkspace('/ws/acme.code-workspace', '/ws/acme', { persistGlobal: true });
  await settle();
  h.writes[1].resolve({ ok: true });
  assert.equal(await kept, true);
  assert.equal(h.writes.length, 2, 'only persistGlobal switches reach the settings write queue');
});

test('an explicit folder selected in Files updates the local context before background settings return', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/acme.code-workspace', workspaceFolder: '/ws/acme' });
  await boot;
  h.listeners.get('cretli-workspace-updated')({ detail: { workspaceFolder: '/ws/other-root' } });
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/other-root');
  h.reads[1].resolve({ ok: true, workspaceFile: '/ws/acme.code-workspace', workspaceFolder: '/ws/acme' });
  await settle();
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/other-root');
});
