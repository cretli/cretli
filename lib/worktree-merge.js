/**
 * Git-level merge of a task worktree branch into the main working tree.
 *
 * This is the explicit, user-initiated counterpart of the "workspace" smart
 * merge: an agent chat running in the main project folder merges the worktree
 * branch with `git merge`. Everything the server can decide deterministically
 * lives here: the preflight (is the main tree safe to merge into?) and the
 * verification of the outcome an agent reports. An agent report alone is never
 * trusted: `merged` is accepted only when Git proves the branch tip is reachable
 * from the target branch.
 */

import fs from 'node:fs';
import {
  branchExists,
  listDirtyWorktreePaths,
  listWorktreeStatusEntries,
  resolveCommit,
  resolveRepositoryRoot,
  runGit,
} from './worktree/git-worktree.js';
import { collectWorkspaceGitActivity } from './git-switch-guard.js';

/** `integration.mergeMode` value written when an agent merges the branch. */
export const GIT_BRANCH_MERGE_MODE = 'git-branch';

/**
 * @typedef {Object} MergeBlocker
 * @property {string} code
 * @property {string} message
 * @property {string[]} [paths]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * Current branch of the main tree, or '' when HEAD is detached.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function readCurrentBranch(repoRoot) {
  const result = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * Forecast whether merging `branchHead` into HEAD conflicts. Uses
 * `git merge-tree --write-tree`, which never touches the index or work tree.
 * Only committed branch content is considered.
 *
 * @param {string} repoRoot
 * @param {string} branchHead
 * @returns {'none' | 'conflicts' | 'unknown'}
 */
function forecastConflicts(repoRoot, branchHead) {
  const result = runGit(['merge-tree', '--write-tree', '--no-messages', 'HEAD', branchHead], repoRoot, { allowFailure: true });
  if (result.status === 0) return 'none';
  if (result.status === 1) return 'conflicts';
  return 'unknown';
}

/**
 * Inspect the main tree and the worktree branch before a git-level merge. Pure
 * read: nothing is staged, switched or written. The caller decides on
 * `blockers`; the facts are returned either way so a UI can show them.
 *
 * @param {{
 *   workspaceFolder: string,
 *   record: object,
 *   dataDir?: string,
 *   deps?: { collectWorkspaceGitActivity?: typeof collectWorkspaceGitActivity },
 * }} input
 * @returns {{
 *   ok: boolean,
 *   blockers: MergeBlocker[],
 *   repoRoot: string,
 *   targetBranch: string,
 *   targetHead: string,
 *   branch: string,
 *   branchHead: string,
 *   baseCommit: string,
 *   ahead: boolean,
 *   uncommittedFiles: number,
 *   dirtyPaths: string[],
 *   conflictForecast: 'none' | 'conflicts' | 'unknown',
 * }}
 */
export function preflightGitBranchMerge(input) {
  const record = input.record || {};
  const branch = readString(record.branch);
  const baseCommit = readString(record.baseCommit);
  /** @type {MergeBlocker[]} */
  const blockers = [];
  const facts = {
    repoRoot: '',
    targetBranch: '',
    targetHead: '',
    branch,
    branchHead: '',
    baseCommit,
    ahead: false,
    uncommittedFiles: 0,
    dirtyPaths: /** @type {string[]} */ ([]),
    conflictForecast: /** @type {'none' | 'conflicts' | 'unknown'} */ ('unknown'),
  };
  const finish = () => ({ ok: blockers.length === 0, blockers, ...facts });
  try {
    facts.repoRoot = resolveRepositoryRoot(input.workspaceFolder);
  } catch {
    blockers.push({ code: 'repo_unavailable', message: 'The workspace is not a Git repository.' });
    return finish();
  }
  const repoRoot = facts.repoRoot;
  facts.targetBranch = readCurrentBranch(repoRoot);
  facts.targetHead = readString(resolveCommit('HEAD', repoRoot));
  if (!facts.targetBranch) {
    blockers.push({ code: 'detached_head', message: 'The main working tree has a detached HEAD; check out the target branch first.' });
  }
  if (!branch || !branchExists(repoRoot, branch)) {
    blockers.push({ code: 'branch_missing', message: `Worktree branch ${branch || '(none)'} does not exist.` });
  } else {
    facts.branchHead = readString(resolveCommit(`refs/heads/${branch}`, repoRoot));
    facts.ahead = Boolean(facts.branchHead) && facts.branchHead !== baseCommit;
    if (branch === facts.targetBranch) {
      blockers.push({ code: 'same_branch', message: 'The worktree branch is the branch checked out in the main tree.' });
    }
  }
  const worktreePath = readString(record.worktreePath);
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    blockers.push({ code: 'worktree_missing', message: `Worktree directory is missing: ${worktreePath || '(none)'}.` });
  } else {
    try {
      facts.uncommittedFiles = listWorktreeStatusEntries(worktreePath).length;
    } catch {
      facts.uncommittedFiles = 0;
    }
  }
  try {
    facts.dirtyPaths = listDirtyWorktreePaths(repoRoot);
  } catch {
    facts.dirtyPaths = [];
  }
  if (facts.dirtyPaths.length > 0) {
    blockers.push({
      code: 'dirty_workspace',
      message: 'The main working tree has uncommitted changes; commit or stash them before merging.',
      paths: facts.dirtyPaths.slice(0, 50),
    });
  }
  const mergeHead = runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repoRoot, { allowFailure: true });
  if (mergeHead.status === 0) {
    blockers.push({ code: 'merge_in_progress', message: 'A merge is already in progress in the main working tree.' });
  }
  const collect = input.deps?.collectWorkspaceGitActivity || collectWorkspaceGitActivity;
  const activity = collect(repoRoot, input.dataDir ? { dataDir: input.dataDir } : {});
  if (activity.busy) {
    blockers.push({
      code: 'workspace_busy',
      message: `Work is live in the main tree (${activity.runningChats} chat run(s), ${activity.runningDelegations} delegation(s), ${activity.watcherCycles} watcher cycle(s)).`,
    });
  }
  if (facts.ahead && facts.targetBranch) facts.conflictForecast = forecastConflicts(repoRoot, facts.branchHead);
  return finish();
}

