import { createHash, randomBytes } from 'crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import {
  isGitRepo,
  normalizeGitArg,
  parseGitStatusBranchLine,
  runGitCommand,
  runGitCommandAsync,
} from '../git-cli.js';
import { collectWorkspaceGitActivity } from '../git-switch-guard.js';
import { getGithubRemoteFromCwd, listWorkflowRuns, listWorkflowRunJobs, fetchWorkflowJobLogs } from '../github.js';
import { getGithubTokenMetaForClient } from '../github-token.js';
import { msg } from '../messages.js';
import { resolveGitRequestContext, resolvePathWithinBase } from '../git-context.js';

/**
 * @typedef {Object} GitRoutesContext
 * @property {() => string} getCurrentCwd
 * @property {string} [dataDir]
 * @property {(req: import('express').Request) => Record<string, any>} [resolveScope]
 * @property {{ beforeStage?: Function, afterVerify?: Function, beforeUpdateRef?: Function, beforeIndexWrite?: Function }} [commitHooks] test seams of the commit route
 *   (each receives the repository root and runs at that point of the flow)
 * @property {Record<string, any>} [gitGuardDeps] injectable registry readers for
 *   `collectWorkspaceGitActivity` (tests); production uses the durable stores
 */

/** Actions that rewrite the main working tree, so the busy-work guard applies. */
const GUARDED_GIT_ACTIONS = new Set(['switch', 'switch-new']);

/** Upper bound of a (dictated) commit message. */
const GIT_COMMIT_MESSAGE_MAX = 500;
/** Per-step limits so a slow hook or signing prompt cannot hold the request forever. */
const GIT_COMMIT_STEP_TIMEOUT_MS = 30_000;
const GIT_COMMIT_TIMEOUT_MS = 90_000;
/** Files above this size are never committed by voice. */
const GIT_COMMIT_LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** Basenames that look like secrets; templates (`.env.example`) are exempt. */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^credentials/i,
  /^secrets?\./i,
  /^\.(netrc|htpasswd)$/i,
];
const TEMPLATE_FILE_SUFFIX = /\.(example|sample|template|dist)$/i;

/**
 * @param {string} name file path (any directory)
 * @returns {boolean}
 */
