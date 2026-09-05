import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyWorkspaceAddPath, applyWorkspaceRemoveId, buildWorkspacesList, maybeSeedRegistry, seedMissingFileWorkspaceOverlays } from '../lib/workspace-list.js';
import { expandUserPath, inspectWorkspacePath } from '../lib/workspace.js';

test('maybeSeedRegistry leaves a non-empty registry untouched', () => {
  const existing = [{ id: 'cretli:ws:keep', kind: 'folders' }];
  const actual = maybeSeedRegistry(existing, ['/a.code-workspace'], ['/b.code-workspace']);
  assert.equal(actual.seeded, false);
  assert.deepEqual(actual.registry, existing);
});

test('maybeSeedRegistry seeds from extra files then scan when empty', () => {
  const actual = maybeSeedRegistry([], ['/scan/one.code-workspace'], ['/env/app.code-workspace']);
  assert.equal(actual.seeded, true);
  assert.deepEqual(actual.registry.map((item) => item.id), [
    '/env/app.code-workspace',
    '/scan/one.code-workspace',
  ]);
});

test('expandUserPath resolves a leading tilde to the home directory', () => {
  assert.equal(expandUserPath('~'), os.homedir());
  assert.equal(expandUserPath('~/projects/test'), path.join(os.homedir(), 'projects', 'test'));
  assert.equal(expandUserPath('/abs/path'), '/abs/path');
});

test('inspectWorkspacePath recognizes a workspace file and a bare folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-inspect-'));
  const filePath = path.join(dir, 'app.code-workspace');
  await writeFile(filePath, '{"folders":[]}', 'utf8');
  const fileInfo = inspectWorkspacePath(filePath);
  assert.equal(fileInfo.ok, true);
  assert.equal(fileInfo.kind, 'file');
  assert.equal(fileInfo.workspaceFile.endsWith('app.code-workspace'), true);
  const nested = path.join(dir, 'project');
  await mkdir(nested);
  const folderInfo = inspectWorkspacePath(nested);
  assert.equal(folderInfo.ok, true);
  assert.equal(folderInfo.kind, 'folders');
  assert.equal(folderInfo.name, 'project');
});

test('inspectWorkspacePath can prefer a bare folder even when a workspace file exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-prefer-'));
  await writeFile(path.join(dir, 'shop.code-workspace'), '{"folders":[]}', 'utf8');
  const asFile = inspectWorkspacePath(dir);
  assert.equal(asFile.kind, 'file');
  const asFolder = inspectWorkspacePath(dir, { preferFolders: true });
  assert.equal(asFolder.ok, true);
  assert.equal(asFolder.kind, 'folders');
  assert.equal(asFolder.name, path.basename(dir));
});

test('inspectWorkspacePath picks a workspace file inside a directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-dir-'));
  await writeFile(path.join(dir, 'shop.code-workspace'), '{"folders":[]}', 'utf8');
  const actual = inspectWorkspacePath(dir);
  assert.equal(actual.ok, true);
  assert.equal(actual.kind, 'file');
  assert.equal(actual.workspaceFile.endsWith('shop.code-workspace'), true);
});

test('applyWorkspaceAddPath creates a folder-only workspace and activates the first one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-add-'));
  const settings = {};
  const result = applyWorkspaceAddPath(settings, dir);
  assert.equal(result.ok, true);
  assert.equal(settings.workspaces.length, 1);
  assert.equal(settings.workspaces[0].kind, 'folders');
  assert.equal(settings.workspaceFile, settings.workspaces[0].id);
  assert.equal(settings.workspaceFolder, dir.replace(/\\/g, '/').replace(/\/$/, ''));
  assert.ok(settings.workspaceSidebarConfig[settings.workspaces[0].id].folders[settings.workspaceFolder]);
});

test('applyWorkspaceRemoveId drops registry and sidebar entries', () => {
  const settings = {
    workspaces: [
      { id: 'cretli:ws:a', kind: 'folders' },
      { id: '/b.code-workspace', kind: 'file', workspaceFile: '/b.code-workspace' },
    ],
    workspaceSidebarConfig: {
      'cretli:ws:a': { folder: '/a' },
      '/b.code-workspace': { folder: '/b' },
    },
    workspaceFile: 'cretli:ws:a',
  };
  const result = applyWorkspaceRemoveId(settings, 'cretli:ws:a');
  assert.equal(result.ok, true);
  assert.equal(settings.workspaces.length, 1);
  assert.equal(settings.workspaceSidebarConfig['cretli:ws:a'], undefined);
  assert.equal(settings.workspaceFile, '/b.code-workspace');
});

