/**
 * Durable workspace route ids (RouteState v1 context).
 *
 * Proves the stage 1 acceptance for the id half of the leaf: the URL only ever
 * carries opaque ids, two workspaces with the same folder name get different
 * ids, ids survive a restart, a removed id never resolves to another project,
 * and the shared resolver rejects a folder that does not belong to the workspace.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { registerWorkspaceRoutes } from '../lib/routes/settings-routes.js';
import {
  applyWorkspaceRouteKeys,
  resolveWorkspaceRouteContext,
  workspaceRouteFolderPaths,
} from '../lib/workspace-route-context.js';
import {
  applyWorkspaceConvertToSelf,
  applyWorkspaceExportToFile,
  applyWorkspaceRemoveId,
} from '../lib/workspace-list.js';
import { isFolderWorkspaceId } from '../lib/persist/workspace-registry.js';
import {
  convertWorkspaceRouteKeys,
  createWorkspaceRouteId,
  dropWorkspaceRouteKeys,
  findFolderByRouteKey,
  findWorkspaceByRouteKey,
  folderRouteKey,
  isWorkspaceRouteId,
  sanitizeWorkspaceRouteKeys,
  workspaceRouteKey,
} from '../lib/persist/workspace-route-keys.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});

const FILE_WORKSPACE = '/w/alpha/app.code-workspace';
const FOLDER_WORKSPACE = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const ALPHA_APP = '/w/alpha/app';
const ALPHA_DOCS = '/w/alpha/docs';
const BETA_APP = '/w/beta/app';

/**
 * Two workspaces that both offer a folder named `app`: the name must never be
 * the identity, so their route ids have to differ.
 * @returns {object}
 */
function workspaceSettings() {
  return {
    workspaces: [
      { id: FILE_WORKSPACE, kind: 'file', workspaceFile: FILE_WORKSPACE },
      { id: FOLDER_WORKSPACE, kind: 'folders' },
    ],
    workspaceSidebarConfig: {
      [FILE_WORKSPACE]: {
        folder: ALPHA_APP,
        folders: {
          [ALPHA_APP]: { enabled: true, name: 'app', source: 'cursor' },
          [ALPHA_DOCS]: { enabled: true, name: 'docs', source: 'cretli' },
        },
      },
      [`${FILE_WORKSPACE}#clone-beta`]: {
        workspaceFile: FILE_WORKSPACE,
        folder: BETA_APP,
        folders: {
          [BETA_APP]: { enabled: true, name: 'app', source: 'cretli' },
        },
      },
      [FOLDER_WORKSPACE]: {
        folder: BETA_APP,
        folders: {
          [BETA_APP]: { enabled: true, name: 'app', source: 'cretli' },
        },
      },
    },
  };
}

/**
 * The client list shape buildWorkspacesList() produces, without touching the
 * filesystem.
 *
 * @param {object} settings
 * @returns {Array<object>}
 */
function fakeClientList(settings) {
  return settings.workspaces.map((entry) => {
    const overlay = settings.workspaceSidebarConfig[entry.id]?.folders || {};
    return {
      id: entry.id,
      kind: entry.kind,
      workspaceFile: entry.kind === 'file' ? entry.workspaceFile : entry.id,
      name: entry.id,
      folders: Object.entries(overlay).map(([resolvedPath, meta]) => ({
        name: meta.name,
        path: resolvedPath,
        resolvedPath,
        exists: true,
        source: meta.source,
        enabled: meta.enabled !== false,
      })),
    };
  });
}

/**
 * @param {object} settings
 * @returns {{ rows: Array<object>, changed: boolean }}
 */
function decorate(settings) {
  const result = applyWorkspaceRouteKeys(settings, fakeClientList(settings));
  return { rows: result.workspaces, changed: result.changed };
}

test('a file workspace keeps its legacy id and gains a UUID route key', () => {
  const settings = workspaceSettings();
  const { rows, changed } = decorate(settings);
  const file = rows.find((row) => row.id === FILE_WORKSPACE);
  assert.equal(changed, true);
  assert.equal(isWorkspaceRouteId(file.workspaceKey), true);
  assert.equal(file.id, FILE_WORKSPACE);
  assert.equal(file.workspaceFile, FILE_WORKSPACE);
  assert.equal(settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE], file.workspaceKey);
  // Nothing may look like a path or a slug of one.
  assert.ok(!file.workspaceKey.includes('/'));
});

