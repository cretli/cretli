import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  emptyWorktreeRegistry,
  getWorktreeRecord,
  listWorktreeRecords,
  mutateWorktreeRegistry,
  readWorktreeRegistry,
  writeWorktreeRegistry,
} from '../lib/persist/worktree-registry-persist.js';
import { normalizeWorktreeConfig, resolveWorktreeLayout } from '../lib/worktree/worktree-layout.js';
import { resolveWorktreeMode } from '../lib/worktree/worktree-mode.js';
import { WORKTREE_ERROR_CODES } from '../lib/worktree/worktree-errors.js';
import { normalizeWorktreeRecord } from '../lib/worktree/worktree-record.js';
import { tempDir } from './helpers/temp-git-repo.js';

/** @param {() => unknown} fn @returns {string} */
function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code || '';
  }
  return '';
}

test('O3 fail closed: layout config has no defaults', () => {
  assert.equal(errorCode(() => normalizeWorktreeConfig(undefined)), WORKTREE_ERROR_CODES.CONFIG_INVALID);
  assert.equal(errorCode(() => normalizeWorktreeConfig({ root: '/tmp/x' })), WORKTREE_ERROR_CODES.CONFIG_INVALID);
  assert.equal(
    errorCode(() => normalizeWorktreeConfig({ root: 'relative', namespace: 'ws', branchPrefix: 'b/', directoryPrefix: 't-' })),
    WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
  assert.equal(
    errorCode(() => normalizeWorktreeConfig({ root: '/tmp/x', namespace: 'a/b', branchPrefix: 'b/', directoryPrefix: 't-' })),
    WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
  const layout = resolveWorktreeLayout(
    { root: '/tmp/outside', namespace: 'ws', branchPrefix: 'cretli/todo/', directoryPrefix: 't-' },
    'abc-123',
  );
  assert.equal(layout.branch, 'cretli/todo/abc-123');
  assert.equal(layout.worktreePath, path.join('/tmp/outside', 'ws', 't-abc-123'));
  assert.equal(errorCode(() => resolveWorktreeLayout({ root: '/tmp/x', namespace: 'ws', branchPrefix: 'b/', directoryPrefix: 't-' }, '../escape')), WORKTREE_ERROR_CODES.CONFIG_INVALID);
});

test('O1 fail closed: mode resolution uses leaf value then policy default, never an ancestor walk', () => {
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'worktree', policyDefault: 'project' }), {
    mode: 'worktree',
    source: 'leaf',
  });
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'project', policyDefault: 'worktree' }), {
    mode: 'project',
    source: 'leaf',
  });
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'inherit', policyDefault: 'worktree' }), {
    mode: 'worktree',
    source: 'policy',
  });
  assert.deepEqual(resolveWorktreeMode({ leafMode: '', policyDefault: 'worktree' }), {
    mode: 'worktree',
    source: 'policy',
  });
  assert.deepEqual(resolveWorktreeMode({}), { mode: 'project', source: 'policy' });
  assert.equal(errorCode(() => resolveWorktreeMode({ leafMode: 'maybe' })), WORKTREE_ERROR_CODES.MODE_INVALID);
  assert.equal(
    errorCode(() => resolveWorktreeMode({ leafMode: 'inherit', policyDefault: 'inherit' })),
    WORKTREE_ERROR_CODES.MODE_INVALID,
  );
});

test('registry writes atomically, bumps the revision and reloads records', () => {
  const dataDir = tempDir('cretli-wt-reg-');
  const registryOptions = { dataDir };
  const doc = readWorktreeRegistry(registryOptions);
  assert.equal(doc.revision, 0);
  assert.equal(Object.keys(doc.items).length, 0);

  const record = normalizeWorktreeRecord({
    todoId: 'todo-1',
    workspaceFolder: '/tmp/ws',
    repoRoot: '/tmp/ws',
    worktreePath: '/tmp/wt/one',
    branch: 'cretli/todo/todo-1',
    baseCommit: 'a'.repeat(40),
  });
  assert.ok(record);

  const result = mutateWorktreeRegistry((draft) => {
    draft.items['todo-1'] = record;
    return { result: 'written' };
  }, registryOptions);
  assert.equal(result, 'written');

  const reloaded = readWorktreeRegistry(registryOptions);
  assert.equal(reloaded.revision, 1);
  assert.equal(reloaded.items['todo-1'].branch, 'cretli/todo/todo-1');
  assert.equal(getWorktreeRecord('todo-1', registryOptions)?.worktreePath, '/tmp/wt/one');
  assert.equal(getWorktreeRecord('missing', registryOptions), null);
  assert.equal(listWorktreeRecords(registryOptions).length, 1);

  // With a dirty cache the second value wins the write.
  writeWorktreeRegistry(reloaded, registryOptions);
  assert.equal(readWorktreeRegistry(registryOptions).revision, 2);
});

test('registry drops records without identity fields and keeps the file readable', () => {
  const dataDir = tempDir('cretli-wt-reg-');
  const filePath = path.join(dataDir, 'worktree-registry.json');
  writeWorktreeRegistry(emptyWorktreeRegistry(), { dataDir });
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.items['broken'] = { todoId: 'broken' };
  fs.writeFileSync(filePath, JSON.stringify(raw));
  assert.deepEqual(readWorktreeRegistry({ dataDir }).items, {});
});

test('a corrupt registry file is a hard refusal (fail closed)', () => {
  const dataDir = tempDir('cretli-wt-reg-');
  fs.writeFileSync(path.join(dataDir, 'worktree-registry.json'), '{ not json');
  assert.equal(errorCode(() => readWorktreeRegistry({ dataDir })), WORKTREE_ERROR_CODES.REGISTRY_CONFLICT);
});
