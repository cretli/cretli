/**
 * Git-level worktree merge: preflight, outcome verification, the worktree list
 * read model and the report -> integration confirmation path.
 *
 * Every repository lives under os.tmpdir(); nothing touches the real repo.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { addTodo, getTodoById, todosDocumentPath, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorktreeRecord, mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import {
  buildSmartMergeRequest,
  buildVerifyIntegrationRequest,
  reportSmartMergeOutcome,
  INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS,
  INTEGRATION_GUARD_CHANGE_IN_HEAD,
} from '../lib/workspace-watcher-integration.js';
import {
  GIT_BRANCH_MERGE_MODE,
  preflightGitBranchMerge,
  verifyGitBranchMerge,
} from '../lib/worktree-merge.js';
import { listWorkspaceWorktrees, readWorktreeDiff } from '../lib/worktree-list.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const NO_ACTIVITY = { collectWorkspaceGitActivity: () => ({ busy: false, runningChats: 0, runningDelegations: 0, watcherCycles: 0 }) };

/**
 * @param {string} name
 * @returns {{ dataDir: string, baseDir: string, repo: string, todo: object, record: object, cleanup: () => void }}
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-wm-data-${name}-`);
  const baseDir = tempDir(`cretli-wm-base-${name}-`);
  const repo = createTempRepo().dir;
  const todo = addTodo(dataDir, repo, { title: `merge ${name}`, status: 'doing', executionMode: 'worktree' }).item;
  const created = ensureWorktree({
    todoId: todo.id,
    workspaceFolder: repo,
    mode: 'worktree',
    config: worktreeConfig(baseDir),
    registryOptions: { dataDir },
  });
  fs.writeFileSync(path.join(created.record.worktreePath, 'feature.txt'), 'feature\n');
  return {
    dataDir,
    baseDir,
    repo,
    todo,
    record: getWorktreeRecord(todo.id, { dataDir }),
    cleanup: () => {
      for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Do what the merge agent is asked to do: commit in the worktree, merge in the main tree.
 *
 * @param {{ repo: string, record: object }} suite
 */
function runAgentMerge(suite) {
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  git(suite.repo, ['merge', '--no-ff', '-m', 'merge task', suite.record.branch]);
}

test('preflight passes on a clean main tree and reports uncommitted worktree files', (t) => {
  const suite = makeSuite('pre-ok');
  t.after(suite.cleanup);
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.targetBranch, 'main');
  assert.equal(result.branch, suite.record.branch);
  assert.equal(result.ahead, false);
  assert.equal(result.uncommittedFiles, 1);
});

test('preflight blocks a dirty main tree, listing the files', (t) => {
  const suite = makeSuite('pre-dirty');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'local.txt'), 'wip\n');
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.equal(result.ok, false);
  const blocker = result.blockers.find((row) => row.code === 'dirty_workspace');
  assert.ok(blocker);
  assert.deepEqual(blocker.paths, ['local.txt']);
});

test('preflight blocks while work is live in the main tree', (t) => {
  const suite = makeSuite('pre-busy');
  t.after(suite.cleanup);
  const busy = { collectWorkspaceGitActivity: () => ({ busy: true, runningChats: 1, runningDelegations: 0, watcherCycles: 0 }) };
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: busy });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((row) => row.code === 'workspace_busy'));
});

test('preflight blocks a detached HEAD', (t) => {
  const suite = makeSuite('pre-state');
  t.after(suite.cleanup);
  git(suite.repo, ['checkout', '-q', '--detach']);
  const detached = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.ok(detached.blockers.some((row) => row.code === 'detached_head'));
});

test('verification refuses a worktree that was never committed', (t) => {
  const suite = makeSuite('verify-uncommitted');
  t.after(suite.cleanup);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nothing_committed');
});

test('verification refuses a committed branch that is not merged yet', (t) => {
  const suite = makeSuite('verify-not-merged');
  t.after(suite.cleanup);
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_merged');
});

test('verification accepts a merged branch and returns the proof commits', (t) => {
  const suite = makeSuite('verify-ok');
  t.after(suite.cleanup);
  runAgentMerge(suite);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, true);
  assert.equal(result.targetCommit, git(suite.repo, ['rev-parse', 'main']).trim());
  assert.equal(result.sourceCommit, git(suite.repo, ['rev-parse', suite.record.branch]).trim());
});

