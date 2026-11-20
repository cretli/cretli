/**
 * Pure view helpers for the workspace branch chip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWorkspaceBranchBadge,
  isSameRepoBranch,
} from '../app_front/features/git/workspaceBranchView.js';

const t = (key, vars = {}) => `${key}${vars && Object.keys(vars).length ? `:${JSON.stringify(vars)}` : ''}`;

test('deriveWorkspaceBranchBadge hides a non-repo workspace', () => {
  const badge = deriveWorkspaceBranchBadge({ ok: true, isRepo: false }, t);
  assert.equal(badge.visible, false);
  const badge2 = deriveWorkspaceBranchBadge(null, t);
  assert.equal(badge2.visible, false);
});

test('deriveWorkspaceBranchBadge shows the branch with upstream details', () => {
  const badge = deriveWorkspaceBranchBadge({
    ok: true,
    isRepo: true,
    branch: 'main',
    upstream: 'origin/main',
    aheadBehind: '↑1',
    head: 'abc1234',
  }, t);
  assert.equal(badge.visible, true);
  assert.equal(badge.detached, false);
  assert.equal(badge.label, 'main');
  assert.match(badge.title, /workspace\.branchTitle/);
  assert.match(badge.title, /↑1/);
  assert.match(badge.title, /origin\/main/);
});

test('deriveWorkspaceBranchBadge renders a detached HEAD from the short hash', () => {
  const badge = deriveWorkspaceBranchBadge({
    ok: true,
    isRepo: true,
    branch: 'HEAD',
    head: 'abc1234',
  }, t);
  assert.equal(badge.visible, true);
  assert.equal(badge.detached, true);
  assert.match(badge.label, /abc1234/);
  assert.match(badge.label, /branchDetached/);
});

test('deriveWorkspaceBranchBadge hides a detached HEAD without a hash', () => {
  const badge = deriveWorkspaceBranchBadge({ ok: true, isRepo: true, branch: 'HEAD', head: '' }, t);
  assert.equal(badge.visible, false);
});

test('isSameRepoBranch only matches the same topLevel and branch', () => {
  const info = { isRepo: true, topLevel: '/repo', branch: 'main' };
  assert.equal(isSameRepoBranch(info, { isRepo: true, topLevel: '/repo', branch: 'main' }), true);
  assert.equal(isSameRepoBranch(
    info,
    { isRepo: true, topLevel: '/repo/', branch: 'main' },
  ), true, 'trailing slash normalizes');
  assert.equal(isSameRepoBranch(
    info,
    { isRepo: true, topLevel: '/repo', branch: 'feature' },
  ), false);
  assert.equal(isSameRepoBranch(
    info,
    { isRepo: true, topLevel: '/other', branch: 'main' },
  ), false);
  assert.equal(isSameRepoBranch(info, { isRepo: false, topLevel: '/repo', branch: 'main' }), false);
  assert.equal(isSameRepoBranch(
    { isRepo: true, topLevel: '/repo', branch: '' },
    { isRepo: true, topLevel: '/repo', branch: '' },
  ), false, 'empty branch is not a duplicate');
});
