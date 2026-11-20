import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../lib/worktree/git-worktree.ts';

export function installGitHooks(
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  hookSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-hooks', 'commit-msg'),
  { force = false, warn = (message) => process.stderr.write(`${message}\n`) } = {},
) {
  const root = path.resolve(repoRoot);
  const gitDir = runGit(['rev-parse', '--git-common-dir'], root).stdout.trim();
  const hooksDir = path.resolve(root, gitDir, 'hooks');
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('Run hooks:install from a Git checkout.');
  const configuredHooksPath = runGit(['config', '--get', 'core.hooksPath'], root, { allowFailure: true }).stdout.trim();
  if (configuredHooksPath) warn(`core.hooksPath is set to "${configuredHooksPath}"; the copied .git/hooks/commit-msg may not run.`);
  fs.mkdirSync(hooksDir, { recursive: true });
  const destination = path.join(hooksDir, 'commit-msg');
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    const proposed = fs.readFileSync(hookSource);
    if (existing.equals(proposed)) return destination;
    if (!force) throw new Error(`Refusing to replace existing ${destination}; rerun with --force to back it up first.`);
    let backup = `${destination}.bak-${Date.now()}`;
    let suffix = 1;
    while (fs.existsSync(backup)) backup = `${destination}.bak-${Date.now()}-${suffix++}`;
    fs.copyFileSync(destination, backup);
  }
  fs.copyFileSync(hookSource, destination);
  fs.chmodSync(destination, 0o755);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--force');
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
  process.stdout.write(`Installed ${installGitHooks(undefined, undefined, { force: args.includes('--force') })}\n`);
}