export function looksLikeSecretFile(name) {
  const base = String(name || '').split('/').pop() || '';
  if (TEMPLATE_FILE_SUFFIX.test(base)) return false;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * @param {{ stderr?: string, stdout?: string, error?: string }} result
 * @param {string} fallback
 * @returns {string}
 */
function gitFailure(result, fallback) {
  return (result.stderr || result.stdout || result.error || '').trim() || fallback;
}

/**
 * Splits `git <args> -- <paths>` into argv-sized chunks (hash-object / ls-files take paths as arguments).
 *
 * @param {string[]} paths
 * @param {number} [size]
 * @returns {string[][]}
 */
function chunkPaths(paths, size = 100) {
  const chunks = [];
  for (let index = 0; index < paths.length; index += size) chunks.push(paths.slice(index, index + size));
  return chunks;
}

/** State files of a merge, cherry-pick, revert or rebase that a plain one-parent commit would silently break. */
const GIT_OPERATION_STATE_FILES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
/** Porcelain v1 states of an unmerged path. */
const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Whether a merge / cherry-pick / revert / rebase is in progress. The voice commit is a single-parent
 * `commit-tree`: it must never record conflict markers as a normal commit or reset the conflict stages.
 *
 * @param {string} cwd
 * @returns {Promise<boolean>} true also when git cannot tell (fail closed)
 */
async function isGitOperationInProgress(cwd) {
  const argv = ['rev-parse', ...GIT_OPERATION_STATE_FILES.flatMap((name) => ['--git-path', name])];
  const paths = await runGitCommandAsync(argv, cwd, { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS });
  if (!paths.ok) return true;
  return (paths.stdout || '').split('\n').filter(Boolean).some((line) => existsSync(path.resolve(cwd, line.trim())));
}

/**
 * Whether the repository demands signed commits. `commit-tree` ignores `commit.gpgsign`, so a voice commit would
 * silently be unsigned; the voice path refuses instead of trying to sign.
 *
 * @param {string} cwd
 * @returns {Promise<boolean>} true also when git cannot tell (fail closed); an unset key is exit status 1
 */
async function isSigningRequired(cwd) {
  const result = await runGitCommandAsync(['config', '--bool', 'commit.gpgsign'], cwd, { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS });
  if (result.ok) return (result.stdout || '').trim() === 'true';
  return result.status !== 1;
}

/**
 * Exact content a voice commit would capture. `git status --porcelain=v1 -uall -z` lists the paths (untracked
 * directories expanded to files); every path is bound by `(path, git hash-object of the current content or a
 * deletion marker, mode)` and the sha256 over those tuples is the fingerprint. The commit route stages only these
 * paths and compares the staged blobs to this plan, so a file edited after the question can never slip in.
 *
 * @param {string} cwd
 * @returns {Promise<{ ok: true, root: string, fingerprint: string, changed: number, untracked: number, sensitiveFiles: number, largeFiles: number, unsupportedFiles: number, partiallyStaged: number, signingRequired: boolean, operationInProgress: boolean, items: Array<{ path: string, kind: 'add' | 'delete', hash: string, mode: string }> } | { ok: false, error: string }>}
 */
export async function readCommitPlan(cwd) {
  const [status, top] = await Promise.all([
    runGitCommandAsync(['status', '--porcelain=v1', '-uall', '-z'], cwd, { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS }),
    runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd),
  ]);
  if (!status.ok) return { ok: false, error: gitFailure(status, 'git command failed.') };
  const root = (top.stdout || '').trim() || cwd;
  const tokens = (status.stdout || '').split('\0').filter(Boolean);
  /** @type {Array<{ xy: string, path: string }>} */
  const entries = [];
  /** @type {Set<string>} */
  const renamedAway = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const xy = tokens[index].slice(0, 2);
    entries.push({ xy, path: tokens[index].slice(3) });
    // A rename / copy carries its source path as the next token; a rename also removes the source.
    if (/[RC]/.test(xy)) {
      index += 1;
      if (xy.includes('R') && tokens[index]) renamedAway.add(tokens[index]);
    }
  }
  const paths = [...new Set([...entries.map((entry) => entry.path), ...renamedAway])];
  let sensitiveFiles = 0;
  let largeFiles = 0;
  let unsupportedFiles = 0;
  /** @type {Array<{ path: string, kind: 'add' | 'delete', hash: string, mode: string }>} */
  const items = [];
  const toHash = [];
  for (const entryPath of paths) {
    let stat = null;
    try {
      stat = lstatSync(path.join(root, entryPath));
    } catch {
      stat = null;
    }
    if (!stat) {
      items.push({ path: entryPath, kind: 'delete', hash: '', mode: '' });
      continue;
    }
    // Symlinks and nested repositories are not committed by voice (their blob is not the file content).
    if (stat.isSymbolicLink() || !stat.isFile()) {
      unsupportedFiles += 1;
      continue;
    }
    if (looksLikeSecretFile(entryPath)) sensitiveFiles += 1;
    if (stat.size > GIT_COMMIT_LARGE_FILE_BYTES) largeFiles += 1;
    items.push({ path: entryPath, kind: 'add', hash: '', mode: stat.mode & 0o111 ? '100755' : '100644' });
    toHash.push(entryPath);
  }
  const hashes = new Map();
  for (const chunk of chunkPaths(toHash)) {
    const hashed = await runGitCommandAsync(['--literal-pathspecs', 'hash-object', '--', ...chunk], root, { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS });
    const lines = (hashed.stdout || '').split('\n').filter(Boolean);
    if (!hashed.ok || lines.length !== chunk.length) return { ok: false, error: gitFailure(hashed, 'git hash-object failed.') };
    chunk.forEach((entryPath, index) => hashes.set(entryPath, lines[index]));
  }
  for (const item of items) if (item.kind === 'add') item.hash = hashes.get(item.path) || '';
  items.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const item of items) hash.update(`${item.kind}\0${item.path}\0${item.hash}\0${item.mode}\n`);
  const untracked = entries.filter((entry) => entry.xy === '??').length;
  // Staged AND modified again in the working tree: the commit takes the working copy, so the staged version would be lost.
  const partiallyStaged = entries.filter((entry) => !UNMERGED_XY.has(entry.xy) && !' ?!'.includes(entry.xy[0]) && entry.xy[1] !== ' ').length;
  const signingRequired = await isSigningRequired(root);
  const operationInProgress = entries.some((entry) => UNMERGED_XY.has(entry.xy)) || await isGitOperationInProgress(root);
  return {
    ok: true,
    root,
    fingerprint: hash.digest('hex'),
    changed: entries.length - untracked,
    untracked,
    sensitiveFiles,
    largeFiles,
    unsupportedFiles,
    partiallyStaged,
    signingRequired,
    operationInProgress,
    items,
  };
}

/**
 * Runs a cleanup step whose failure must not replace the real outcome (a commit that already moved HEAD).
 *
 * @param {() => void} step
 */
function bestEffort(step) {
  try {
    step();
  } catch {
    // Leftover temp files are harmless; hiding a successful commit is not.
  }
}

/**
 * After the ref moved, the committed paths in the user's real index still hold the old HEAD blobs and would show
 * as staged reverts. They are refreshed under git's own index lock, so no other git command can write the index
 * between the inspection and the write: `index.lock` is created exclusively, a scratch copy of the index is
 * inspected and reset there, then written through the lock and renamed over the index (git's writer protocol).
 * A path whose entry is neither HEAD's nor the committed blob was staged by the user: it is left alone and
 * reported. When the lock is held by someone else nothing is touched (the commit itself already succeeded).
 *
 * @param {Awaited<ReturnType<typeof readCommitPlan>> & { ok: true }} plan
 * @param {string} oldHead
 * @param {GitRoutesContext['commitHooks']} hooks test seams
 * @returns {Promise<{ refreshed: boolean, stale: number }>}
 */
