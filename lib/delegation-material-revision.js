/**
 * Short material revision for delegation workflow patches.
 * HEAD plus a fingerprint of `git status --porcelain` when the tree is dirty.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function readDelegationMaterialRevision(cwd = process.cwd()) {
  const folder = String(cwd || '').trim() || process.cwd();
  try {
    const head = execFileSync('git', ['-C', folder, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!head) return '';
    const dirty = execFileSync('git', ['-C', folder, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!String(dirty || '').trim()) return head;
    const stamp = createHash('sha256').update(String(dirty), 'utf8').digest('hex').slice(0, 8);
    return `${head}+${stamp}`;
  } catch {
    return '';
  }
}
