import { createHash } from 'node:crypto';
import { isGitOwnershipRefusal, resolveCommit, resolveRepositoryIdentity, resolveRepositoryRoot, runGit } from './worktree/git-worktree.ts';
import { WORKTREE_ERROR_CODES } from './worktree/worktree-errors.ts';

/**
 * Name an ownership refusal explicitly; any other Git failure keeps the
 * caller's fallback reason.
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
function classifyGitFailure(error, fallback) {
  const source = /** @type {{ code?: unknown, message?: unknown }} */ (error);
  if (source?.code === WORKTREE_ERROR_CODES.GIT_OWNERSHIP || isGitOwnershipRefusal(source?.message)) return 'git_ownership';
  return fallback;
}

function readText(/** @type {any} */ value) {
  return String(value ?? '').trim();
}

/**
 * Fingerprint task material and execution generation, excluding cosmetic title
 * and unrelated metadata edits.
 * @param {any} todo
 * @returns {string}
 */
export function fingerprintTodoMaterial(todo) {
  return createHash('sha256').update(JSON.stringify({
    body: String(todo?.body || ''),
    plan: String(todo?.planStoredMarkdown ?? todo?.plan?.markdown ?? ''),
    chatId: readText(todo?.chatId),
    attemptId: readText(todo?.execution?.attemptId),
    cycleId: readText(todo?.execution?.cycleId),
  })).digest('hex');
}

/**
 * Fingerprint the identity and material of every TODO in a tree.
 * @param {any[]} items
 * @param {string} rootId
 * @returns {string}
 */
export function fingerprintTodoTree(items, rootId) {
  const rows = Array.isArray(items) ? items : [];
  const byId = new Map(rows.map((row) => [readText(row?.id), row]));
  const root = readText(rootId);
  const included = new Set();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop();
    if (!id || included.has(id) || !byId.has(id)) continue;
    included.add(id);
    for (const row of rows) {
      if (readText(row?.parentId) === id) pending.push(readText(row?.id));
    }
  }
  const material = [...included].sort().map((id) => ({
    id,
    parentId: readText(byId.get(id)?.parentId),
    fingerprint: fingerprintTodoMaterial(byId.get(id)),
  }));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/**
 * Build a one-click proof from the workspace itself: the current local branch,
 * its HEAD commit, and the human's click as the attestation. This reads Git
 * only. A detached HEAD cannot name a target branch, so it is refused.
 * @param {{ workspaceFolder: string, executionFolder?: string, todoId: string, materialRevision?: string, scope?: string }} input
 * @returns {{ ok: true, proof: any } | { ok: false, reason: string }}
 */
export function deriveSimpleTodoIntegrationProof(input) {
  try {
    if (input.executionFolder && !todoRepositoryMatches(input.workspaceFolder, input.executionFolder)) {
      return { ok: false, reason: 'repository_mismatch' };
    }
    const repoRoot = resolveRepositoryRoot(input.workspaceFolder);
    // runGit scopes safe.directory to this checkout, so a repo owned by another
    // uid than the server ("dubious ownership") still resolves.
    const branch = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, { timeoutMs: 5000 }).stdout.trim();
    const head = resolveCommit('HEAD', repoRoot);
    if (!branch || !head) return { ok: false, reason: 'target_ref_missing' };
    return {
      ok: true,
      proof: {
        targetBranch: branch,
        targetCommit: head,
        sourceCommit: head,
        materialRevision: readText(input.materialRevision) || head,
        changeRef: `manual confirmation: TODO ${readText(input.todoId)} on ${branch}@${head.slice(0, 12)}`,
        changeAttested: true,
        scope: readText(input.scope) === 'tree' ? 'tree' : 'task',
      },
    };
  } catch (error) {
    return { ok: false, reason: classifyGitFailure(error, 'target_ref_missing') };
  }
}

/**
 * Resolve an operator's commit assertion on the workspace target branch. Squash
 * commits attest to the task change, so the source worktree HEAD need not be an
 * ancestor. Git reachability verifies the assertion's destination only.
 * @param {{ workspaceFolder: string, executionFolder?: string, todoId: string, commit: string, materialRevision?: string, scope?: string }} input
 * @returns {{ ok: true, proof: any } | { ok: false, reason: string }}
 */
