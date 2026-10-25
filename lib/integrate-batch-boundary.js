/**
 * Safe-boundary inspection for a bulk integrate batch.
 *
 * A batch may continue after a failed or unconfirmed entry only when the logical
 * workspace is at a boundary the next agent can start from: nothing unmerged,
 * no merge / rebase / cherry-pick / revert in progress, and the set of dirty
 * paths (with content fingerprints) equal to the snapshot taken when the entry
 * was dispatched. Nothing is restored or discarded here; inspection is read-only.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './worktree/git-worktree.ts';

const IN_PROGRESS_MARKERS = Object.freeze([
  ['MERGE_HEAD', 'merge_in_progress'],
  ['rebase-merge', 'rebase_in_progress'],
  ['rebase-apply', 'rebase_in_progress'],
  ['CHERRY_PICK_HEAD', 'cherry_pick_in_progress'],
  ['REVERT_HEAD', 'revert_in_progress'],
]);

// Caps for content-fingerprinting dirty paths inside nested repositories; exceeding
// them fails closed (inspection error) instead of comparing a partial fingerprint.
export const NESTED_MAX_FILES = 2000;
export const NESTED_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Content fingerprint of one dirty path. Real absence (ENOENT) is a state of its
 * own; any other failure (unreadable file, permission) throws so the caller
 * reports an inspection failure instead of a comparable fingerprint. A directory
 * (nested repo / submodule) is fingerprinted by its HEAD when it is a git
 * checkout, and by its entry names otherwise.
 *
 * @param {string} filePath
 * @param {typeof runGit} git
 * @returns {string}
 */
function fingerprintWorktreeFile(filePath, git, budget = null, limits = null) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && /** @type {any} */ (error).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(filePath)}`;
  if (stat.isDirectory()) {
    // A nested directory is a repository when it carries its own .git entry; a plain
    // subdirectory of the outer repo keeps the entry-name fingerprint.
    if (fs.existsSync(path.join(filePath, '.git'))) {
      const name = path.basename(filePath);
      const head = git(['rev-parse', '--verify', '-q', 'HEAD'], filePath, { allowFailure: true });
      let headId;
      if (head.status === 0) {
        headId = head.stdout.trim();
      } else {
        // Only a genuinely unborn HEAD is tolerated; anything else is an inspection failure.
        const sym = git(['symbolic-ref', '-q', 'HEAD'], filePath, { allowFailure: true });
        if (sym.status !== 0 || head.stdout.trim()) throw new Error(`dir_head_unresolved:${name}`);
        headId = 'unborn';
      }
      const dirty = git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], filePath, { allowFailure: true });
      if (dirty.status !== 0) throw new Error(`dir_inspection_failed:${name}`);
      // HEAD and XY status stay identical when an already-dirty file is edited again,
      // so every dirty path inside the nested repo is fingerprinted by content.
      const nestedBudget = /** @type {any} */ (budget || { files: /** @type {any} */ (limits)?.maxFiles ?? NESTED_MAX_FILES, bytes: /** @type {any} */ (limits)?.maxBytes ?? NESTED_MAX_BYTES });
      const hash = createHash('sha1');
      const rows = parsePorcelainV2(dirty.stdout).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const row of rows) {
        if (!row.path) throw new Error(`nested_unparsable_status:${name}`);
        nestedBudget.files -= 1;
        if (nestedBudget.files < 0) throw new Error('nested_inspection_limit_files');
        hash.update(`${row.xy}|${row.indexBlob}|${row.path}|${fingerprintWorktreeFile(path.join(filePath, row.path), git, nestedBudget)}\0`);
      }
      return `repo:${headId}:${hash.digest('hex')}`;
    }
    const names = fs.readdirSync(filePath).sort().join('\0');
    return `dir:${createHash('sha1').update(names).digest('hex')}`;
  }
  if (budget) {
    /** @type {any} */ (budget).bytes -= stat.size;
    if (/** @type {any} */ (budget).bytes < 0) throw new Error('nested_inspection_limit_bytes');
  }
  return `file:${createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')}`;
}

/**
 * Parse `git status --porcelain=v2 -z` output into dirty-path records.
 *
 * @param {string} output
 * @returns {{ path: string, kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked', xy: string, indexBlob: string }[]}
 */
