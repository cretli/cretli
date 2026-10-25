/**
 * `store.workspaces`: workspace definitions live in SQL, `.code-workspace` is an
 * import source only (migration, import, read without the file, id aliases, rollback).
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeTempDir } from './helpers/temp-dir.js';
import { loadSettings, saveSettings, resolveWorkspaceAlias, exportConfigWithWorkspaces } from '../lib/persist/settings.js';
import {
  closeAllWorkspacesStores,
  listWorkspaceStoreMeta,
  workspacesDbPath,
} from '../lib/persist/workspaces-store.js';
import { applyMigrations, WORKSPACE_MIGRATIONS } from '../lib/storage/migrations.js';
import {
  applyWorkspaceAddPath,
  applyWorkspaceConvertToSelf,
  applyWorkspaceRefreshFromFile,
} from '../lib/workspace-list.js';
import { buildWorkspacesListWithRouteKeys } from '../lib/workspace-registry-service.js';
import { resolveWorkspaceCwd } from '../lib/workspace-folders.js';
import { findWorkspaceByRef } from '../lib/workspace-ref.js';
import { resolveTodoHomeFromSettings } from '../lib/todo-home.js';

const CONFIG_FILE = path.join(ISOLATED_DATA_DIR, 'config.json');

function reset() {
  closeAllWorkspacesStores();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${workspacesDbPath(ISOLATED_DATA_DIR)}${suffix}`, { force: true });
  fs.rmSync(CONFIG_FILE, { force: true });
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function posix(p) {
  return p.replace(/\\/g, '/');
}

/** A real project layout: two folders plus a .code-workspace file listing them. */
function makeProject(extraFolders = []) {
  const root = makeTempDir('cretli-ws-store-');
  const names = ['app', 'libs', ...extraFolders];
  for (const name of names) fs.mkdirSync(path.join(root, name));
  const file = path.join(root, 'project.code-workspace');
  fs.writeFileSync(file, JSON.stringify({ folders: names.slice(0, 2).map((n) => ({ path: n, name: n.toUpperCase() })) }));
  return { root, file: posix(file), app: posix(path.join(root, 'app')), libs: posix(path.join(root, 'libs')), names };
}

const FOLDER_WS = 'cretli:ws:11111111-1111-4111-8111-111111111111';

test('schema: workspace migrations apply once on a fresh database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const first = applyMigrations(db, { migrations: WORKSPACE_MIGRATIONS });
  assert.deepEqual(first.applied, [1]);
  assert.deepEqual(applyMigrations(db, { migrations: WORKSPACE_MIGRATIONS }).applied, []);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const name of ['workspaces', 'workspace_aliases', 'workspace_folders', 'workspace_overlays', 'workspace_route_keys']) {
    assert.ok(tables.includes(name), name);
  }
  db.close();
});

