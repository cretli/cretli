/**
 * Leaf file-scope extraction and collision checks for parallel todo siblings.
 */

import { listExistingFilePathsInLeafBody } from './model-pick-leaf-size.js';

/**
 * @param {any | null | undefined} item
 * @returns {string}
 */
function readTodoParentId(item) {
  if (!item || typeof item.parentId !== 'string') return '';
  return item.parentId.trim();
}

const LEAF_SCOPE_HEADING_RE = /^##\s+leaf\s+scope\s*$/im;
const SCOPE_BULLET_RE = /^[-*]\s+(.+?)\s*$/;
const GLOB_CHAR_RE = /[*?{]/;

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
 * @param {unknown} path
 * @returns {boolean}
 */
export function isLeafScopeGlob(path) {
  return GLOB_CHAR_RE.test(String(path || ''));
}

/**
 * Splits on commas that are not inside `{...}` (brace alternatives of a glob).
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitOutsideBraces(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * One Leaf scope bullet may hold several comma-separated entries, each with
 * trailing notes: `lib/a.js (fragment only)`, `lib/a.js, lib/b.js`. Returns the
 * bare path tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseScopeBulletEntries(text) {
  const noParens = String(text || '').replace(/\([^)]*\)/g, ' ');
  /** @type {string[]} */
  const entries = [];
  const ticks = [...noParens.matchAll(/`([^`]+)`/g)];
  const chunks = ticks.length > 0
    ? ticks.map((m) => m[1])
    : splitOutsideBraces(noParens);
  for (const chunk of chunks) {
    for (const piece of splitOutsideBraces(chunk)) {
      // Text after the first space is a note, not part of the path.
      const token = piece.trim().split(/\s+/)[0] || '';
      if (token) entries.push(token);
    }
  }
  return entries;
}

/**
 * True when the markdown contains a `## Leaf scope` heading, even if the
 * section lists no usable paths.
 *
 * @param {unknown} markdown
 * @returns {boolean}
 */
export function hasExplicitLeafScopeSection(markdown) {
  return String(markdown || '').split(/\r?\n/).some((line) => LEAF_SCOPE_HEADING_RE.test(line.trim()));
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
    for (const entry of parseScopeBulletEntries(bullet[1])) {
      const normalized = normalizeLeafScopePath(entry);
      if (!normalized || paths.has(normalized)) continue;
      paths.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}

/**
 * @param {any | null | undefined} todo
 * @returns {string[]}
 */
export function collectTodoLeafScopePaths(todo) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];
  const addPath = (/** @type {any} */ raw) => {
    const normalized = normalizeLeafScopePath(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };
  const planMarkdown = String(todo?.plan?.markdown || '');
  const body = String(todo?.body || '');
  for (const path of parseExplicitLeafScopePaths(planMarkdown)) addPath(path);
  for (const path of parseExplicitLeafScopePaths(body)) addPath(path);
  // An explicit `## Leaf scope` is authoritative: paths merely mentioned in the
  // description (a diagnosis, a "see lib/x.js" aside) must not widen it.
  // An explicitly present but empty section stays empty (unknown scope).
  if (paths.length > 0 || hasExplicitLeafScopeSection(planMarkdown) || hasExplicitLeafScopeSection(body)) return paths;
  // Inline mentions only count when they name a directory path: a bare file
  // name (`index.js` in a shared rules paragraph like
  // `features/<f>/{state,views,index.js}`) made every sibling collide.
  for (const path of listExistingFilePathsInLeafBody(planMarkdown)) if (String(path).includes('/') && !isLeafScopeGlob(path)) addPath(path);
  for (const path of listExistingFilePathsInLeafBody(body)) if (String(path).includes('/') && !isLeafScopeGlob(path)) addPath(path);
  return paths;
}

/**
 * Built per call (only for nodes without their own scope): rows are edited in
 * place, so a cached map could miss a newly added child.
 *
 * @param {any[]} items
 * @returns {Map<string, any[]>}
 */
function readChildrenByParent(items) {
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const row of items) {
    const pid = readTodoParentId(row);
    if (!pid) continue;
    const list = map.get(pid);
    if (list) list.push(row);
    else map.set(pid, [row]);
  }
  return map;
}

/**
 * Scope of a node for sibling collision checks. A leaf (or a node with its own
 * Leaf scope) uses its declared paths. A group without its own scope covers the
 * union of its children's scopes; one child with an unknown scope makes the
 * whole group unknown (empty), so it still never runs next to a sibling.
 *
 * @param {any[]} items
 * @param {any} todo
 * @returns {string[]}
 */
export function collectTodoSubtreeScopePaths(items, todo) {
  const own = collectTodoLeafScopePaths(todo);
  if (own.length > 0 || !Array.isArray(items)) return own;
  const children = readChildrenByParent(items);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {any} node @returns {boolean} false when some descendant has no scope */
  const walk = (node) => {
    const id = String(node?.id || '');
    if (!id || visited.has(id)) return true;
    visited.add(id);
    const kids = children.get(id) || [];
    if (kids.length === 0) return false;
    for (const kid of kids) {
      if (kid?.status === 'done' || kid?.status === 'deferred') continue;
      const kidOwn = collectTodoLeafScopePaths(kid);
      if (kidOwn.length > 0) {
        for (const path of kidOwn) if (!seen.has(path)) { seen.add(path); paths.push(path); }
        continue;
      }
      if (!walk(kid)) return false;
    }
    return true;
  };
  return walk(todo) ? paths : [];
}

