import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../app_front/features/watcher/watcherWorkspaceScope.js';

function makePanel() {
  let folder = '/projects';
  const bar = { hidden: false, innerHTML: '', classList: { toggle() {} }, querySelector: () => null };
  const why = { hidden: false, innerHTML: '' };
  const pending = [];
  const context = vm.createContext({
    probeSync: (_name, fn) => fn(),
    document: { getElementById: (id) => id === 'todo-watcher-bar' ? bar : (id === 'todo-watcher-why' ? why : null), querySelector: () => null },
    window: { dispatchEvent() {} },
    CustomEvent: class {},
    getWatcherWorkspaceFolder: () => folder,
    normalizeWatcherWorkspaceFolder,
    scopeWatcherRequestToWorkspace,
    isWorkspaceWatcherRead: () => true,
    // Blocked groups load after each paint; answer them at once so `pending` holds only watcher reads.
    getWorkspaceWatcherView: (url) => url.startsWith('/api/workspace-watcher/blocked')
      ? Promise.resolve({ json: { ok: true, groups: [] } })
      : new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    renderWatcherBarHtml: (view) => view.watcher.orchestratorChatId,
    escapeWatcherHtml: (value) => value,
    renderTodoBlockedHtml: () => '',
    paintWatcherAutomation: () => {},
    t: (key) => key,
  });
  const source = fs.readFileSync(new URL('../app_front/features/watcher/watcherPanel.js', import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(source, context);
  return {
    bar, why, pending,
    switchTo: (next) => { folder = next; },
    refresh: () => vm.runInContext('refreshWatcherPanel()', context),
    view: () => vm.runInContext('getWatcherView()', context),
  };
}

function response(cwd, chatId) {
  return { json: { ok: true, cwd, watcher: { mode: 'autopilot', orchestratorChatId: chatId } } };
}

test('switching from projects to Backend clears the old controls and ignores a delayed response', async () => {
  const panel = makePanel();
  const first = panel.refresh();
  panel.pending[0].resolve(response('/projects', 'acme-chat'));
  await first;
  assert.equal(panel.bar.innerHTML, 'acme-chat');
  const old = panel.refresh();
  panel.switchTo('/backend');
  assert.equal(panel.view(), null);
  const next = panel.refresh();
  assert.equal(panel.bar.innerHTML, '');
  assert.equal(panel.bar.hidden, true);
  assert.equal(panel.why.hidden, true);
  assert.match(panel.pending[2].url, /workspaceFolder=%2Fbackend/);
  panel.pending[2].resolve(response('/backend', 'backend-chat'));
  await next;
  panel.pending[1].resolve(response('/projects', 'acme-chat'));
  await old;
  assert.equal(panel.bar.innerHTML, 'backend-chat');
  assert.equal(panel.view().cwd, '/backend');
});

test('a delayed failure from the previous workspace cannot replace Backend with an error', async () => {
  const panel = makePanel();
  const old = panel.refresh();
  panel.switchTo('/backend');
  const next = panel.refresh();
  panel.pending[1].resolve(response('/backend', 'backend-chat'));
  await next;
  panel.pending[0].reject(new Error('Old request failed'));
  await old;
  assert.equal(panel.bar.innerHTML, 'backend-chat');
});

test('a response for another workspace is never painted', async () => {
  const panel = makePanel();
  panel.switchTo('/backend');
  const next = panel.refresh();
  panel.pending[0].resolve(response('/projects', 'acme-chat'));
  await next;
  assert.equal(panel.bar.innerHTML, '');
  assert.equal(panel.view(), null);
});