export function parsePorcelainV2(output) {
  const fields = String(output ?? '').split('\0');
  const rows = [];
  // Unknown or malformed records throw: a partially parsed status is never comparable.
  const bad = (/** @type {any} */ record) => new Error(`status_parse_error:${String(record).slice(0, 40)}`);
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    const kind = record[0];
    const parts = record.split(' ');
    if (kind === '1') {
      if (parts.length < 9 || record[1] !== ' ') throw bad(record);
      rows.push({ kind: 'ordinary', xy: parts[1], indexBlob: parts[7] || '', path: parts.slice(8).join(' ') });
    } else if (kind === '2') {
      if (parts.length < 10 || record[1] !== ' ' || i + 1 >= fields.length || !fields[i + 1]) throw bad(record);
      rows.push({ kind: 'rename', xy: parts[1], indexBlob: parts[7] || '', path: parts.slice(9).join(' ') });
      i += 1; // the original path follows as its own NUL-separated field
    } else if (kind === 'u') {
      if (parts.length < 11 || record[1] !== ' ') throw bad(record);
      rows.push({ kind: 'unmerged', xy: parts[1], indexBlob: parts[7] || '', path: parts.slice(10).join(' ') });
    } else if (kind === '?') {
      if (record[1] !== ' ' || record.length < 3) throw bad(record);
      rows.push({ kind: 'untracked', xy: '??', indexBlob: '', path: record.slice(2) });
    } else if (kind === '!' || kind === '#') {
      if (record[1] !== ' ') throw bad(record);
    } else {
      throw bad(record);
    }
  }
  return /** @type {any} */ (rows);
}

/**
 * Snapshot the boundary of a workspace.
 *
 * @param {{ workspaceFolder: string, nestedLimits?: { maxFiles?: number, maxBytes?: number }, deps?: { runGit?: typeof runGit } }} input
 * @returns {{ ok: boolean, reason?: string, unmerged: string[], inProgress: string[], dirty: Record<string, string> }}
 */
export function inspectWorkspaceBoundary(input) {
  const git = typeof input.deps?.runGit === 'function' ? input.deps.runGit : runGit;
  const cwd = input.workspaceFolder;
  const empty = { unmerged: [], inProgress: [], dirty: {} };
  try {
    const status = git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd, { allowFailure: true });
    if (status.status !== 0) return { ok: false, reason: 'git_status_failed', ...empty };
    const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd, { allowFailure: true });
    if (gitDir.status !== 0) return { ok: false, reason: 'git_dir_unavailable', ...empty };
    const gitDirPath = gitDir.stdout.trim();
    const inProgress = IN_PROGRESS_MARKERS
      .filter(([marker]) => fs.existsSync(path.join(gitDirPath, marker)))
      .map(([, label]) => label);
    const rows = parsePorcelainV2(status.stdout);
    /** @type {Record<string, string>} */
    const dirty = {};
    const unmerged = [];
    for (const row of rows) {
      if (!row.path) return { ok: false, reason: 'unparsable_status', ...empty };
      if (row.kind === 'unmerged') unmerged.push(row.path);
      dirty[row.path] = `${row.xy}|${row.indexBlob}|${fingerprintWorktreeFile(path.join(cwd, row.path), git, /** @type {any} */ (null), /** @type {any} */ (input.nestedLimits))}`;
    }
    return { ok: true, unmerged, inProgress: [...new Set(inProgress)], dirty };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'boundary_inspection_failed', ...empty };
  }
}

/**
 * Decide whether `current` is a safe place to continue from `snapshot`.
 *
 * @param {{ snapshot: Record<string, string> | null, current: ReturnType<typeof inspectWorkspaceBoundary>, driftIgnored?: boolean }} input
 * @returns {{ safe: boolean, reasons: string[], paths: string[] }}
 */
export function evaluateBoundary(input) {
  const { current } = input;
  if (!current.ok) return { safe: false, reasons: [`inspection_failed:${current.reason || 'unknown'}`], paths: [] };
  const reasons = [];
  const paths = [];
  if (current.unmerged.length) {
    reasons.push('unmerged_paths');
    paths.push(...current.unmerged);
  }
  reasons.push(...current.inProgress);
  if (!input.driftIgnored) {
    if (!input.snapshot) {
      reasons.push('snapshot_missing');
    } else {
      const before = input.snapshot;
      const names = new Set([...Object.keys(before), ...Object.keys(current.dirty)]);
      const drifted = [...names].filter((name) => before[name] !== current.dirty[name]);
      if (drifted.length) {
        reasons.push('workspace_drift');
        paths.push(...drifted);
      }
    }
  }
  return { safe: reasons.length === 0, reasons, paths: [...new Set(paths)].slice(0, 50) };
}
