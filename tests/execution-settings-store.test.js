/**
 * Execution settings store: saved record wins over legacy watcher policy, an
 * explicitly cleared prepareCommand stays empty, and the watcher-policy alias
 * writes through to the new store.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getExecutionSettings, saveExecutionSettings } from '../lib/persist/execution-settings-persist.js';
import { applyExecutionSettingsToPolicy, resolveExecutionSettingsView } from '../lib/execution-settings.js';
import { applyWorkspaceWatcherPatch } from '../lib/workspace-watcher-control.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { createTempRepo, tempDir } from './helpers/temp-git-repo.js';

test('saved record wins over legacy policy; cleared prepareCommand stays empty', () => {
  const dataDir = tempDir('cretli-exec-data-');
  const repo = createTempRepo().dir;
  try {
    const legacy = { executionMode: 'worktree', worktree: { root: '/legacy', namespace: 'old', prepareCommand: ['npm', 'ci'] } };
    assert.deepEqual(applyExecutionSettingsToPolicy(legacy, repo, dataDir), legacy);
    saveExecutionSettings(repo, { executionMode: 'project', worktree: { root: '/new', prepareCommand: [] } }, { dataDir });
    const merged = applyExecutionSettingsToPolicy(legacy, repo, dataDir);
    assert.equal(merged.executionMode, 'project');
    assert.equal(merged.worktree.root, '/new');
    assert.equal(merged.worktree.namespace, 'old');
    assert.deepEqual(merged.worktree.prepareCommand, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('view exposes saved, effective and proposal; validation rejects bad mode', () => {
  const dataDir = tempDir('cretli-exec-data-');
  const repo = createTempRepo().dir;
  try {
    const view = resolveExecutionSettingsView({ workspaceFolder: repo, dataDir });
    assert.equal(view.saved, null);
    assert.equal(view.proposal.available, true);
    assert.equal(view.effective.executionMode, 'project');
    assert.equal(view.effective.worktree.directoryPrefix, 't-');
    assert.throws(() => saveExecutionSettings(repo, { executionMode: 'bogus' }, { dataDir }), /executionMode/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('watcher policy.worktree alias writes through to the execution store', () => {
  const dataDir = tempDir('cretli-exec-data-');
  const repo = createTempRepo().dir;
  try {
    const row = applyWorkspaceWatcherPatch({
      dataDir,
      workspaceFolder: repo,
      patch: { policy: { executionMode: 'worktree', worktree: { prepareCommand: [] } } },
    });
    const saved = getExecutionSettings(repo, { dataDir });
    assert.equal(saved.executionMode, 'worktree');
    assert.deepEqual(saved.worktree.prepareCommand, []);
    assert.ok(saved.worktree.root, 'layout backfilled from the proposal');
    assert.notEqual(row.policy?.executionMode, 'worktree', 'alias is not stored on the watcher row');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unsafe layout values are rejected on save and ignored on read', () => {
  const dataDir = tempDir('cretli-exec-data-');
  const repo = createTempRepo().dir;
  try {
    const bad = [
      ['directoryPrefix', '../../escaped-'],
      ['directoryPrefix', 'a/b'],
      ['namespace', '..'],
      ['namespace', 'a\\b'],
      ['branchPrefix', '../x/'],
      ['branchPrefix', '/abs/'],
      ['branchPrefix', 'has space/'],
    ];
    for (const [field, value] of bad) {
      assert.throws(
        () => saveExecutionSettings(repo, { worktree: { [field]: value } }, { dataDir }),
        { code: 'VALIDATION' },
        `${field}=${value}`,
      );
    }
    saveExecutionSettings(repo, { worktree: { namespace: 'acme', directoryPrefix: 'wt-', branchPrefix: 'cretli/todo/' } }, { dataDir });
    const file = `${dataDir}/execution-settings.json`;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [key] = Object.keys(doc.items);
    doc.items[key].worktree.directoryPrefix = '../../escaped-';
    fs.writeFileSync(file, JSON.stringify(doc));
    const read = getExecutionSettings(repo, { dataDir });
    assert.equal(read.worktree.directoryPrefix, undefined);
    assert.equal(read.worktree.namespace, 'acme');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('executionMode-only / prepareCommand-only alias patch keeps the legacy layout', () => {
  for (const policyPatch of [{ executionMode: 'worktree' }, { worktree: { prepareCommand: [] } }]) {
    const dataDir = tempDir('cretli-exec-data-');
    const repo = createTempRepo().dir;
    try {
      upsertWorkspaceWatcher(repo, {
        policy: { worktree: { root: '/tmp/legacy-root', namespace: 'legacyns', branchPrefix: 'legacy/', directoryPrefix: 'lg-' } },
      }, { dataDir });
      applyWorkspaceWatcherPatch({ dataDir, workspaceFolder: repo, patch: { policy: policyPatch } });
      const saved = getExecutionSettings(repo, { dataDir });
      for (const key of ['root', 'namespace', 'branchPrefix', 'directoryPrefix']) {
        assert.equal(saved?.worktree?.[key], undefined, `${key} not frozen into the store`);
      }
      const view = resolveExecutionSettingsView({ workspaceFolder: repo, dataDir });
      assert.equal(view.effective.worktree.root, '/tmp/legacy-root');
      assert.equal(view.effective.worktree.namespace, 'legacyns');
      assert.equal(view.effective.worktree.branchPrefix, 'legacy/');
      assert.equal(view.effective.worktree.directoryPrefix, 'lg-');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
