import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runGitAsync as runGit } from '../worktree/git-worktree.ts';
import { runFrontendSmoke } from './frontend-smoke.js';

const generated = ['docs/typecheck-baseline.json', 'tests/fixtures/front-size-baseline.json'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

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

/** Temporary indexes and checkouts isolate both conflicts and gates from foreign edits. */
export async function integrateGitResult({ workspaceFolder, result, todoId, gates = runIntegrationGates, beforePublish = (_publication) => {} }) {
  workspaceFolder = path.resolve(workspaceFolder);
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
    for (const file of scope) {
      for (let part = path.join(workspaceFolder, file); part !== workspaceFolder; part = path.dirname(part)) {
        if (fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) fail('protected_workspace_symlink');
      }
      const candidatePath = path.join(candidate, file);
      if (fs.lstatSync(candidatePath, { throwIfNoEntry: false })?.isSymbolicLink()) fail('unsupported_symlink');
      if (await git(['status', '--porcelain', '--untracked-files=all', '--', file])) fail('protected_workspace_change');
    }
    if (await git(['rev-parse', 'HEAD']) !== head || await git(['symbolic-ref', '--short', 'HEAD']) !== branch) fail('head_changed');
    // Stage only the verified scope, using an index independent of the user's staging area.
    await runGit(['add', '-A', '--', ...scope], candidate, { env: { GIT_LITERAL_PATHSPECS: '1' } });
    const finalTree = (await runGit(['write-tree'], candidate)).stdout.trim();
    // The candidate clone shares objects only in the read direction.
    await git(['fetch', '--no-tags', candidate, finalTree]);
    const commit = await git(['commit-tree', finalTree, '-p', head, '-m', `Auto integrate TODO ${todoId}\n\nPatch: ${result.patchSha256}\nCycle: ${result.cycleId}`], { env: { GIT_AUTHOR_NAME: 'Cretli integrator', GIT_AUTHOR_EMAIL: 'integrator@example.com', GIT_COMMITTER_NAME: 'Cretli integrator', GIT_COMMITTER_EMAIL: 'integrator@example.com' } });
    const userIndex = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    indexLock = `${userIndex}.lock`;
    try { indexLockFd = fs.openSync(indexLock, 'wx'); }
    catch { indexLock = ''; fail('protected_workspace_index_lock'); }
    const preservedIndex = path.join(scratch, 'preserved-index');
    fs.copyFileSync(userIndex, preservedIndex);
    // Recheck under the index lock: a user could have staged a scope path during gates.
    for (const file of scope) {
      if (await git(['status', '--porcelain', '--untracked-files=all', '--', file])) fail('protected_workspace_change');
    }
    await beforePublish({ commit, branch });
    await git(['update-ref', `refs/heads/${branch}`, commit, head]);
    published = true;
    for (const file of scope) {
      const source = path.join(candidate, file);
      const target = path.join(workspaceFolder, file);
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        fs.chmodSync(target, fs.statSync(source).mode);
      } else fs.rmSync(target, { force: true });
    }
    await git(['add', '-A', '--', ...scope], { env: { GIT_INDEX_FILE: preservedIndex } });
    fs.copyFileSync(preservedIndex, indexLock);
    fs.renameSync(indexLock, userIndex);
    indexLock = '';
    return { ok: true, commit, branch, files: scope };
  } catch (error) {
    if (published) error.code = 'confirmation_pending';
    throw error;
  } finally {
    if (indexLockFd !== undefined) fs.closeSync(indexLockFd);
    if (indexLock) fs.rmSync(indexLock, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
