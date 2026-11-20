import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readAuthorAsync, runGitAsync as runGit } from '../worktree/git-worktree.ts';
import { runFrontendSmoke } from './frontend-smoke.js';
import { readLatestLeafVerifiedByTrailer } from '../verified-by-trailer.js';

const generated = ['docs/typecheck-baseline.json', 'tests/fixtures/front-size-baseline.json'];
const fail = (code, artifacts) => { throw Object.assign(new Error(code), { code }, artifacts ? { artifacts } : {}); };

export function acceptMovedTypeErrors(before, after, files) {
  let oldTotal = 0;
  let newTotal = 0;
  for (const project of new Set([...Object.keys(before.projects), ...Object.keys(after.projects)])) {
    const a = before.projects[project] || {};
    const b = after.projects[project] || {};
    for (const file of new Set([...Object.keys(a), ...Object.keys(b)])) {
      oldTotal += Number(a[file]) || 0;
      newTotal += Number(b[file]) || 0;
      if ((Number(b[file]) || 0) > (Number(a[file]) || 0) && !files.includes(file)) return false;
    }
  }
  return newTotal <= oldTotal;
}

async function command(cwd, file, args) {
  try {
    await promisify(execFile)(file, args, { cwd, timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    return true;
  } catch { return false; }
}

/** Run gates on disposable trees; a failing affected test is compared with HEAD. */
export async function runIntegrationGates({ candidate, baseline, files, frontendSmoke = runFrontendSmoke }) {
  const node = (cwd, args) => command(cwd, process.execPath, args);
  const exists = (file) => fs.existsSync(path.join(candidate, file));
  // Registration failures are release blockers even when HEAD also fails.
  // Comparing this gate with HEAD would let an existing missing import persist.
  if (files.some((file) => file.startsWith('app_front/'))) {
    const registrationTest = 'tests/custom-elements-imported.test.js';
    if (!exists(registrationTest)) fail(`required_gate_missing:${registrationTest}`);
    if (!await node(candidate, [registrationTest])) fail(`test_failed:${registrationTest}`);
  }
  for (const file of ['scripts/typecheck-ratchet.mjs', 'scripts/front-size-baseline.js', 'tests/front-size-ratchet.test.js', 'tests/architecture-acceptance.test.js', 'tests/i18n-harness-packs.test.js']) {
    if (fs.existsSync(path.join(baseline, file)) && !exists(file)) fail(`required_gate_missing:${file}`);
  }
  const tests = new Set(files.filter((file) => /^tests\/.*\.test\.js$/.test(file) && exists(file)));
  const modules = files.filter((file) => /\.(js|ts|mjs)$/.test(file)).map((file) => path.basename(file));
  if (exists('tests')) {
    for (const entry of fs.readdirSync(path.join(candidate, 'tests'))) {
      if (!entry.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(candidate, 'tests', entry), 'utf8');
      if (modules.some((name) => source.includes(`/${name}'`) || source.includes(`/${name}"`))) tests.add(`tests/${entry}`);
    }
  }
  for (const file of ['tests/front-size-ratchet.test.js', 'tests/architecture-acceptance.test.js', 'tests/i18n-harness-packs.test.js']) {
    if (exists(file)) tests.add(file);
  }
  if (exists('scripts/typecheck-ratchet.mjs')) {
    const before = JSON.parse(fs.readFileSync(path.join(baseline, generated[0]), 'utf8'));
    if (!await node(candidate, ['scripts/typecheck-ratchet.mjs', '--update'])) fail('typecheck_failed');
    const after = JSON.parse(fs.readFileSync(path.join(candidate, generated[0]), 'utf8'));
    if (!acceptMovedTypeErrors(before, after, files)) fail('typecheck_regression');
  }
  if (exists('scripts/front-size-baseline.js') && !await node(candidate, ['scripts/front-size-baseline.js', '--write'])) fail('size_baseline_failed');
  for (const file of tests) {
    if (!await node(candidate, [file]) && (!fs.existsSync(path.join(baseline, file)) || await node(baseline, [file]))) fail(`test_failed:${file}`);
  }
  const sources = files.filter((file) => /\.(js|ts|mjs)$/.test(file) && exists(file));
  if (sources.length && !await node(candidate, ['node_modules/eslint/bin/eslint.js', ...sources])) fail('eslint_failed');
  if (files.some((file) => file.startsWith('app_front/'))) await frontendSmoke({ candidate });
}

/**
 * Copies `source` over `target` through a uniquely named temp file in the target folder, so a process killed
 * mid-copy never leaves a truncated or half-old file. The temp file is created exclusively ('wx' = O_EXCL, which
 * never follows a symlink at the final component), a collision rejects instead of overwriting, and the temp
 * file is removed on any failure.
 * @param {string} source
 * @param {string} target
 * @param {{ tempName?: () => string }} [options] `tempName` is a test seam for forcing collisions.
 */
export function copyFileAtomically(source, target, { tempName = () => randomBytes(8).toString('hex') } = {}) {
  const temporary = `${target}.cretli-integrate-${tempName()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', fs.statSync(source).mode & 0o777);
    created = true;
    try {
      fs.writeFileSync(fd, fs.readFileSync(source));
      fs.fchmodSync(fd, fs.statSync(source).mode & 0o777);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    created = false;
  } finally {
    // Only remove what this call created; on a collision the pre-existing path is not ours.
    if (created) fs.rmSync(temporary, { force: true });
  }
}

/**
 * Returns the paths (default: every path the commit changed) whose working-tree content
 * differs from the committed blob. Deleted paths must be absent. `hash-object --path`
 * applies the clean filters (autocrlf, attributes), so it matches what `git add` stages.
 * @param {{ workspaceFolder: string, commit: string, files?: (string | { path: string, blob?: string })[] }} options
 */
export async function verifyMaterialization({ workspaceFolder, commit, files }) {
  const mismatches = await verifyScope({ workspaceFolder, commit, files });
  if (!mismatches.length) return mismatches;
  // A server killed between update-ref and the copy leaves a durable intent; finish it so the caller sees the real state.
  const recovery = await recoverMaterializationIntent({ workspaceFolder, commit }).catch(() => null);
  return recovery?.recovered ? verifyScope({ workspaceFolder, commit, files }) : mismatches;
}

async function verifyScope({ workspaceFolder, commit, files }) {
  const git = async (args) => (await runGit(args, workspaceFolder, { env: { GIT_LITERAL_PATHSPECS: '0' } })).stdout;
  const changedFiles = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', commit])).split('\0').filter(Boolean);
  const committedBlobs = new Map((await git(['ls-tree', '-r', '-z', commit])).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]];
  }));
  const scope = files ? files.map((entry) => typeof entry === 'string' ? entry : entry.path) : [...new Set([...changedFiles, ...generated.filter((file) => committedBlobs.has(file))])];
  const mismatches = [];
  for (const file of scope) {
    const blob = committedBlobs.get(file) || '';
    const target = path.join(workspaceFolder, file);
    if (!blob) {
      if (fs.existsSync(target)) mismatches.push(file);
      continue;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      mismatches.push(file);
      continue;
    }
    const actual = (await git(['hash-object', '--path', file, '--', target]).catch(() => '')).trim();
    if (actual !== blob) mismatches.push(file);
  }
  return mismatches;
}

function intentPath(gitDir) {
  return path.join(gitDir, 'cretli-materialization-intent.json');
}

/** Recover a published integration only when every scoped file still matches its first parent. */
/** @param {{ workspaceFolder: string, commit?: string }} options */
export async function recoverMaterializationIntent({ workspaceFolder, commit: expectedCommit }) {
  workspaceFolder = path.resolve(workspaceFolder);
  const run = async (args) => (await runGit(args, workspaceFolder, { env: { GIT_LITERAL_PATHSPECS: '0' } })).stdout.trim();
  const gitDir = await run(['rev-parse', '--absolute-git-dir']);
  const filename = intentPath(gitDir);
  if (!fs.existsSync(filename)) return { recovered: false, reason: 'no_intent' };
  let intent;
  try { intent = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return { recovered: false, reason: 'invalid_intent' }; }
  const { commit, parent, files } = intent || {};
  const wipIntent = intent?.wip;
  if (!commit || !parent || !Array.isArray(files) || (expectedCommit && expectedCommit !== commit)) return { recovered: false, reason: 'intent_mismatch' };
  const normalizedFiles = files.map((entry) => typeof entry === 'string' ? { path: entry, blob: '' } : entry);
  if (normalizedFiles.some((entry) => !entry || typeof entry.path !== 'string' || !entry.path || typeof entry.blob !== 'string'
    || path.isAbsolute(entry.path) || path.resolve(workspaceFolder, entry.path) === workspaceFolder
    || !path.resolve(workspaceFolder, entry.path).startsWith(`${workspaceFolder}${path.sep}`))) return { recovered: false, reason: 'invalid_intent_path' };
  for (const entry of normalizedFiles) {
    const target = path.join(workspaceFolder, entry.path);
    const relative = path.relative(workspaceFolder, target);
    let current = workspaceFolder;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return { recovered: false, reason: 'symlinked_intent_path', file: entry.path };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        break;
      }
    }
  }
  const parentOfCommit = await run(['rev-parse', `${commit}^`]).catch(() => '');
  if (parentOfCommit !== parent) return { recovered: false, reason: 'intent_parent_mismatch' };
  if (await run(['rev-parse', 'HEAD']) !== commit) return { recovered: false, reason: 'commit_not_published' };
  // Each target may be at its parent blob (not copied yet) or at the commit blob (copied before the crash).
  const notAtCommit = await verifyScope({ workspaceFolder, commit, files: normalizedFiles });
  if (!notAtCommit.length) {
    const wipSkipped = applyWipEntries(workspaceFolder, wipIntent);
    fs.rmSync(filename, { force: true });
    return { recovered: true, commit, alreadyMaterialized: true, ...(wipSkipped.length ? { wipSkipped } : {}) };
  }
  const notAtParent = new Set((await verifyScope({ workspaceFolder, commit: parent, files: normalizedFiles })));
  const foreign = notAtCommit.filter((file) => notAtParent.has(file));
  if (foreign.length) return { recovered: false, reason: 'foreign_worktree', files: foreign };
  const pending = new Set(notAtCommit);
  for (const entry of normalizedFiles) {
    const file = entry.path;
    if (!pending.has(file)) continue;
    const blob = entry.blob;
    const target = path.join(workspaceFolder, file);
    const actualBlob = (await run(['rev-parse', `${commit}:${file}`]).catch(() => ''));
    if (blob && actualBlob !== blob) return { recovered: false, reason: 'intent_hash_mismatch', file };
    if (!actualBlob) fs.rmSync(target, { force: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // checkout-index writes raw blob bytes (stdout would be UTF-8 decoded), into a private staging dir.
      const staging = fs.mkdtempSync(path.join(gitDir, 'cretli-recover-'));
      try {
        const stagingIndex = path.join(staging, 'index');
        await runGit(['read-tree', commit], workspaceFolder, { env: { GIT_INDEX_FILE: stagingIndex } });
        await runGit(['checkout-index', `--prefix=${staging}/tree/`, '--', file], workspaceFolder, { env: { GIT_INDEX_FILE: stagingIndex, GIT_LITERAL_PATHSPECS: '1' } });
        copyFileAtomically(path.join(staging, 'tree', file), target);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
  }
  const remaining = await verifyScope({ workspaceFolder, commit, files: normalizedFiles });
  if (remaining.length) return { recovered: false, reason: 'verification_failed', files: remaining };
  const wipSkipped = applyWipEntries(workspaceFolder, wipIntent);
  fs.rmSync(filename, { force: true });
  return { recovered: true, commit, ...(wipSkipped.length ? { wipSkipped } : {}) };
}


/** Raw porcelain status of one path (not trimmed: the leading space of ' M' is a column). */
async function rawStatus(workspaceFolder, file) {
  return (await runGit(['status', '--porcelain', '--untracked-files=all', '--', file], workspaceFolder, { env: { GIT_LITERAL_PATHSPECS: '1' } })).stdout;
}
const PLAIN_MODIFIED = /^ M [^\n]*\n?$/;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Finishes WIP merges recorded in an intent: a file still byte-identical to its pre-merge content gets the merged
 * content; a file the user changed since is left alone (the merged copy stays in the store).
 */
function applyWipEntries(workspaceFolder, entries) {
  const skipped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const target = path.join(workspaceFolder, entry.path);
    try {
      if (sha256(fs.readFileSync(target)) === entry.originalSha256) fs.writeFileSync(target, fs.readFileSync(entry.mergedPath));
      else if (sha256(fs.readFileSync(target)) !== entry.mergedSha256) skipped.push(entry.path);
    } catch { skipped.push(entry.path); }
  }
  return skipped;
}

/** Describes where git left conflict markers, as line ranges of the merged file. */
function conflictRanges(text) {
  const ranges = [];
  let start = 0;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('<<<<<<<')) start = i + 1;
    else if (line.startsWith('>>>>>>>') && start) { ranges.push(start === i + 1 ? `${start}` : `${start}-${i + 1}`); start = 0; }
  });
  return ranges;
}

/**
 * 3-way merges one dirty working file: base = HEAD blob, ours = the file with foreign WIP, theirs = the patched
 * candidate. Nothing in the workspace is written; the result is returned for a later in-place write.
 * @returns {Promise<{ merged: Buffer, original: Buffer } | { conflict: string }>}
 */
async function mergeWipFile({ workspaceFolder, file, baseDir, theirsDir, scratch, n }) {
  const ours = path.join(workspaceFolder, file);
  const theirs = path.join(theirsDir, file);
  const base = path.join(baseDir, file);
  if (!fs.existsSync(theirs) || !fs.existsSync(base)) return { conflict: `${file}: patch adds or removes a file that has uncommitted changes` };
  const original = fs.readFileSync(ours);
  const mergedPath = path.join(scratch, `merged-${n}`);
  fs.writeFileSync(mergedPath, original);
  const run = await runGit(['merge-file', '-L', 'workspace', '-L', 'base', '-L', 'patch', mergedPath, base, theirs], workspaceFolder, { allowFailure: true });
  const merged = fs.readFileSync(mergedPath);
  if (run.status === 0) return { merged, original };
  const ranges = conflictRanges(merged.toString('utf8'));
  return { conflict: `${file}: ${ranges.length ? `patch hunks overlap uncommitted changes at merged lines ${ranges.join(', ')}` : 'cannot be merged (binary or unmergeable content)'}` };
}

/** Temporary indexes and checkouts isolate both conflicts and gates from foreign edits. */
export async function integrateGitResult({ workspaceFolder, result, todoId, dataDir, gates = runIntegrationGates, beforePublish = (_publication) => {}, afterPublish = (_publication) => {}, afterMaterialize = (_publication) => {} }) {
  workspaceFolder = path.resolve(workspaceFolder);
  // Finish any interrupted materialization first so it is not mistaken for a foreign change.
  await recoverMaterializationIntent({ workspaceFolder }).catch(() => {});
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-auto-integrate-'));
  const git = async (args, options = {}) => (await runGit(args, workspaceFolder, { ...options, env: { GIT_LITERAL_PATHSPECS: '1', ...options.env } })).stdout.trim();
  const index = path.join(scratch, 'index');
  const env = { GIT_INDEX_FILE: index };
  let published = false;
  let indexLock = '';
  let indexLockFd;
  try {
    const head = await git(['rev-parse', '--verify', 'HEAD']);
    const branch = await git(['symbolic-ref', '--short', 'HEAD']);
    await git(['read-tree', head], { env });
    const apply = await runGit(['apply', '--cached', '--3way', ...generated.map((file) => `--exclude=${file}`), result.patchPath], workspaceFolder, { env, allowFailure: true });
    if (apply.status !== 0) fail('integration_conflict');
    const tree = await git(['write-tree'], { env });
    const files = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', head, tree, '-z'])).split('\0').filter(Boolean);
    const candidate = path.join(scratch, 'candidate');
    const baseline = path.join(scratch, 'baseline');
    for (const [folder, ref] of [[candidate, tree], [baseline, head]]) {
      await runGit(['clone', '--shared', '--no-checkout', workspaceFolder, folder], scratch);
      await runGit(['read-tree', ref], folder);
      await runGit(['checkout-index', '-a'], folder);
      if (fs.existsSync(path.join(workspaceFolder, 'node_modules'))) fs.symlinkSync(path.join(workspaceFolder, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
    }
    if (!files.length) fail('empty_patch');
    await gates({ candidate, baseline, files });
    const scope = [...new Set([...files, ...generated.filter((file) => fs.existsSync(path.join(candidate, file)))])];
    // Files with foreign uncommitted changes are merged 3-way instead of refused; only overlapping hunks refuse.
    const wipFiles = new Map();
    for (const file of scope) {
      for (let part = path.join(workspaceFolder, file); part !== workspaceFolder; part = path.dirname(part)) {
        if (fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) fail('protected_workspace_symlink');
      }
      const candidatePath = path.join(candidate, file);
      if (fs.lstatSync(candidatePath, { throwIfNoEntry: false })?.isSymbolicLink()) fail('unsupported_symlink');
      const status = await rawStatus(workspaceFolder, file);
      if (!status) continue;
      // Only a plain unstaged modification of a tracked regular file can carry WIP; anything else keeps refusing.
      if (!PLAIN_MODIFIED.test(status) || !fs.statSync(path.join(workspaceFolder, file), { throwIfNoEntry: false })?.isFile()) fail('protected_workspace_change');
      wipFiles.set(file, null);
    }
    const wipConflicts = [];
    if (wipFiles.size) {
      const baseDir = path.join(scratch, 'wip-base');
      const baseIndex = path.join(scratch, 'wip-base-index');
      await git(['read-tree', head], { env: { GIT_INDEX_FILE: baseIndex } });
      await git(['checkout-index', `--prefix=${baseDir}/`, '--', ...wipFiles.keys()], { env: { GIT_INDEX_FILE: baseIndex } });
      // Both sides come out of this repository's own filters so line endings match the working files.
      const theirsDir = path.join(scratch, 'wip-theirs');
      await git(['checkout-index', `--prefix=${theirsDir}/`, '--', ...wipFiles.keys()], { env });
      let n = 0;
      for (const file of wipFiles.keys()) {
        const merge = await mergeWipFile({ workspaceFolder, file, baseDir, theirsDir, scratch, n: n++ });
        if ('conflict' in merge) wipConflicts.push(merge.conflict);
        else wipFiles.set(file, merge);
      }
      if (wipConflicts.length) fail('protected_workspace_change', wipConflicts.join('; '));
    }
    const cleanScope = scope.filter((file) => !wipFiles.has(file));
    if (await git(['rev-parse', 'HEAD']) !== head || await git(['symbolic-ref', '--short', 'HEAD']) !== branch) fail('head_changed');
    // Stage only the verified scope, using an index independent of the user's staging area.
    await runGit(['add', '-A', '--', ...scope], candidate, { env: { GIT_LITERAL_PATHSPECS: '1' } });
    const finalTree = (await runGit(['write-tree'], candidate)).stdout.trim();
    let verifiedTrailer = 'Verified-by: none';
    try {
      verifiedTrailer = await readLatestLeafVerifiedByTrailer({ workspaceFolder, dataDir, leafId: todoId });
    } catch {}
    // The candidate clone shares objects only in the read direction.
    await git(['fetch', '--no-tags', candidate, finalTree]);
    const commitMessage = `Auto integrate TODO ${todoId}\n\nPatch: ${result.patchSha256}\nCycle: ${result.cycleId}\n\n${verifiedTrailer}`;
    // The repository's configured identity: a hardcoded bot author would leak a second contributor into the history.
    const commit = await git(['commit-tree', finalTree, '-p', head, '-m', commitMessage], { env: await readAuthorAsync(workspaceFolder) });
    const userIndex = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    indexLock = `${userIndex}.lock`;
    try { indexLockFd = fs.openSync(indexLock, 'wx'); }
    catch { indexLock = ''; fail('protected_workspace_index_lock'); }
    const preservedIndex = path.join(scratch, 'preserved-index');
    fs.copyFileSync(userIndex, preservedIndex);
    // Recheck under the index lock: a user could have staged a scope path during gates.
    for (const file of cleanScope) {
      if (await git(['status', '--porcelain', '--untracked-files=all', '--', file])) fail('protected_workspace_change');
    }
    for (const [file, merge] of wipFiles) {
      // Also guards the index move below: a file staged meanwhile must keep the user's staged blob.
      if (!PLAIN_MODIFIED.test(await rawStatus(workspaceFolder, file))) fail('protected_workspace_change', `${file}: staged or changed while integrating`);
      if (!fs.readFileSync(path.join(workspaceFolder, file)).equals(merge.original)) fail('protected_workspace_change', `${file}: changed while integrating`);
    }
    const gitDir = await git(['rev-parse', '--absolute-git-dir']);
    // Original WIP copies go to _carry; merged results are stored durably (carry, or the git dir without a dataDir).
    const carry = dataDir ? path.join(dataDir, 'worktree-results', '_carry', `${todoId || 'integrate'}-${Date.now()}`) : '';
    const mergedStore = carry ? path.join(carry, '_merged') : path.join(gitDir, `cretli-wip-merged-${commit}`);
    const wipEntries = [];
    for (const [file, merge] of wipFiles) {
      if (carry) {
        fs.mkdirSync(path.dirname(path.join(carry, file)), { recursive: true });
        fs.writeFileSync(path.join(carry, file), merge.original);
      }
      const mergedPath = path.join(mergedStore, file);
      fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
      fs.writeFileSync(mergedPath, merge.merged);
      wipEntries.push({ path: file, mergedPath, originalSha256: sha256(merge.original), mergedSha256: sha256(merge.merged) });
    }
    await beforePublish({ commit, branch, files: scope });
    const intent = intentPath(gitDir);
    const treeEntries = (await git(['ls-tree', '-r', '-z', commit])).split('\0').filter(Boolean);
    const blobs = new Map(treeEntries.map((line) => { const tab = line.indexOf('\t'); return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]]; }));
    const intentData = { commit, parent: head, files: cleanScope.map((file) => ({ path: file, blob: blobs.get(file) || '' })), wip: wipEntries };
    const intentTemp = `${intent}.${randomBytes(8).toString('hex')}.tmp`;
    const intentFd = fs.openSync(intentTemp, 'wx', 0o600);
    try { fs.writeFileSync(intentFd, JSON.stringify(intentData)); fs.fsyncSync(intentFd); }
    finally { fs.closeSync(intentFd); }
    try {
      fs.renameSync(intentTemp, intent);
      const dirFd = fs.openSync(gitDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally { fs.rmSync(intentTemp, { force: true }); }
    try { await git(['update-ref', `refs/heads/${branch}`, commit, head]); }
    catch (error) { fs.rmSync(intent, { force: true }); throw error; }
    published = true;
    await afterPublish({ commit, branch, files: scope });
    for (const file of cleanScope) {
      const source = path.join(candidate, file);
      const target = path.join(workspaceFolder, file);
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copyFileAtomically(source, target);
      } else fs.rmSync(target, { force: true });
    }
    // WIP files are rewritten in place (same inode, owner and mode) with the merged content.
    // Re-read right before writing: a user edit since the check wins, and the merged result stays in the store.
    const changedWip = [];
    for (const [file, merge] of wipFiles) {
      const target = path.join(workspaceFolder, file);
      if (fs.readFileSync(target).equals(merge.original)) fs.writeFileSync(target, merge.merged);
      else changedWip.push(file);
    }
    if (changedWip.length) {
      const where = wipEntries.filter((entry) => changedWip.includes(entry.path)).map((entry) => `${entry.path} (merged copy: ${entry.mergedPath})`).join(', ');
      throw Object.assign(new Error(`materialization_mismatch:${changedWip.join(',')}`), { code: 'materialization_mismatch', paths: changedWip, files: scope, artifacts: where });
    }
    fs.rmSync(intent, { force: true });
    await afterMaterialize({ commit, branch, files: scope });
    const assertMaterialized = async () => {
      const mismatches = await verifyMaterialization({ workspaceFolder, commit, files: cleanScope });
      if (mismatches.length) throw Object.assign(new Error(`materialization_mismatch:${mismatches.join(',')}`), { code: 'materialization_mismatch', paths: mismatches, files: scope, artifacts: mismatches.join(',') });
    };
    await assertMaterialized();
    await git(['add', '-A', '--', ...cleanScope], { env: { GIT_INDEX_FILE: preservedIndex } });
    // A WIP file's index entry follows the new commit so only the foreign changes remain as unstaged diff.
    for (const file of wipFiles.keys()) {
      const entry = treeEntries.find((line) => line.slice(line.indexOf('\t') + 1) === file);
      const [mode, , blob] = entry.slice(0, entry.indexOf('\t')).split(' ');
      await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`], { env: { GIT_INDEX_FILE: preservedIndex } });
    }
    fs.copyFileSync(preservedIndex, indexLock);
    fs.renameSync(indexLock, userIndex);
    indexLock = '';
    // Re-verify once the index is swapped: anything that rewrote the files in between must halt automation, not pass silently.
    await assertMaterialized();
    if (!carry) fs.rmSync(mergedStore, { recursive: true, force: true });
    return { ok: true, commit, branch, files: scope };
  } catch (error) {
    // A published commit stays pending confirmation, except a materialization mismatch which the caller handles itself.
    if (published && error.code !== 'materialization_mismatch') error.code = 'confirmation_pending';
    throw error;
  } finally {
    if (indexLockFd !== undefined) fs.closeSync(indexLockFd);
    if (indexLock) fs.rmSync(indexLock, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
