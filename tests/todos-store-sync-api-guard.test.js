import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Synchronous `todos-persist.js` entry points the async facade replaces. */
const SYNC_API = ['loadTodosData', 'addTodo', 'updateTodo', 'saveTodosData'];
/**
 * Every other `todos-persist.js` export that reads or writes the todo document.
 * Outside the legacy adapters/facade these must come from the async
 * `lib/persist/todos-store.js` (where a store-backed equivalent exists).
 */
const STORAGE_DEPENDENT_API = [
  ...SYNC_API,
  'getTodoById', 'linkTodoChat', 'deleteTodo', 'getTodosFileRevision', 'isTodosDocCurrent',
  'moveTodoDocuments', 'commitWatcherTodoCommand', 'writeTodoReview', 'writeTodoReviewBatch',
  'closeTodoLeafIfEligible',
];
const LEGACY_ADAPTERS = new Set(['lib/persist/todos-store.js', 'lib/persist/todos-legacy-move-adapter.js']);

/** Files already moved to `lib/persist/todos-store.js`; they must never use the sync API again. */
const CONVERTED = Object.freeze([
  'lib/workspace-watcher-scout.js',
  'lib/workspace-watcher-cycle.js',
  'lib/todo-review-sync.js',
  'lib/todo-review-sync-hooks.js',
  'lib/todo-plan-sync.js',
  'lib/todo-leaf-material.js',
  'lib/routes/todos-routes.js',
  'lib/routes/chats-routes.js',
  'lib/routes/chat-agent-routes.js',
  'lib/routes/workspace-watcher-routes.js',
  'lib/mcp/builtin/todo-tools.js',
  'lib/mcp/mcp-external-operator-tools.js',
  'lib/mcp/mcp-inprocess-client.js',
  'lib/model-pick-leaf-implement.js',
  'lib/orchestrator-leaf-resolution.js',
  'lib/review-lessons-checks.js',
  'lib/server-health/server-stall-watchdog.js',
  'lib/usage/todo-usage-read.ts',
  'lib/feedback-triage.js',
  'lib/persist/feedback-store.js',
  'lib/workspace-watcher.js',
  'lib/workspace-watcher-control.js',
  'lib/workspace-watcher-delegation-guard.js',
  'lib/workspace-watcher-history-repair.js',
  'lib/workspace-watcher-review-gate-guard.js',
  'lib/workspace-watcher-cycle-close.js',
  'lib/workspace-watcher-integration.js',
  'lib/delegation-retention.js',
  'lib/delegation-service.js',
  'lib/delegation-settings.js',
  'lib/delegation-slot-stop.js',
  'lib/delegation-takeover.js',
  'lib/workspace-watcher-todo-recover.js',
  'lib/worktree-deps.js',
  'lib/worktree-list.js',
  'lib/remote-api-client.js',
  'lib/integrate-batch.js',
  'lib/todo-review-backfill.js',
  'scripts/architecture-http-fixture.mjs',
  'scripts/architecture-stall-profile.mjs',
  'scripts/audit-automatic-prompts.mjs',
  'scripts/manual-smart-merge-fixture.mjs',
  'scripts/measure-todo-save.js',
  'scripts/scout-pass-fixture.mjs',
  'server.js',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Sync names imported from the persist module or its explicit legacy adapter. */
function syncImports(source, api = SYNC_API) {
  const found = new Set();
  const importRe = /(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*todos-(?:persist|legacy-adapter)(?:\.js)?['"]/g;
  for (const match of source.matchAll(importRe)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (api.includes(name)) found.add(name);
    }
  }
  // Namespace imports and dynamic imports can reach every export.
  if (/import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*todos-(?:persist|legacy-adapter)/.test(source)) found.add('*namespace');
  if (/import\(\s*['"][^'"]*todos-(?:persist|legacy-adapter)/.test(source)) found.add('*dynamic');
  if (/export\s*\*\s*(?:as\s+\w+\s*)?from\s*['"][^'"]*todos-(?:persist|legacy-adapter)/.test(source)) found.add('*reexport');
  return [...found];
}

function scanFiles() {
  const files = ['server.js'];
  for (const dir of ['lib', 'scripts']) files.push(...walk(path.join(ROOT, dir)).map((f) => path.relative(ROOT, f)));
  return files
    .map((f) => f.split(path.sep).join('/'))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)) && rel !== 'lib/persist/todos-persist.js' && rel !== 'lib/persist/todos-legacy-adapter.js');
}

function scan() {
  const files = scanFiles();
  const users = new Map();
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full) || rel === 'lib/persist/todos-persist.js' || rel === 'lib/persist/todos-legacy-adapter.js') continue;
    const names = syncImports(fs.readFileSync(full, 'utf8'));
    if (names.length) users.set(rel.split(path.sep).join('/'), names);
  }
  return users;
}

describe('store.todos sync API guard', () => {
  const users = scan();

  it('converted files do not use the sync todos API', () => {
    for (const file of CONVERTED) {
      assert.deepEqual(users.get(file) || [], [], `${file} must use lib/persist/todos-store.js`);
    }
  });

  it('L3c modules also avoid synchronous detail reads and review commands', () => {
    for (const file of ['lib/todo-leaf-material.js', 'lib/todo-plan-sync.js', 'lib/todo-review-sync.js', 'lib/todo-review-sync-hooks.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.deepEqual(syncImports(source, [...SYNC_API, 'getTodoById', 'writeTodoReview', 'writeTodoReviewBatch', 'closeTodoLeafIfEligible']), [], file);
    }
  });

  it('no non-adapter file imports the synchronous API', () => {
    assert.deepEqual([...users.keys()].filter((file) => !LEGACY_ADAPTERS.has(file)), [], 'use todos-store.js or the explicit legacy adapter');
    assert.deepEqual([...users.keys()].sort(), [...LEGACY_ADAPTERS].sort(), 'the legacy adapter inventory must stay exact');
  });

  it('no file outside the legacy adapters and the facade imports storage-dependent persist functions', () => {
    const offenders = [];
    for (const rel of scanFiles()) {
      if (LEGACY_ADAPTERS.has(rel)) continue;
      const names = syncImports(fs.readFileSync(path.join(ROOT, rel), 'utf8'), STORAGE_DEPENDENT_API);
      if (names.length) offenders.push(`${rel}: ${names.join(', ')}`);
    }
    assert.deepEqual(offenders, [], 'use lib/persist/todos-store.js');
  });

  it('detects storage-dependent names, aliases and re-exports', () => {
    const detect = (src) => syncImports(src, STORAGE_DEPENDENT_API);
    assert.deepEqual(detect("import { getTodoById as g, normalizeStatus } from './persist/todos-persist.js'"), ['getTodoById']);
    assert.deepEqual(detect("import { linkTodoChat } from '../persist/todos-persist'"), ['linkTodoChat']);
    assert.deepEqual(detect("export { deleteTodo } from './persist/todos-legacy-adapter.js'"), ['deleteTodo']);
    assert.deepEqual(detect("import { normalizeStatus, TODO_STATUSES } from './persist/todos-persist.js'"), []);
  });

  it('detects named and star re-exports of the legacy API', () => {
    assert.deepEqual(syncImports("export { loadTodosData as list } from './persist/todos-legacy-adapter.js'"), ['loadTodosData']);
    assert.deepEqual(syncImports("export * from './persist/todos-legacy-adapter.js'"), ['*reexport']);
    assert.deepEqual(syncImports("export * as legacy from './persist/todos-legacy-adapter.js'"), ['*reexport']);
  });

  it('the persist module does not export the four synchronous entry points', async () => {
    const persist = await import('../lib/persist/todos-persist.js');
    for (const name of SYNC_API) assert.equal(Object.hasOwn(persist, name), false, name);
  });
});
