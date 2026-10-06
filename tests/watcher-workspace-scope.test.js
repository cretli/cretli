/**
 * Workspace scoping contract for the Workspace Watcher surfaces.
 *
 * The watcher is keyed by workspace folder, but without an explicit folder the
 * REST API answers for the server's global "current cwd". A chat can carry a
 * different workspace than that global selection, so the settings form used to
 * show (and Save) another workspace's policy. These tests pin the pure request
 * scoper and the panel wiring that attaches the active folder and rebuilds the
 * form when the active workspace changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getWatcherWorkspaceFolder,
  normalizeWatcherWorkspaceFolder,
  scopeWatcherRequestToWorkspace,
  watcherWorkspaceScopeChanged,
} from '../app_front/features/watcher/watcherWorkspaceScope.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsSource = fs.readFileSync(
  path.join(root, 'app_front/features/settings/workspaceWatcherSettings.js'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.join(root, 'app_front/features/watcher/watcherPanel.js'),
  'utf8',
);

test('a read gets the workspace folder as a query param', () => {
  const scoped = scopeWatcherRequestToWorkspace('/api/workspace-watcher', {}, '/home/ar2oor/www/fade');
  assert.equal(scoped.path, '/api/workspace-watcher?workspaceFolder=%2Fhome%2Far2oor%2Fwww%2Ffade');
  assert.deepEqual(scoped.options, {});
});

test('an existing query string is extended, not replaced', () => {
  const scoped = scopeWatcherRequestToWorkspace('/api/workspace-watcher?limit=5', {}, '/w');
  assert.equal(scoped.path, '/api/workspace-watcher?limit=5&workspaceFolder=%2Fw');
});

test('a mutation carries the workspace folder in the JSON body', () => {
  const scoped = scopeWatcherRequestToWorkspace(
    '/api/workspace-watcher',
    { method: 'PATCH', body: { mode: 'autopilot' } },
    '/w',
  );
  assert.equal(scoped.path, '/api/workspace-watcher');
  assert.deepEqual(scoped.options.body, { mode: 'autopilot', workspaceFolder: '/w' });

  const targeted = scopeWatcherRequestToWorkspace(
    '/api/workspace-watcher/tick',
    { method: 'POST', body: {} },
    '/w',
  );
  assert.deepEqual(targeted.options.body, { workspaceFolder: '/w' });
});

test('an explicit workspace folder is never overwritten or duplicated', () => {
  const fromBody = scopeWatcherRequestToWorkspace(
    '/api/workspace-watcher',
    { method: 'PATCH', body: { workspaceFolder: '/explicit', mode: 'off' } },
    '/other',
  );
  assert.deepEqual(fromBody.options.body, { workspaceFolder: '/explicit', mode: 'off' });

  const fromQuery = scopeWatcherRequestToWorkspace(
    '/api/workspace-watcher?workspaceFolder=%2Fexplicit',
    {},
    '/other',
  );
  assert.equal(fromQuery.path, '/api/workspace-watcher?workspaceFolder=%2Fexplicit');
});

test('a clone folder is scoped independently of its parent workspace', () => {
  // A clone shares `workspaceFile` with its parent but has its own folder, and
  // the watcher is keyed by folder. Switching to the clone must therefore scope
  // to the clone folder, never the parent's default folder and never the
  // `.code-workspace` root. This is the case that used to leak the parent row.
  const parentDefault = '/home/ar2oor/www/fade.freshthing.pl';
  const cloneFolder = '/home/ar2oor/www/freshthing.pl';

  const read = scopeWatcherRequestToWorkspace('/api/workspace-watcher', {}, cloneFolder);
  assert.equal(read.path, `/api/workspace-watcher?workspaceFolder=${encodeURIComponent(cloneFolder)}`);
  assert.notEqual(read.path, `/api/workspace-watcher?workspaceFolder=${encodeURIComponent(parentDefault)}`);

  const write = scopeWatcherRequestToWorkspace(
    '/api/workspace-watcher',
    { method: 'PATCH', body: { mode: 'off' } },
    cloneFolder,
  );
  assert.equal(write.options.body.workspaceFolder, cloneFolder);
  assert.notEqual(write.options.body.workspaceFolder, parentDefault);

  // Parent default and clone are a real switch, so the mounted form rebuilds.
  assert.notEqual(
    normalizeWatcherWorkspaceFolder(cloneFolder),
    normalizeWatcherWorkspaceFolder(parentDefault),
  );
});

test('a missing active folder leaves the request untouched for the server default', () => {
  const scoped = scopeWatcherRequestToWorkspace('/api/workspace-watcher', {}, '');
  assert.equal(scoped.path, '/api/workspace-watcher');
  assert.deepEqual(scoped.options, {});
});

test('getWatcherWorkspaceFolder degrades to empty without a DOM', () => {
  assert.equal(getWatcherWorkspaceFolder(), '');
});

test('folder normalization collapses trailing separators and backslashes', () => {
  assert.equal(normalizeWatcherWorkspaceFolder('/home/w/'), '/home/w');
  assert.equal(normalizeWatcherWorkspaceFolder('/home/w///'), '/home/w');
  assert.equal(normalizeWatcherWorkspaceFolder('C:\\home\\w'), 'C:/home/w');
  assert.equal(normalizeWatcherWorkspaceFolder('/'), '/');
  assert.equal(normalizeWatcherWorkspaceFolder('  '), '');
});

test('an unknown active folder is not treated as a workspace switch', () => {
  // Without a DOM the active folder is empty, so nothing is stale — rebuilding
  // on every tab activation would be churn, not a fix.
  assert.equal(watcherWorkspaceScopeChanged('/home/ar2oor/www/cretli'), false);
  assert.equal(watcherWorkspaceScopeChanged(''), false);
});

test('the settings panel scopes every watcher request to the active workspace', () => {
  assert.match(settingsSource, /scopeWatcherRequestToWorkspace\(/);
  assert.match(settingsSource, /getWatcherWorkspaceFolder\(\)/);
  assert.match(
    settingsSource,
    /scopeWatcherRequestToWorkspace\(path, options, getWatcherWorkspaceFolder\(\)\)/,
    'the settings API wrapper attaches the active folder',
  );
});

test('the settings form rebuilds when the active workspace changes', () => {
  // A live change forces the full path when the form was rendered for another
  // workspace, so the previous workspace's policy is never left editable.
  assert.match(
    settingsSource,
    /let renderedWorkspaceFolder = '';/,
    'the panel remembers which workspace it rendered',
  );
  assert.match(
    settingsSource,
    /root\.dataset\.rendered !== 'true'\s*\|\| watcherWorkspaceScopeChanged\(renderedWorkspaceFolder\)/,
    'a mismatched active folder forces the full render path',
  );
  assert.match(
    settingsSource,
    /renderedWorkspaceFolder = String\(res\.json\.workspaceFolder \|\| res\.json\.cwd \|\| ''\)\.trim\(\)/,
    'a successful full render records the server-confirmed folder',
  );
  assert.match(
    settingsSource,
    /addEventListener\('cretli-active-workspace-changed', refreshOnActiveWorkspaceChange\)/,
    'an open panel follows the active workspace',
  );
  assert.match(
    settingsSource,
    /addEventListener\('cretli-workspace-updated', refreshOnActiveWorkspaceChange\)/,
    'a workspace configuration change also re-checks the scope',
  );
  assert.match(
    settingsSource,
    /if \(watcherWorkspaceScopeChanged\(renderedWorkspaceFolder\)\) \{\s*void refreshWorkspaceWatcherSettingsPanel\(\);/,
    're-opening the pane after a hidden switch refetches',
  );
});

test('the todo watcher bar is workspace-scoped too', () => {
  assert.match(panelSource, /scopeWatcherRequestToWorkspace\(/);
  assert.match(
    panelSource,
    /scopeWatcherRequestToWorkspace\(path, options, getWatcherWorkspaceFolder\(\)\)/,
    'the top-bar API wrapper attaches the active folder',
  );
  assert.match(
    panelSource,
    /addEventListener\('cretli-active-workspace-changed', \(\) => \{\s*void refreshWatcherPanel\(\);/,
    'the bar drops the previous workspace on a switch',
  );
});