async function refreshRealIndexLocked(plan, oldHead, hooks) {
  const options = { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS };
  const allPaths = plan.items.map((item) => item.path);
  const indexPath = await runGitCommandAsync(['rev-parse', '--git-path', 'index'], plan.root, options);
  const scratchPath = await runGitCommandAsync(['rev-parse', '--git-path', `cretli-voice-refresh-${randomBytes(6).toString('hex')}`], plan.root, options);
  if (!indexPath.ok || !scratchPath.ok) return { refreshed: false, stale: allPaths.length };
  const realIndex = path.resolve(plan.root, (indexPath.stdout || '').trim());
  const lockPath = `${realIndex}.lock`;
  const scratch = path.resolve(plan.root, (scratchPath.stdout || '').trim());
  let lockFd = null;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch {
    // Another git process is writing the index right now: never wait on it or steal its lock.
    return { refreshed: false, stale: allPaths.length };
  }
  let lockOwned = true;
  try {
    if (existsSync(realIndex)) copyFileSync(realIndex, scratch);
    const scratchEnv = { env: { GIT_INDEX_FILE: scratch }, ...options };
    const entryKey = (entry) => (entry ? `${entry.mode} ${entry.hash}` : '');
    const headEntries = new Map();
    const realEntries = new Map();
    for (const chunk of chunkPaths(allPaths)) {
      const real = await runGitCommandAsync(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk], plan.root, scratchEnv);
      const tree = oldHead ? await runGitCommandAsync(['--literal-pathspecs', 'ls-tree', '-z', oldHead, '--', ...chunk], plan.root, options) : { ok: true, stdout: '' };
      if (!real.ok || !tree.ok) return { refreshed: false, stale: allPaths.length };
      for (const record of (real.stdout || '').split('\0').filter(Boolean)) {
        const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
        if (match) realEntries.set(match[4], { mode: match[1], hash: match[2], stage: match[3] });
      }
      for (const record of (tree.stdout || '').split('\0').filter(Boolean)) {
        const match = record.match(/^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s);
        if (match) headEntries.set(match[3], { mode: match[1], hash: match[2] });
      }
    }
    const resettable = [];
    let stale = 0;
    for (const item of plan.items) {
      const entry = realEntries.get(item.path);
      const real = entryKey(entry);
      const committed = item.kind === 'delete' ? '' : `${item.mode} ${item.hash}`;
      const known = (!entry || entry.stage === '0') && (real === committed || real === entryKey(headEntries.get(item.path)));
      if (known) resettable.push(item.path);
      else stale += 1;
    }
    for (const chunk of chunkPaths(resettable)) {
      const reset = await runGitCommandAsync(['--literal-pathspecs', 'reset', '-q', '--', ...chunk], plan.root, scratchEnv);
      if (!reset.ok) return { refreshed: false, stale: allPaths.length };
    }
    await hooks?.beforeIndexWrite?.(plan.root);
    // git's writer protocol: the new content goes into the lock file, which is then renamed over the index.
    writeFileSync(lockFd, readFileSync(scratch));
    closeSync(lockFd);
    lockFd = null;
    renameSync(lockPath, realIndex);
    lockOwned = false;
    return { refreshed: stale === 0, stale };
  } catch {
    // The commit already moved HEAD: a failed refresh must not turn it into an error, only leave the index as it was.
    return { refreshed: false, stale: allPaths.length };
  } finally {
    if (lockFd !== null) bestEffort(() => closeSync(lockFd));
    if (lockOwned) bestEffort(() => rmSync(lockPath, { force: true }));
    bestEffort(() => rmSync(scratch, { force: true }));
    bestEffort(() => rmSync(`${scratch}.lock`, { force: true }));
  }
}

/**
 * Builds the voice commit in a TEMPORARY index and never touches the user's real index while doing so:
 * `read-tree HEAD` into the temp index, stage only the planned paths there, prove it holds exactly the planned
 * blobs and modes, then `write-tree` + `commit-tree` + a compare-and-swap `update-ref`. Only after the ref moved
 * are the committed paths refreshed in the real index (`reset -q -- <paths>`, index only). Hooks do not run on
 * this path and the configured author is used.
 *
 * @param {Awaited<ReturnType<typeof readCommitPlan>> & { ok: true }} plan
 * @param {string} message
 * @param {GitRoutesContext['commitHooks']} hooks test seams
 * @returns {Promise<{ ok: true, head: string, indexRefreshed: boolean, staleIndexPaths?: number } | { ok: false, code: string, error: string }>}
 */
