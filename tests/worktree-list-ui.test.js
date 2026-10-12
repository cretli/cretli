/**
 * Worktree list UI contract: pure view helpers are exercised directly; the
 * wiring (HTML host, panel init, API client, i18n parity) is asserted from
 * source so a refactor that drops it fails without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canStartMerge,
  cleanupNeedsDiscard,
  describeMergeBlocker,
  describeWorktreeState,
  shortCommit,
  summarizeWorktreeChanges,
} from '../app_front/features/git/worktreeListView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { WORKTREE_LIST_STATES } from '../lib/worktree-list.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fakeT = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

/**
 * @param {object} dictionary
 * @param {string} dotted
 * @returns {unknown}
 */
function lookup(dictionary, dotted) {
  return dotted.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dictionary);
}

test('every server row state has a label and tone', () => {
  for (const state of WORKTREE_LIST_STATES) {
    const view = describeWorktreeState(state, fakeT);
    assert.match(view.label, /^worktrees\.state\./, state);
    assert.ok(view.tone, state);
  }
  assert.equal(describeWorktreeState('unexpected', fakeT).label, 'unexpected');
});

test('merge may only start from a preflight without blockers', () => {
  assert.equal(canStartMerge(null), false);
  assert.equal(canStartMerge({ ok: false, blockers: [{ code: 'dirty_workspace' }] }), false);
  assert.equal(canStartMerge({ ok: true, blockers: [] }), true);
});

test('blockers map to i18n keys and unknown codes fall back to the server message', () => {
  assert.equal(describeMergeBlocker({ code: 'dirty_workspace' }, fakeT), 'worktrees.blocker.dirtyWorkspace');
  assert.equal(describeMergeBlocker({ code: 'zzz', message: 'raw' }, fakeT), 'raw');
});

test('change summary and commit helpers', () => {
  assert.equal(shortCommit('0123456789abcdef'), '01234567');
  assert.equal(summarizeWorktreeChanges({}, fakeT), 'worktrees.noChanges');
  assert.match(summarizeWorktreeChanges({ aheadCommits: 2, uncommittedFiles: 1 }, fakeT), /"commits":2,"files":1/);
});

test('cleanup of anything not integrated is a discard', () => {
  assert.equal(cleanupNeedsDiscard({ state: 'integrated' }), false);
  assert.equal(cleanupNeedsDiscard({ state: 'rejected' }), true);
  assert.equal(cleanupNeedsDiscard({ state: 'active' }), true);
});

test('every worktrees i18n key used by the UI exists in en and pl', () => {
  const source = readSource('app_front/features/git/worktreeList.js') + readSource('app_front/features/git/worktreeListView.js');
  const used = new Set();
  for (const match of source.matchAll(/t\('(worktrees\.[A-Za-z.]+)'/g)) used.add(match[1]);
  for (const match of source.matchAll(/key: '(worktrees\.[A-Za-z.]+)'/g)) used.add(match[1]);
  for (const match of source.matchAll(/'(worktrees\.blocker\.[A-Za-z]+)'/g)) used.add(match[1]);
  for (const forecast of ['none', 'conflicts', 'unknown']) used.add(`worktrees.forecast.${forecast}`);
  assert.ok(used.size > 20);
  for (const key of used) {
    assert.equal(typeof lookup(en, key), 'string', `en ${key}`);
    assert.equal(typeof lookup(pl, key), 'string', `pl ${key}`);
  }
});

test('the Git panel hosts the worktree list and initialises it', () => {
  const html = readSource('public/index.html');
  assert.match(html, /id="git-worktrees-list"/);
  assert.match(html, /id="git-worktrees-refresh"/);
  const panel = readSource('app_front/gitPanel.js');
  assert.match(panel, /initWorktreeList\(\)/);
  assert.match(panel, /refreshWorktreeList\(\)/);
});

test('the list drops stale answers and merge goes through the shared model picker', () => {
  const source = readSource('app_front/features/git/worktreeList.js');
  assert.match(source, /requestId !== refreshRequestId/);
  assert.match(source, /openTodoAgentStartModal\(/);
  assert.match(source, /api\.startWorktreeMerge\(/);
  assert.match(source, /disabled: !canStartMerge\(pre\)/);
});

test('the API client targets the worktree routes', () => {
  const api = readSource('app_front/api.js');
  for (const fragment of ['/api/worktrees/list', '/merge-preview', '/merge`', '/reject`', '/cleanup`', '/diff']) {
    assert.ok(api.includes(fragment), fragment);
  }
});