test('a folders workspace reuses its existing cretli:ws id as the route key', () => {
  const settings = workspaceSettings();
  const { rows } = decorate(settings);
  const folderWorkspace = rows.find((row) => row.id === FOLDER_WORKSPACE);
  assert.equal(folderWorkspace.workspaceKey, FOLDER_WORKSPACE);
  assert.equal(isFolderWorkspaceId(folderWorkspace.workspaceKey), true);
  assert.equal(settings.workspaceRouteKeys.workspaces[FOLDER_WORKSPACE], undefined);
});

test('the same folder name in two workspaces gets two different ids', () => {
  const settings = workspaceSettings();
  const { rows } = decorate(settings);
  const fileApp = rows
    .find((row) => row.id === FILE_WORKSPACE)
    .folders.find((folder) => folder.resolvedPath === ALPHA_APP);
  const selfApp = rows
    .find((row) => row.id === FOLDER_WORKSPACE)
    .folders.find((folder) => folder.resolvedPath === BETA_APP);
  assert.equal(fileApp.name, 'app');
  assert.equal(selfApp.name, 'app');
  assert.ok(fileApp.folderKey && selfApp.folderKey);
  assert.notEqual(fileApp.folderKey, selfApp.folderKey);
  assert.notEqual(fileApp.folderKey, ALPHA_APP);
});

test('a clone row is addressable under its parent workspace', () => {
  const settings = workspaceSettings();
  const paths = workspaceRouteFolderPaths(settings, FILE_WORKSPACE);
  assert.ok(paths.includes(BETA_APP), JSON.stringify(paths));
  const store = sanitizeWorkspaceRouteKeys(settings.workspaceRouteKeys);
  const key = workspaceRouteKey(store, { id: FILE_WORKSPACE, kind: 'file' });
  const folderKey = folderRouteKey(store, key, BETA_APP);
  assert.equal(findFolderByRouteKey(store, key, folderKey, paths), BETA_APP);
});

test('decoration is idempotent, so a restart keeps the same ids', () => {
  const settings = workspaceSettings();
  const first = decorate(settings);
  saveSettings(settings);
  const reloaded = loadSettings();
  assert.ok(reloaded.workspaceRouteKeys, 'route ids must be persisted');
  const second = decorate(reloaded);
  assert.equal(second.changed, false);
  assert.deepEqual(
    second.rows.map((row) => [row.id, row.workspaceKey, row.folders.map((f) => [f.resolvedPath, f.folderKey])]),
    first.rows.map((row) => [row.id, row.workspaceKey, row.folders.map((f) => [f.resolvedPath, f.folderKey])]),
  );
});

test('the workspaces API returns the new keys beside the legacy fields', async () => {
  const settings = workspaceSettings();
  saveSettings(settings);
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(route, fn) {
      handlers.set(`GET ${route}`, fn);
    },
    post(route, fn) {
      handlers.set(`POST ${route}`, fn);
    },
  };
  registerWorkspaceRoutes(app, {
    projectRoot: '/w',
    getCurrentWorkspace: () => null,
    getCurrentWorkspaceFile: () => null,
  });
  /** @type {object|null} */
  let body = null;
  const res = { json: (payload) => { body = payload; } };
  handlers.get('GET /api/workspaces')({ query: {}, headers: {} }, res, () => {});
  assert.ok(body?.ok, JSON.stringify(body));
  const file = body.workspaces.find((row) => row.id === FILE_WORKSPACE);
  assert.equal(isWorkspaceRouteId(file.workspaceKey), true);
  assert.equal(file.fileExists, false, 'legacy field stays as before');
  assert.ok(file.folders.every((folder) => isWorkspaceRouteId(folder.folderKey)));
  const cloneFolder = file.folders.find((folder) => folder.resolvedPath === BETA_APP);
  assert.ok(cloneFolder, JSON.stringify(file.folders.map((f) => f.resolvedPath)));
  assert.ok(isWorkspaceRouteId(cloneFolder.folderKey));
  const self = body.workspaces.find((row) => row.id === FOLDER_WORKSPACE);
  assert.equal(self.workspaceKey, FOLDER_WORKSPACE);
  assert.equal(loadSettings().workspaceRouteKeys.workspaces[FILE_WORKSPACE], file.workspaceKey);
});

