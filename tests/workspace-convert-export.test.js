import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertFileToFolderWorkspace, isFolderWorkspaceId } from '../lib/persist/workspace-registry.js';
import {
  applyWorkspaceConvertToSelf,
  applyWorkspaceExportToFile,
} from '../lib/workspace-list.js';
import { toPosixPath } from '../lib/persist/workspace-registry.js';
import { loadWorkspace } from '../lib/workspace.js';

test('convertFileToFolderWorkspace swaps a file row for a folder workspace, keeping the label', () => {
  const list = [
    { id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace', label: 'App' },
    { id: 'cretli:ws:other', kind: 'folders' },
  ];
  const { registry, id, found } = convertFileToFolderWorkspace(list, '/w/app.code-workspace');
  assert.equal(found, true);
  assert.ok(isFolderWorkspaceId(id));
  assert.equal(registry.length, 2);
  assert.ok(!registry.some((entry) => entry.id === '/w/app.code-workspace'));
  const converted = registry.find((entry) => entry.id === id);
  assert.equal(converted.kind, 'folders');
  assert.equal(converted.label, 'App');
});

test('convertFileToFolderWorkspace is a no-op for unknown or folder ids', () => {
  const list = [{ id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace' }];
  const unknown = convertFileToFolderWorkspace(list, '/nope.code-workspace');
  assert.equal(unknown.found, false);
  assert.equal(unknown.registry.length, 1);
  const folderWs = convertFileToFolderWorkspace(list, 'cretli:ws:nope');
  assert.equal(folderWs.found, false);
});

test('applyWorkspaceConvertToSelf detaches folders, keeps them and migrates the active selection', () => {
  const settings = {
    workspaces: [
      { id: '/w/app.code-workspace', kind: 'file', workspaceFile: '/w/app.code-workspace' },
    ],
    workspaceSidebarConfig: {
      '/w/app.code-workspace': {
        label: 'App',
        folder: '/w/app',
        folders: {
          '/w/app': { enabled: true, name: 'App', source: 'cursor' },
          '/w/docs': { enabled: false, name: 'Docs', source: 'cursor' },
          '/w/extra': { enabled: true, name: 'Extra', source: 'cretli' },
        },
      },
      '/w/app.code-workspace#clone-a': { workspaceFile: '/w/app.code-workspace', folder: '/w/docs' },
    },
    workspaceFile: '/w/app.code-workspace',
    workspaceFolder: '/w/app',
  };
  const result = applyWorkspaceConvertToSelf(settings, '/w/app.code-workspace', {
    loadWorkspaceFn: () => ({ folders: [] }),
  });
  assert.equal(result.ok, true);
  assert.ok(isFolderWorkspaceId(result.id));
  // registry: only the new self workspace remains
  assert.equal(settings.workspaces.length, 1);
  assert.equal(settings.workspaces[0].id, result.id);
  // active selection follows the conversion
  assert.equal(settings.workspaceFile, result.id);
  assert.equal(settings.workspaceFolder, '/w/app');
  // sidebar: old key and its clone are gone, folders are cretli-owned now
  const sidebar = settings.workspaceSidebarConfig;
  assert.equal(sidebar['/w/app.code-workspace'], undefined);
  assert.equal(sidebar['/w/app.code-workspace#clone-a'], undefined);
  const converted = sidebar[result.id];
  assert.equal(converted.label, 'App');
  assert.equal(converted.folders['/w/app'].source, 'cretli');
  assert.equal(converted.folders['/w/app'].enabled, true);
  assert.equal(converted.folders['/w/docs'].source, 'cretli');
  assert.equal(converted.folders['/w/docs'].enabled, false);
  assert.equal(converted.folders['/w/extra'].source, 'cretli');
});

test('applyWorkspaceConvertToSelf pulls file folders when the overlay has none', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-convert-'));
  const file = path.join(dir, 'app.code-workspace');
  await writeFile(file, '{"folders":[{"path":"app"},{"path":"docs"}]}', 'utf8');
  const settings = {
    workspaces: [{ id: file, kind: 'file', workspaceFile: file }],
    workspaceSidebarConfig: {},
    workspaceFile: file,
  };
  const result = applyWorkspaceConvertToSelf(settings, file, { loadWorkspaceFn: loadWorkspace });
  assert.equal(result.ok, true);
  const folders = settings.workspaceSidebarConfig[result.id].folders;
  assert.ok(folders[path.join(dir, 'app')]);
  assert.equal(folders[path.join(dir, 'app')].source, 'cretli');
  assert.ok(folders[path.join(dir, 'docs')]);
});

test('applyWorkspaceExportToFile writes a new .code-workspace with enabled folders only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-export-'));
  const folderA = path.join(dir, 'a');
  const folderB = path.join(dir, 'b');
  const target = path.join(dir, 'exported.code-workspace');
  const settings = {
    workspaces: [{ id: 'cretli:ws:shop', kind: 'folders' }],
    workspaceSidebarConfig: {
      'cretli:ws:shop': {
        folders: {
          [folderA]: { enabled: true, name: 'A', source: 'cretli' },
          [folderB]: { enabled: false, name: 'B', source: 'cretli' },
        },
      },
    },
  };
  const result = applyWorkspaceExportToFile(settings, 'cretli:ws:shop', { targetFile: target });
  assert.equal(result.ok, true);
  assert.equal(result.file, toPosixPath(target));
  const raw = await readFile(target, 'utf8');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.folders.map((folder) => folder.path), ['a']);
});

test('applyWorkspaceExportToFile writes into its own file for a file workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-export-file-'));
  const file = path.join(dir, 'app.code-workspace');
  const folder = path.join(dir, 'app');
  await writeFile(file, '{"folders":[{"path":"old"}]}', 'utf8');
  const settings = {
    workspaces: [{ id: file, kind: 'file', workspaceFile: file }],
    workspaceSidebarConfig: {
      [file]: { folders: { [folder]: { enabled: true, name: 'App', source: 'cretli' } } },
    },
  };
  const result = applyWorkspaceExportToFile(settings, file, {});
  assert.equal(result.ok, true);
  const raw = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw).folders, [{ path: 'app', name: 'App' }]);
});

test('applyWorkspaceExportToFile rejects folder workspaces without a target', () => {
  const settings = {
    workspaces: [{ id: 'cretli:ws:shop', kind: 'folders' }],
    workspaceSidebarConfig: {},
  };
  const result = applyWorkspaceExportToFile(settings, 'cretli:ws:shop', {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_target');
});