async function commitPlannedPaths(plan, message, hooks) {
  const options = { timeoutMs: GIT_COMMIT_STEP_TIMEOUT_MS };
  const fail = (code, error) => ({ ok: false, code, error });
  const gitPath = await runGitCommandAsync(['rev-parse', '--git-path', `cretli-voice-index-${randomBytes(6).toString('hex')}`], plan.root, options);
  if (!gitPath.ok) return fail('add_failed', gitFailure(gitPath, 'git command failed.'));
  const tempIndex = path.resolve(plan.root, (gitPath.stdout || '').trim());
  const indexEnv = { env: { GIT_INDEX_FILE: tempIndex }, ...options };
  try {
    // Checked again here: a merge or rebase may have started after the plan was read.
    if (await isGitOperationInProgress(plan.root)) return fail('operation_in_progress', 'A merge or rebase is in progress. Nothing was committed.');
    const head = await runGitCommandAsync(['rev-parse', '--verify', '-q', 'HEAD'], plan.root, options);
    const oldHead = head.ok ? (head.stdout || '').trim() : '';
    const seeded = await runGitCommandAsync(oldHead ? ['read-tree', oldHead] : ['read-tree', '--empty'], plan.root, indexEnv);
    if (!seeded.ok) return fail('add_failed', gitFailure(seeded, 'git read-tree failed.'));
    await hooks?.beforeStage?.(plan.root);

    const adds = plan.items.filter((item) => item.kind === 'add').map((item) => item.path);
    const removes = plan.items.filter((item) => item.kind === 'delete').map((item) => item.path);
    for (const chunk of chunkPaths(adds)) {
      const staged = await runGitCommandAsync(['--literal-pathspecs', 'add', '--', ...chunk], plan.root, indexEnv);
      if (!staged.ok) return fail(staged.timedOut ? 'timeout' : 'add_failed', gitFailure(staged, 'git add failed.'));
    }
    for (const chunk of chunkPaths(removes)) {
      const removed = await runGitCommandAsync(['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '-q', '--', ...chunk], plan.root, indexEnv);
      if (!removed.ok) return fail(removed.timedOut ? 'timeout' : 'add_failed', gitFailure(removed, 'git rm failed.'));
    }
    const changed = (error) => fail('tree_changed', error);
    // Anything that differs from HEAD outside the plan means the tree moved under us.
    const diff = await runGitCommandAsync(['diff', '--cached', '--name-only', '--no-renames', '-z'], plan.root, indexEnv);
    if (!diff.ok) return fail('add_failed', gitFailure(diff, 'git diff failed.'));
    const planned = new Set(plan.items.map((item) => item.path));
    if ((diff.stdout || '').split('\0').filter(Boolean).some((entryPath) => !planned.has(entryPath))) {
      return changed('Other files differ from HEAD. Nothing was committed.');
    }
    // Every planned path must hold exactly the planned blob and mode (or be absent for a deletion).
    const indexed = new Map();
    for (const chunk of chunkPaths(plan.items.map((item) => item.path))) {
      const listing = await runGitCommandAsync(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk], plan.root, indexEnv);
      if (!listing.ok) return fail('add_failed', gitFailure(listing, 'git ls-files failed.'));
      for (const record of (listing.stdout || '').split('\0').filter(Boolean)) {
        const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
        if (match) indexed.set(match[4], { mode: match[1], hash: match[2], stage: match[3] });
      }
    }
    for (const item of plan.items) {
      const entry = indexed.get(item.path);
      if (item.kind === 'delete' ? entry : !entry || entry.hash !== item.hash || entry.mode !== item.mode || entry.stage !== '0') {
        return changed('A file changed while it was being staged. Nothing was committed.');
      }
    }
    // The checks that matter run again on what is really staged.
    const added = await runGitCommandAsync(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=d', '-z'], plan.root, indexEnv);
    if (!added.ok) return fail('add_failed', gitFailure(added, 'git diff failed.'));
    const addedPaths = (added.stdout || '').split('\0').filter(Boolean);
    if (addedPaths.some(looksLikeSecretFile)) return fail('sensitive_files', 'Some changes look like secrets.');
    if (addedPaths.length > 0) {
      const blobIds = addedPaths.map((entryPath) => indexed.get(entryPath)?.hash || '');
      if (blobIds.some((id) => !/^[0-9a-f]+$/.test(id))) return fail('add_failed', 'A staged file has no blob id. Nothing was committed.');
      // One process for all files; a missing object or an unparsable line is a refusal, never a pass.
      const sizes = await runGitCommandAsync(['cat-file', '--batch-check=%(objectname) %(objectsize)'], plan.root, { ...options, input: `${blobIds.join('\n')}\n` });
      if (!sizes.ok) return fail(sizes.timedOut ? 'timeout' : 'add_failed', gitFailure(sizes, 'git cat-file failed.'));
      const lines = (sizes.stdout || '').split('\n').filter(Boolean);
      if (lines.length !== blobIds.length) return fail('add_failed', 'git cat-file returned an unexpected answer. Nothing was committed.');
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^([0-9a-f]+) (\d+)$/);
        if (!match || match[1] !== blobIds[index]) return fail('add_failed', 'git cat-file could not size a staged file. Nothing was committed.');
        if (Number(match[2]) > GIT_COMMIT_LARGE_FILE_BYTES) return fail('large_files', 'Some changes are very large files.');
      }
    }
    await hooks?.afterVerify?.(plan.root);

    const tree = await runGitCommandAsync(['write-tree'], plan.root, indexEnv);
    if (!tree.ok) return fail('commit_failed', gitFailure(tree, 'git write-tree failed.'));
    // The message is one argv entry (no shell), so quotes and leading dashes in it are inert.
    const created = await runGitCommandAsync(
      ['commit-tree', (tree.stdout || '').trim(), ...(oldHead ? ['-p', oldHead] : []), '-m', message], plan.root, { timeoutMs: GIT_COMMIT_TIMEOUT_MS },
    );
    if (!created.ok) {
      const text = gitFailure(created, 'git commit-tree failed.');
      return fail(created.timedOut ? 'timeout' : /ident|who you are|user\.(name|email)/i.test(text) ? 'identity_missing' : 'commit_failed', text);
    }
    const commitId = (created.stdout || '').trim();
    await hooks?.beforeUpdateRef?.(plan.root);
    // Compare-and-swap: refuses when HEAD moved since the plan (an unborn branch expects the null id).
    // The null id has the length of the repository's object ids (40 for SHA-1, 64 for SHA-256).
    const moved = await runGitCommandAsync(['update-ref', '-m', 'commit (voice)', 'HEAD', commitId, oldHead || '0'.repeat(commitId.length)], plan.root, options);
    if (!moved.ok) return fail('head_moved', 'HEAD moved while committing. Nothing was committed.');
    const refresh = await refreshRealIndexLocked(plan, oldHead, hooks);
    return { ok: true, head: commitId.slice(0, 7), indexRefreshed: refresh.refreshed, ...(refresh.stale ? { staleIndexPaths: refresh.stale } : {}) };
  } finally {
    bestEffort(() => rmSync(tempIndex, { force: true }));
    bestEffort(() => rmSync(`${tempIndex}.lock`, { force: true }));
  }
}

