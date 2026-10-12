/**
 * Per-leaf material baseline and worktree checkpoints.
 */

import './helpers/isolated-data-dir.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById, updateTodo, writeTodoReview } from '../lib/persist/todos-persist.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import {
  assertSafeLeafCheckpointWorktree,
  buildLeafMaterialPromptBlock,
  captureProjectLeafManifest,
  diffProjectLeafManifest,
  ensureLeafMaterialBase,
  formatTodoLeafMaterialDiagnostics,
  readLeafScopedMaterialRevisionForTodo,
  resolveLeafMaterialExecutionContext,
  resolveWorkflowMaterialRevisionForLeaf,
  updateLeafMaterialPartialPaths,
} from '../lib/todo-leaf-material.js';
import { createWorktreeLeafCheckpoint, resolveHeadCommit } from '../lib/worktree/git-worktree.js';
import { commitFile, createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import { applyDelegationWorkflowPatch } from '../lib/delegation-workflow.js';

/**
 * @param {string} name
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-leaf-mat-data-${name}-`);
  const baseDir = tempDir(`cretli-leaf-mat-base-${name}-`);
  const repo = createTempRepo().dir;
  return {
    dataDir,
    baseDir,
    repo,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function seedReviewPassed(dataDir, repo, leafId) {
  writeTodoReview(dataDir, repo, leafId, {
    schemaVersion: 1,
    computedAt: new Date().toISOString(),
    code: { state: 'passed', reason: 'fresh_review', round: { index: 1, id: 'a', openedAt: '', invalidationAt: '' }, reviewers: [], reviewerCount: 0, truncated: false, implementer: null, independence: { class: 'unknown', reason: '' }, material: { current: true, kind: 'trusted', reason: '', revision: 'x' }, acceptance: null, updatedAt: new Date().toISOString() },
    plan: { state: 'none', reason: '', round: { index: 0, id: '', openedAt: '', invalidationAt: '' }, reviewers: [], reviewerCount: 0, truncated: false, implementer: null, independence: { class: 'unknown', reason: '' }, material: { current: false, kind: 'unavailable', reason: '', revision: '' }, acceptance: null, updatedAt: new Date().toISOString() },
  });
}

test('worktree leaf checkpoint commits on the worktree branch and leaves main untouched', async (t) => {
  const suite = makeSuite('wt-ckpt');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { executionMode: 'worktree', worktree: config },
  }, { dataDir: suite.dataDir });
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf1',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const mainHeadBefore = git(suite.repo, ['rev-parse', 'HEAD']).trim();
  const created = ensureWorktree({
    todoId: root.id,
    workspaceFolder: suite.repo,
    mode: 'worktree',
    config,
    registryOptions: { dataDir: suite.dataDir },
    dirtyPolicy: 'head',
  });
  fs.writeFileSync(path.join(created.record.worktreePath, 'leaf-a.js'), 'export const a = 1;\n');
  ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  seedReviewPassed(suite.dataDir, suite.repo, leaf.id);
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  const afterLeaf = getTodoById(suite.dataDir, suite.repo, leaf.id);
  const checkpoint = String(afterLeaf?.leafMaterial?.lastCheckpoint?.commit || '').trim();
  assert.ok(checkpoint, 'expected a checkpoint commit');
  assert.equal(git(suite.repo, ['rev-parse', 'HEAD']).trim(), mainHeadBefore, 'main branch HEAD unchanged');
  assert.equal(
    git(created.record.worktreePath, ['rev-parse', 'HEAD']).trim(),
    checkpoint,
    'worktree HEAD moved to checkpoint',
  );
  assert.ok(fs.existsSync(path.join(created.record.worktreePath, 'leaf-a.js')));
});

test('second leaf prompt uses the first leaf checkpoint as diff base', (t) => {
  const suite = makeSuite('wt-prompt');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { executionMode: 'worktree', worktree: config },
  }, { dataDir: suite.dataDir });
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf1 = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf1',
    parentId: root.id,
    status: 'done',
    siblingIndex: 0,
  }).item;
  updateTodo(suite.dataDir, suite.repo, leaf1.id, {
    leafMaterial: {
      mode: 'worktree',
      baseCapturedAt: new Date().toISOString(),
      baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lastCheckpoint: { at: new Date().toISOString(), commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    },
  });
  const leaf2 = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf2',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 1,
  }).item;
  const updated = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf2.id });
  assert.equal(updated?.leafMaterial?.baseCommit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const prompt = buildLeafMaterialPromptBlock(updated);
  assert.match(prompt, /bbbbbbbbbbbb/);
  assert.doesNotMatch(prompt, /aaaaaaaaaaaa/);
});

test('project mode records manifest delta without committing and ignores pre-existing dirty baseline', (t) => {
  const suite = makeSuite('proj');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'foreign.js'), 'foreign\n');
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'project',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const mainHead = git(suite.repo, ['rev-parse', 'HEAD']).trim();
  ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  const withBase = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.equal(withBase?.leafMaterial?.mode, 'project');
  assert.ok(withBase?.leafMaterial?.baseManifest?.['foreign.js']);
  fs.writeFileSync(path.join(suite.repo, 'leaf-only.js'), 'leaf\n');
  const diff = diffProjectLeafManifest(
    suite.repo,
    /** @type {Record<string, string>} */ (withBase.leafMaterial.baseManifest),
  );
  assert.deepEqual(diff.changedPaths, ['leaf-only.js']);
  seedReviewPassed(suite.dataDir, suite.repo, leaf.id);
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  assert.equal(git(suite.repo, ['rev-parse', 'HEAD']).trim(), mainHead, 'project mode never commits');
  const doneLeaf = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.ok(doneLeaf.leafMaterial.lastCheckpoint.manifest);
});

