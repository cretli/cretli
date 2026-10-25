/** Git status of the workspace tree: path -> change code, plus dirty directories. */
import * as api from '../../../core/api/index.js';

export const GIT_STATUS_EVENT = 'cretli-git-changed';

export const GIT_CLASS_BY_STATUS = {
  M: 'is-modified',
  A: 'is-added',
  D: 'is-deleted',
  R: 'is-renamed',
  C: 'is-renamed',
  U: 'is-untracked',
};

/** @type {Map<string, string>} */
let gitStatusByPath = new Map();
/** @type {Set<string>} */
let gitDirtyDirs = new Set();
let gitStatusLoaded = false;

export function classifyGitStatus(code) {
  if (!code || code.length < 2) return '';
  if (code === '??') return 'U';
  if (code === '!!') return '';
  const x = code[0];
  const y = code[1];
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  if (x === 'M' || y === 'M') return 'M';
  return '';
}

export function parseGitStatusShort(lines) {
  const byPath = new Map();
  const dirtyDirs = new Set();
  for (const raw of lines) {
    if (!raw || raw.startsWith('## ')) continue;
    const code = raw.slice(0, 2);
    const rest = raw.slice(3);
    // Rename/copy: "old -> new" — take both paths
    const arrowIdx = rest.indexOf(' -> ');
    const paths = arrowIdx >= 0 ? [rest.slice(0, arrowIdx), rest.slice(arrowIdx + 4)] : [rest];
    const cls = classifyGitStatus(code);
    if (!cls) continue;
    for (let p of paths) {
      if (!p) continue;
      // porcelain v1 quotes paths that contain special characters
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1');
      p = p.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!p) continue;
      byPath.set(p, cls);
      const segments = p.split('/');
      for (let i = 1; i < segments.length; i++) {
        dirtyDirs.add(segments.slice(0, i).join('/'));
      }
    }
  }
  return { byPath, dirtyDirs };
}

function reset() {
  gitStatusByPath = new Map();
  gitDirtyDirs = new Set();
  gitStatusLoaded = true;
}

/** Fetches the status; always resolves (errors reset it to "clean"). */
export function fetchGitStatus() {
  return api.getGitInfo().then((data) => {
    if (!data?.ok || !data.isRepo || !Array.isArray(data.statusShort)) {
      reset();
      return;
    }
    const { byPath, dirtyDirs } = parseGitStatusShort(data.statusShort);
    gitStatusByPath = byPath;
    gitDirtyDirs = dirtyDirs;
    gitStatusLoaded = true;
  }).catch(reset);
}

export function isGitStatusLoaded() {
  return gitStatusLoaded;
}

export function fileHasGitChanges(filePath) {
  return !!filePath && gitStatusByPath.has(filePath);
}

/** CSS state class of a tree entry, '' when clean or status not loaded. */
export function gitClassFor(path, isDir) {
  if (!gitStatusLoaded || !path) return '';
  if (isDir) return gitDirtyDirs.has(path) ? 'has-changes' : '';
  return GIT_CLASS_BY_STATUS[gitStatusByPath.get(path) || ''] || '';
}
