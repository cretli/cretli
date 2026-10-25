import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveSimpleTodoIntegrationProof, verifyTodoIntegrationProof } from '../lib/todo-integration-proof.js';
import { isGitOwnershipRefusal } from '../lib/worktree/git-worktree.ts';

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

  git(repo, 'checkout', '-q', '--detach');
  const detached = deriveSimpleTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1' });
  assert.equal(detached.ok, false);
  assert.equal(detached.reason, 'target_ref_missing');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
console.log('todo-integration-simple-proof.test.js OK');