test('migration from config.json: folders rows copied, file rows snapshotted with importedFrom', () => {
  reset();
  const project = makeProject();
  writeConfig({
    lanHost: 'my-pc',
    workspaceFile: project.file,
    workspaces: [
      { id: FOLDER_WS, kind: 'folders', label: 'Direct' },
      { id: project.file, kind: 'file', workspaceFile: project.file, label: 'Legacy file' },
    ],
    workspaceSidebarConfig: {
      [FOLDER_WS]: { folder: '/w/direct-b', folders: { '/w/direct-a': { enabled: false, name: 'A' }, '/w/direct-b': { enabled: true, name: 'B' } } },
      // Overlay knows only `libs` (disabled); `app` comes from the file.
      [project.file]: { folder: project.libs, folders: { [project.libs]: { enabled: false, name: 'Libraries' } } },
      [`${project.file}#clone-1`]: { workspaceFile: project.file, folders: { [project.app]: { enabled: true } } },
    },
    workspaceRouteKeys: {
      version: 1,
      workspaces: { [project.file]: '22222222-2222-4222-8222-222222222222' },
      folders: { '22222222-2222-4222-8222-222222222222': { [project.app]: '33333333-3333-4333-8333-333333333333' } },
    },
    additionalCursorContextDirs: ['/shared/docs'],
  });

  const settings = loadSettings();
  assert.equal(settings.lanHost, 'my-pc');
  assert.deepEqual(settings.workspaces.map((w) => [w.id, w.kind, w.label]), [
    [FOLDER_WS, 'folders', 'Direct'],
    [project.file, 'file', 'Legacy file'],
  ]);
  assert.equal(settings.workspaces[1].importedFrom, project.file);
  assert.equal(settings.workspaces[0].importedFrom, undefined);
  const direct = settings.workspaceSidebarConfig[FOLDER_WS];
  assert.deepEqual(Object.keys(direct.folders), ['/w/direct-a', '/w/direct-b'], 'folder order is kept');
  assert.equal(direct.folders['/w/direct-a'].enabled, false);
  assert.equal(direct.folder, '/w/direct-b', 'default folder is kept');
  const file = settings.workspaceSidebarConfig[project.file];
  assert.deepEqual(Object.keys(file.folders), [project.libs, project.app], 'overlay first, then file folders');
  assert.equal(file.folders[project.libs].enabled, false);
  assert.equal(file.folders[project.libs].name, 'Libraries');
  assert.equal(file.folders[project.app].enabled, true);
  assert.equal(file.folders[project.app].name, 'APP');
  assert.equal(file.folder, project.libs);
  assert.ok(settings.workspaceSidebarConfig[`${project.file}#clone-1`], 'clone overlay survives');
  assert.equal(settings.workspaceRouteKeys.workspaces[project.file], '22222222-2222-4222-8222-222222222222');
  assert.equal(settings.workspaceRouteKeys.folders['22222222-2222-4222-8222-222222222222'][project.app], '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(settings.additionalCursorContextDirs, ['/shared/docs']);

  // The next save moves the sections out of config.json for good.
  saveSettings(settings);
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const key of ['workspaces', 'workspaceSidebarConfig', 'workspaceRouteKeys', 'additionalCursorContextDirs']) {
    assert.equal(key in onDisk, false, key);
  }
  assert.equal(onDisk.lanHost, 'my-pc');
  assert.equal(onDisk.workspaceFile, project.file, 'the active selection stays a plain setting');
});

test('reads come from SQL: deleting the .code-workspace file changes nothing', () => {
  reset();
  const project = makeProject();
  writeConfig({
    workspaces: [{ id: project.file, kind: 'file', workspaceFile: project.file }],
    workspaceSidebarConfig: { [project.file]: { folder: project.app } },
  });
  const before = buildWorkspacesListWithRouteKeys(loadSettings()).list[0];
  assert.deepEqual(before.folders.map((f) => f.resolvedPath), [project.app, project.libs]);

  fs.rmSync(project.file);
  const after = buildWorkspacesListWithRouteKeys(loadSettings()).list[0];
  assert.deepEqual(after.folders.map((f) => [f.resolvedPath, f.name, f.enabled]), before.folders.map((f) => [f.resolvedPath, f.name, f.enabled]));
  assert.equal(after.importedFrom, project.file);
  const settings = loadSettings();
  assert.equal(resolveWorkspaceCwd({
    workspaceId: project.file,
    registry: settings.workspaces,
    sidebarConfig: settings.workspaceSidebarConfig,
  }), project.app, 'default folder (the todo/chat key) is unchanged');
  assert.equal(resolveTodoHomeFromSettings({ workspaceId: project.file }).homeFolder, project.app);
});

test('migration is one-time: a later config.json edit does not override SQL', () => {
  reset();
  writeConfig({ workspaces: [{ id: FOLDER_WS, kind: 'folders', label: 'First' }] });
  assert.equal(loadSettings().workspaces[0].label, 'First');
  writeConfig({ workspaces: [{ id: FOLDER_WS, kind: 'folders', label: 'Edited in file' }] });
  assert.equal(loadSettings().workspaces[0].label, 'First');
});

test('legacy id alias: path, UUID and pre-convert id keep resolving', () => {
  reset();
  const project = makeProject();
  writeConfig({
    workspaces: [{ id: project.file, kind: 'file', workspaceFile: project.file }],
    workspaceSidebarConfig: { [project.file]: { folder: project.app } },
  });
  const settings = loadSettings();
  const meta = listWorkspaceStoreMeta(ISOLATED_DATA_DIR);
  assert.equal(meta.length, 1);
  assert.match(meta[0].uuid, /^[0-9a-f-]{36}$/);
  assert.equal(resolveWorkspaceAlias(project.file), project.file);
  assert.equal(resolveWorkspaceAlias(meta[0].uuid), project.file, 'UUID resolves to the registry id');
  assert.equal(resolveWorkspaceAlias('/not/registered'), '');
  assert.equal(findWorkspaceByRef(settings.workspaces, meta[0].uuid)?.id, project.file);

  // Convert changes the registry id; the UUID stays and the old path becomes an alias.
  const converted = applyWorkspaceConvertToSelf(settings, project.file);
  assert.equal(converted.ok, true);
  saveSettings(settings);
  const after = listWorkspaceStoreMeta(ISOLATED_DATA_DIR);
  assert.equal(after.length, 1);
  assert.equal(after[0].uuid, meta[0].uuid, 'same workspace identity');
  assert.equal(after[0].id, converted.id);
  assert.equal(resolveWorkspaceAlias(project.file), converted.id, 'old chat.workspaceFile still resolves');
  assert.equal(findWorkspaceByRef(loadSettings().workspaces, project.file)?.id, converted.id);
  assert.equal(loadSettings().workspaces[0].importedFrom, project.file);
});

