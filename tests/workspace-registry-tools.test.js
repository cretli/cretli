/**
 * Builtin MCP workspace registry tools: wsreg_list / wsreg_add / wsreg_remove.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-wsreg-data-'));
process.env.CRETLI_DATA_DIR = dataDir;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-wsreg-fs-'));

const { loadSettings, saveSettings } = await import('../lib/persist/settings.js');
const { createCretliMcpToolHandlers, listBuiltinMcpReadToolNames, listBuiltinMcpMutatingToolNames } = await import('../lib/mcp/mcp-builtin-tools.js');
const { applyWorkspaceAddPath } = await import('../lib/workspace-list.js');
const { buildWorkspacesListWithRouteKeys } = await import('../lib/workspace-registry-service.js');
const { invalidateWorkspacesCache } = await import('../lib/routes/settings-routes.js');

const agent = createCretliMcpToolHandlers({}, { chatId: 'c1', workspaceFolder: scratch, mode: 'agent' });

/**
 * @param {string} name
 * @returns {string}
 */
function makeDir(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Seed an active workspace so every test can check it is left alone.
 */
function resetSettings() {
  const settings = {};
  applyWorkspaceAddPath(settings, makeDir('active-app'), { preferFolders: true });
  saveSettings(settings);
  return settings;
}

test('wsreg_add registers a folder workspace idempotently without switching the active one', async () => {
  const before = resetSettings();
  const dir = makeDir('my-app');
  const first = await agent.wsreg_add({ path: dir, label: 'My app' });
  assert.equal(first.isError, false, first.content[0].text);
  assert.equal(first.structuredContent.created, true);
  const row = first.structuredContent.workspace;
  assert.match(row.id, /^cretli:ws:/);
  assert.equal(row.kind, 'folders');
  assert.equal(row.label, 'My app');
  assert.deepEqual(row.folders, [dir]);
  assert.ok(row.route_key);
  let settings = loadSettings();
  assert.equal(settings.workspaces.length, 2);
  assert.equal(settings.workspaces.find((entry) => entry.id === row.id).label, 'My app');
  assert.equal(settings.workspaceFile, before.workspaceFile);
  assert.equal(settings.workspaceFolder, before.workspaceFolder);
  // The REST list builder (GET /api/workspaces) shows the same row.
  const restList = buildWorkspacesListWithRouteKeys(settings).list;
  assert.ok(restList.some((item) => item.id === row.id && item.workspaceKey === row.route_key));
  const again = await agent.wsreg_add({ path: `${dir}/` });
  assert.equal(again.isError, false);
  assert.equal(again.structuredContent.created, false);
  assert.equal(again.structuredContent.workspace.id, row.id);
  settings = loadSettings();
  assert.equal(settings.workspaces.length, 2);
  const listed = await agent.wsreg_list({});
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.total, 2);
  const listedRow = listed.structuredContent.items.find((item) => item.id === row.id);
  assert.equal(listedRow.route_key, row.route_key);
  assert.equal(listedRow.active, false);
  assert.equal(listed.structuredContent.items.filter((item) => item.active).length, 1);
});

test('wsreg_add keeps a directory with a .code-workspace a folder workspace by default', async () => {
  resetSettings();
  const dir = makeDir('with-file');
  fs.writeFileSync(path.join(dir, 'with-file.code-workspace'), JSON.stringify({ folders: [{ path: '.' }] }));
  const asFolder = await agent.wsreg_add({ path: dir });
  assert.equal(asFolder.structuredContent.workspace.kind, 'folders');
  const asFile = await agent.wsreg_add({ path: dir, prefer_folder: false });
  assert.equal(asFile.structuredContent.created, true);
  // A file is imported once into a Cretli-owned folder workspace.
  assert.equal(asFile.structuredContent.workspace.kind, 'folders');
  assert.equal(asFile.structuredContent.workspace.imported_from, path.join(dir, 'with-file.code-workspace').replace(/\\/g, '/'));
  const asFileAgain = await agent.wsreg_add({ path: path.join(dir, 'with-file.code-workspace') });
  assert.equal(asFileAgain.structuredContent.created, false);
  assert.equal(loadSettings().workspaces.length, 3);
});

