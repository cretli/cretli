import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mergeWorkspaceSidebarConfig,
  sanitizeWorkspaceSidebarConfig,
} from '../lib/persist/settings-sidebar.js';
import {
  foldersForWriteback,
  mergeFoldersForClient,
  moveFolderOverlayEntry,
  resolveWorkspaceCwd,
  syncFoldersFromFile,
  writeWorkspaceFoldersJsonc,
} from '../lib/workspace-folders.js';

test('sanitizeWorkspaceSidebarConfig keeps folder overlay entries', () => {
  const actual = sanitizeWorkspaceSidebarConfig({
    '/w/app.code-workspace': {
      folders: {
        '/w/app': { enabled: true, name: 'App', source: 'cursor' },
        '/w/extra': { enabled: false, name: 'Extra', source: 'cretli' },
      },
    },
  });
  assert.deepEqual(actual['/w/app.code-workspace'].folders['/w/app'], {
    enabled: true,
    name: 'App',
    source: 'cursor',
  });
  assert.equal(actual['/w/app.code-workspace'].folders['/w/extra'].enabled, false);
});

test('mergeWorkspaceSidebarConfig keeps disabled folder overlay', () => {
  const existing = {
    '/w/app.code-workspace': {
      folders: { '/w/app': { enabled: true, source: 'cursor' } },
    },
  };
  const incoming = {
    '/w/app.code-workspace': {
      folders: { '/w/app': { enabled: false, name: 'App', source: 'cursor' } },
    },
  };
  const actual = mergeWorkspaceSidebarConfig(existing, incoming);
  assert.equal(actual['/w/app.code-workspace'].folders['/w/app'].enabled, false);
});

test('mergeWorkspaceSidebarConfig replaces folders when incoming sends them', () => {
  const existing = {
    '/w/app.code-workspace': {
      folder: '/w/app',
      folders: { '/w/old': { enabled: true, source: 'cursor' } },
    },
  };
  const incoming = {
    '/w/app.code-workspace': {
      folder: '/w/app',
      folders: { '/w/new': { enabled: true, source: 'cretli' } },
    },
  };
  const actual = mergeWorkspaceSidebarConfig(existing, incoming);
  assert.equal(actual['/w/app.code-workspace'].folders['/w/old'], undefined);
  assert.ok(actual['/w/app.code-workspace'].folders['/w/new']);
});

test('syncFoldersFromFile adds new file folders and keeps disabled state', () => {
  const fileFolders = [
    { name: 'App', path: '.', resolvedPath: '/w/app' },
    { name: 'Libs', path: '../libs', resolvedPath: '/w/libs' },
  ];
  const overlay = {
    '/w/app': { enabled: false, name: 'App', source: 'cursor' },
    '/w/gone': { enabled: true, name: 'Gone', source: 'cursor' },
    '/w/extra': { enabled: true, name: 'Extra', source: 'cretli' },
  };
  const actual = syncFoldersFromFile(fileFolders, overlay);
  assert.equal(actual['/w/app'].enabled, false);
  assert.equal(actual['/w/libs'].enabled, true);
  assert.equal(actual['/w/libs'].source, 'cursor');
  assert.equal(actual['/w/gone'], undefined);
  assert.equal(actual['/w/extra'].source, 'cretli');
});

test('mergeFoldersForClient includes exists and source for overlay extras', () => {
  const actual = mergeFoldersForClient({
    fileFolders: [{ name: 'App', path: '.', resolvedPath: '/w/app' }],
    overlayFolders: {
      '/w/app': { enabled: true, name: 'App', source: 'cursor' },
      '/missing/extra': { enabled: true, name: 'Extra', source: 'cretli' },
    },
    existsSet: new Set(['/w/app']),
  });
  assert.equal(actual.length, 2);
  assert.equal(actual[0].exists, true);
  assert.equal(actual[1].exists, false);
  assert.equal(actual[1].source, 'cretli');
});

