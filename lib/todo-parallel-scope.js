/**
 * Leaf file-scope extraction and collision checks for parallel todo siblings.
 */

import { listExistingFilePathsInLeafBody } from './model-pick-leaf-size.js';

/**
 * @param {object | null | undefined} item
 * @returns {string}
 */
function readTodoParentId(item) {
  if (!item || typeof item.parentId !== 'string') return '';
  return item.parentId.trim();
}

const LEAF_SCOPE_HEADING_RE = /^##\s+leaf\s+scope\s*$/im;
const SCOPE_BULLET_RE = /^[-*]\s+(?:`([^`]+)`|(.+?))\s*$/;

/**
 * @param {unknown} path
 * @returns {string}
 */
export function normalizeLeafScopePath(path) {
  const raw = String(path || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped.toLowerCase();
}

/**
 * @param {unknown} markdown
 * @returns {string[]}
 */
export function parseExplicitLeafScopePaths(markdown) {
  const source = String(markdown || '');
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  let inSection = false;
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {string[]} */
  const ordered = [];
  for (const line of lines) {
    if (LEAF_SCOPE_HEADING_RE.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line.trim())) break;
    if (!inSection) continue;
    const bullet = line.trim().match(SCOPE_BULLET_RE);
    if (!bullet) continue;
    const normalized = normalizeLeafScopePath(bullet[1] || bullet[2]);
    if (!normalized || paths.has(normalized)) continue;
    paths.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * @param {object | null | undefined} todo
 * @returns {string[]}
 */
export function collectTodoLeafScopePaths(todo) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];
  const addPath = (raw) => {
    const normalized = normalizeLeafScopePath(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };
  const planMarkdown = String(todo?.plan?.markdown || '');
  const body = String(todo?.body || '');
  for (const path of parseExplicitLeafScopePaths(planMarkdown)) addPath(path);
  for (const path of parseExplicitLeafScopePaths(body)) addPath(path);
  for (const path of listExistingFilePathsInLeafBody(planMarkdown)) addPath(path);
  for (const path of listExistingFilePathsInLeafBody(body)) addPath(path);
  return paths;
}

/**
 * Unknown scope (no declared paths) must not run parallel with another leaf.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
export function leafScopePathsCollide(left, right) {
  const a = Array.isArray(left) ? left.map(normalizeLeafScopePath).filter(Boolean) : [];
  const b = Array.isArray(right) ? right.map(normalizeLeafScopePath).filter(Boolean) : [];
  if (a.length === 0 || b.length === 0) return true;
  for (const pathA of a) {
    for (const pathB of b) {
      if (pathA === pathB) return true;
      if (pathA.startsWith(`${pathB}/`)) return true;
      if (pathB.startsWith(`${pathA}/`)) return true;
    }
  }
  return false;
}

/**
 * @param {object[]} items
 * @param {string} parentId
 * @returns {object[]}
 */
export function listTodoSiblings(items, parentId) {
  const pid = String(parentId || '').trim();
  if (!pid) return [];
  return (Array.isArray(items) ? items : []).filter((row) => readTodoParentId(row) === pid);
}

/**
 * @param {object[]} items
 * @param {string} parentId
 * @returns {{ leafId: string, paths: string[] }[]}
 */
export function buildSiblingScopeIndex(items, parentId) {
  return listTodoSiblings(items, parentId).map((row) => ({
    leafId: String(row.id || ''),
    paths: collectTodoLeafScopePaths(row),
  }));
}

/**
 * @param {object[]} items
 * @param {string} parentId
 * @returns {{ a: string, b: string, pathsA: string[], pathsB: string[] }[]}
 */
export function listParallelSiblingScopeCollisions(items, parentId) {
  const scopes = buildSiblingScopeIndex(items, parentId);
  /** @type {{ a: string, b: string, pathsA: string[], pathsB: string[] }[]} */
  const collisions = [];
  for (let i = 0; i < scopes.length; i += 1) {
    for (let j = i + 1; j < scopes.length; j += 1) {
      const left = scopes[i];
      const right = scopes[j];
      if (!leafScopePathsCollide(left.paths, right.paths)) continue;
      collisions.push({
        a: left.leafId,
        b: right.leafId,
        pathsA: left.paths,
        pathsB: right.paths,
      });
    }
  }
  return collisions;
}

/**
 * @param {object[]} items
 * @param {string} parentId
 * @returns {{ ok: true } | { ok: false, collisions: object[] }}
 */
export function assessParallelRunModeForSiblings(items, parentId) {
  const collisions = listParallelSiblingScopeCollisions(items, parentId);
  if (collisions.length === 0) return { ok: true };
  return { ok: false, collisions };
}

/**
 * True when a parallel parent's sibling in `doing` overlaps this leaf's scope.
 *
 * @param {object[]} items
 * @param {object} item
 * @param {Map<string, object>} index
 * @returns {boolean}
 */
export function isTodoBlockedByParallelSiblingScope(items, item, index) {
  const parentId = readTodoParentId(item);
  if (!parentId || !index) return false;
  const parent = index.get(parentId);
  if (!parent || parent.runMode !== 'parallel') return false;
  const ownPaths = collectTodoLeafScopePaths(item);
  const siblings = listTodoSiblings(items, parentId);
  return siblings.some((row) => {
    if (!row?.id || row.id === item.id) return false;
    if (row.status !== 'doing') return false;
    return leafScopePathsCollide(ownPaths, collectTodoLeafScopePaths(row));
  });
}
