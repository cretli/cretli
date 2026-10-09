import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ensureWorktree,
  reconcileWorktreeRegistry,
  removeWorktree,
  updateWorktreeState,
  verifyWorktreeRecord,
} from '../lib/worktree-manager.js';
import { readWorktreeRegistry, mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { createWorktreeRecord } from '../lib/worktree/worktree-record.js';
import { resolveWorktreeLayout } from '../lib/worktree/worktree-layout.js';
import { WORKTREE_ERROR_CODES } from '../lib/worktree/worktree-errors.js';
import { commitFile, createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const TODO_A = '11111111-1111-1111-1111-111111111111';
const TODO_B = '22222222-2222-2222-2222-222222222222';

/**
 * @param {import('node:test').TestContext} t
 * @param {{ repo?: string, config?: object }} [overrides]
 */
function setup(t, overrides = {}) {
  const base = tempDir('cretli-wt-base-');
  const repo = overrides.repo || createTempRepo().dir;
  const config = overrides.config || worktreeConfig(base);
  const dataDir = tempDir('cretli-wt-data-');
  const registryOptions = { dataDir, lockTimeoutMs: 15_000 };
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, repo, config, dataDir, registryOptions };
}

/** @param {() => unknown} fn @returns {string} */
function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code || '';
  }
  return '';
}

test('ensureWorktree creates once and retry reuses the frozen base and existing changes', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const first = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(first.created, true);
  assert.equal(first.reused, false);
  assert.equal(first.record.baseCommit, git(repo, ['rev-parse', 'HEAD']).trim());
  assert.ok(fs.existsSync(first.record.worktreePath));
  assert.equal(verifyWorktreeRecord(first.record).ok, true);
  assert.match(git(repo, ['worktree', 'list', '--porcelain']), /cretli\/todo\/11111111/);

  // Work done in the worktree must survive a retry untouched.
  fs.writeFileSync(path.join(first.record.worktreePath, 'work.txt'), 'half done\n');
  const second = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(second.created, false);
  assert.equal(second.reused, true);
  assert.equal(second.record.baseCommit, first.record.baseCommit);
  assert.equal(fs.readFileSync(path.join(second.record.worktreePath, 'work.txt'), 'utf8'), 'half done\n');
  const worktreeLines = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  assert.equal(worktreeLines.length, 2, 'main + one worktree, no duplicate');
});

test('dirty logical tree blocks a new worktree (S6)', (t) => {
  const { repo, config, registryOptions } = setup(t);
  fs.appendFileSync(path.join(repo, 'README.md'), 'uncommitted\n');
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions })),
    WORKTREE_ERROR_CODES.DIRTY,
  );
});

test('explicit head start freezes skipped paths and leaves the dirty tree untouched', (t) => {
  const { repo, config, registryOptions } = setup(t);
  fs.appendFileSync(path.join(repo, 'README.md'), 'local edit\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'local file\n');
  const before = git(repo, ['status', '--porcelain', '-z']);
  const result = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions, dirtyPolicy: 'head' });
  assert.equal(result.record.baseKind, 'head');
  assert.deepEqual(new Set(result.record.skippedPaths), new Set(['README.md', 'untracked.txt']));
  assert.equal(git(repo, ['status', '--porcelain', '-z']), before);
  assert.equal(fs.existsSync(path.join(result.record.worktreePath, 'untracked.txt')), false);
});

test('snapshot start includes dirty and untracked files without changing user Git state', (t) => {
  const { repo, config, registryOptions } = setup(t);
  fs.appendFileSync(path.join(repo, 'README.md'), 'local edit\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'local file\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n', { flag: 'a' });
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'ignored\n');
  const statusBefore = git(repo, ['status', '--porcelain', '-z']);
  const indexBefore = git(repo, ['write-tree']).trim();
  const stashBefore = git(repo, ['stash', 'list']);
  const result = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions, dirtyPolicy: 'snapshot' });
  assert.equal(result.record.baseKind, 'snapshot');
  assert.equal(result.record.snapshotOfHead, git(repo, ['rev-parse', 'HEAD']).trim());
  assert.equal(git(repo, ['status', '--porcelain', '-z']), statusBefore);
  assert.equal(git(repo, ['write-tree']).trim(), indexBefore);
  assert.equal(git(repo, ['stash', 'list']), stashBefore);
  assert.equal(fs.readFileSync(path.join(result.record.worktreePath, 'README.md'), 'utf8').endsWith('local edit\n'), true);
  assert.equal(fs.readFileSync(path.join(result.record.worktreePath, 'untracked.txt'), 'utf8'), 'local file\n');
  assert.equal(fs.existsSync(path.join(result.record.worktreePath, 'ignored.txt')), false);
  const frozenBase = result.record.baseCommit;
  const retried = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions, dirtyPolicy: 'head' });
  assert.equal(retried.record.baseCommit, frozenBase);
  assert.equal(retried.record.baseKind, 'snapshot');
  assert.equal(verifyWorktreeRecord(retried.record).ok, true);
});