test('mergeFoldersForClient keeps overlay key order as the folder order', () => {
  const actual = mergeFoldersForClient({
    fileFolders: [{ name: 'App', path: '.', resolvedPath: '/w/app' }],
    overlayFolders: {
      '/proj/projects': { enabled: true, name: 'projects', source: 'cretli' },
      '/w/app': { enabled: true, name: 'App', source: 'cursor' },
    },
    existsSet: new Set(['/proj/projects', '/w/app']),
  });
  assert.deepEqual(actual.map((folder) => folder.resolvedPath), [
    '/proj/projects',
    '/w/app',
  ]);
});

test('moveFolderOverlayEntry swaps a folder up and is a no-op at the edges', () => {
  const inputOverlay = {
    '/a': { enabled: true, name: 'A' },
    '/b': { enabled: true, name: 'B' },
    '/c': { enabled: true, name: 'C' },
  };
  const actualUp = moveFolderOverlayEntry(inputOverlay, '/b', 'up');
  assert.deepEqual(Object.keys(actualUp), ['/b', '/a', '/c']);
  const actualDown = moveFolderOverlayEntry(inputOverlay, '/c', 'down');
  assert.deepEqual(Object.keys(actualDown), ['/a', '/b', '/c']);
  const actualFirst = moveFolderOverlayEntry(inputOverlay, '/a', 'up');
  assert.deepEqual(Object.keys(actualFirst), ['/a', '/b', '/c']);
});

test('foldersForWriteback skips disabled folders', () => {
  const actual = foldersForWriteback({
    '/w/app': { enabled: true, name: 'App', source: 'cursor' },
    '/w/off': { enabled: false, name: 'Off', source: 'cursor' },
    '/w/extra': { enabled: true, name: 'Extra', source: 'cretli' },
  }, '/w');
  assert.deepEqual(actual, [
    { name: 'App', path: 'app' },
    { name: 'Extra', path: 'extra' },
  ]);
});

test('writeWorkspaceFoldersJsonc updates folders and keeps JSONC comments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-jsonc-'));
  const filePath = path.join(dir, 'app.code-workspace');
  await writeFile(
    filePath,
    `{
	"folders": [
		{ "name": "Old", "path": "." }
	],
	"settings": {
		// keep this comment
		"php.version": "8.2"
	}
}
`,
    'utf8'
  );
  writeWorkspaceFoldersJsonc(filePath, [
    { name: 'App', path: '.' },
    { name: 'Libs', path: '../libs' },
  ]);
  const raw = await readFile(filePath, 'utf8');
  assert.match(raw, /keep this comment/);
  assert.match(raw, /"name": "Libs"/);
  assert.doesNotMatch(raw, /"name": "Old"/);
});

test('resolveWorkspaceCwd uses the first enabled folder for a virtual workspace', () => {
  const cwd = resolveWorkspaceCwd({
    workspaceId: 'cretli:ws:shop',
    workspaceFolder: '',
    registry: [{ id: 'cretli:ws:shop', kind: 'folders' }],
    sidebarConfig: {
      'cretli:ws:shop': {
        folders: {
          '/proj/a': { enabled: false, name: 'A', source: 'cretli' },
          '/proj/b': { enabled: true, name: 'B', source: 'cretli' },
        },
      },
    },
    existsSet: new Set(['/proj/a', '/proj/b']),
  });
  assert.equal(cwd, '/proj/b');
});

test('resolveWorkspaceCwd prefers an explicit workspaceFolder that exists', () => {
  const cwd = resolveWorkspaceCwd({
    workspaceId: 'cretli:ws:shop',
    workspaceFolder: '/proj/a',
    registry: [{ id: 'cretli:ws:shop', kind: 'folders' }],
    sidebarConfig: {
      'cretli:ws:shop': {
        folders: {
          '/proj/a': { enabled: true, name: 'A', source: 'cretli' },
          '/proj/b': { enabled: true, name: 'B', source: 'cretli' },
        },
      },
    },
    existsSet: new Set(['/proj/a', '/proj/b']),
  });
  assert.equal(cwd, '/proj/a');
});