test('sequential leaves: done hook checkpoint then next leaf base without gap', (t) => {
  const suite = makeSuite('seq-leaves');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { executionMode: 'worktree', worktree: config },
  }, { dataDir: suite.dataDir });
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf1 = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf1',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const leaf2 = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf2',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 1,
  }).item;
  const created = ensureWorktree({
    todoId: root.id,
    workspaceFolder: suite.repo,
    mode: 'worktree',
    config,
    registryOptions: { dataDir: suite.dataDir },
    dirtyPolicy: 'head',
  });
  ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf1.id });
  fs.writeFileSync(path.join(created.record.worktreePath, 'leaf-one.js'), 'one\n');
  seedReviewPassed(suite.dataDir, suite.repo, leaf1.id);
  updateTodo(suite.dataDir, suite.repo, leaf1.id, { status: 'done', strictStatus: true });
  const doneLeaf1 = getTodoById(suite.dataDir, suite.repo, leaf1.id);
  const checkpoint1 = String(doneLeaf1?.leafMaterial?.lastCheckpoint?.commit || '').trim();
  assert.ok(checkpoint1, 'leaf1 checkpoint written synchronously on done');
  const leaf2Base = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf2.id });
  assert.equal(leaf2Base?.leafMaterial?.baseCommit, checkpoint1);
  const reviewPrompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review leaf two.',
    assignment: 'review',
    executionMode: 'agent',
    leafMaterialText: buildLeafMaterialPromptBlock(leaf2Base),
  });
  assert.equal(reviewPrompt.ok, true);
  assert.match(String(reviewPrompt.prompt), new RegExp(checkpoint1.slice(0, 12)));
});

test('worktree checkpoint failure keeps todo done and records diagnostic', (t) => {
  const suite = makeSuite('wt-err');
  t.after(suite.cleanup);
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  updateTodo(suite.dataDir, suite.repo, leaf.id, {
    leafMaterial: {
      mode: 'worktree',
      baseCapturedAt: new Date().toISOString(),
      baseCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    },
  });
  seedReviewPassed(suite.dataDir, suite.repo, leaf.id);
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  const doneLeaf = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.equal(doneLeaf.status, 'done');
  assert.ok(String(doneLeaf.leafMaterial?.lastCheckpoint?.error || '').trim(), 'checkpoint error persisted');
  const diag = formatTodoLeafMaterialDiagnostics(doneLeaf);
  assert.match(diag, /checkpoint_error=/);
});