test('import creates a Cretli workspace once; a repeat needs explicit confirmation', () => {
  reset();
  const project = makeProject();
  const settings = {};
  const first = applyWorkspaceAddPath(settings, project.file, { activate: false });
  assert.equal(first.ok, true);
  assert.equal(first.kind, 'folders');
  saveSettings(settings);

  const fresh = loadSettings();
  assert.equal(fresh.workspaces.length, 1);
  assert.equal(fresh.workspaces[0].importedFrom, project.file);
  assert.deepEqual(Object.keys(fresh.workspaceSidebarConfig[first.id].folders), [project.app, project.libs]);

  const again = applyWorkspaceAddPath(fresh, project.file, { activate: false });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'duplicate_import');
  assert.equal(again.existingId, first.id);
  assert.equal(fresh.workspaces.length, 1, 'no duplicate without confirmation');

  const confirmed = applyWorkspaceAddPath(fresh, project.file, { activate: false, confirmDuplicate: true });
  assert.equal(confirmed.ok, true);
  assert.notEqual(confirmed.id, first.id);
  saveSettings(fresh);
  assert.equal(loadSettings().workspaces.length, 2);
  assert.equal(listWorkspaceStoreMeta(ISOLATED_DATA_DIR).filter((m) => m.importedFrom === project.file).length, 2);
});

test('refresh from file is explicit, additive and never touches existing folder settings', () => {
  reset();
  const project = makeProject(['docs']);
  const settings = {};
  const imported = applyWorkspaceAddPath(settings, project.file, { activate: false });
  settings.workspaceSidebarConfig[imported.id].folders[project.libs].enabled = false;
  settings.workspaceSidebarConfig[imported.id].folders[project.libs].name = 'Mine';
  saveSettings(settings);

  // The file gains a folder after the import; nothing happens until asked.
  fs.writeFileSync(project.file, JSON.stringify({ folders: [{ path: 'app' }, { path: 'libs' }, { path: 'docs' }] }));
  assert.deepEqual(Object.keys(loadSettings().workspaceSidebarConfig[imported.id].folders), [project.app, project.libs]);

  const next = loadSettings();
  const refreshed = applyWorkspaceRefreshFromFile(next, imported.id);
  assert.deepEqual([refreshed.ok, refreshed.added], [true, 1]);
  saveSettings(next);
  const folders = loadSettings().workspaceSidebarConfig[imported.id].folders;
  assert.deepEqual(Object.keys(folders), [project.app, project.libs, posix(path.join(project.root, 'docs'))]);
  assert.equal(folders[project.libs].enabled, false);
  assert.equal(folders[project.libs].name, 'Mine');

  fs.rmSync(project.file);
  assert.equal(applyWorkspaceRefreshFromFile(loadSettings(), imported.id).error, 'file_missing');
  assert.equal(applyWorkspaceRefreshFromFile(loadSettings(), 'cretli:ws:missing').error, 'not_found');
});

test('folder edits (add, remove, reorder, default folder) persist in SQL', () => {
  reset();
  const settings = {
    workspaces: [{ id: FOLDER_WS, kind: 'folders' }],
    workspaceSidebarConfig: { [FOLDER_WS]: { folder: '/w/a', folders: { '/w/a': { enabled: true }, '/w/b': { enabled: true }, '/w/c': { enabled: true } } } },
  };
  saveSettings(settings);
  const edited = loadSettings();
  const entry = edited.workspaceSidebarConfig[FOLDER_WS];
  delete entry.folders['/w/b'];
  entry.folders = { '/w/c': entry.folders['/w/c'], '/w/a': entry.folders['/w/a'], '/w/d': { enabled: false, name: 'D', source: 'cretli' } };
  entry.folder = '/w/c';
  saveSettings(edited);
  const reloaded = loadSettings().workspaceSidebarConfig[FOLDER_WS];
  assert.deepEqual(Object.keys(reloaded.folders), ['/w/c', '/w/a', '/w/d']);
  assert.equal(reloaded.folders['/w/d'].enabled, false);
  assert.equal(reloaded.folder, '/w/c');
});