test('GET /api/workspace/context resolves route ids and refuses foreign or missing ones', () => {
  const settings = workspaceSettings();
  decorate(settings);
  saveSettings(settings);
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(route, fn) {
      handlers.set(`GET ${route}`, fn);
    },
    post(route, fn) {
      handlers.set(`POST ${route}`, fn);
    },
  };
  let exists = true;
  registerWorkspaceRoutes(app, {
    projectRoot: '/w',
    getCurrentWorkspace: () => null,
    getCurrentWorkspaceFile: () => null,
    folderExistsFn: () => exists,
  });
  const handler = handlers.get('GET /api/workspace/context');
  assert.ok(handler, 'the context route must be registered');
  const call = (query) => {
    /** @type {{ status?: number, body?: object }} */
    const out = {};
    const res = {
      status(code) {
        out.status = code;
        return res;
      },
      json(payload) {
        out.body = payload;
        return res;
      },
    };
    handler({ query, headers: {} }, res, () => {});
    return out;
  };
  const fileKey = settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE];
  const appKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP];

  const ok = call({ ws: fileKey, folder: appKey });
  assert.equal(ok.status, undefined);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.workspace.workspaceFile, FILE_WORKSPACE);
  assert.equal(ok.body.folder.resolvedPath, ALPHA_APP);

  const foreign = call({ ws: fileKey, folder: settings.workspaceRouteKeys.folders[FOLDER_WORKSPACE][BETA_APP] });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, 'folder-not-in-workspace');

  exists = false;
  const unavailable = call({ ws: fileKey, folder: appKey });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error, 'folder-unavailable');
  exists = true;

  const unknown = call({ ws: createWorkspaceRouteId() });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'workspace-unknown');

  // A link without context is not an error: the caller keeps its own default.
  const bare = call({});
  assert.equal(bare.status, undefined);
  assert.equal(bare.body.ok, true);
  assert.equal(bare.body.workspace, null);
});

test('the resolver maps ids back to a workspace and validates folder membership', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const store = settings.workspaceRouteKeys;
  const fileKey = store.workspaces[FILE_WORKSPACE];
  const appKey = store.folders[fileKey][ALPHA_APP];

  const ok = resolveWorkspaceRouteContext(settings, { workspaceKey: fileKey, folderKey: appKey }, {
    existsFn: () => true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.error, '');
  assert.equal(ok.workspace.id, FILE_WORKSPACE);
  assert.equal(ok.folder.resolvedPath, ALPHA_APP);
  assert.equal(ok.folder.name, 'app');

  // A folder id of another workspace never resolves into this one.
  const foreignFolder = store.folders[FOLDER_WORKSPACE][BETA_APP];
  const foreign = resolveWorkspaceRouteContext(settings, { workspaceKey: fileKey, folderKey: foreignFolder }, {
    existsFn: () => true,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'folder-not-in-workspace');

  const unknownFolder = resolveWorkspaceRouteContext(settings, { workspaceKey: fileKey, folderKey: createWorkspaceRouteId() }, {
    existsFn: () => true,
  });
  assert.equal(unknownFolder.error, 'folder-unknown');

  // Registered but currently missing (unmounted, deleted on disk): not a 404 of
  // the identity, but never used as if the folder were there.
  const unavailable = resolveWorkspaceRouteContext(settings, { workspaceKey: fileKey, folderKey: appKey }, {
    existsFn: () => false,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, 'folder-unavailable');
  assert.equal(unavailable.folder.resolvedPath, ALPHA_APP);

  const unknownWorkspace = resolveWorkspaceRouteContext(settings, { workspaceKey: createWorkspaceRouteId() }, {
    existsFn: () => true,
  });
  assert.equal(unknownWorkspace.error, 'workspace-unknown');

  // No ids in the URL is not an error: the caller keeps its own default context.
  for (const workspaceKey of ['', undefined]) {
    const none = resolveWorkspaceRouteContext(settings, { workspaceKey }, { existsFn: () => true });
    assert.equal(none.ok, true, String(workspaceKey));
    assert.equal(none.workspace, null, String(workspaceKey));
  }

  for (const workspaceKey of ['/w/alpha', 'cretli:ws:../../etc', 'not-an-id']) {
    assert.equal(
      resolveWorkspaceRouteContext(settings, { workspaceKey }, { existsFn: () => true }).error,
      'workspace-unknown',
      String(workspaceKey),
    );
  }
});

test('a URL can never register a workspace: resolution is read-only', () => {
  const settings = workspaceSettings();
  const fresh = sanitizeWorkspaceRouteKeys(null);
  const resolved = resolveWorkspaceRouteContext(
    { ...settings, workspaceRouteKeys: fresh },
    { workspaceKey: createWorkspaceRouteId() },
    { existsFn: () => true },
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error, 'workspace-unknown');
  assert.equal(Object.keys(fresh.workspaces).length, 0);
  assert.equal(Object.keys(fresh.folders).length, 0);
});

test('removing a workspace retires its ids and re-adding mints a new key', () => {
  const settings = workspaceSettings();
  const { rows } = decorate(settings);
  const originalKey = rows.find((row) => row.id === FILE_WORKSPACE).workspaceKey;
  const originalFolderKey = settings.workspaceRouteKeys.folders[originalKey][ALPHA_APP];

  applyWorkspaceRemoveId(settings, FILE_WORKSPACE);
  assert.equal(settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE], undefined);
  assert.equal(settings.workspaceRouteKeys.folders[originalKey], undefined);
  const afterRemove = resolveWorkspaceRouteContext(settings, { workspaceKey: originalKey }, {
    existsFn: () => true,
  });
  assert.equal(afterRemove.error, 'workspace-unknown');

  const readded = workspaceSettings();
  readded.workspaceRouteKeys = settings.workspaceRouteKeys;
  const fresh = decorate(readded);
  const newKey = fresh.rows.find((row) => row.id === FILE_WORKSPACE).workspaceKey;
  assert.notEqual(newKey, originalKey, 'a retired id is never handed to another project');
  const folderKeys = readded.workspaceRouteKeys.folders[newKey];
  assert.ok(folderKeys[ALPHA_APP] && folderKeys[ALPHA_DOCS]);
  assert.notEqual(folderKeys[ALPHA_APP], originalFolderKey);
  // The folders workspace was untouched by the removal.
  assert.equal(fresh.rows.find((row) => row.id === FOLDER_WORKSPACE).workspaceKey, FOLDER_WORKSPACE);
});

test('a folder that disappears from the overlay loses its id', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const fileKey = settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE];
  const appKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP];
  assert.ok(settings.workspaceRouteKeys.folders[fileKey][ALPHA_DOCS]);
  delete settings.workspaceSidebarConfig[FILE_WORKSPACE].folders[ALPHA_DOCS];
  decorate(settings);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey][ALPHA_DOCS], undefined);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP], appKey);
});