test('inprocess workflow_update rewrites material_revision from leaf base', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const dataDir = ISOLATED_DATA_DIR;
  const parent = addChat(crypto.randomUUID(), 'leaf-mat-parent', null, repo, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leaf = addTodo(dataDir, repo, {
    title: 'leaf',
    status: 'ready',
    siblingIndex: 0,
  }).item;
  ensureLeafMaterialBase({ dataDir, workspaceFolder: repo, leafId: leaf.id });
  fs.writeFileSync(path.join(repo, 'scoped.js'), 'scoped\n');
  const scoped = readLeafScopedMaterialRevisionForTodo(
    getTodoById(dataDir, repo, leaf.id),
    repo,
  );
  assert.ok(scoped, 'expected scoped revision');
  assert.notEqual(scoped, 'client-global-revision');
  const resolved = resolveWorkflowMaterialRevisionForLeaf({
    dataDir,
    workspaceFolder: repo,
    leafId: leaf.id,
    clientRevision: 'client-global-revision',
  });
  assert.equal(resolved, scoped);
  const client = createInProcessMcpClient({
    harness: 'opencode',
    chatId: parent.id,
    workspaceFolder: repo,
  });
  const handlers = createCretliMcpToolHandlers(client, {
    chatId: parent.id,
    workspaceFolder: repo,
    mode: 'agent',
  });
  const result = await handlers.workflow_update({
    leaf_id: leaf.id,
    material_revision: 'client-global-revision',
    idempotency_key: 'leaf-scoped-material',
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.workflow.materialRevision, scoped);
  const viaHttpPatch = applyDelegationWorkflowPatch({
    parentChatId: parent.id,
    leafId: leaf.id,
    workspaceFolder: repo,
    materialRevision: resolveWorkflowMaterialRevisionForLeaf({
      dataDir,
      workspaceFolder: repo,
      leafId: leaf.id,
      clientRevision: 'client-global-revision',
    }),
    idempotencyKey: 'route-parity',
  });
  assert.equal(viaHttpPatch.materialRevision, scoped);
});

test('inherit root with watcher worktree policy resolves to worktree when live record exists', (t) => {
  const suite = makeSuite('inherit-wt');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { executionMode: 'worktree', worktree: config },
  }, { dataDir: suite.dataDir });
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'inherit',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  ensureWorktree({
    todoId: root.id,
    workspaceFolder: suite.repo,
    mode: 'worktree',
    config,
    registryOptions: { dataDir: suite.dataDir },
    dirtyPolicy: 'head',
  });
  const ctx = resolveLeafMaterialExecutionContext({
    dataDir: suite.dataDir,
    workspaceFolder: suite.repo,
    leafId: leaf.id,
  });
  assert.equal(ctx.mode, 'worktree');
  assert.ok(ctx.worktreeRecord?.worktreePath);
  const withBase = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  assert.equal(withBase?.leafMaterial?.mode, 'worktree');
  assert.ok(withBase?.leafMaterial?.baseCommit);
});

test('checkpoint guard rejects non-todo branch without mutating main', (t) => {
  const suite = makeSuite('guard-branch');
  t.after(suite.cleanup);
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  updateTodo(suite.dataDir, suite.repo, leaf.id, {
    leafMaterial: {
      mode: 'worktree',
      baseCapturedAt: new Date().toISOString(),
      baseCommit: git(suite.repo, ['rev-parse', 'HEAD']).trim(),
    },
  });
  seedReviewPassed(suite.dataDir, suite.repo, leaf.id);
  const mainBefore = git(suite.repo, ['rev-parse', 'HEAD']).trim();
  assert.throws(
    () => assertSafeLeafCheckpointWorktree(suite.repo, 'main'),
    /checkpoint_branch_prefix_rejected|checkpoint_head_branch_mismatch/,
  );
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  assert.equal(git(suite.repo, ['rev-parse', 'HEAD']).trim(), mainBefore, 'main branch HEAD unchanged');
});