/**
 * A voice commit is refused inside a Cretli-managed task worktree and while chats, delegations or a Watcher
 * cycle still work in the folder (it would capture half-finished work).
 *
 * @param {import('express').Request} req
 * @param {Record<string, any>} context resolved scope
 * @param {string} cwd
 * @param {GitRoutesContext} ctx
 * @returns {Promise<Record<string, any> | null>} a refusal body, or null when the commit may go on
 */
async function refuseBusyCommit(req, context, cwd, ctx) {
  if (context.isWorktree === true) {
    return { ok: false, code: 'workspace_busy', error: msg(req, 'git.commitWorktree') };
  }
  const topLevel = runGitCommand(['rev-parse', '--show-toplevel'], cwd);
  const activity = await collectWorkspaceGitActivity(topLevel.stdout?.trim() || cwd, { dataDir: ctx.dataDir, deps: ctx.gitGuardDeps });
  if (!activity.busy) return null;
  return {
    ok: false,
    code: 'workspace_busy',
    error: msg(req, 'git.commitBusy', { chats: activity.runningChats, delegations: activity.runningDelegations, watcher: activity.watcherCycles }),
  };
}

/**
 * Parse `git for-each-ref --format='%(refname:short)%09%(HEAD)' refs/heads`.
 * A tab separator is used because it can never occur inside a ref name.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, current: boolean, argSafe: boolean }>}
 */
export function parseGitBranchRefs(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tabIndex = line.indexOf('\t');
      const name = (tabIndex > -1 ? line.slice(0, tabIndex) : line).trim();
      const marker = tabIndex > -1 ? line.slice(tabIndex + 1).trim() : '';
      return {
        name,
        current: marker === '*',
        // normalizeGitArg is the same allow-list the run action enforces, so a
        // name rejected there is rendered disabled instead of failing later.
        argSafe: Boolean(name) && normalizeGitArg(name) === name,
      };
    })
    .filter((branch) => branch.name !== '');
}

/**
 * Resolve the authorized Git context for a request. The default resolver reads
 * durable chat / TODO records; tests may inject `ctx.resolveScope`.
 *
 * @param {import('express').Request} req
 * @param {GitRoutesContext} ctx
 * @returns {Promise<{ ok: true, context: Record<string, any> } | { ok: false, status: number, body: Record<string, any> }>}
 */
async function resolveScope(req, ctx) {
  const resolver = typeof ctx.resolveScope === 'function' ? ctx.resolveScope : null;
  /** @type {Record<string, any>} */
  const result = resolver
    ? await resolver(req)
    : await resolveGitRequestContext(req, { dataDir: ctx.dataDir, getCurrentCwd: ctx.getCurrentCwd });
  if (result?.ok) return { ok: true, context: result };
  const code = String(result?.code || 'scope_error');
  const status = code === 'chat_not_found' || code === 'todo_not_found'
    ? 404
    : code === 'context_conflict'
      ? 409
      : 400;
  return { ok: false, status, body: { ok: false, code, error: result?.error || 'Invalid Git context.' } };
}

/**
 * Trimmed scope fields shared by every response so the UI can tell the main
 * project apart from a task worktree.
 *
 * @param {Record<string, any>} context
 * @returns {Record<string, any>}
 */
function scopeSummary(context) {
  return {
    source: context.source,
    chatId: context.chatId || '',
    todoId: context.todoId || '',
    workspaceFolder: context.workspaceFolder || '',
    executionFolder: context.executionFolder || '',
    isWorktree: context.isWorktree === true,
    worktree: context.worktree || null,
    todo: context.todo || null,
    chat: context.chat || null,
  };
}

/**
 * @param {string} cwd
 */