/**
 * @param {string} glob normalized glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') { braceDepth += 1; out += '(?:'; }
    else if (ch === '}' && braceDepth > 0) { braceDepth -= 1; out += ')'; }
    else if (ch === ',' && braceDepth > 0) out += '|';
    else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** @param {string} glob @returns {string} literal text before the first wildcard */
function globStaticPrefix(glob) {
  const idx = glob.search(GLOB_CHAR_RE);
  return idx < 0 ? glob : glob.slice(0, idx);
}

/** @param {string} glob @returns {string} literal text after the last wildcard */
function globStaticSuffix(glob) {
  let idx = -1;
  for (let i = glob.length - 1; i >= 0; i -= 1) {
    if ('*?{}'.includes(glob[i])) { idx = i; break; }
  }
  return idx < 0 ? glob : glob.slice(idx + 1);
}

/**
 * @param {string} glob
 * @param {string} path non-glob
 * @returns {boolean}
 */
function globCollidesWithPath(glob, path) {
  const re = globToRegExp(glob);
  const segments = path.split('/');
  // The path itself, or any of its parent directories, matched by the glob.
  for (let n = segments.length; n >= 1; n -= 1) {
    if (re.test(segments.slice(0, n).join('/'))) return true;
  }
  // The path is a directory that contains what the glob selects.
  return globStaticPrefix(glob).startsWith(`${path}/`);
}

/** @param {string} glob @returns {string[]} */
function expandBraces(glob) {
  const m = glob.match(/\{([^{}]*)\}/);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

/**
 * Brace alternatives are expanded first so `lib/{a,b}.js` and `lib/{c,d}.js`
 * are recognised as disjoint.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function globsCollide(a, b) {
  const altsA = expandBraces(a);
  const altsB = expandBraces(b);
  return altsA.some((x) => altsB.some((y) => plainGlobsCollide(x, y)));
}

/**
 * Conservative glob-vs-glob check: disjoint literal prefixes or incompatible
 * literal suffixes (`.js` vs `.css`) cannot overlap; anything else may.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function plainGlobsCollide(a, b) {
  const pa = globStaticPrefix(a);
  const pb = globStaticPrefix(b);
  if (!pa.startsWith(pb) && !pb.startsWith(pa)) return false;
  const sa = globStaticSuffix(a);
  const sb = globStaticSuffix(b);
  if (sa && sb && !sa.endsWith(sb) && !sb.endsWith(sa)) return false;
  return true;
}

/**
 * @param {string} pathA
 * @param {string} pathB
 * @returns {boolean}
 */
function scopeEntriesCollide(pathA, pathB) {
  const globA = isLeafScopeGlob(pathA);
  const globB = isLeafScopeGlob(pathB);
  if (globA && globB) return globsCollide(pathA, pathB);
  if (globA) return globCollidesWithPath(pathA, pathB);
  if (globB) return globCollidesWithPath(pathB, pathA);
  return pathA === pathB || pathA.startsWith(`${pathB}/`) || pathB.startsWith(`${pathA}/`);
}

/**
 * Unknown scope (no declared paths) must not run parallel with another leaf.
 * Entries containing glob characters are matched as globs, not as paths.
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
      if (scopeEntriesCollide(pathA, pathB)) return true;
    }
  }
  return false;
}

/**
 * @param {any[]} items
 * @param {string} parentId
 * @returns {any[]}
 */
export function listTodoSiblings(items, parentId) {
  const pid = String(parentId || '').trim();
  if (!pid) return [];
  return (Array.isArray(items) ? items : []).filter((row) => readTodoParentId(row) === pid);
}

/**
 * @param {any[]} items
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
 * @param {any[]} items
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
 * @param {any[]} items
 * @param {string} parentId
 * @returns {{ ok: true } | { ok: false, collisions: any[] }}
 */
export function assessParallelRunModeForSiblings(items, parentId) {
  const collisions = listParallelSiblingScopeCollisions(items, parentId);
  if (collisions.length === 0) return { ok: true };
  return { ok: false, collisions };
}

/**
 * True when a parallel parent's sibling in `doing` overlaps this leaf's scope.
 *
 * @param {any[]} items
 * @param {any} item
 * @param {Map<string, any>} index
 * @returns {boolean}
 */
export function isTodoBlockedByParallelSiblingScope(items, item, index) {
  const parentId = readTodoParentId(item);
  if (!parentId || !index) return false;
  const parent = index.get(parentId);
  if (!parent || parent.runMode !== 'parallel') return false;
  const ownPaths = collectTodoSubtreeScopePaths(items, item);
  const siblings = listTodoSiblings(items, parentId);
  return siblings.some((row) => {
    if (!row?.id || row.id === item.id) return false;
    if (row.status !== 'doing') return false;
    return leafScopePathsCollide(ownPaths, collectTodoSubtreeScopePaths(items, row));
  });
}