test('non-Git workspace, unknown base and non-worktree mode give clear errors', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const plain = tempDir('cretli-wt-plain-');
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: plain, mode: 'worktree', config, registryOptions })),
    WORKTREE_ERROR_CODES.NOT_GIT,
  );
  assert.equal(
    errorCode(() =>
      ensureWorktree({
        todoId: TODO_A,
        workspaceFolder: repo,
        mode: 'worktree',
        config,
        baseCommit: 'deadbeef',
        registryOptions,
      }),
    ),
    WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'project', config, registryOptions })),
    WORKTREE_ERROR_CODES.MODE_NOT_WORKTREE,
  );
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config: {}, registryOptions })),
    WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
});

test('branch collision and an existing unregistered path are refused, never adopted (S9/O4)', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const layout = resolveWorktreeLayout(config, TODO_A);
  git(repo, ['branch', layout.branch, 'HEAD']);
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions })),
    WORKTREE_ERROR_CODES.BRANCH_COLLISION,
  );

  const { repo: repo2, config: config2, registryOptions: registry2 } = setup(t);
  const layout2 = resolveWorktreeLayout(config2, TODO_A);
  fs.mkdirSync(layout2.worktreePath, { recursive: true });
  fs.writeFileSync(path.join(layout2.worktreePath, 'someone-elses.txt'), 'keep me\n');
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo2, mode: 'worktree', config: config2, registryOptions: registry2 })),
    WORKTREE_ERROR_CODES.PATH_EXISTS,
  );
  assert.equal(fs.readFileSync(path.join(layout2.worktreePath, 'someone-elses.txt'), 'utf8'), 'keep me\n');
});

test('a reservation left by a crash is resumed without duplication', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const layout = resolveWorktreeLayout(config, TODO_A);
  const reservation = createWorktreeRecord({
    todoId: TODO_A,
    workspaceFolder: repo,
    repoRoot: repo,
    worktreePath: layout.worktreePath,
    branch: layout.branch,
    baseCommit,
    creationState: 'reserved',
  });
  mutateWorktreeRegistry((doc) => {
    doc.items[TODO_A] = reservation;
    return { result: null };
  }, registryOptions);

  const result = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(result.created, true);
  assert.equal(result.recovered, true);
  assert.equal(result.record.baseCommit, baseCommit);
  assert.equal(verifyWorktreeRecord(result.record).ok, true);
});

test('a crash after git worktree add keeps the changes and finalizes on retry', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const layout = resolveWorktreeLayout(config, TODO_A);
  const reservation = createWorktreeRecord({
    todoId: TODO_A,
    workspaceFolder: repo,
    repoRoot: repo,
    worktreePath: layout.worktreePath,
    branch: layout.branch,
    baseCommit,
    creationState: 'reserved',
  });
  mutateWorktreeRegistry((doc) => {
    doc.items[TODO_A] = reservation;
    return { result: null };
  }, registryOptions);
  git(repo, ['worktree', 'add', '-b', layout.branch, layout.worktreePath, baseCommit]);
  fs.writeFileSync(path.join(layout.worktreePath, 'already-working.txt'), 'do not lose\n');

  const result = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(result.recovered, true);
  assert.equal(result.record.creationState, 'ready');
  assert.equal(
    fs.readFileSync(path.join(layout.worktreePath, 'already-working.txt'), 'utf8'),
    'do not lose\n',
  );
});

test('a registered worktree missing on disk is refused, not silently recreated (O4)', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const created = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  fs.rmSync(created.record.worktreePath, { recursive: true, force: true });
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions })),
    WORKTREE_ERROR_CODES.MISSING,
  );
  assert.equal(readWorktreeRegistry(registryOptions).items[TODO_A].worktreePath, created.record.worktreePath);
});