function resolveGithubRepoFromCwd(cwd) {
  if (!isGitRepo(cwd)) {
    return { ok: false, cwd, isRepo: false, isGithub: false };
  }
  const remote = getGithubRemoteFromCwd(runGitCommand, cwd);
  if (!remote) {
    return { ok: true, cwd, isRepo: true, isGithub: false };
  }
  return {
    ok: true,
    cwd,
    isRepo: true,
    isGithub: true,
    owner: remote.owner,
    repo: remote.repo,
    remoteUrl: remote.remoteUrl,
    htmlUrl: remote.htmlUrl,
    ...getGithubTokenMetaForClient(),
  };
}

/** Short TTL: the signature below cannot see unstaged edits, so bound staleness in time. */
const GIT_INFO_TTL_MS = 2000;
const GIT_INFO_CACHE_MAX = 64;
/** @type {Map<string, { at: number, signature: string, info: Record<string, any> | null }>} */
const gitInfoCache = new Map();
/** @type {Map<string, Promise<Record<string, any> | null>>} */
const gitInfoInflight = new Map();

/**
 * Cheap change signature: mtimes of the git dir's HEAD and index (async stat).
 *
 * @param {string} gitDir
 * @returns {Promise<string>}
 */
async function gitStateSignature(gitDir) {
  const mtime = async (/** @type {string} */ name) => {
    try {
      return (await fsp.stat(path.join(gitDir, name))).mtimeMs;
    } catch {
      return 0;
    }
  };
  const [head, index] = await Promise.all([mtime('HEAD'), mtime('index')]);
  return `${head}:${index}`;
}

/**
 * @param {string} cwd
 * @returns {Promise<Record<string, any> | null>} null when cwd is not a git repo
 */
async function computeGitInfo(cwd) {
  const [inside, status, head, top, gitDir] = await Promise.all([
    runGitCommandAsync(['rev-parse', '--is-inside-work-tree'], cwd),
    runGitCommandAsync(['status', '--porcelain=v1', '-b'], cwd),
    runGitCommandAsync(['rev-parse', '--short', 'HEAD'], cwd),
    runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd),
    runGitCommandAsync(['rev-parse', '--absolute-git-dir'], cwd),
  ]);
  if (!inside.ok || (inside.stdout || '').trim() !== 'true') return null;
  const lines = (status.stdout || '').split('\n').filter(Boolean);
  const branchLine = lines.find((l) => l.startsWith('## ')) || '';
  const { branch, upstream, aheadBehind } = parseGitStatusBranchLine(branchLine);
  return {
    topLevel: (top.stdout || '').trim(),
    branch,
    upstream,
    aheadBehind,
    head: (head.stdout || '').trim(),
    statusShort: lines.filter((l) => !l.startsWith('## ')),
    gitDir: (gitDir.stdout || '').trim(),
  };
}

/**
 * Cached, non-blocking repo snapshot for `/api/git/info`.
 *
 * @param {string} cwd
 * @returns {Promise<Record<string, any> | null>}
 */
async function readGitInfo(cwd) {
  const hit = gitInfoCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_INFO_TTL_MS) {
    const gitDir = hit.info?.gitDir;
    if (!gitDir || (await gitStateSignature(gitDir)) === hit.signature) return strip(hit.info);
  }
  let pending = gitInfoInflight.get(cwd);
  if (!pending) {
    // Sign before computing: a change landing mid-compute then mismatches on the next read.
    const prior = gitInfoCache.get(cwd)?.info?.gitDir;
    const early = prior ? gitStateSignature(prior) : null;
    pending = computeGitInfo(cwd)
      .then(async (info) => {
        const signature = !info?.gitDir ? ''
          : early && info.gitDir === prior ? await early : await gitStateSignature(info.gitDir);
        gitInfoCache.delete(cwd);
        gitInfoCache.set(cwd, { at: Date.now(), signature, info });
        while (gitInfoCache.size > GIT_INFO_CACHE_MAX) {
          gitInfoCache.delete(gitInfoCache.keys().next().value);
        }
        return info;
      })
      .finally(() => gitInfoInflight.delete(cwd));
    gitInfoInflight.set(cwd, pending);
  }
  return strip(await pending);
}

/**
 * Drop the internal gitDir field so the response shape is unchanged.
 *
 * @param {Record<string, any> | null} info
 */
function strip(info) {
  if (!info) return null;
  const { gitDir: _gitDir, ...rest } = info;
  return rest;
}

/**
 * @param {import('express').Express} app
 * @param {GitRoutesContext} ctx
 */
