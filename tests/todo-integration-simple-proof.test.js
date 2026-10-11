import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveSimpleTodoIntegrationProof, verifyTodoIntegrationProof } from '../lib/todo-integration-proof.js';

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

  git(repo, 'checkout', '-q', '--detach');
  const detached = deriveSimpleTodoIntegrationProof({ workspaceFolder: repo, todoId: 'todo-1' });
  assert.equal(detached.ok, false);
  assert.equal(detached.reason, 'target_ref_missing');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
console.log('todo-integration-simple-proof.test.js OK');