test('a repository that is itself a worktree can host a nested worktree', (t) => {
  const { base, repo, config, registryOptions } = setup(t);
  const linked = path.join(base, 'linked');
  git(repo, ['worktree', 'add', '-q', '-b', 'linked-feature', linked, 'HEAD']);
  const linkedHead = git(linked, ['rev-parse', 'HEAD']).trim();
  const result = ensureWorktree({
    todoId: TODO_B,
    workspaceFolder: linked,
    mode: 'worktree',
    config,
    registryOptions,
  });
  assert.equal(result.record.repoRoot, linked);
  assert.equal(result.record.baseCommit, linkedHead);
  assert.equal(verifyWorktreeRecord(result.record).ok, true);
  assert.ok(git(linked, ['worktree', 'list', '--porcelain']).includes(result.record.worktreePath));
});

test('reconcile classifies verified, missing, foreign and orphan state without mutating (S6.5)', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const verified = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  const missing = ensureWorktree({ todoId: TODO_B, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  fs.rmSync(missing.record.worktreePath, { recursive: true, force: true });

  const foreignPath = path.join(config.root, config.namespace, 't-foreign');
  git(repo, ['worktree', 'add', '-q', '-b', 'foreign-branch', foreignPath, 'HEAD']);
  git(repo, ['branch', 'cretli/todo/orphan-branch', 'HEAD']);

  const revisionBefore = readWorktreeRegistry(registryOptions).revision;
  const report = reconcileWorktreeRegistry({ registryOptions, config });
  assert.equal(report.counts.verified, 1);
  assert.equal(report.counts.missing, 1);
  assert.ok(report.entries.some((entry) => entry.todoId === TODO_A && entry.status === 'verified'));
  assert.ok(report.entries.some((entry) => entry.todoId === TODO_B && entry.status === 'missing'));
  assert.ok(report.foreign.some((entry) => entry.path === foreignPath));
  assert.ok(report.orphanBranches.some((entry) => entry.branch === 'cretli/todo/orphan-branch'));
  assert.equal(readWorktreeRegistry(registryOptions).revision, revisionBefore, 'reconcile is read-only');
  assert.ok(fs.existsSync(verified.record.worktreePath));
});

test('cleanup refuses active, unaccepted and unverifiable state; integrated cleanup is safe', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const created = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  const { worktreePath, branch } = created.record;

  updateWorktreeState({ todoId: TODO_A, registryOptions, executionState: 'active' });
  assert.equal(
    errorCode(() => removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => false })),
    WORKTREE_ERROR_CODES.BUSY,
  );

  updateWorktreeState({ todoId: TODO_A, registryOptions, executionState: 'execution_closed', integrationState: 'ready' });
  assert.equal(
    errorCode(() => removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => false })),
    WORKTREE_ERROR_CODES.UNACCEPTED,
  );
  assert.equal(
    errorCode(() =>
      removeWorktree({
        todoId: TODO_A,
        registryOptions,
        confirmation: { discard: true, worktreePath, branch },
      }),
    ),
    WORKTREE_ERROR_CODES.BUSY_CHECK_UNAVAILABLE,
  );
  assert.equal(
    errorCode(() => removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => true })),
    WORKTREE_ERROR_CODES.BUSY,
  );
  assert.ok(fs.existsSync(worktreePath), 'nothing removed while refused');

  updateWorktreeState({ todoId: TODO_A, registryOptions, integrationState: 'integrated' });
  const removed = removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: (record) => record.todoId !== TODO_A });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.match(git(repo, ['show-ref', '--verify', `refs/heads/${branch}`]), /refs\/heads/);
  assert.ok(removed.record.cleanedAt);
  assert.equal(removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => false }).alreadyCleaned, true);
});

test('integrated snapshot cleanup removes its retained snapshot ref', (t) => {
  const { repo, config, registryOptions } = setup(t);
  fs.appendFileSync(path.join(repo, 'README.md'), 'snapshot content\n');
  const created = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions, dirtyPolicy: 'snapshot' });
  const snapshotRef = created.record.snapshotRef;
  assert.ok(git(repo, ['show-ref', '--verify', snapshotRef]));
  updateWorktreeState({ todoId: TODO_A, registryOptions, executionState: 'execution_closed', integrationState: 'integrated' });
  removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => false });
  assert.equal(git(repo, ['show-ref', '--verify', snapshotRef], { allowFailure: true }), '');
});

