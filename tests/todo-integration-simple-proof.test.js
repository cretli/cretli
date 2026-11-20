import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveCommittedTodoIntegrationProof, deriveSimpleTodoIntegrationProof, todoRepositoryMatches, verifyTodoIntegrationProof } from '../lib/todo-integration-proof.js';
import { isGitOwnershipRefusal } from '../lib/worktree/git-worktree.ts';
import { addTodo } from '../lib/persist/todos-legacy-adapter.js';
import { confirmWorkspaceTodoIntegration } from '../lib/workspace-watcher-integration.js';
import { ensureWorktree, updateWorktreeState } from '../lib/worktree-manager.js';
import { commitFile, createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-simple-proof-'));
try {
  git(repo, 'init', '-q', '-b', 'work');
  git(repo, 'config', 'user.email', 'dev@example.com');
  git(repo, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');

  const derived = deriveSimpleTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1' });
  assert.equal(derived.ok, true);
  assert.equal(derived.proof.targetBranch, 'work');
  assert.equal(derived.proof.targetCommit, head);
  assert.equal(derived.proof.changeAttested, true);
  assert.equal(derived.proof.scope, 'task');

  // The derived proof must pass the unchanged strict verifier.
  const verified = verifyTodoIntegrationProof({ workspaceFolder: repo, ...derived.proof, todoId: 'todo-1', todoItems: [] });
  assert.equal(verified.ok, true);
  assert.equal(verified.evidence.targetCommit, head);

  const confirmDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-confirm-proof-'));
  const confirmTodo = addTodo(confirmDataDir, repo, { title: 'confirm proof', status: 'doing' }).item;
  const staleCommit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'later.txt'), 'later');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'move HEAD');
  const simpleMismatch = await confirmWorkspaceTodoIntegration({
    workspaceFolder: repo,
    dataDir: confirmDataDir,
    todoId: confirmTodo.id,
    expectedUpdatedAt: confirmTodo.updatedAt,
    proof: { simple: true, targetCommit: staleCommit },
  });
  assert.equal(simpleMismatch.ok, false);
  assert.equal(simpleMismatch.reason, 'target_head_mismatch');
  fs.rmSync(confirmDataDir, { recursive: true, force: true });

  const foreignRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-foreign-proof-'));
  try {
    git(foreignRepo, 'init', '-q', '-b', 'other');
    git(foreignRepo, 'config', 'user.email', 'dev@example.com');
    git(foreignRepo, 'config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(foreignRepo, 'b.txt'), 'b');
    git(foreignRepo, 'add', '-A');
    git(foreignRepo, 'commit', '-q', '-m', 'foreign');
    const foreignHead = git(foreignRepo, 'rev-parse', 'HEAD');
    const mismatch = verifyTodoIntegrationProof({
      workspaceFolder: repo,
      targetBranch: 'other',
      targetCommit: foreignHead,
      sourceCommit: foreignHead,
      materialRevision: 'material',
      changeRef: 'foreign commit',
      changeAttested: true,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'target_ref_missing');
    assert.equal(todoRepositoryMatches(repo, foreignRepo), false);
  } finally {
    fs.rmSync(foreignRepo, { recursive: true, force: true });
  }

  const liveRepo = createTempRepo();
  const liveDataDir = tempDir('cretli-live-worktree-proof-data-');
  const worktreeBase = tempDir('cretli-live-worktree-proof-base-');
  try {
    const liveTodo = addTodo(liveDataDir, liveRepo.dir, { title: 'live worktree proof', status: 'doing' }).item;
    const registryOptions = { dataDir: liveDataDir };
    const created = ensureWorktree({
      todoId: liveTodo.id,
      workspaceFolder: liveRepo.dir,
      mode: 'worktree',
      config: worktreeConfig(worktreeBase),
      registryOptions,
    });
    updateWorktreeState({ todoId: liveTodo.id, registryOptions, executionState: 'active' });
    const leafCommit = commitFile(created.record.worktreePath, 'leaf-only.txt', 'leaf commit\n');
    const confirmInput = {
      workspaceFolder: liveRepo.dir,
      dataDir: liveDataDir,
      todoId: liveTodo.id,
      expectedUpdatedAt: liveTodo.updatedAt,
      proof: { simple: true },
    };
    const unmerged = await confirmWorkspaceTodoIntegration(confirmInput);
    assert.equal(unmerged.ok, false);
    assert.equal(unmerged.reason, 'target_commit_not_on_branch');
    assert.equal(unmerged.item, undefined);
    assert.equal(git(liveRepo.dir, 'rev-parse', 'HEAD'), liveRepo.baseCommit);

    git(liveRepo.dir, 'merge', '--ff-only', created.record.branch);
    assert.equal(git(liveRepo.dir, 'rev-parse', 'HEAD'), leafCommit);
    const merged = await confirmWorkspaceTodoIntegration(confirmInput);
    assert.equal(merged.ok, true, merged.reason);
    assert.equal(merged.item.integration.evidence.targetCommit, leafCommit);
  } finally {
    fs.rmSync(liveDataDir, { recursive: true, force: true });
    fs.rmSync(worktreeBase, { recursive: true, force: true });
    fs.rmSync(liveRepo.dir, { recursive: true, force: true });
  }

  const linked = path.join(os.tmpdir(), `cretli-proof-worktree-${process.pid}`);
  const linkedBranch = `proof-${process.pid}`;
  try {
    git(repo, 'branch', linkedBranch, 'work');
    git(repo, 'worktree', 'add', '-q', linked, linkedBranch);
    assert.equal(todoRepositoryMatches(repo, linked), true);
    const badHead = verifyTodoIntegrationProof({
      workspaceFolder: repo,
      executionFolder: linked,
      requireHeadMatch: true,
      targetBranch: linkedBranch,
      targetCommit: git(repo, 'commit-tree', 'HEAD^{tree}', '-m', 'other head'),
      sourceCommit: head,
      materialRevision: 'material',
      changeRef: 'wrong head',
      changeAttested: true,
    });
    assert.equal(badHead.ok, false);
    assert.equal(badHead.reason, 'target_head_mismatch');
  } finally {
    if (fs.existsSync(linked)) git(repo, 'worktree', 'remove', '--force', linked);
    git(repo, 'branch', '-D', linkedBranch);
  }

  // A checkout owned by another uid than the server ("dubious ownership") must
  // still verify: every Git read trusts this exact checkout for one command.
  const savedOwnerKnob = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  try {
    const foreign = deriveSimpleTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1' });
    assert.equal(foreign.ok, true, `foreign-owned repo: ${foreign.reason}`);
    const foreignVerified = verifyTodoIntegrationProof({ workspaceFolder: repo, ...foreign.proof, todoId: 'todo-1', todoItems: [] });
    assert.equal(foreignVerified.ok, true, `foreign-owned repo: ${foreignVerified.reason}`);
    // Without the scoped trust Git refuses; the detector must recognise the real
    // stderr so a refusal is reported as git_ownership, not target_ref_missing.
    const bare = spawnSync('git', ['-c', 'safe.directory=', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(bare.status, 0);
    assert.equal(isGitOwnershipRefusal(bare.stderr), true, bare.stderr);
    assert.equal(isGitOwnershipRefusal('fatal: not a git repository'), false);
  } finally {
    if (savedOwnerKnob === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = savedOwnerKnob;
  }

  const committed = deriveCommittedTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1', commit: head.slice(0, 10) });
  assert.equal(committed.ok, true);
  assert.equal(committed.proof.targetCommit, head, 'an older reachable commit need not be HEAD');
  assert.equal(deriveCommittedTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1', commit: '--all' }).reason, 'invalid_commit');
  assert.equal(deriveCommittedTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1', commit: 'f'.repeat(40) }).reason, 'target_ref_missing');

  git(repo, 'checkout', '-q', '--detach');
  const detached = deriveSimpleTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1' });
  assert.equal(detached.ok, false);
  assert.equal(detached.reason, 'target_ref_missing');
  assert.equal(deriveCommittedTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1', commit: head }).reason, 'target_ref_missing');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
console.log('todo-integration-simple-proof.test.js OK');