export function deriveCommittedTodoIntegrationProof(input) {
  const commit = readText(input.commit);
  if (!/^[a-f0-9]{4,64}$/i.test(commit)) return { ok: false, reason: 'invalid_commit' };
  const derived = deriveSimpleTodoIntegrationProof(input);
  if (!derived.ok) return derived;
  try {
    const repoRoot = resolveRepositoryRoot(input.workspaceFolder);
    const targetCommit = resolveCommit(commit, repoRoot);
    if (!targetCommit) return { ok: false, reason: 'target_ref_missing' };
    const branches = runGit(['branch', '--contains', targetCommit, '--format=%(refname)'], repoRoot, { timeoutMs: 5000 }).stdout.split('\n').map(readText);
    if (!branches.includes(`refs/heads/${derived.proof.targetBranch}`)) {
      return { ok: false, reason: 'target_commit_not_on_branch' };
    }
    return { ok: true, proof: {
      ...derived.proof,
      targetCommit,
      sourceCommit: targetCommit,
      materialRevision: readText(input.materialRevision) || targetCommit,
      changeRef: `operator confirmation: TODO ${readText(input.todoId)} in ${targetCommit}`,
    } };
  } catch (error) {
    return { ok: false, reason: classifyGitFailure(error, 'target_ref_missing') };
  }
}

/** Compare repository identity, treating a linked worktree as the same repository. */
export function todoRepositoryMatches(workspaceFolder, executionFolder = workspaceFolder) {
  const workspace = resolveRepositoryIdentity(workspaceFolder);
  const execution = resolveRepositoryIdentity(executionFolder);
  return Boolean(workspace && execution && workspace.commonDir === execution.commonDir);
}

/**
 * Validate a human supplied task-to-commit assertion against the named local
 * branch. This reads Git only; it never updates refs or the working tree.
 * @param {{ workspaceFolder: string, executionFolder?: string, requireHeadMatch?: boolean, targetBranch: unknown, targetCommit: unknown, sourceCommit: unknown, materialRevision: unknown, changeRef: unknown, changeAttested: unknown, scope?: unknown, todoId?: unknown, todoItems?: any[], cycleId?: unknown, source?: string, now?: string }} input
 * @returns {{ ok: true, evidence: any } | { ok: false, reason: string }}
 */
export function verifyTodoIntegrationProof(input) {
  const targetBranch = readText(input.targetBranch);
  const targetCommitInput = readText(input.targetCommit);
  const sourceCommitInput = readText(input.sourceCommit);
  const materialRevision = readText(input.materialRevision);
  const changeRef = readText(input.changeRef);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(targetBranch)
    || targetBranch.includes('..') || targetBranch.endsWith('/') || targetBranch.endsWith('.lock')) {
    return { ok: false, reason: 'invalid_target_branch' };
  }
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(targetCommitInput)
    || !/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(sourceCommitInput)) {
    return { ok: false, reason: 'full_commit_required' };
  }
  if (!materialRevision || !changeRef || input.changeAttested !== true) {
    return { ok: false, reason: 'task_change_link_required' };
  }
  try {
    if (input.executionFolder && !todoRepositoryMatches(input.workspaceFolder, input.executionFolder)) {
      return { ok: false, reason: 'repository_mismatch' };
    }
    const repoRoot = resolveRepositoryRoot(input.workspaceFolder);
    const targetCommit = resolveCommit(targetCommitInput, repoRoot);
    const sourceCommit = resolveCommit(sourceCommitInput, repoRoot);
    const branchCommit = resolveCommit(`refs/heads/${targetBranch}`, repoRoot);
    if (!targetCommit || !sourceCommit || !branchCommit) return { ok: false, reason: 'target_ref_missing' };
    if (input.requireHeadMatch === true && resolveCommit('HEAD', repoRoot) !== targetCommit) {
      return { ok: false, reason: 'target_head_mismatch' };
    }
    runGit(['merge-base', '--is-ancestor', targetCommit, branchCommit], repoRoot, { timeoutMs: 5000 });
    return {
      ok: true,
      evidence: {
        targetBranch,
        targetCommit,
        sourceCommit,
        materialRevision,
        cycleId: readText(input.cycleId),
        source: readText(input.source) || 'human_project',
        confirmedAt: readText(input.now) || new Date().toISOString(),
        changeRef: changeRef.slice(0, 500),
        changeAttested: true,
        branchVerified: true,
        verification: 'target_commit_reachable_from_local_branch',
        ...(readText(input.scope) === 'tree' ? {
          scope: 'tree',
          treeMaterialFingerprint: fingerprintTodoTree(/** @type {any} */ (input.todoItems), /** @type {any} */ (input.todoId)),
        } : {}),
      },
    };
  } catch (error) {
    return { ok: false, reason: classifyGitFailure(error, 'target_commit_not_on_branch') };
  }
}
