import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { filterScoutPathsByScope } from './workspace-scout-glob.js';

/** Preserve failures separately from successful empty Git output. */
export function describeScoutGitError(error, args = []) {
  const stderr = String(error?.stderr || '').trim().slice(0, 2000);
  let code = error?.code || 'git_failed';
  if (/dubious ownership|unsafe repository/i.test(stderr)) code = 'git_ownership';
  else if (error?.code === 'ENOENT') code = 'git_unavailable';
  else if (error?.code === 'ETIMEDOUT') code = 'git_timeout';
  else if (/not a git repository/i.test(stderr)) code = 'git_not_repository';
  else if (args[0] === 'rev-parse' && error?.status === 1) code = 'git_base_missing';
  return { code, message: stderr || String(error?.message || 'Git command failed'), command: args.length ? ['git', ...args] : (error?.command || ['git']) };
}

/** Repository routing must come from the selected cwd, not inherited Git overrides. */
function buildScoutGitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
}

/** Trust only the repository containing the explicitly selected workspace, per command. */
export function execScoutGit(args, cwd, options = {}) {
  try {
    let root = fs.realpathSync(cwd);
    while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
    const trust = fs.existsSync(path.join(root, '.git'))
      ? ['-c', 'safe.directory=', '-c', `safe.directory=${root}`]
      : ['-c', 'safe.directory='];
    const config = [...trust, '-c', 'core.fsmonitor=false'];
    return execFileSync(options.program || 'git', [...config, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout ?? 5000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildScoutGitEnvironment(),
    });
  } catch (cause) {
    const diagnostic = describeScoutGitError(cause, args);
    const error = new Error(diagnostic.message, { cause });
    Object.assign(error, diagnostic);
    throw error;
  }
}

/** Resolve once to a commit: explicit refs fail closed; only `auto` permits fallback. */
export function resolveScoutGitBase(base, cwd, execGit, diagnostics = []) {
  const requestedBase = String(base || 'main');
  const candidates = requestedBase === 'auto' ? ['main', 'master', 'HEAD'] : [requestedBase];
  for (const candidate of candidates) {
    try {
      const ref = requestedBase === 'auto' && candidate !== 'HEAD' ? `refs/heads/${candidate}` : candidate;
      const commit = String(execGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd)).trim();
      if (!commit) {
        const error = new Error(`Git base "${candidate}" does not resolve to a commit.`);
        error.code = 'git_base_missing';
        throw error;
      }
      if (requestedBase === 'auto') diagnostics.push({ code: 'git_base_auto', message: `Auto base selected ${candidate} (${commit}).` });
      return { requestedBase, resolvedBase: candidate, baseCommit: commit };
    } catch (error) {
      const diagnostic = describeScoutGitError(error);
      if (diagnostic.code !== 'git_base_missing') throw error;
      if (requestedBase !== 'auto') {
        const hint = candidate === 'main' || candidate === 'master'
          ? ' Select the existing main/master branch explicitly, or choose auto (main → master → HEAD).'
          : ' Correct the explicit base, or choose auto (main → master → HEAD).';
        error.message = `Git base "${candidate}" is missing or is not a commit.${hint}`;
        throw error;
      }
    }
  }
  const error = new Error('Auto base could not resolve main, master or HEAD to a commit.');
  error.code = 'git_base_missing';
  throw error;
}

/** Collect tracked and untracked paths with identical filters and a pinned diff base. */
export function collectScoutGitChanges(scope, cwd, execGit, options = {}) {
  const diagnostics = [];
  const resolution = resolveScoutGitBase(scope.base, cwd, execGit, diagnostics);
  try {
    const tracked = execGit(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z', '--relative', resolution.baseCommit, '--', '.'], cwd);
    const untracked = execGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    const splitPaths = (value) => String(value || '').split(String(value || '').includes('\0') ? '\0' : '\n').filter(Boolean);
    const untrackedPaths = splitPaths(untracked);
    const matchedFiles = filterScoutPathsByScope([...splitPaths(tracked), ...untrackedPaths], scope, options.maxFiles);
    const diff = options.includeDiff && matchedFiles.length
      ? execGit(['diff', '--no-ext-diff', '--no-textconv', '--relative', resolution.baseCommit, '--', ...matchedFiles.map((file) => `:(literal)${file}`)], cwd)
      : '';
    return { ...resolution, diagnostics, matchedFiles, untrackedFiles: matchedFiles.filter((file) => untrackedPaths.includes(file)), diff };
  } catch (error) {
    error.scopeResolution = { ...resolution, diagnostics };
    throw error;
  }
}