test('project manifest hashes symlink-to-dir without throwing', (t) => {
  const suite = makeSuite('symlink-dir');
  t.after(suite.cleanup);
  fs.mkdirSync(path.join(suite.repo, 'linked-dir'), { recursive: true });
  fs.writeFileSync(path.join(suite.repo, 'linked-dir', 'inside.txt'), 'x\n');
  fs.symlinkSync('linked-dir', path.join(suite.repo, 'link-to-dir'));
  git(suite.repo, ['add', 'link-to-dir']);
  git(suite.repo, ['commit', '-qm', 'symlink dir']);
  const manifest = captureProjectLeafManifest(suite.repo);
  assert.ok(manifest['link-to-dir']);
  assert.notEqual(manifest['link-to-dir'], 'deleted');
});

test('worktree partial paths appear in prompt and clear after completed run', (t) => {
  const suite = makeSuite('partial-wt');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'worktree',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const created = ensureWorktree({
    todoId: root.id,
    workspaceFolder: suite.repo,
    mode: 'worktree',
    config,
    registryOptions: { dataDir: suite.dataDir },
    dirtyPolicy: 'head',
  });
  ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  fs.writeFileSync(path.join(created.record.worktreePath, 'partial-wt.js'), 'partial\n');
  updateLeafMaterialPartialPaths({
    dataDir: suite.dataDir,
    workspaceFolder: suite.repo,
    leafId: leaf.id,
    executionFolder: created.record.worktreePath,
    delegation: { assignment: 'implement', status: 'interrupted' },
  });
  const interrupted = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.deepEqual(interrupted.leafMaterial.partialPaths, ['partial-wt.js']);
  const prompt = buildLeafMaterialPromptBlock(interrupted);
  assert.match(prompt, /partial-wt\.js/);
  updateLeafMaterialPartialPaths({
    dataDir: suite.dataDir,
    workspaceFolder: suite.repo,
    leafId: leaf.id,
    executionFolder: created.record.worktreePath,
    delegation: { assignment: 'implement', status: 'completed' },
  });
  const completed = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.equal(completed.leafMaterial.partialPaths, undefined);
});

test('done sibling without review pass records handoff diagnostic on next leaf', (t) => {
  const suite = makeSuite('sibling-gap');
  t.after(suite.cleanup);
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'project',
  }).item;
  addTodo(suite.dataDir, suite.repo, {
    title: 'leaf1',
    parentId: root.id,
    status: 'done',
    siblingIndex: 0,
  });
  const leaf2 = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf2',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 1,
  }).item;
  const withBase = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf2.id });
  assert.equal(withBase?.leafMaterial?.siblingCheckpointGap?.reason, 'previous_sibling_done_without_verified_pass');
  const diag = formatTodoLeafMaterialDiagnostics(withBase);
  assert.match(diag, /sibling_gap=previous_sibling_done_without_verified_pass/);
});