test('rollback export reproduces the config.json shape', () => {
  reset();
  const project = makeProject();
  writeConfig({
    lanHost: 'my-pc',
    workspaces: [
      { id: FOLDER_WS, kind: 'folders', label: 'Direct' },
      { id: project.file, kind: 'file', workspaceFile: project.file },
    ],
    workspaceSidebarConfig: { [FOLDER_WS]: { folder: '/w/a', folders: { '/w/a': { enabled: true, name: 'A' } } } },
    additionalCursorContextDirs: ['/shared/docs'],
  });
  saveSettings(loadSettings());
  const exported = exportConfigWithWorkspaces();
  assert.equal(exported.lanHost, 'my-pc');
  assert.deepEqual(exported.workspaces, [
    { id: FOLDER_WS, kind: 'folders', label: 'Direct' },
    { id: project.file, kind: 'file', workspaceFile: project.file },
  ]);
  assert.equal(exported.workspaceSidebarConfig[FOLDER_WS].folders['/w/a'].name, 'A');
  assert.deepEqual(exported.workspaceSidebarConfig[project.file].folders && Object.keys(exported.workspaceSidebarConfig[project.file].folders), [project.app, project.libs]);
  assert.deepEqual(exported.additionalCursorContextDirs, ['/shared/docs']);

  // Writing the export over config.json and loading with a fresh store gives the same registry.
  const expectedIds = exported.workspaces.map((w) => w.id);
  reset();
  writeConfig(exported);
  assert.deepEqual(loadSettings().workspaces.map((w) => w.id), expectedIds);
});

test('an untouched install keeps empty settings and creates no registry rows', () => {
  reset();
  assert.deepEqual(loadSettings(), {});
  saveSettings({ lanHost: 'x' });
  assert.deepEqual(loadSettings(), { lanHost: 'x' });
});

function seedMigratedStore() {
  reset();
  writeConfig({
    workspaces: [{ id: FOLDER_WS, kind: 'folders', label: 'Direct' }],
    workspaceSidebarConfig: { [FOLDER_WS]: { folder: '/w/a', folders: { '/w/a': { enabled: true, name: 'A' } } } },
    workspaceRouteKeys: {
      version: 1,
      workspaces: {},
      folders: { [FOLDER_WS]: { '/w/a': '33333333-3333-4333-8333-333333333333' } },
    },
    additionalCursorContextDirs: ['/shared/docs'],
  });
  saveSettings(loadSettings());
}

test('saving settings without workspace keys keeps every stored section', () => {
  seedMigratedStore();
  saveSettings({ lanHost: 'other-pc' });
  const after = loadSettings();
  assert.equal(after.lanHost, 'other-pc');
  assert.equal(after.workspaces[0].id, FOLDER_WS);
  assert.equal(after.workspaceSidebarConfig[FOLDER_WS].folders['/w/a'].name, 'A');
  assert.equal(after.workspaceRouteKeys.folders[FOLDER_WS]['/w/a'], '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(after.additionalCursorContextDirs, ['/shared/docs']);
  assert.equal(listWorkspaceStoreMeta(ISOLATED_DATA_DIR).length, 1);
});

test('an explicit empty value clears only that section', () => {
  seedMigratedStore();
  saveSettings({ additionalCursorContextDirs: [] });
  let after = loadSettings();
  assert.equal(after.additionalCursorContextDirs, undefined);
  assert.equal(after.workspaces.length, 1);
  assert.ok(after.workspaceSidebarConfig[FOLDER_WS]);
  assert.ok(after.workspaceRouteKeys);

  saveSettings({ workspaceSidebarConfig: {} });
  after = loadSettings();
  assert.equal(after.workspaceSidebarConfig, undefined);
  assert.equal(after.workspaces.length, 1);
  assert.ok(after.workspaceRouteKeys);

  saveSettings({ workspaces: [] });
  after = loadSettings();
  assert.equal(after.workspaces, undefined);
});
