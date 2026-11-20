/**
 * Short material revision for delegation workflow patches.
 * HEAD plus a fingerprint of `git status --porcelain` when the tree is dirty.
 */

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

import { createHash } from 'node:crypto';
import { resolveExecutionFolderForRecord } from './execution-folder.js';
import { runGit } from './worktree/git-worktree.ts';

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function readDelegationMaterialRevision(cwd = process.cwd()) {
  const folder = String(cwd || '').trim() || process.cwd();
  try {
    // runGit trusts this checkout only, so a foreign-owned repo still resolves.
    const head = runGit(['rev-parse', '--short=12', 'HEAD'], folder).stdout.trim();
    if (!head) return '';
    const dirty = runGit(['status', '--porcelain'], folder).stdout;
    if (!String(dirty || '').trim()) return head;
    const stamp = createHash('sha256').update(String(dirty), 'utf8').digest('hex').slice(0, 8);
    return `${head}+${stamp}`;
  } catch {
    return '';
  }
}

/**
 * Material revision of a delegation record: its frozen execution folder, or
 * the logical workspace when no execution folder was recorded.
 *
 * @param {Record<string, any>} row
 * @returns {string}
 */
export function readDelegationMaterialRevisionForRecord(row) {
  return readDelegationMaterialRevision(resolveExecutionFolderForRecord(row));
}