test('workspace smart merge asks the agent to commit listed paths and record proof', (t) => {
  const suite = makeSuite('workspace-prompt');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  for (const guard of ['Workspace (merge target', 'Worktree path:', 'Worktree branch:', 'Base commit', 'Prepared patch', 'Authorization scope file:', 'Commit only paths from this file that you changed', 'for a rename both paths are in scope', 'Do not stage any other path', 'Do not push, reset, stash, or delete the worktree or its branch', 'Never discard, revert or overwrite', 'combine both sides', 'not by picking one wholesale', 'unrelated local edits', 'name it in the summary', 'Do not confirm when the commit fails', 'task change is not in HEAD', 'report must happen', 'current branch contains HEAD', 'todo_show for expected_updated_at', 'proof.simple true', 'curl -sS -X POST', suite.todo.id, suite.repo]) assert.ok(started.prompt.includes(guard), guard);
  assert.ok(started.prompt.indexOf('2. Report') < started.prompt.indexOf('3. On outcome'));
  assert.match(started.prompt, /todo_integration action confirm/);
  assert.match(started.prompt, /Do not push/);
  assert.doesNotMatch(started.prompt, /Do NOT commit/);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.integration.reason, 'smart_merge_running');
  assert.notEqual(todo.integration.mergeMode, GIT_BRANCH_MERGE_MODE);
});

test('git-branch merge request: refused untouched when blocked, started with a marker when clear', (t) => {
  const suite = makeSuite('request');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'local.txt'), 'wip\n');
  const blocked = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'dirty_workspace');
  assert.equal(getTodoById(suite.dataDir, suite.repo, suite.todo.id).integration, undefined);
  fs.rmSync(path.join(suite.repo, 'local.txt'));
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    instructions: 'prefer small commits', baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  for (const guard of ['git diff --stat <base>', 'git status', 'Commit every intended change', 'Nothing may stay uncommitted', 'git merge --no-ff', 'never by picking one side wholesale', 'Complete the merge commit', 'Run the relevant tests/checks', 'covers ONLY this merge', 'Do NOT push, reset --hard, force anything, stash', 'delete the worktree or delete the branch', 'Do not switch the main tree to another branch', 'REPORT THE OUTCOME', 'smart-merge-report-from-agent']) assert.ok(started.prompt.includes(guard), guard);
  assert.match(started.prompt, /prefer small commits/);
  assert.match(started.prompt, /smart-merge-report-from-agent/);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.integration.mergeMode, GIT_BRANCH_MERGE_MODE);
  assert.equal(todo.integration.targetBranch, 'main');
  assert.equal(todo.integration.reason, 'smart_merge_running');
});

test('a verified merged report confirms the integration and marks the todo done', (t) => {
  const suite = makeSuite('report-ok');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  runAgentMerge(suite);
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'merged', summary: 'done',
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  assert.equal(reported.confirmed, true);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.status, 'done');
  assert.equal(todo.integration.state, 'integrated');
  assert.equal(todo.integration.evidence.targetBranch, 'main');
  assert.equal(getWorktreeRecord(suite.todo.id, { dataDir: suite.dataDir }).integrationState, 'integrated');
});

test('a merged report that Git cannot prove stays unconfirmed with a reason', (t) => {
  const suite = makeSuite('report-lie');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'merged',
  });
  assert.equal(reported.ok, false);
  assert.equal(reported.reason, 'merge_unverified');
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.notEqual(todo.status, 'done');
  assert.match(todo.integration.reason, /^git_merge_unverified: nothing_committed/);
});

test('a failed report keeps the todo awaiting integration with the reason', (t) => {
  const suite = makeSuite('report-failed');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'failed', summary: 'conflict in a.js',
  });
  assert.equal(reported.ok, true);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.integration.state, 'ready');
  assert.match(todo.integration.reason, /smart_merge_failed: conflict in a\.js/);
});

test('the worktree list reconciles the registry with Git and derives states', (t) => {
  const suite = makeSuite('list');
  t.after(suite.cleanup);
  const listed = listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(listed.rows.length, 1);
  const [row] = listed.rows;
  assert.equal(row.todoId, suite.todo.id);
  assert.equal(row.branch, suite.record.branch);
  assert.equal(row.exists, true);
  assert.equal(row.state, 'active');
  assert.equal(row.uncommittedFiles, 1);
  assert.equal(row.title, suite.todo.title);
  fs.rmSync(suite.record.worktreePath, { recursive: true, force: true });
  const afterRemoval = listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(afterRemoval.rows[0].state, 'missing');
  assert.equal(afterRemoval.rows[0].exists, false);
  assert.equal(afterRemoval.rows[0].actions.merge, false);
});

test('the list only exposes records of the requested workspace', (t) => {
  const suite = makeSuite('list-scope');
  t.after(suite.cleanup);
  const other = createTempRepo().dir;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: other }).rows.length, 0);
});

test('the diff is read from the record path and refuses a foreign workspace', (t) => {
  const suite = makeSuite('diff');
  t.after(suite.cleanup);
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  const diff = readWorktreeDiff({ dataDir: suite.dataDir, workspaceFolder: suite.repo, todoId: suite.todo.id });
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /feature\.txt/);
  const other = createTempRepo().dir;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(readWorktreeDiff({ dataDir: suite.dataDir, workspaceFolder: other, todoId: suite.todo.id }).reason, 'not_found');
});