export function registerGitRoutes(app, ctx) {
  app.get('/api/git/info', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    const summary = scopeSummary(context);
    try {
      const info = await readGitInfo(cwd);
      if (!info) return res.json({ ok: true, ...summary, cwd, isRepo: false });
      return res.json({ ok: true, ...summary, cwd, isRepo: true, ...info });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'git info failed.' });
    }
  });

  /** Single-file diff against HEAD. path = relative to the execution folder. */
  app.get('/api/git/file-diff', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: msg(req, 'git.noRepo') });
    }
    const rel = (req.query.path && String(req.query.path).trim()) || '';
    if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
    /** @type {Record<string, any>} */
    const located = resolvePathWithinBase(cwd, rel);
    if (!located.ok) {
      return res.status(400).json({ ok: false, error: located.error });
    }
    const { resolvedReal, relPosix } = located;
    const statusRes = runGitCommand(['status', '--porcelain=v1', '--', relPosix], cwd);
    if (!statusRes.ok) {
      return res.json({ ok: false, error: statusRes.error || 'git status failed.' });
    }
    const statusLine = (statusRes.stdout || '').split('\n').find((l) => l.trim());
    const code = statusLine ? statusLine.slice(0, 2) : '';
    const isUntracked = code === '??';
    const isDeleted = !isUntracked && (code[0] === 'D' || code[1] === 'D');
    if (isUntracked) {
      try {
        if (!existsSync(resolvedReal) || !statSync(resolvedReal).isFile()) {
          return res.json({ ok: false, error: msg(req, 'files.fileNotFound') });
        }
        const content = readFileSync(resolvedReal, 'utf8');
        const header =
          `diff --git a/${relPosix} b/${relPosix}\n` +
          `new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ b/${relPosix}\n` +
          `@@ -0,0 +1,${content.split('\n').length} @@\n`;
        return res.json({
          ok: true,
          path: relPosix,
          status: 'U',
          isUntracked: true,
          isDeleted: false,
          diff: header + content.split('\n').map((l) => `+${l}`).join('\n'),
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }
    const diffRes = runGitCommand(['--no-pager', 'diff', 'HEAD', '--', relPosix], cwd);
    if (!diffRes.ok) {
      return res.json({ ok: false, error: diffRes.stderr?.trim() || diffRes.error || 'git diff failed.' });
    }
    return res.json({
      ok: true,
      path: relPosix,
      status: code.trim() || '',
      isUntracked: false,
      isDeleted,
      diff: diffRes.stdout || '',
    });
  });

  /** Local branches for the workspace quick switch; `for-each-ref`, not `branch -a`. */
  app.get('/api/git/branches', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, ...scopeSummary(context), error: msg(req, 'git.noRepo') });
    }
    const result = runGitCommand(
      ['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads'],
      cwd,
    );
    if (!result.ok) {
      const message = (result.stderr || result.stdout || '').trim();
      return res.json({ ok: false, ...scopeSummary(context), error: message || msg(req, 'git.branchesError') });
    }
    return res.json({
      ok: true,
      ...scopeSummary(context),
      branches: parseGitBranchRefs(result.stdout),
    });
  });

  app.post('/api/git/run', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: 'No git repository in the current directory.' });
    }
    // Any git action may mutate the repo: drop the cached snapshot before and after the response.
    gitInfoCache.delete(cwd);
    res.on?.('finish', () => gitInfoCache.delete(cwd));
    const action = String(req.body?.action || '').trim();
    const arg = normalizeGitArg(req.body?.arg);
    const actionMap = {
      status: () => ['status', '-sb'],
      fetch: () => ['fetch'],
      pull: () => ['pull'],
      push: () => ['push'],
      log: () => ['log', '--oneline', '--graph', '--decorate', '-n', '20'],
      diff: () => ['diff'],
      'diff-staged': () => ['diff', '--staged'],
      branch: () => ['branch', '-a'],
      stash: () => ['stash'],
      'stash-pop': () => ['stash', 'pop'],
      switch: (value) => ['switch', value],
      'switch-new': (value) => ['switch', '-c', value],
      merge: (value) => ['merge', value],
      rebase: (value) => ['rebase', value],
    };
    const factory = actionMap[action];
    if (!factory) return res.json({ ok: false, error: msg(req, 'git.unknownAction') });
    if (['switch', 'switch-new', 'merge', 'rebase'].includes(action) && !arg) {
      return res.json({ ok: false, error: 'Missing required value (e.g. branch name).' });
    }
    if (GUARDED_GIT_ACTIONS.has(action)) {
      const topLevel = runGitCommand(['rev-parse', '--show-toplevel'], cwd);
      const activity = await collectWorkspaceGitActivity(topLevel.stdout?.trim() || cwd, {
        dataDir: ctx.dataDir,
        deps: ctx.gitGuardDeps,
      });
      if (activity.busy) {
        return res.json({
          ok: false,
          code: 'workspace_busy',
          error: msg(req, 'git.workspaceBusy', {
            chats: activity.runningChats,
            delegations: activity.runningDelegations,
            watcher: activity.watcherCycles,
          }),
        });
      }
    }
    const args = factory(arg);
    const result = runGitCommand(args, cwd);
    if (!result.ok) {
      const message = (result.stderr || result.stdout || '').trim();
      return res.json({ ok: false, error: message || 'git command failed.' });
    }
    return res.json({
      ok: true,
      ...scopeSummary(context),
      command: `git ${args.join(' ')}`,
      output: (result.stdout || result.stderr || '').trim(),
    });
  });

  /**
   * Read-only plan of a voice commit: file counts (untracked counted per file), a fingerprint of the exact tree
   * state, and whether secrets or large files are among the changes. The commit route re-checks the fingerprint.
   */
  app.get('/api/git/commit-plan', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const cwd = scope.context.executionFolder;
    if (!isGitRepo(cwd)) return res.json({ ok: false, code: 'no_repo', error: msg(req, 'git.noRepo') });
    const refused = await refuseBusyCommit(req, scope.context, cwd, ctx);
    if (refused) return res.json(refused);
    const plan = await readCommitPlan(cwd);
    if (!plan.ok) return res.json({ ok: false, error: plan.error });
    const { items, root, ...summary } = plan;
    return res.json({ ...summary, paths: items.map((item) => item.path).slice(0, 500), ...scopeSummary(scope.context) });
  });

  /**
   * Commit every change of the scoped folder (voice `ops` git_commit). A dedicated route instead of a
   * `/api/git/run` action: it needs a message, a fingerprint and several git calls, and `push` / `merge` stay out of it.
   */
  app.post('/api/git/commit', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = await resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, code: 'no_repo', error: msg(req, 'git.noRepo') });
    }
    const message = String(req.body?.message ?? '').replace(/\0/g, '').trim();
    if (!message) return res.json({ ok: false, code: 'no_message', error: 'A commit message is required.' });
    if (message.length > GIT_COMMIT_MESSAGE_MAX) {
      return res.json({ ok: false, code: 'message_too_long', error: 'The commit message is too long.' });
    }
    const fingerprint = String(req.body?.fingerprint ?? '').trim();
    if (!fingerprint) return res.json({ ok: false, code: 'no_fingerprint', error: 'The state read back is required.' });
    const refused = await refuseBusyCommit(req, context, cwd, ctx);
    if (refused) return res.json(refused);
    gitInfoCache.delete(cwd);
    res.on?.('finish', () => gitInfoCache.delete(cwd));
    const plan = await readCommitPlan(cwd);
    if (!plan.ok) return res.json({ ok: false, error: plan.error });
    if (plan.changed + plan.untracked === 0) return res.json({ ok: false, code: 'nothing_to_commit', error: 'Nothing to commit.' });
    if (plan.fingerprint !== fingerprint) {
      return res.json({ ok: false, code: 'tree_changed', error: 'The files changed since the question. Nothing was committed.' });
    }
    if (plan.operationInProgress) {
      return res.json({ ok: false, code: 'operation_in_progress', error: 'A merge or rebase is in progress. Finish it from the Git panel.' });
    }
    if (plan.signingRequired) {
      return res.json({ ok: false, code: 'signing_required', error: 'This repository requires signed commits. Commit from the Git panel.' });
    }
    if (plan.partiallyStaged > 0) {
      return res.json({ ok: false, code: 'partially_staged', error: 'Some files have staged changes that differ from the working copy. Commit them from the Git panel.' });
    }
    if (plan.unsupportedFiles > 0) {
      return res.json({ ok: false, code: 'unsupported_files', error: 'Some changes are symlinks or nested repositories. Commit them from the Git panel.' });
    }
    if (plan.sensitiveFiles > 0) {
      return res.json({ ok: false, code: 'sensitive_files', error: 'Some changes look like secrets. Commit them from the Git panel.' });
    }
    if (plan.largeFiles > 0) {
      return res.json({ ok: false, code: 'large_files', error: 'Some changes are very large files. Commit them from the Git panel.' });
    }
    const committed = await commitPlannedPaths(plan, message, ctx.commitHooks);
    if (!committed.ok) return res.json(committed);
    return res.json({ ok: true, ...scopeSummary(context), head: committed.head, indexRefreshed: committed.indexRefreshed, ...(committed.staleIndexPaths ? { staleIndexPaths: committed.staleIndexPaths } : {}) });
  });

  app.get('/api/github/info', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = await resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      res.json({ ...resolveGithubRepoFromCwd(scope.context.executionFolder), scope: scopeSummary(scope.context) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/github/actions/runs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = await resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const perPage = Number(req.query.per_page) || 20;
      const page = Number(req.query.page) || 1;
      const data = await listWorkflowRuns(
        { owner: repoInfo.owner, repo: repoInfo.repo },
        { perPage, page },
      );
      res.json({
        ok: true,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        htmlUrl: repoInfo.htmlUrl,
        totalCount: data.totalCount,
        runs: data.runs,
      });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load GitHub Actions runs.',
      });
    }
  });

  app.get('/api/github/actions/runs/:runId/jobs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = await resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const runId = String(req.params.runId || '').trim();
      if (!/^\d+$/.test(runId)) {
        return res.status(400).json({ ok: false, error: 'Invalid workflow run id.' });
      }
      const jobs = await listWorkflowRunJobs({ owner: repoInfo.owner, repo: repoInfo.repo }, runId);
      res.json({ ok: true, runId, jobs });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load workflow jobs.',
      });
    }
  });

  app.get('/api/github/actions/jobs/:jobId/logs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = await resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const jobId = String(req.params.jobId || '').trim();
      if (!/^\d+$/.test(jobId)) {
        return res.status(400).json({ ok: false, error: 'Invalid job id.' });
      }
      const logs = await fetchWorkflowJobLogs({ owner: repoInfo.owner, repo: repoInfo.repo }, jobId);
      res.json({ ok: true, jobId, logs });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load job logs.',
      });
    }
  });
}
