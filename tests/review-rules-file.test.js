import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import { readPinnedReviewRulesBlob, resolveRepositoryReviewRules } from '../lib/review-rules-file.js';
import { resolveRunRepositoryReviewRules } from '../lib/delegation-service.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createTempRepo, git } from './helpers/temp-git-repo.js';

function write(repo, text) {
  fs.writeFileSync(`${repo}/REVIEW.md`, text);
  git(repo, ['add', 'REVIEW.md']);
  git(repo, ['commit', '-qm', 'review rules']);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

test('rules stay pinned across a later commit and are stored as a reusable blob', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const pinned = write(repo, 'Pinned rules\n');
  write(repo, 'New rules\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: pinned, baseCommit: pinned }, log: false });
  assert.match(result.block, /Pinned rules/);
  assert.doesNotMatch(result.block, /New rules/);
  assert.equal(await readPinnedReviewRulesBlob(repo, result.blob), result.content);
});

test('missing REVIEW.md produces no rules block', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: git(repo, ['rev-parse', 'HEAD']).trim() }, log: false });
  assert.equal(result.block, '');
});

test('rules are capped at 16 KiB and report the omitted byte count', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const rules = 'x'.repeat(17 * 1024);
  const sha = write(repo, rules);
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: sha }, log: false });
  assert.match(result.block, /\[truncated 1024 bytes\]/);
});

test('leaf REVIEW.md changes warn, while plan review and implement prompts omit repository rules', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = write(repo, 'Rules\n');
  fs.writeFileSync(`${repo}/REVIEW.md`, 'changed\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, mode: 'worktree', leafMaterial: { reviewRulesCommit: sha, baseCommit: sha }, log: false });
  assert.match(result.block, /outside the scope of this review/);
  const prompt = (assignment, reviewSubject) => buildDelegationExecutorPrompt({ sourceKind: 'text', taskText: 'x', assignment, executionMode: 'agent', reviewSubject, repositoryReviewRules: result.block }).prompt;
  assert.match(prompt('review', 'code'), /\[REPOSITORY REVIEW RULES\]/);
  assert.doesNotMatch(prompt('review', 'plan'), /\[REPOSITORY REVIEW RULES\]/);
  assert.doesNotMatch(prompt('implement', 'code'), /\[REPOSITORY REVIEW RULES\]/);
});

test('an unpinned leaf reads HEAD with an explicit fallback line', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(repo, 'Head rules\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: null, log: false });
  assert.match(result.block, /rules read from current HEAD \(no pinned base\)/);
  assert.match(result.block, /Head rules/);
});

test('an unreachable pinned commit never falls back to current HEAD content', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(repo, 'Secret current rules\n');
  const nonexistent = 'f'.repeat(40);
  const old = process.env.CRETLI_TEST_DATA_DIR;
  delete process.env.CRETLI_TEST_DATA_DIR;
  const originalInfo = console.info;
  const messages = [];
  console.info = (...args) => messages.push(args.join(' '));
  try {
    const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: nonexistent }, record: { id: 'review-test' } });
    assert.equal(result.content, `pinned review rules unavailable (${nonexistent})`);
    assert.doesNotMatch(result.content, /Secret current rules/);
    assert.ok(messages.some((line) => line.includes('review-rules-unavailable')));
  } finally {
    console.info = originalInfo;
    if (old !== undefined) process.env.CRETLI_TEST_DATA_DIR = old;
  }
});

test('project manifest changes to REVIEW.md warn the code reviewer', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = write(repo, 'Rules\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, mode: 'project', manifestDelta: ['REVIEW.md'], leafMaterial: { reviewRulesCommit: sha }, log: false });
  assert.match(result.block, /outside the scope of this review/);
});

test('persisted reviewRulesBlob keeps retry prompt pinned after REVIEW.md changes', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const pinned = write(repo, 'Rules from first start\n');
  const created = createDelegationRecord({
    parentChatId: 'parent', childChatId: 'child', workspaceFolder: repo,
    assignment: 'review', reviewSubject: 'code', reviewMode: 'audit',
  });
  const first = await resolveRunRepositoryReviewRules(created, {
    cwd: repo, executionFolder: repo, assignment: 'review',
    leafTodo: { leafMaterial: { mode: 'worktree', baseCommit: pinned, reviewRulesCommit: pinned } },
  });
  updateDelegationRecord(created.id, { reviewRulesBlob: first.blob });
  assert.equal(getDelegationById(created.id).reviewRulesBlob, first.blob);
  write(repo, 'Rules changed after first start\n');
  const retryRow = getDelegationById(created.id);
  const retry = await resolveRunRepositoryReviewRules(retryRow, { cwd: repo, assignment: 'review' });
  const prompt = buildDelegationExecutorPrompt({
    sourceKind: 'text', taskText: 'retry', assignment: 'review', executionMode: 'agent',
    reviewSubject: 'code', repositoryReviewRules: retry.block,
  });
  assert.match(prompt.prompt, /Rules from first start/);
  assert.doesNotMatch(prompt.prompt, /Rules changed after first start/);
});