test('a removed folder loses its id even when entry.folder still selects it', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const fileKey = settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE];
  const appKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP];
  delete settings.workspaceSidebarConfig[FILE_WORKSPACE].folders[ALPHA_APP];
  assert.equal(settings.workspaceSidebarConfig[FILE_WORKSPACE].folder, ALPHA_APP);
  decorate(settings);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP], undefined);
  const stale = resolveWorkspaceRouteContext(settings, { workspaceKey: fileKey, folderKey: appKey }, {
    existsFn: () => true,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'folder-unknown');
});

test('converting a file workspace carries its folder ids to the new key', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const fileKey = settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE];
  const appKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP];
  const docsKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_DOCS];

  const result = applyWorkspaceConvertToSelf(settings, FILE_WORKSPACE, { loadWorkspaceFn: () => null });
  assert.equal(result.ok, true);
  assert.ok(isFolderWorkspaceId(result.id));
  assert.equal(settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE], undefined);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey], undefined);
  assert.equal(settings.workspaceRouteKeys.folders[result.id][ALPHA_APP], appKey);
  assert.equal(settings.workspaceRouteKeys.folders[result.id][ALPHA_DOCS], docsKey);
  const resolved = resolveWorkspaceRouteContext(settings, {
    workspaceKey: result.id,
    folderKey: appKey,
  }, { existsFn: () => true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspace.kind, 'folders');
});

test('exporting a workspace to a file leaves every route id intact', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const before = JSON.stringify(settings.workspaceRouteKeys);
  const target = path.join(ISOLATED_DATA_DIR, 'exported.code-workspace');
  const result = applyWorkspaceExportToFile(settings, FOLDER_WORKSPACE, { targetFile: target });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.stringify(settings.workspaceRouteKeys), before);
  assert.equal(resolveWorkspaceRouteContext(settings, {
    workspaceKey: FOLDER_WORKSPACE,
    folderKey: settings.workspaceRouteKeys.folders[FOLDER_WORKSPACE][BETA_APP],
  }, { existsFn: () => true }).ok, true);
});