for (const cause of ['missing', 'unreadable', 'hash mismatch']) test(`smart merge fallback: ${cause}`, (t) => {
  const suite = makeSuite(`fallback-${cause.replaceAll(' ', '-')}`);
  t.after(suite.cleanup);
  const input = { todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir };
  assert.equal(buildSmartMergeRequest(input).ok, true);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  const result = getWorktreeRecord(suite.todo.id, { dataDir: suite.dataDir }).results[todo.integration.cycleId];
  fs.unlinkSync(result.patchPath);
  if (cause === 'unreadable') fs.mkdirSync(result.patchPath);
  if (cause === 'hash mismatch') fs.writeFileSync(result.patchPath, 'different patch');
  const conflicts = Array.from({ length: 60 }, (_, index) => `conflict-${index}`);
  const prompt = buildSmartMergeRequest({ ...input, conflicts }).prompt;
  const sidecar = JSON.parse(fs.readFileSync(`${result.patchPath}.files.json`));
  assert.equal(sidecar.scopeUnavailable, true);
  assert.deepEqual(sidecar.conflicts, conflicts);
  assert.ok(prompt.includes('this file does not authorize paths'));
  for (const text of ['Patch missing, unreadable or hash mismatch', 'git diff --name-status -z -M <base>', 'git ls-files --others --exclude-standard', 'best effort', 'worktree is gone, stop and report failure', 'commit only paths from the derived scope']) assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes('Authorization scope file:'));
});

