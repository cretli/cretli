import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  normalizeDelegationWorkspaceKey,
  resetDelegationWorkspaceKeyCache,
} from '../lib/delegation-workspace-key.js';

test('empty input yields empty key', () => {
  assert.equal(normalizeDelegationWorkspaceKey('  '), '');
});

test('missing path is not cached; later-created symlinked path resolves', () => {
  resetDelegationWorkspaceKeyCache();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-')));
  try {
    const target = path.join(base, 'real');
    const link = path.join(base, 'link');
    assert.equal(normalizeDelegationWorkspaceKey(link), link);
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    assert.equal(normalizeDelegationWorkspaceKey(link), target);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('successful realpath is cached and survives many distinct keys', () => {
  resetDelegationWorkspaceKeyCache();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-')));
  try {
    const target = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    assert.equal(normalizeDelegationWorkspaceKey(link), target);
    fs.rmSync(link);
    assert.equal(normalizeDelegationWorkspaceKey(link), target, 'served from cache');
    for (let i = 0; i < 300; i += 1) normalizeDelegationWorkspaceKey(path.join(base, `n${i}`));
    resetDelegationWorkspaceKeyCache();
    assert.equal(normalizeDelegationWorkspaceKey(link), link);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