test('buildWorkspacesList maps file and folder entries for the client', () => {
  const actual = buildWorkspacesList({
    registry: [
      { id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace' },
      { id: 'cretli:ws:shop', kind: 'folders' },
    ],
    sidebarConfig: {
      'cretli:ws:shop': {
        label: 'Shop',
        folders: { '/proj/shop': { enabled: true, name: 'Shop', source: 'cretli' } },
      },
    },
    loadWorkspaceFn: () => ({
      workspaceDir: '/w',
      folders: [{ name: 'App', path: '.', resolvedPath: '/w/app' }],
    }),
    existsSet: new Set(['/w', '/w/app', '/proj/shop']),
  });
  assert.equal(actual[0].kind, 'file');
  assert.equal(actual[0].workspaceFile, '/w/app.code-workspace');
  assert.equal(actual[0].folders[0].name, 'App');
  assert.equal(actual[1].kind, 'folders');
  assert.equal(actual[1].workspaceFile, 'cretli:ws:shop');
  assert.equal(actual[1].name, 'Shop');
  assert.equal(actual[1].folders[0].resolvedPath, '/proj/shop');
});

test('buildWorkspacesList keeps overlay enabled false without syncing from file', () => {
  const actual = buildWorkspacesList({
    registry: [
      { id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace' },
    ],
    sidebarConfig: {
      '/w/app.code-workspace': {
        folders: { '/w/app': { enabled: false, name: 'App', source: 'cursor' } },
      },
    },
    loadWorkspaceFn: () => ({
      workspaceDir: '/w',
      folders: [{ name: 'App', path: '.', resolvedPath: '/w/app' }],
    }),
    existsSet: new Set(['/w', '/w/app']),
  });
  assert.equal(actual[0].folders[0].enabled, false);
});

test('buildWorkspacesList uses the first overlay folder as workspaceDir', () => {
  const actual = buildWorkspacesList({
    registry: [{ id: 'cretli:ws:shop', kind: 'folders' }],
    sidebarConfig: {
      'cretli:ws:shop': {
        folders: {
          '/proj/projects': { enabled: true, name: 'projects', source: 'cretli' },
          '/proj/esystent': { enabled: true, name: 'esystent.pl', source: 'cretli' },
        },
      },
    },
    existsSet: new Set(['/proj/projects', '/proj/esystent']),
  });
  assert.equal(actual[0].workspaceDir, '/proj/projects');
  assert.deepEqual(actual[0].folders.map((folder) => folder.resolvedPath), [
    '/proj/projects',
    '/proj/esystent',
  ]);
});

test('applyWorkspaceAddPath copies .code-workspace folders into the overlay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-import-'));
  const appDir = path.join(dir, 'app');
  const libsDir = path.join(dir, 'libs');
  await mkdir(appDir);
  await mkdir(libsDir);
  const filePath = path.join(dir, 'app.code-workspace');
  await writeFile(filePath, JSON.stringify({
    folders: [
      { path: 'app', name: 'App' },
      { path: 'libs', name: 'Libs' },
    ],
  }), 'utf8');
  const settings = {};
  const result = applyWorkspaceAddPath(settings, filePath);
  assert.equal(result.ok, true);
  const posixFile = filePath.replace(/\\/g, '/');
  const overlay = settings.workspaceSidebarConfig[posixFile].folders;
  assert.equal(overlay[appDir.replace(/\\/g, '/')].name, 'App');
  assert.equal(overlay[libsDir.replace(/\\/g, '/')].name, 'Libs');
});

test('seedMissingFileWorkspaceOverlays fills an empty overlay from the file', () => {
  const settings = {
    workspaces: [{ id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace' }],
    workspaceSidebarConfig: {},
  };
  const changed = seedMissingFileWorkspaceOverlays(settings, () => ({
    folders: [{ name: 'App', resolvedPath: '/w/app' }],
  }));
  assert.equal(changed, true);
  assert.equal(settings.workspaceSidebarConfig['/w/app.code-workspace'].folders['/w/app'].name, 'App');
});