test('wsreg_add rejects relative, ~, missing and non-workspace paths', async () => {
  resetSettings();
  const cases = [
    [{ path: 'relative/dir' }, 'VALIDATION_ERROR'],
    [{ path: '~/my-app' }, 'VALIDATION_ERROR'],
    [{ path: '' }, 'VALIDATION_ERROR'],
    [{ path: path.join(scratch, 'does-not-exist') }, 'NOT_FOUND'],
  ];
  const plainFile = path.join(scratch, 'notes.txt');
  fs.writeFileSync(plainFile, 'x');
  cases.push([{ path: plainFile }, 'VALIDATION_ERROR']);
  for (const [args, code] of cases) {
    const result = await agent.wsreg_add(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.structuredContent.code, code, JSON.stringify(args));
  }
  assert.equal(loadSettings().workspaces.length, 1);
});

test('wsreg_remove needs confirm, guards the active workspace and deletes no files', async () => {
  const before = resetSettings();
  const dir = makeDir('to-remove');
  const added = await agent.wsreg_add({ path: dir });
  const id = added.structuredContent.workspace.id;
  const noConfirm = await agent.wsreg_remove({ id });
  assert.equal(noConfirm.structuredContent.code, 'VALIDATION_ERROR');
  const missing = await agent.wsreg_remove({ id: 'cretli:ws:nope', confirm: true });
  assert.equal(missing.structuredContent.code, 'NOT_FOUND');
  const removed = await agent.wsreg_remove({ id, confirm: true });
  assert.equal(removed.isError, false, removed.content[0].text);
  let settings = loadSettings();
  assert.equal(settings.workspaces.length, 1);
  assert.equal(settings.workspaceSidebarConfig?.[id], undefined);
  assert.ok(!JSON.stringify(settings.workspaceRouteKeys || {}).includes(id));
  assert.equal(settings.workspaceFile, before.workspaceFile);
  assert.ok(fs.existsSync(dir));
  const activeGuard = await agent.wsreg_remove({ id: before.workspaceFile, confirm: true });
  assert.equal(activeGuard.structuredContent.code, 'VALIDATION_ERROR');
  const forced = await agent.wsreg_remove({ id: before.workspaceFile, confirm: true, force_active: true });
  assert.equal(forced.isError, false);
  assert.equal(forced.structuredContent.was_active, true);
  settings = loadSettings();
  assert.equal((settings.workspaces || []).length, 0);
  assert.equal(settings.workspaceFile, undefined);
  assert.ok(fs.existsSync(path.join(scratch, 'active-app')));
});

test('read/write classification and Ask / Scout gating', async () => {
  resetSettings();
  assert.ok(listBuiltinMcpReadToolNames().includes('wsreg_list'));
  assert.ok(listBuiltinMcpMutatingToolNames().includes('wsreg_add'));
  assert.ok(listBuiltinMcpMutatingToolNames().includes('wsreg_remove'));
  const ask = createCretliMcpToolHandlers({}, { chatId: 'c1', workspaceFolder: scratch, mode: 'ask' });
  const scout = createCretliMcpToolHandlers(
    { isWorkspaceScoutChat: () => true },
    { chatId: 'c1', workspaceFolder: scratch, mode: 'agent' },
  );
  for (const handlers of [ask, scout]) {
    const add = await handlers.wsreg_add({ path: makeDir('gated') });
    assert.equal(add.structuredContent.code, 'PLAN_MODE_DENIED');
    const remove = await handlers.wsreg_remove({ id: loadSettings().workspaceFile, confirm: true, force_active: true });
    assert.equal(remove.structuredContent.code, 'PLAN_MODE_DENIED');
    const list = await handlers.wsreg_list({});
    assert.equal(list.isError, false);
  }
  assert.equal(loadSettings().workspaces.length, 1);
  invalidateWorkspacesCache();
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});
