import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../app_front/app/appShell/workspaceHelpers.js';
import { resolveWorkspaceTargetForChat } from '../app_front/features/sidebar/workspaceChatMatch.js';
import { scopeWatcherRequestToWorkspace } from '../app_front/features/watcher/watcherWorkspaceScope.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const trigger = { dataset: { workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/fade' }, addEventListener() {} };
  const label = { textContent: '' };
  const events = [];
  const listeners = new Map();
  const writes = [];
  const reads = [];
  const context = vm.createContext({
    ...helpers,
    document: { getElementById: (id) => ({ 'header-workspace-trigger': trigger, 'header-workspace-label': label, 'header-workspace-popover': {} })[id] || null },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      dispatchEvent: (event) => events.push(event),
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    t: (key) => key,
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
  workspace.seedWorkspacesList([{ workspaceFile: '/ws/domq.code-workspace', workspaceDir: '/ws/projects', folders: [] }]);
  return { workspace, trigger, label, writes, reads, events, listeners };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('opening a legacy esystent chat scopes Scout writes to esystent before the settings write finishes', async () => {
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
  h.writes[0].resolve({ ok: true });
  await switched;
});

test('direct chat alignment shares the sidebar project and clone lookup', async () => {
  const source = fs.readFileSync(new URL('../app_front/chat.js', import.meta.url), 'utf8');
  const alignment = source.slice(source.indexOf('function alignActiveWorkspaceWithChat('),
    source.indexOf('\nfunction performSelectChat('));
  const file = '/projects/esystent.code-workspace';
  const catalog = [{ workspaceFile: file, workspaceDir: '/projects' }];
  let active = { workspaceFile: '/projects/other.code-workspace', workspaceFolder: '/other' };
  const switches = [];
  const context = vm.createContext({
    resolveWorkspaceTargetForChat,
    isEmbedWidgetMode: () => false,
    getWorkspaceContextForChat: () => active,
    listWorkspaceContextsForChat: () => catalog,
    getPreferredWorkspaceFolderForChat: (key) => key.includes('#clone') ? '/projects' : '/esystent',
    workspaceRefreshPreserveDepth: 0,
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
  const switched = h.workspace.switchWorkspace('/ws/domq.code-workspace', '/ws/domq');
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/domq');
  assert.equal(h.events.at(-1).detail.workspaceFolder, '/ws/domq');
  await settle();
  assert.equal(h.writes[0].payload.workspaceFolder, '/ws/domq');
  h.writes[0].resolve({ ok: true });
  assert.equal(await switched, true);
});

test('an older in-flight selection cannot repaint the header or finish selecting its chat', async () => {
  const h = harness();
  const first = h.workspace.switchWorkspace('/ws/fresh.code-workspace', '/ws/shop');
  await settle();
  const second = h.workspace.switchWorkspace('/ws/domq.code-workspace', '/ws/domq');
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/domq');
  assert.equal(h.writes.length, 1, 'settings writes are serialized');
  h.writes[0].resolve({ ok: true });
  assert.equal(await first, false);
  await settle();
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/domq');
  h.writes[1].resolve({ ok: true });
  assert.equal(await second, true);
});

test('late boot settings cannot overwrite the workspace selected by the operator', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  const switched = h.workspace.switchWorkspace('/ws/domq.code-workspace', '/ws/domq');
  await settle();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/fade' });
  await boot;
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/domq');
  h.writes[0].resolve({ ok: true });
  await switched;
});

test('background settings refresh preserves this client selection instead of the global server folder', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/domq.code-workspace', workspaceFolder: '/ws/domq' });
  await boot;
  h.listeners.get('cretli-workspace-updated')();
  h.reads[1].resolve({ ok: true, workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/shop' });
  await settle();
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/domq');
});

test('a failed selection restores the previous workspace and publishes the restored scope', async () => {
  const h = harness();
  const switched = h.workspace.switchWorkspace('/ws/domq.code-workspace', '/ws/domq');
  await settle();
  h.writes[0].reject(new Error('Network failure'));
  assert.equal(await switched, false);
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/fade');
  assert.equal(h.events.at(-1).detail.workspaceFolder, '/ws/fade');
});

test('an explicit folder selected in Files updates the local context before background settings return', async () => {
  const h = harness();
  const boot = h.workspace.initWorkspacePopover();
  h.reads[0].resolve({ ok: true, workspaceFile: '/ws/domq.code-workspace', workspaceFolder: '/ws/domq' });
  await boot;
  h.listeners.get('cretli-workspace-updated')({ detail: { workspaceFolder: '/ws/other-root' } });
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/other-root');
  h.reads[1].resolve({ ok: true, workspaceFile: '/ws/domq.code-workspace', workspaceFolder: '/ws/domq' });
  await settle();
  assert.equal(h.trigger.dataset.workspaceFolder, '/ws/other-root');
});