/**
 * Verify a reported git-level merge against Git. The worktree changes must be
 * committed on the branch (the branch moved past the frozen base), nothing may
 * be left uncommitted in the worktree, and the branch tip must be an ancestor of
 * the target branch tip.
 *
 * @param {{ workspaceFolder: string, record: object, targetBranch: string }} input
 * @returns {{ ok: true, targetBranch: string, targetCommit: string, sourceCommit: string }
 *   | { ok: false, reason: string, message: string }}
 */
export function verifyGitBranchMerge(input) {
  const record = input.record || {};
  const branch = readString(record.branch);
  const targetBranch = readString(input.targetBranch);
  let repoRoot = '';
  try {
    repoRoot = resolveRepositoryRoot(input.workspaceFolder);
  } catch {
    return { ok: false, reason: 'repo_unavailable', message: 'The workspace is not a Git repository.' };
  }
  if (!targetBranch) return { ok: false, reason: 'target_branch_missing', message: 'No target branch was recorded for this merge.' };
  const branchHead = readString(resolveCommit(`refs/heads/${branch}`, repoRoot));
  const targetCommit = readString(resolveCommit(`refs/heads/${targetBranch}`, repoRoot));
  if (!branchHead || !targetCommit) {
    return { ok: false, reason: 'target_ref_missing', message: 'The worktree branch or the target branch no longer resolves.' };
  }
  if (branchHead === readString(record.baseCommit)) {
    return { ok: false, reason: 'nothing_committed', message: 'The worktree branch has no commits beyond its base; the worktree changes were never committed.' };
  }
  const worktreePath = readString(record.worktreePath);
  if (worktreePath && fs.existsSync(worktreePath)) {
    let leftovers = 0;
    try {
      leftovers = listWorktreeStatusEntries(worktreePath).length;
    } catch {
      leftovers = 0;
    }
    if (leftovers > 0) {
      return { ok: false, reason: 'worktree_uncommitted', message: `${leftovers} change(s) in the worktree were not committed, so they are not part of the merge.` };
    }
  }
  const ancestry = runGit(['merge-base', '--is-ancestor', branchHead, targetCommit], repoRoot, { allowFailure: true });
  if (ancestry.status !== 0) {
    return { ok: false, reason: 'not_merged', message: `Branch ${branch} is not contained in ${targetBranch}.` };
  }
  return { ok: true, targetBranch, targetCommit, sourceCommit: branchHead };
}

/**
 * Prompt for the merge agent. The agent works in the main project folder.
 *
 * @param {{
 *   workspaceFolder: string,
 *   record: object,
 *   preflight: ReturnType<typeof preflightGitBranchMerge>,
 *   changedFiles?: string[],
 *   instructions?: string,
 *   callback: string,
 * }} input
 * @returns {string}
 */
export function buildGitBranchMergePrompt(input) {
  const { record, preflight } = input;
  const files = (input.changedFiles || []).map((file) => `- ${file}`).join('\n') || '- (none recorded)';
  const extra = readString(input.instructions).slice(0, 2000);
  return [
    'Git merge: merge a task worktree branch into the target branch of the main project.',
    '',
    `Main project folder (your working directory): ${input.workspaceFolder}`,
    `Target branch (currently checked out): ${preflight.targetBranch}`,
    `Worktree path: ${readString(record.worktreePath)}`,
    `Worktree branch: ${preflight.branch}`,
    `Base commit of the worktree: ${preflight.baseCommit}`,
    '',
    'Files changed in the worktree:',
    files,
    '',
    'Steps:',
    `1. In the worktree (${readString(record.worktreePath)}) check \`git status\`. Commit every intended change on branch ${preflight.branch} (git add -A, then a clear commit message). Nothing may stay uncommitted there.`,
    `2. In the main project folder run \`git merge --no-ff ${preflight.branch}\` while ${preflight.targetBranch} is checked out.`,
    '3. Resolve any conflicts by understanding the intent of both sides, never by picking one side wholesale. Complete the merge commit.',
    '4. Run the relevant tests/checks and fix what the merge broke.',
    '',
    'Rules:',
    '- This is an explicit user-requested exception to the usual "agents do not commit or merge" rule. It covers ONLY this merge.',
    '- Do NOT push, reset --hard, force anything, stash the user\'s work, delete the worktree or delete the branch.',
    '- Do not switch the main tree to another branch.',
    ...(extra ? ['', 'Additional instructions from the user:', extra] : []),
    '',
    'REPORT THE OUTCOME (required, last step) with this callback; outcome is "merged" or "failed", summary is one short line:',
    input.callback,
  ].join('\n');
}
