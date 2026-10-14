/** Exercise the generated merge contract by hand in disposable repositories. */
import { removeIsolatedDataDir } from '../tests/helpers/isolated-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { seedScopeFixture, applyScopeChanges } from '../tests/helpers/patch-scope-fixture.js';
import { git, tempDir, worktreeConfig } from '../tests/helpers/temp-git-repo.js';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import { buildSmartMergeRequest, reportSmartMergeOutcome, confirmWorkspaceTodoIntegration } from '../lib/workspace-watcher-integration.js';
import { collectWorktreeExecutionDiff } from '../lib/worktree/git-worktree.js';

const { dir: workspace, baseCommit } = seedScopeFixture();
const dataDir = tempDir('cretli-manual-merge-data-');
const baseDir = tempDir('cretli-manual-merge-worktrees-');
const todo = addTodo(dataDir, workspace, { title: 'Manual smart merge fixture', status: 'doing' }).item;
let callbackResult = null;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  assert.equal(req.url, '/api/smart-merge-report-from-agent');
  callbackResult = reportSmartMergeOutcome({ ...JSON.parse(body), dataDir });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(callbackResult));
});
try {
  const { record } = ensureWorktree({ todoId: todo.id, workspaceFolder: workspace, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir } });
  applyScopeChanges(record.worktreePath);
  fs.appendFileSync(path.join(workspace, 'modify.txt'), 'user local edit\n');
  fs.writeFileSync(path.join(workspace, 'unrelated.txt'), 'unrelated user work\n');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const input = { todoId: todo.id, workspaceFolder: workspace, dataDir, baseUrl, deps: { collectWorktreeExecutionDiff: ({ worktreePath }) => {
    const diff = collectWorktreeExecutionDiff({ worktreePath, baseCommit });
    const tracked = git(worktreePath, ['diff', '--binary', baseCommit, '--']);
    return { ...diff, patch: git(worktreePath, ['diff', '--binary', '-M', '-C', '--find-copies-harder', baseCommit]) + diff.patch.slice(tracked.length) };
  } } };
  const request = buildSmartMergeRequest(input);
  assert.equal(request.ok, true);
  const current = getTodoById(dataDir, workspace, todo.id);
  const scope = JSON.parse(fs.readFileSync(`${current.integration.resultPath}.files.json`));
  const allowed = [...new Set(scope.files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))];
  assert.equal(allowed.length, 16);
  // Resolve intent explicitly: copy each task result, preserving the local line in the overlapping file.
  for (const file of scope.files) {
    const destination = path.join(workspace, file.path);
    if (file.status === 'D') { fs.rmSync(destination); continue; }
    if (file.status === 'R') fs.rmSync(path.join(workspace, file.oldPath));
    if (file.path === 'modify.txt') {
      fs.appendFileSync(destination, 'task edit\n');
      continue;
    }
    fs.rmSync(destination, { force: true });
    const source = path.join(record.worktreePath, file.path);
    if (fs.lstatSync(source).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
    else { fs.copyFileSync(source, destination); fs.chmodSync(destination, fs.statSync(source).mode); }
  }
  const changed = allowed.filter((file) => git(workspace, ['status', '--porcelain', '--', file]).trim());
  git(workspace, ['add', '--', ...changed]);
  const staged = git(workspace, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  assert.ok(staged.every((file) => allowed.includes(file)));
  assert.ok(!staged.includes('unrelated.txt'));
  git(workspace, ['commit', '-qm', 'Integrate fixture task; modify.txt includes user local edit']);
  const merged = git(workspace, ['show', 'HEAD:modify.txt']);
  assert.ok(merged.includes('user local edit\n') && merged.includes('task edit\n'));
  for (const file of scope.files) {
    if (file.status === 'D') { assert.ok(!fs.existsSync(path.join(workspace, file.path))); continue; }
    if (file.path === 'modify.txt') continue;
    const source = path.join(record.worktreePath, file.path);
    const destination = path.join(workspace, file.path);
    if (fs.lstatSync(source).isSymbolicLink()) assert.equal(fs.readlinkSync(destination), fs.readlinkSync(source));
    else { assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source)); assert.equal(fs.statSync(destination).mode, fs.statSync(source).mode); }
  }
  assert.equal(git(workspace, ['status', '--porcelain']).trim(), '?? unrelated.txt');
  const summary = 'Fixture merged; modify.txt includes unrelated local edit; unrelated.txt left uncommitted.';
  const { stdout } = await promisify(execFile)('curl', ['-sS', '-X', 'POST', `${baseUrl}/api/smart-merge-report-from-agent`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ todoId: todo.id, workspaceFolder: workspace, outcome: 'merged', summary })]);
  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(callbackResult.item.status, 'doing');
  assert.ok(callbackResult.item.integration.appliedAt);
  git(workspace, ['merge-base', '--is-ancestor', 'HEAD', 'main']);
  const fresh = getTodoById(dataDir, workspace, todo.id);
  const confirmation = confirmWorkspaceTodoIntegration({ todoId: todo.id, workspaceFolder: workspace, dataDir, expectedUpdatedAt: fresh.updatedAt, proof: { simple: true } });
  assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
  console.log(JSON.stringify({ scopePaths: allowed.length, stagedPaths: staged.length, allTaskChangesInHead: true, localEditPreserved: true, unrelatedPathUncommitted: true, callbackPosted: true, reportBeforeConfirm: true, confirmation: confirmation.item.status }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of [workspace, dataDir, baseDir]) fs.rmSync(dir, { recursive: true, force: true });
  removeIsolatedDataDir();
}