test('project manifest cap persists incomplete capture metadata on leaf base', (t) => {
  const suite = makeSuite('manifest-cap');
  t.after(suite.cleanup);
  const prevCap = process.env.CRETLI_LEAF_MATERIAL_MANIFEST_MAX_PATHS;
  process.env.CRETLI_LEAF_MATERIAL_MANIFEST_MAX_PATHS = '2';
  t.after(() => {
    if (prevCap === undefined) delete process.env.CRETLI_LEAF_MATERIAL_MANIFEST_MAX_PATHS;
    else process.env.CRETLI_LEAF_MATERIAL_MANIFEST_MAX_PATHS = prevCap;
  });
  commitFile(suite.repo, 'one.js', '1\n');
  commitFile(suite.repo, 'two.js', '2\n');
  commitFile(suite.repo, 'three.js', '3\n');
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'project',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const withBase = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  const capture = withBase?.leafMaterial?.baseManifestCapture;
  assert.equal(capture?.incomplete, true);
  assert.equal(capture?.capturedPaths, 2);
  assert.ok(Number(capture?.totalPaths) > 2, 'totalPaths should exceed manifest cap');
  assert.equal(Object.keys(withBase?.leafMaterial?.baseManifest || {}).length, 2);
  const diag = formatTodoLeafMaterialDiagnostics(withBase);
  assert.match(diag, new RegExp(`manifest_incomplete=2/${capture?.totalPaths}`));
  const prompt = buildLeafMaterialPromptBlock(withBase);
  assert.match(prompt, /incomplete/i);
  assert.match(prompt, /do not treat the diff as exhaustive/i);
});

test('watcher worktree policy without live record flags worktreeRecordMissing', (t) => {
  const suite = makeSuite('wt-no-record');
  t.after(suite.cleanup);
  const config = worktreeConfig(suite.baseDir);
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { executionMode: 'worktree', worktree: config },
  }, { dataDir: suite.dataDir });
  const root = addTodo(suite.dataDir, suite.repo, {
    title: 'root',
    status: 'doing',
    executionMode: 'inherit',
  }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, {
    title: 'leaf',
    parentId: root.id,
    status: 'ready',
    siblingIndex: 0,
  }).item;
  const ctx = resolveLeafMaterialExecutionContext({
    dataDir: suite.dataDir,
    workspaceFolder: suite.repo,
    leafId: leaf.id,
  });
  assert.equal(ctx.mode, 'worktree');
  assert.equal(ctx.worktreeRecordMissing, true);
  assert.equal(ctx.executionFolder, suite.repo);
  const withBase = ensureLeafMaterialBase({ dataDir: suite.dataDir, workspaceFolder: suite.repo, leafId: leaf.id });
  assert.equal(withBase?.leafMaterial?.worktreeRecordMissing, true);
  assert.equal(withBase?.leafMaterial?.mode, 'worktree');
  const diag = formatTodoLeafMaterialDiagnostics(withBase);
  assert.match(diag, /worktree_record_missing=true/);
  const prompt = buildLeafMaterialPromptBlock(withBase);
  assert.match(prompt, /missing_worktree_record/);
  updateTodo(suite.dataDir, suite.repo, leaf.id, {
    leafMaterial: {
      ...withBase.leafMaterial,
      baseCapturedAt: withBase.leafMaterial.baseCapturedAt,
    },
  });
  seedReviewPassed(suite.dataDir, suite.repo, leaf.id);
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  const doneLeaf = getTodoById(suite.dataDir, suite.repo, leaf.id);
  assert.match(String(doneLeaf.leafMaterial?.lastCheckpoint?.error || ''), /missing_worktree_record/);
});

test('createWorktreeLeafCheckpoint advances branch tip in isolation', () => {
  const repo = createTempRepo().dir;
  const baseDir = tempDir('cretli-leaf-ckpt-direct-');
  const config = worktreeConfig(baseDir);
  const layoutBranch = `${config.branchPrefix}test-leaf`;
  const worktreePath = path.join(config.root, config.namespace, `${config.directoryPrefix}test-leaf`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo, ['worktree', 'add', '-b', layoutBranch, worktreePath, 'HEAD']);
  commitFile(worktreePath, 'z.js', 'z\n');
  const parent = resolveHeadCommit(worktreePath);
  const result = createWorktreeLeafCheckpoint(worktreePath, 'test-leaf', layoutBranch);
  assert.notEqual(result.commit, parent);
  assert.equal(git(worktreePath, ['rev-parse', 'HEAD']).trim(), result.commit);
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), git(repo, ['rev-parse', 'main']).trim());
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