test('store primitives: sanitizing drops junk and a retired key is dropped whole', () => {
  const store = sanitizeWorkspaceRouteKeys({
    version: 1,
    workspaces: {
      '/w/a.code-workspace': createWorkspaceRouteId(),
      'cretli:ws:22222222-2222-4222-8222-222222222222': createWorkspaceRouteId(),
      '/w/dup.code-workspace': null,
      '': 'x',
    },
    folders: {
      bad: { '/w/x': 'not-a-uuid' },
    },
  });
  // A folders workspace keys itself, so a stored mapping for one is dropped.
  assert.equal(Object.keys(store.workspaces).length, 1);
  assert.deepEqual(store.folders, {});
  const key = store.workspaces['/w/a.code-workspace'];

  const other = sanitizeWorkspaceRouteKeys({
    workspaces: { '/w/b.code-workspace': key },
    folders: { [key]: { '/w/b': createWorkspaceRouteId() } },
  });
  assert.equal(dropWorkspaceRouteKeys(other, '/w/b.code-workspace'), true);
  assert.equal(other.workspaces['/w/b.code-workspace'], undefined);
  assert.equal(other.folders[key], undefined);
  assert.equal(dropWorkspaceRouteKeys(other, '/w/b.code-workspace'), false);
});

test('renaming a label or a clone row keeps every route id, a folder path change does not', () => {
  const settings = workspaceSettings();
  decorate(settings);
  const fileKey = settings.workspaceRouteKeys.workspaces[FILE_WORKSPACE];
  const cloneAppKey = settings.workspaceRouteKeys.folders[fileKey][BETA_APP];
  const alphaAppKey = settings.workspaceRouteKeys.folders[fileKey][ALPHA_APP];
  const sidebar = settings.workspaceSidebarConfig;

  // The product's two renames: a display label and a clone sidebar row.
  sidebar[FILE_WORKSPACE].label = 'Renamed project';
  const renamedCloneKey = `${FILE_WORKSPACE}#clone-renamed`;
  sidebar[renamedCloneKey] = { ...sidebar[`${FILE_WORKSPACE}#clone-beta`], label: 'Renamed clone' };
  delete sidebar[`${FILE_WORKSPACE}#clone-beta`];
  const after = decorate(settings);
  assert.equal(after.changed, false, 'a rename mints nothing');
  assert.equal(after.rows.find((row) => row.id === FILE_WORKSPACE).workspaceKey, fileKey);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey][BETA_APP], cloneAppKey);
  assert.equal(
    after.rows.find((row) => row.id === FILE_WORKSPACE)
      .folders.find((folder) => folder.resolvedPath === ALPHA_APP).folderKey,
    alphaAppKey,
  );

  // A folder that actually moved on disk is a new path: the overlay entry and the
  // workspace pin both change, so the old id stops resolving and the new path
  // gets a fresh id instead of silently inheriting the old one.
  const movedPath = '/w/alpha/app-v2';
  const cloneEntry = sidebar[renamedCloneKey];
  cloneEntry.folders[movedPath] = { enabled: true, name: 'app', source: 'cretli' };
  delete cloneEntry.folders[BETA_APP];
  cloneEntry.folder = movedPath;
  decorate(settings);
  assert.equal(settings.workspaceRouteKeys.folders[fileKey][BETA_APP], undefined);
  assert.ok(settings.workspaceRouteKeys.folders[fileKey][movedPath]);
  assert.notEqual(settings.workspaceRouteKeys.folders[fileKey][movedPath], cloneAppKey);
});

test('reverse lookup needs a registered workspace, so a stale id never resolves', () => {
  const settings = workspaceSettings();
  const store = sanitizeWorkspaceRouteKeys(null);
  const key = workspaceRouteKey(store, { id: FILE_WORKSPACE, kind: 'file' });
  // The id exists in the route store but the registry row is gone.
  assert.equal(findWorkspaceByRouteKey(store, [], key), null);
  assert.equal(findWorkspaceByRouteKey(store, settings.workspaces, key).id, FILE_WORKSPACE);
  assert.equal(findWorkspaceByRouteKey(store, settings.workspaces, FOLDER_WORKSPACE).kind, 'folders');
  assert.equal(findWorkspaceByRouteKey(store, settings.workspaces, createWorkspaceRouteId()), null);
  assert.equal(findWorkspaceByRouteKey(store, settings.workspaces, '/w/alpha'), null);
  assert.equal(convertWorkspaceRouteKeys(store, FILE_WORKSPACE, 'not-a-folder-id'), false);
});

test('a route key is only minted for a registered workspace when asked', () => {
  const store = sanitizeWorkspaceRouteKeys(null);
  assert.equal(workspaceRouteKey(store, { id: FILE_WORKSPACE, kind: 'file' }, { create: false }), '');
  assert.deepEqual(store, { version: 1, workspaces: {}, folders: {} });
  assert.equal(folderRouteKey(store, 'ws-key', ALPHA_APP, { create: false }), '');
  assert.equal(workspaceRouteKey(store, { id: '', kind: 'file' }), '');
});
