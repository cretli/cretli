import path from 'path';
import { realpathSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * @param {string} cwd
 * @returns {string}
 */
function resolveGitSafeDirectory(cwd) {
  const base = cwd ? path.resolve(String(cwd)) : process.cwd();
  try {
    return realpathSync(base);
  } catch {
    return base;
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, status?: number, stdout?: string, stderr?: string, error?: string }}
 */
export function runGitCommand(args, cwd) {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, error: 'No git command.' };
  }
  try {
    const safeCwd = resolveGitSafeDirectory(cwd);
    const gitArgs = ['-c', `safe.directory=${safeCwd}`, ...args];
    const result = spawnSync('git', gitArgs, {
      cwd: safeCwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'Failed to run git.' };
  }
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
export function isGitRepo(cwd) {
  const res = runGitCommand(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!res.ok) return false;
  return res.stdout.trim() === 'true';
}

/**
 * @param {string} line
 * @returns {{ branch: string, upstream: string, aheadBehind: string }}
 */
export function parseGitStatusBranchLine(line) {
  if (!line) return { branch: '', upstream: '', aheadBehind: '' };
  const clean = line.replace(/^##\s*/, '').trim();
  if (!clean) return { branch: '', upstream: '', aheadBehind: '' };
  if (clean.startsWith('HEAD')) return { branch: 'HEAD', upstream: '', aheadBehind: '' };
  if (!clean.includes('...')) {
    const spaceIndex = clean.indexOf(' ');
    const branch = spaceIndex > -1 ? clean.slice(0, spaceIndex).trim() : clean;
    return { branch, upstream: '', aheadBehind: '' };
  }
  const [branchPart, rest] = clean.split('...');
  const branch = (branchPart || '').trim();
  const restTrim = (rest || '').trim();
  const upstream = restTrim.split(' ')[0] || '';
  const match = restTrim.match(/\[(.+)\]/);
  const aheadBehind = match ? match[1].trim() : '';
  return { branch, upstream, aheadBehind };
}

/**
 * @param {unknown} arg
 * @returns {string}
 */
export function normalizeGitArg(arg) {
  if (!arg || typeof arg !== 'string') return '';
  const trimmed = arg.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('-')) return '';
  if (!/^[0-9A-Za-z._/-]+$/.test(trimmed)) return '';
  return trimmed;
}
