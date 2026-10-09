/**
 * Git context UI contract.
 *
 * Pure helpers are exercised directly; wiring (index.html hosts, panel scope
 * forwarding, stale-response guard, TODO chip) is asserted from source so a
 * refactor that drops the context indicator fails loudly without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGitScopeKey,
  getGitScope,
  getGitScopeRevision,
  isCurrentGitRevision,
  isGitScopeLocked,
  normalizeGitScope,
  resetGitScopeForTests,
  setGitScope,
  subscribeGitScope,
} from '../app_front/features/git/gitScope.js';
import {
  buildGitDetailRows,
  deriveGitContextBadge,
  deriveGitContextKind,
  isStaleGitResponse,
  resolveChatGitScope,
  resolveTodoGitScope,
  shouldShowGitContextBadge,
  shortGitId,
} from '../app_front/features/git/gitContextView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fakeT = (key, vars) => {
  let out = key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
};

test('normalizeGitScope trims and fills missing fields', () => {
  assert.deepEqual(normalizeGitScope(null), { chatId: '', todoId: '', workspaceFolder: '' });
  assert.deepEqual(
    normalizeGitScope({ chatId: ' c1 ', todoId: ' t1 ', workspaceFolder: ' /p ' }),
    { chatId: 'c1', todoId: 't1', workspaceFolder: '/p' },
  );
});

test('buildGitScopeKey distinguishes every scope dimension', () => {
  const base = buildGitScopeKey({ chatId: 'c', todoId: 't', workspaceFolder: '/p' });
  assert.equal(base, buildGitScopeKey({ chatId: 'c', todoId: 't', workspaceFolder: '/p' }));
  assert.notEqual(base, buildGitScopeKey({ chatId: 'c2', todoId: 't', workspaceFolder: '/p' }));
  assert.notEqual(base, buildGitScopeKey({ chatId: 'c', todoId: 't2', workspaceFolder: '/p' }));
  assert.notEqual(base, buildGitScopeKey({ chatId: 'c', todoId: 't', workspaceFolder: '/p2' }));
});

test('setGitScope bumps the revision only when the scope changes and notifies once', () => {
  resetGitScopeForTests();
  const seen = [];
  const unsubscribe = subscribeGitScope((scope, revision) => seen.push({ scope, revision }));
  setGitScope({ chatId: 'c1' });
  assert.equal(getGitScopeRevision(), 1);
  assert.equal(getGitScope().chatId, 'c1');
  setGitScope({ chatId: 'c1' });
  assert.equal(getGitScopeRevision(), 1, 'a redundant set keeps the revision');
  setGitScope({ todoId: 't1' });
  assert.equal(getGitScopeRevision(), 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].revision, 2);
  assert.equal(seen[1].scope.todoId, 't1');
  unsubscribe();
  setGitScope({ chatId: 'c2' });
  assert.equal(seen.length, 2, 'unsubscribe stops notifications');
  resetGitScopeForTests();
});

test('isCurrentGitRevision detects a superseded request', () => {
  resetGitScopeForTests();
  const requestRevision = getGitScopeRevision();
  assert.equal(isCurrentGitRevision(requestRevision), true);
  setGitScope({ todoId: 't1' });
  assert.equal(isCurrentGitRevision(requestRevision), false);
  resetGitScopeForTests();
});

test('a task scope can be pinned, and a chat scope releases the pin', () => {
  resetGitScopeForTests();
  setGitScope({ todoId: 't1', workspaceFolder: '/p' }, { lock: true });
  assert.equal(isGitScopeLocked(), true);
  setGitScope({ chatId: 'c1', workspaceFolder: '/p' }, { lock: false });
  assert.equal(isGitScopeLocked(), false);
  resetGitScopeForTests();
});

test('isStaleGitResponse compares captured and live scope keys', () => {
  const key = buildGitScopeKey({ chatId: 'c' });
  assert.equal(isStaleGitResponse(key, key), false);
  assert.equal(isStaleGitResponse(key, buildGitScopeKey({ chatId: 'other' })), true);
});

test('chat and task scopes are built from durable ids, not a client path', () => {
  assert.deepEqual(
    resolveChatGitScope({ id: 'c1', todoId: 't1', workspaceFolder: '/project' }, '/fallback'),
    { chatId: 'c1', todoId: 't1', workspaceFolder: '/project' },
  );
  assert.deepEqual(
    resolveChatGitScope({ id: 'c1' }, '/fallback'),
    { chatId: 'c1', todoId: '', workspaceFolder: '/fallback' },
  );
  assert.deepEqual(
    resolveTodoGitScope({ id: 't1' }, '/project'),
    { chatId: '', todoId: 't1', workspaceFolder: '/project' },
  );
});

test('context kind and badge visibility distinguish worktree, task, chat and global', () => {
  assert.equal(deriveGitContextKind({ isWorktree: true }), 'worktree');
  assert.equal(deriveGitContextKind({ todoId: 't' }), 'todo');
  assert.equal(deriveGitContextKind({ chatId: 'c' }), 'chat');
  assert.equal(deriveGitContextKind({ workspaceFolder: '/p', source: 'workspace' }), 'workspace');
  assert.equal(deriveGitContextKind(null), 'global');

  assert.equal(shouldShowGitContextBadge({ isWorktree: true }), true);
  assert.equal(shouldShowGitContextBadge({ todoId: 't' }), true);
  assert.equal(shouldShowGitContextBadge({ chatId: 'c' }), true);
  assert.equal(shouldShowGitContextBadge({ workspaceFolder: '/p' }), false);
  assert.equal(shouldShowGitContextBadge(null), false);
});

test('deriveGitContextBadge exposes the branch and a translated title', () => {
  const badge = deriveGitContextBadge(
    { isWorktree: true, branch: 'todo/x', worktree: { branch: 'todo/x' } },
    fakeT,
  );
  assert.equal(badge.kind, 'worktree');
  assert.equal(badge.tone, 'worktree');
  assert.equal(badge.branch, 'todo/x');
  assert.equal(badge.label, 'git.contextWorktree');
  assert.equal(badge.title, 'git.contextBadgeTitle');
});

test('buildGitDetailRows shows project, base, changes, task and integration', () => {
  const info = {
    isWorktree: true,
    source: 'worktree',
    workspaceFolder: '/project',
    cwd: '/worktrees/t1',
    branch: 'todo/t1',
    aheadBehind: 'ahead 2',
    statusShort: [' M a.js', '?? b.js'],
    worktree: {
      worktreePath: '/worktrees/t1',
      baseCommit: 'abcdef1234567890',
      integrationState: 'ready',
    },
    todo: { id: 't1', title: 'Fix the thing', integration: { state: 'ready' } },
  };
  const rows = buildGitDetailRows(info, fakeT);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.context.value, 'git.contextWorktree');
  assert.equal(byKey.workspace.value, '/project');
  assert.equal(byKey.worktree.value, '/worktrees/t1');
  assert.equal(byKey.base.value, 'abcdef12');
  assert.equal(byKey.changes.value, '2');
  assert.equal(byKey.todo.value, 'Fix the thing');
  assert.equal(byKey.integration.value, 'git.integration.ready');
});

test('buildGitDetailRows drops empty values and still reports the change count', () => {
  assert.deepEqual(buildGitDetailRows(null, fakeT), []);
  const rows = buildGitDetailRows({ source: 'global', workspaceFolder: '' }, fakeT);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.context.value, 'git.contextGlobal');
  assert.equal(byKey.changes.value, '0');
  assert.equal(byKey.workspace, undefined);
});

test('shortGitId keeps the first eight characters', () => {
  assert.equal(shortGitId('abcdef123456'), 'abcdef12');
  assert.equal(shortGitId(''), '');
});

test('git context i18n keys exist in English and Polish', () => {
  const keys = [
    'contextLabel', 'contextGlobal', 'contextChat', 'contextTodo', 'contextWorktree',
    'contextBadgeAria', 'contextBadgeTitle', 'contextBadgeNoBranch',
    'mainProject', 'worktreePath', 'baseCommit', 'branchLabel', 'changes',
    'relatedTask', 'integrationState',
  ];
  for (const key of keys) {
    assert.equal(typeof en.git?.[key], 'string', `en.git.${key}`);
    assert.equal(typeof pl.git?.[key], 'string', `pl.git.${key}`);
  }
  for (const state of ['not_applicable', 'pending', 'ready', 'integrated', 'rejected']) {
    assert.equal(typeof en.git?.integration?.[state], 'string', `en.git.integration.${state}`);
    assert.equal(typeof pl.git?.integration?.[state], 'string', `pl.git.integration.${state}`);
  }
  assert.equal(typeof en.todo?.gitBadgeTitle, 'string');
  assert.equal(typeof pl.todo?.gitBadgeTitle, 'string');
});

test('index.html hosts the header badge, panel chip and detail container', () => {
  const html = readSource('public/index.html');
  assert.match(html, /id="header-git-badge"/);
  assert.match(html, /id="git-context-chip"/);
  assert.match(html, /id="git-info-details"/);
});

test('the Git panel forwards scope to the API and guards stale answers', () => {
  const source = readSource('app_front/gitPanel.js');
  assert.match(source, /api\.getGitInfo\(scope\)/);
  assert.match(source, /api\.postGitAction\(\{ action, arg \}, scope\)/);
  assert.match(source, /refreshRequestId/);
  assert.match(source, /buildGitScopeKey\(getGitScope\(\)\)/);
  assert.match(source, /subscribeGitScope/);
  assert.match(source, /setGitPanelScope/);
});

test('the header badge dispatches the panel-open event and drops stale answers', () => {
  const source = readSource('app_front/gitContextBadge.js');
  assert.match(source, /cretli-git-open/);
  assert.match(source, /setGitScope\(lastState\.scope/);
  assert.match(source, /seq !== requestSeq/);
  assert.match(source, /api\.getGitInfo\(scope\)/);
});

test('App.js wires the header badge and opens the Git panel on the event', () => {
  const source = readSource('app_front/App.js');
  assert.match(source, /initGitContextBadge/);
  assert.match(source, /cretli-git-open/);
  assert.match(source, /showPanel\('git'\)/);
  assert.match(source, /gitContextBadge\.refresh\(\)/);
});

test('the TODO card exposes a Git chip and the panel opens the task scope', () => {
  const card = readSource('app_front/components/ui/cr-todo-card.js');
  assert.match(card, /todo-open-git/);
  assert.match(card, /todo-item-git-chip/);
  const panel = readSource('app_front/todoPanel.js');
  assert.match(panel, /'todo-open-git'/);
  assert.match(panel, /setGitScope\(\{ todoId: id/);
  assert.match(panel, /showPanelFn\('git'\)/);
});
