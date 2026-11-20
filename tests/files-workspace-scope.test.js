import './helpers/isolated-data-dir.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { registerFilesRoutes } from '../lib/routes/files-routes.js';

function loadModule(file, globals) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ URLSearchParams, ...globals });
  vm.runInContext(source, context);
  return context;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Files listing and preview use the selected folder while legacy requests keep their default', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-files-scope-'));
  const folders = ['default', 'acme'].map((name) => path.join(root, name));
  for (const [index, folder] of folders.entries()) {
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'report.txt'), `report ${index}`);
    writeFileSync(path.join(folder, `${index}.txt`), '');
  }
  const app = express();
  registerFilesRoutes(app, { getCurrentCwd: () => folders[0] });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/files`;
  try {
    for (const [index, folder] of folders.entries()) {
      const query = new URLSearchParams(index ? { workspaceFile: 'cretli:ws:acme', workspaceFolder: folder } : {});
      const listing = await (await fetch(`${base}/entries?${query}`)).json();
      assert.equal(listing.ok, true);
      assert.equal(listing.root, folder);
      assert.ok(listing.entries.some((entry) => entry.name === `${index}.txt`));
      query.set('path', 'report.txt');
      assert.equal((await (await fetch(`${base}/read?${query}`)).json()).content, `report ${index}`);
      query.set('path', '../default/report.txt');
      if (index) assert.equal((await fetch(`${base}/read?${query}`)).status, 400);
    }
    for (const suffix of ['entries', 'read?path=report.txt']) {
      const separator = suffix.includes('?') ? '&' : '?';
      const response = await fetch(`${base}/${suffix}${separator}workspaceFile=cretli:ws:acme`);
      assert.equal((await response.json()).ok, false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    removeIsolatedDataDir();
  }
});

test('Files API sends the tab scope on both reads and blocks unresolved contexts', async () => {
  const urls = [];
  let allowed = true;
  const scope = { workspaceFile: 'cretli:ws:acme', workspaceFolder: '/ws/acme' };
  const h = loadModule('../app_front/core/api/workspace.js', {
    getViewContextRuntimeScope: () => scope,
    isViewContextScopedAccessAllowed: () => allowed,
    apiFetchJson: async (url) => { urls.push(url); return { ok: true }; },
    cretliApiFetch: async (url) => { urls.push(url); return { ok: true }; },
    getCurrentLang: () => 'en', json: (x) => x,
  });
  await h.getFilesEntries('docs', true);
  await h.getFileContent('docs/report.md');
  for (const url of urls) {
    const query = new URL(url, 'http://localhost').searchParams;
    assert.equal(query.get('workspaceFolder'), scope.workspaceFolder);
    assert.equal(query.get('workspaceFile'), scope.workspaceFile);
  }
  allowed = false;
  assert.equal((await h.getFilesEntries()).ok, false);
  assert.equal((await h.getFileContent('report.md')).ok, false);
  assert.equal(urls.length, 2);
});

test('Files folder menu and label follow the tab and selection requests a local workspace switch', async () => {
  let scope = { workspaceFile: 'cretli:ws:acme', workspaceFolder: '/ws/acme' };
  let resolveCatalog;
  const catalog = new Promise((resolve) => { resolveCatalog = resolve; });
  const events = [];
  let options;
  const dom = { rootLabelText: {}, rootLabel: {}, rootDropdown: {} };
  const h = loadModule('../app_front/features/files/components/rootPicker.js', {
    getViewContextRuntimeScope: () => scope,
    isViewContextScopedAccessAllowed: () => true,
    api: {
      getWorkspaces: () => catalog,
      getWorkspace: () => { throw new Error('Global workspace must not be read'); },
      patchSettings: () => { throw new Error('Global settings must not be written'); },
    },
    dom, t: (key) => key,
    html: (parts, ...values) => ({ parts, values }),
    render: (value) => { options = value; },
    window: { dispatchEvent: (event) => events.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  h.refreshRootLabel();
  resolveCatalog({ ok: true, workspaces: [{
    id: scope.workspaceFile, workspaceDir: '/ws/acme',
    folders: [{ name: 'API', resolvedPath: '/ws/acme/api' }, { resolvedPath: '/ws/disabled', enabled: false }],
  }, { id: 'cretli:ws:other', workspaceDir: '/ws/other', folders: [] }] });
  await settle();
  assert.equal(dom.rootLabelText.textContent, '/ws/acme');
  h.toggleRootDropdown();
  await settle();
  assert.equal(options.length, 2);
  h.selectFolder('/ws/acme/api');
  assert.equal(events[0].type, 'cretli-request-workspace');
  assert.equal(events[0].detail.workspaceFile, scope.workspaceFile);
  assert.equal(events[0].detail.workspaceFolder, '/ws/acme/api');
});