test('smart merge size is independent of file count; conflicts spill after fifty', (t) => {
  const suite = makeSuite('sixty-files');
  t.after(suite.cleanup);
  const input = { todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir };
  const first = buildSmartMergeRequest(input).prompt;
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  const result = getWorktreeRecord(suite.todo.id, { dataDir: suite.dataDir }).results[todo.integration.cycleId];
  // Keep paths/ids fixed to isolate the file-count effect from parameter lengths.
  const patch = Array.from({ length: 60 }, (_, index) => `diff --git a/file-${index}.txt b/file-${index}.txt\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ b/file-${index}.txt\n@@ -0,0 +1 @@\n+x\n`).join('');
  fs.writeFileSync(result.patchPath, patch);
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  mutateWorktreeRegistry((doc) => {
    const stored = doc.items[suite.todo.id].results[todo.integration.cycleId];
    stored.patchSha256 = patchSha256;
    stored.changedFiles = Array.from({ length: 60 }, (_, index) => ({ path: `file-${index}.txt`, status: 'A' }));
    return { changed: true };
  }, { dataDir: suite.dataDir });
  const next = buildSmartMergeRequest(input).prompt;
  assert.equal(next, first);
  const conflicts = Array.from({ length: 60 }, (_, index) => `conflict-${String(index).padStart(2, '0')}`);
  const conflictPrompt = buildSmartMergeRequest({ ...input, conflicts }).prompt;
  assert.ok(conflictPrompt.includes('conflict-49'));
  assert.ok(!conflictPrompt.includes('conflict-50'));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${result.patchPath}.files.json`)).conflicts, conflicts);
  assert.equal(JSON.parse(fs.readFileSync(`${result.patchPath}.files.json`)).files.length, 60);
});


test('verify integration retains search, repair, commit and proof guards', (t) => {
  const suite = makeSuite('verify-prompt');
  t.after(suite.cleanup);
  const todo = addTodo(suite.dataDir, suite.repo, { title: 'finished task', status: 'done' }).item;
  const prompt = buildVerifyIntegrationRequest({ todoId: todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt;
  for (const guard of ['todo_show this todo (and its children)', 'Do NOT conclude "missing"', 'chat_history / chat_event', 'git log -S/-G', 'git status/diff', 'git branch --contains <commit>', 'Run the relevant checks', 'fresh expected_updated_at', 'proof.simple true', 'action no_code', 'commit ONLY the task paths', 'never stage unrelated files', 'test or fixture is stale', 'regression test', 'do not confirm', 'Never push, reset, stash or discard local changes', 'leave them untouched and uncommitted', 'user attestation', 'change is not in HEAD']) assert.ok(prompt.includes(guard), guard);
});

test('verify integration adds bounded server hints and shares guard core', (t) => {
  const suite = makeSuite('verify-hints');
  t.after(suite.cleanup);
  const linkedChatIds = Array.from({ length: 3 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  const todo = addTodo(suite.dataDir, suite.repo, {
    title: 'finished task', status: 'done', chatId: linkedChatIds[0],
    plan: { sourceChatId: linkedChatIds[1] },
  }).item;
  for (const linkedChatId of linkedChatIds.slice(2)) updateTodo(suite.dataDir, suite.repo, todo.id, { linkedChatId });
  const storedPath = todosDocumentPath(suite.dataDir, suite.repo);
  const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  const storedTodo = stored.items.find((item) => item.id === todo.id);
  storedTodo.chatId = linkedChatIds[0];
  storedTodo.linkedChatIds = linkedChatIds.slice(1);
  storedTodo.plan = { ...storedTodo.plan, sourceChatId: linkedChatIds[1] };
  storedTodo.leafMaterial = { mode: 'worktree', lastCheckpoint: { commit: 'a'.repeat(40) } };
  storedTodo.integration = { ...storedTodo.integration, resultPath: '/tmp/result.patch' };
  fs.writeFileSync(storedPath, JSON.stringify(stored));
  updateTodo(suite.dataDir, suite.repo, todo.id, { leafMaterial: { mode: 'worktree', lastCheckpoint: { commit: 'a'.repeat(40) } } });
  const verifyPrompt = buildVerifyIntegrationRequest({ todoId: todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt;
  assert.ok(verifyPrompt.includes('Hints from the server, unverified; check HEAD and behaviour yourself.'));
  assert.ok(verifyPrompt.includes(`${linkedChatIds[0]}: executor`));
  assert.ok(verifyPrompt.includes('Checkpoint commit'));
  assert.ok(verifyPrompt.includes('NOT proof of presence in HEAD'));
  assert.equal((verifyPrompt.match(/- Chat /g) || []).length, 3);
  const hintBlock = verifyPrompt.split('Hints from the server, unverified; check HEAD and behaviour yourself.')[1].trim();
  assert.ok(Buffer.byteLength(`Hints from the server, unverified; check HEAD and behaviour yourself.${hintBlock ? `\n${hintBlock}` : ''}`, 'utf8') <= 600);
  assert.ok(verifyPrompt.includes('Do NOT conclude "missing" from a path/commit search alone'));
  assert.ok(verifyPrompt.includes('proof.simple true'));
  const smartPrompt = buildSmartMergeRequest({ todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt;
  assert.ok(verifyPrompt.includes(INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS));
  assert.ok(smartPrompt.includes(INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS));
  assert.ok(verifyPrompt.includes(INTEGRATION_GUARD_CHANGE_IN_HEAD));
  assert.ok(smartPrompt.includes(INTEGRATION_GUARD_CHANGE_IN_HEAD));
  const manyChatTodo = addTodo(suite.dataDir, suite.repo, { title: 'many chats', status: 'done' }).item;
  const manyChatDoc = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  manyChatDoc.items.find((item) => item.id === manyChatTodo.id).linkedChatIds = Array.from({ length: 7 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  fs.writeFileSync(storedPath, JSON.stringify(manyChatDoc));
  const manyChatPrompt = buildVerifyIntegrationRequest({ todoId: manyChatTodo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt;
  assert.equal((manyChatPrompt.match(/- Chat /g) || []).length, 5);
  // Newest linkedChatIds entries win ties; none of the 7 is filtered as deleted (empty chat index).
  const manyChatHint = manyChatPrompt.split('Hints from the server')[1];
  assert.ok(manyChatHint.includes('10000000-0000-4000-8000-000000000006'));
  assert.ok(!manyChatHint.includes('10000000-0000-4000-8000-000000000000'));
  const unicodeTodo = addTodo(suite.dataDir, suite.repo, { title: 'unicode patch', status: 'done' }).item;
  const unicodeDoc = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  const unicodeRow = unicodeDoc.items.find((item) => item.id === unicodeTodo.id);
  unicodeRow.chatId = linkedChatIds[0];
  unicodeRow.integration = { resultPath: `/tmp/${'zażółć-'.repeat(60)}.patch` };
  fs.writeFileSync(storedPath, JSON.stringify(unicodeDoc));
  const unicodeHint = buildVerifyIntegrationRequest({ todoId: unicodeTodo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt.split('Hints from the server')[1];
  assert.ok(Buffer.byteLength(`Hints from the server${unicodeHint}`, 'utf8') <= 600 + 1);
  assert.ok(!unicodeHint.includes('zażółć-zażółć-zażółć-zażółć-zażółć-zażółć-zażółć-zażółć'));
  assert.ok(unicodeHint.includes(linkedChatIds[0]));
  const unknown = addTodo(suite.dataDir, suite.repo, { title: 'no hints', status: 'done' }).item;
  const unknownPrompt = buildVerifyIntegrationRequest({ todoId: unknown.id, workspaceFolder: suite.repo, dataDir: suite.dataDir }).prompt;
  assert.ok(!unknownPrompt.includes('Hints from the server'));
});
