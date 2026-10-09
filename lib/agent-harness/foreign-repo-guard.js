/**
 * Keeps shell-tool git mutations inside the chat workspace repository.
 *
 * The shell tool starts in the workspace folder, but a command can still name
 * any other checkout on the machine by path. Shared rules and directory
 * listings make sibling projects visible to the model, so "commit everything"
 * must not be able to reach them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const MUTATING_GIT_VERBS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
]);
const GIT_PROGRAM_PATTERN = /^git(-[\w.-]+)?(\.sh)?$/;
const ALLOW_ENV = 'CRETLI_ALLOW_FOREIGN_REPO_GIT';

/**
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  return String(command || '').split(/[\s"'`;|&<>()]+/).filter(Boolean);
}

/**
 * @param {string} dir
 * @returns {string} Nearest ancestor (or self) holding a `.git` entry, else ''.
 */
function findRepoRoot(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

/**
 * @param {string} token
 * @param {string} cwd
 * @returns {string} Real path of an existing directory the token names, else ''.
 */
function resolveDirectoryToken(token, cwd) {
  const expanded = token === '~' || token.startsWith('~/')
    ? path.join(os.homedir(), token.slice(1))
    : token;
  if (!path.isAbsolute(expanded) && !expanded.startsWith('..')) return '';
  try {
    const real = fs.realpathSync(path.resolve(cwd, expanded));
    return fs.statSync(real).isDirectory() ? real : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isInsideOrEqual(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the repository root a mutating git command would touch outside the
 * workspace, or '' when the command stays inside it.
 *
 * @param {unknown} command
 * @param {string} cwd Workspace folder of the chat.
 * @returns {string}
 */
export function findForeignRepoGitTarget(command, cwd) {
  if (process.env[ALLOW_ENV] === '1') return '';
  const tokens = tokenizeCommand(String(command || ''));
  if (!tokens.some((token) => GIT_PROGRAM_PATTERN.test(path.basename(token)))) return '';
  if (!tokens.some((token) => MUTATING_GIT_VERBS.has(token))) return '';
  let workspaceDir = '';
  try {
    workspaceDir = fs.realpathSync(path.resolve(cwd));
  } catch {
    return '';
  }
  const workspaceRepo = findRepoRoot(workspaceDir);
  for (const token of tokens) {
    const dir = resolveDirectoryToken(token, workspaceDir);
    if (!dir || isInsideOrEqual(dir, workspaceDir)) continue;
    const repo = findRepoRoot(dir);
    if (repo && repo !== workspaceRepo) return repo;
  }
  return '';
}

/**
 * @param {string} repoRoot
 * @param {string} cwd
 * @returns {string}
 */
export function foreignRepoBlockedMessage(repoRoot, cwd) {
  return [
    `Blocked: this command changes git state in ${repoRoot}, which is a different repository than this chat's workspace (${cwd}).`,
    'Only commit, push or otherwise modify the workspace repository.',
    'If the user explicitly asked for that other repository, tell them to run it from a chat opened in that project.',
  ].join(' ');
}