test('a leaf that adds REVIEW.md warns and the reviewer never sees the new file', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(`${repo}/REVIEW.md`, 'Leaf invented rules\n');
  const untracked = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, mode: 'worktree', leafMaterial: { reviewRulesCommit: sha, baseCommit: sha }, log: false });
  assert.match(untracked.block, /outside the scope of this review/);
  assert.doesNotMatch(untracked.block, /Leaf invented rules/);
  git(repo, ['add', 'REVIEW.md']);
  const staged = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, mode: 'worktree', leafMaterial: { reviewRulesCommit: sha, baseCommit: sha }, log: false });
  assert.match(staged.block, /outside the scope of this review/);
  assert.doesNotMatch(staged.block, /Leaf invented rules/);
});

test('a malformed pinned sha is treated as unreachable and never reaches git', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(repo, 'Secret current rules\n');
  for (const bad of ['HEAD', '--output=/tmp/x', 'abc', 'a'.repeat(12), 'g'.repeat(40)]) {
    const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: bad }, log: false });
    assert.equal(result.content, `pinned review rules unavailable (${bad})`);
    assert.doesNotMatch(result.block, /Secret current rules/);
  }
});

test('an unreadable pinned blob on retry yields the unavailable fallback and a log event', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const missing = 'e'.repeat(40);
  const created = createDelegationRecord({
    parentChatId: 'parent', childChatId: 'child', workspaceFolder: repo,
    assignment: 'review', reviewSubject: 'code', reviewMode: 'audit',
  });
  updateDelegationRecord(created.id, { reviewRulesBlob: missing });
  const row = getDelegationById(created.id);
  const old = process.env.CRETLI_TEST_DATA_DIR;
  delete process.env.CRETLI_TEST_DATA_DIR;
  const originalInfo = console.info;
  const messages = [];
  console.info = (...args) => messages.push(args.join(' '));
  try {
    const retry = await resolveRunRepositoryReviewRules(row, { cwd: repo, assignment: 'review' });
    assert.match(retry.block, /pinned review rules blob unavailable \(e{40}\)/);
    assert.equal(retry.blob, '');
    assert.ok(messages.some((line) => line.includes('review-rules-unavailable') && line.includes('reviewRulesBlob')));
  } finally {
    console.info = originalInfo;
    if (old !== undefined) process.env.CRETLI_TEST_DATA_DIR = old;
  }
});

test('a REVIEW.md added by an earlier sibling gets a neutral note, not the added warning', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const pinned = git(repo, ['rev-parse', 'HEAD']).trim();
  const base = write(repo, 'Sibling rules\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, mode: 'worktree', leafMaterial: { reviewRulesCommit: pinned, baseCommit: base }, log: false });
  assert.match(result.block, /not pinned for this leaf/);
  assert.doesNotMatch(result.block, /outside the scope of this review/);
  assert.doesNotMatch(result.block, /Sibling rules/);
});

test('without leaf material an untracked REVIEW.md never triggers the added warning', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(`${repo}/REVIEW.md`, 'User draft\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, leafMaterial: null, log: false });
  assert.doesNotMatch(result.block, /outside the scope of this review/);
  assert.doesNotMatch(result.block, /User draft/);
});

test('an invalid base commit skips added-detection', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(`${repo}/REVIEW.md`, 'Leaf rules\n');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, executionFolder: repo, mode: 'worktree', leafMaterial: { reviewRulesCommit: sha, baseCommit: '--output=/tmp/x' }, log: false });
  assert.equal(result.block, '');
});

test('rules are found when the workspace is a subdirectory of the repository', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = write(repo, 'Root rules\n');
  fs.mkdirSync(`${repo}/pkg/app`, { recursive: true });
  const result = await resolveRepositoryReviewRules({ workspaceFolder: `${repo}/pkg/app`, executionFolder: `${repo}/pkg/app`, mode: 'worktree', leafMaterial: { reviewRulesCommit: sha, baseCommit: sha }, log: false });
  assert.match(result.block, /Root rules/);
  assert.doesNotMatch(result.block, /outside the scope of this review/);
});

test('a git failure on the pinned commit gives an unavailable block without pinning a blob', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = write(repo, 'Rules\n');
  const loose = `${repo}/.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  fs.chmodSync(loose, 0o644);
  fs.writeFileSync(loose, 'corrupt');
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: sha }, log: false });
  assert.equal(result.blob, '');
  assert.match(result.block, /pinned review rules unavailable/);
});

test('a cleanly missing pinned commit still pins the unavailable block', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const result = await resolveRepositoryReviewRules({ workspaceFolder: repo, leafMaterial: { reviewRulesCommit: 'f'.repeat(40) }, log: false });
  assert.match(result.blob, /^[0-9a-f]{40}$/);
});
