/**
 * Git worktrees URL + route apply (plan stage 4): UI asks navigate; route apply
 * only paints; no duplicate listeners; opening a route does not run Git actions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSpaNavigation } from '../app_front/app/appShell/spaNavigation.js';
import { parseSpaRoute } from '../lib/spa-routes.js';
import { readTodoPanelSource } from './helpers/todoPanelSource.js';
import { readAppShellSource } from './helpers/app-shell-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('worktree tabs and showWorktreeView request SPA navigation, not local paint', () => {
  const source = readSource('app_front/features/git/worktreeList.js');
  assert.match(source, /function requestGitSubviewNavigation\(/);
  assert.match(source, /navigateSpa\(\{ panel: 'git', subview \}/);
  assert.doesNotMatch(source, /cretli-git-show-worktrees/,
    'App.js owns that event; a second listener would double-navigate');
  assert.match(source, /applyGitSubviewFromRoute[\s\S]*paintGitSubview\(/);
  const paintBody = source.slice(source.indexOf('function paintGitSubview'));
  assert.doesNotMatch(paintBody.slice(0, paintBody.indexOf('function requestGitSubviewNavigation') || paintBody.length),
    /navigateSpa\(/,
    'route apply must not write history');
});

test('route apply paints worktrees without merge or cleanup modals', () => {
  const source = readSource('app_front/features/git/worktreeList.js');
  const applyBlock = source.slice(source.indexOf('export function applyGitSubviewFromRoute'));
  const paintOnly = applyBlock.slice(0, applyBlock.indexOf('function requestGitSubviewNavigation'));
  assert.doesNotMatch(paintOnly, /openMergeDialog|runCleanup|runReject|confirmDialog/);
  assert.match(paintOnly, /paintGitSubview/);
});

test('TODO worktree chip navigates with explicit scope=todo on /git/worktrees', () => {
  const panel = readTodoPanelSource();
  const handler = panel.slice(panel.indexOf('function onOpenGit'));
  const body = handler.slice(0, handler.indexOf('function onStartAgent'));
  assert.match(body, /navigateSpa\(/);
  assert.match(body, /subview: 'worktrees'/);
  assert.match(body, /scope: 'todo'/);
  assert.doesNotMatch(body, /cretli-git-show-worktrees/);
  assert.doesNotMatch(body, /setGitScope\(/, 'scope lock is owned by applyRouteGitScope');
});

test('App.js centralises cretli-git-show-worktrees as a single navigate handler', () => {
  const app = readAppShellSource();
  const matches = app.match(/cretli-git-show-worktrees/g) || [];
  assert.equal(matches.length, 1);
  assert.match(app, /navigate\(\{ panel: 'git', subview: 'worktrees' \}/);
});

test('cold boot apply calls applyGitSubview before restore without a history push', async () => {
  const order = [];
  const nav = createSpaNavigation({
    readLocation: () => ({
      pathname: '/git/worktrees',
      search: '?ws=cretli:ws:abc&folder=f1',
    }),
    writeHistory: () => order.push('history'),
    applyRouteContext: async () => {
      order.push('context');
    },
    ensurePanelReady: async () => {
      order.push('ready');
    },
    showPanel: () => order.push('panel'),
    applySettingsTab: () => {},
    applyGitSubview: (subview) => order.push(`git:${subview}`),
    applyRouteGitScope: () => order.push('gitScope'),
    restoreRouteResources: async () => order.push('restore'),
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['git'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  await nav.bootApply({ panel: 'git' });
  const route = parseSpaRoute({ pathname: '/git/worktrees', search: '?ws=cretli:ws:abc&folder=f1' });
  assert.equal(route?.subview, 'worktrees');
  assert.ok(order.includes('git:worktrees'), 'subview is applied from the URL');
  const gitIdx = order.indexOf('git:worktrees');
  const restoreIdx = order.indexOf('restore');
  assert.ok(gitIdx >= 0 && restoreIdx > gitIdx, 'subview before resource restore');
  assert.ok(order.indexOf('context') < gitIdx, 'context resolves before Git paint');
  assert.equal(order.filter((step) => step === 'history').length, 0,
    'boot replace is skipped when canonical already matches location');
});

test('explicit scope=todo is preserved in the worktrees canonical URL', () => {
  const route = parseSpaRoute('/git/worktrees?ws=cretli:ws:abc&scope=todo&todo=todo-1');
  assert.equal(route?.subview, 'worktrees');
  assert.equal(route?.scope, 'todo');
  assert.equal(route?.query?.todo, 'todo-1');
  assert.match(route?.canonical || '', /scope=todo/);
  assert.match(route?.canonical || '', /todo=todo-1/);
});