test('explicit discard confirmation is required to force a rejected dirty worktree; integrated never auto-forces', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const rejected = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  updateWorktreeState({ todoId: TODO_A, registryOptions, executionState: 'execution_closed', integrationState: 'rejected' });
  fs.writeFileSync(path.join(rejected.record.worktreePath, 'rejected-work.txt'), 'unaccepted\n');
  assert.equal(
    errorCode(() => removeWorktree({ todoId: TODO_A, registryOptions, hasActiveAgent: () => false })),
    WORKTREE_ERROR_CODES.UNACCEPTED,
  );
  const discarded = removeWorktree({
    todoId: TODO_A,
    registryOptions,
    hasActiveAgent: () => false,
    confirmation: { discard: true, worktreePath: rejected.record.worktreePath, branch: rejected.record.branch },
  });
  assert.equal(discarded.removed, true);
  assert.match(git(repo, ['show-ref', '--verify', `refs/heads/${rejected.record.branch}`]), /refs\/heads/);

  // Integrated but dirty: the default removal must refuse and never force.
  const integrated = ensureWorktree({ todoId: TODO_B, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  updateWorktreeState({ todoId: TODO_B, registryOptions, executionState: 'execution_closed', integrationState: 'integrated' });
  fs.writeFileSync(path.join(integrated.record.worktreePath, 'dirty-after-integration.txt'), 'x\n');
  assert.equal(
    errorCode(() => removeWorktree({ todoId: TODO_B, registryOptions, hasActiveAgent: () => false })),
    WORKTREE_ERROR_CODES.REMOVE_REFUSED,
  );
  assert.ok(fs.existsSync(integrated.record.worktreePath));
});

test('updateWorktreeState validates vocabulary and requires a record', (t) => {
  const { repo, config, registryOptions } = setup(t);
  ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(
    errorCode(() => updateWorktreeState({ todoId: TODO_A, registryOptions, integrationState: 'maybe' })),
    WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
  );
  assert.equal(
    errorCode(() => updateWorktreeState({ todoId: 'unknown', registryOptions, executionState: 'active' })),
    WORKTREE_ERROR_CODES.RECORD_MISSING,
  );
  const updated = updateWorktreeState({ todoId: TODO_A, registryOptions, cycleId: 'cycle-1', chatId: 'chat-1' });
  assert.deepEqual(updated.cycles, ['cycle-1']);
  assert.deepEqual(updated.chats, ['chat-1']);
  const again = updateWorktreeState({ todoId: TODO_A, registryOptions, cycleId: 'cycle-1', chatId: 'chat-1' });
  assert.deepEqual(again.cycles, ['cycle-1']);
  assert.deepEqual(again.chats, ['chat-1']);
});

test('the worktree root must live outside the repository (S8/O3)', (t) => {
  const { repo } = setup(t);
  const insideRoot = path.join(repo, 'wts');
  fs.mkdirSync(insideRoot, { recursive: true });
  const config = { root: insideRoot, namespace: 'ws', branchPrefix: 'cretli/todo/', directoryPrefix: 't-' };
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions: { dataDir: tempDir('cretli-wt-data-') } })),
    WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
});

test('a base commit recorded before execution is frozen and never re-read on retry (S5)', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const created = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  const nextCommit = commitFile(repo, 'later.txt');
  assert.notEqual(nextCommit, created.record.baseCommit);
  const retried = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(retried.record.baseCommit, created.record.baseCommit);
});

test('an external change to a registered worktree is detected and never adopted', (t) => {
  const { repo, config, registryOptions } = setup(t);
  const created = ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  fs.writeFileSync(path.join(created.record.worktreePath, 'external.txt'), 'external\n');
  git(created.record.worktreePath, ['add', 'external.txt']);
  git(created.record.worktreePath, ['commit', '-qm', 'external change']);

  const verification = verifyWorktreeRecord(created.record);
  assert.equal(verification.status, 'external_change');
  assert.equal(
    errorCode(() => ensureWorktree({ todoId: TODO_A, workspaceFolder: repo, mode: 'worktree', config, registryOptions })),
    WORKTREE_ERROR_CODES.EXTERNAL_CHANGE,
  );
  const report = reconcileWorktreeRegistry({ registryOptions, config });
  assert.ok(report.entries.some((entry) => entry.todoId === TODO_A && entry.status === 'external_change'));
  assert.ok(fs.existsSync(created.record.worktreePath), 'external change is reported, never deleted');
});
