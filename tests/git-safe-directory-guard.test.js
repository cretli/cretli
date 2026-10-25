/**
 * Guard: server code must not open a Git repository without scoping
 * `safe.directory` to that checkout. Cretli often runs as a different uid than
 * the workspace owner; a bare `git` call then fails with "dubious ownership"
 * and surfaces as a misleading error (e.g. `target_ref_missing`).
 *
 * Use `runGit` from `lib/worktree/git-worktree.ts` (or `runGitCommand` from
 * `lib/git-cli.js`) instead of spawning `git` directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['lib', 'server.js'];
const SPAWN_GIT = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git\b[^\n]*/g;
// The argument list may wrap; look this far past the call for safe.directory.
const ARGS_WINDOW = 240;

// file -> reason. Each entry either adds safe.directory through a variable or
// runs a git subcommand that never opens a repository.
const ALLOWED = new Map([
  ['lib/git-cli.js', 'runGitCommand: prepends safe.directory via gitArgs'],
  ['lib/storage/cutover-code.js', 'git merge-file on temp files, no repository'],
  ['lib/worktree/patch-scope.ts', 'git apply --numstat on stdin, no repository'],
]);

function listSourceFiles(entry) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  const out = [];
  for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (dirent.name === 'node_modules') continue;
    const child = path.join(entry, dirent.name);
    if (dirent.isDirectory()) out.push(...listSourceFiles(child));
    else if (/\.(?:c|m)?[jt]s$/.test(dirent.name) && !dirent.name.endsWith('.d.ts')) out.push(path.join(ROOT, child));
  }
  return out;
}

test('every direct git spawn in server code scopes safe.directory', () => {
  const offenders = [];
  for (const file of SCAN_ROOTS.flatMap(listSourceFiles)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPAWN_GIT)) {
      if (source.slice(match.index, match.index + match[0].length + ARGS_WINDOW).includes('safe.directory')) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${rel}:${line}: ${match[0].trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Direct git spawns without safe.directory (use runGit from lib/worktree/git-worktree.ts):\n${offenders.join('\n')}`,
  );
});

test('allow-listed files still exist', () => {
  for (const rel of ALLOWED.keys()) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `stale allow-list entry: ${rel}`);
  }
});
