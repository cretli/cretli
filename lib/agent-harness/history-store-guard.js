/**
 * Conversation stores that file tools must not search or read.
 * Agents load chat history through Cretli MCP (chat_show / chat_history).
 */

import fs from 'fs';
import path from 'path';

/** Directory names that mark a conversation store anywhere in a path. */
export const HISTORY_STORE_DIR_NAMES = Object.freeze([
  'agent-transcripts',
  'chat-history',
  'runtime-home',
  'sdk-agent-store',
]);

/**
 * Patterns for .cursorignore / ripgrep. Do not rely on .gitignore alone —
 * Cursor glob honors .cursorignore, not gitignore, for explicit target dirs.
 *
 * Use file globs (`…/**`), not directory entries (`data/runtime-home/`).
 * Ignoring a parent directory makes Cursor SDK Glob/Read of a nested store
 * start then drop the `completed` event, so the probe never sees a result.
 */
export const HISTORY_STORE_IGNORE_PATTERNS = Object.freeze([
  'data/chat-history/**',
  'data/sdk-agent-store/**',
  '**/agent-transcripts/**',
]);

/** Older directory-level lines that abort nested Glob/Read; strip on sync. */
export const OBSOLETE_HISTORY_STORE_IGNORE_PATTERNS = Object.freeze([
  'data/chat-history/',
  'data/runtime-home/',
  'data/runtime-home/**',
  'data/sdk-agent-store/',
  '**/agent-transcripts/',
]);

const BLOCKED_DIR_NAMES = new Set(HISTORY_STORE_DIR_NAMES);
const IGNORE_FILE_HEADER = '# Conversation stores. Agents must use Cretli MCP chat_show / chat_history.';
const NESTED_STORE_IGNORE_HEADER = '# Nested conversation store. Do not search or read files here.';
const SKIP_WALK_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.vendor']);
const STORE_WALK_MAX_DEPTH = 10;

/**
 * File globs inside a store directory so Glob of that directory as search root
 * still emits `completed` (empty/denied). Lone `*` / `**` abort the tool and
 * drop the completed event, which the live probe cannot count as evidence.
 */
export const HISTORY_STORE_NESTED_IGNORE_PATTERNS = Object.freeze([
  '*.jsonl',
  '*.json',
  '**/*.jsonl',
  '**/*.json',
]);

/** Directory-wide nested lines that abort Cursor Glob/Read; strip on seal. */
export const OBSOLETE_NESTED_HISTORY_STORE_IGNORE_PATTERNS = Object.freeze(['*', '**']);

/**
 * @param {unknown} filePath
 * @returns {string}
 */
function resolvePathString(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw.replace(/\\/g, '/');
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function pathHasBlockedDir(value) {
  if (!value) return false;
  return value.split(/[\\/]+/).filter(Boolean).some((part) => BLOCKED_DIR_NAMES.has(part));
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function resolveExistingRealPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    try {
      if (!fs.lstatSync(filePath).isSymbolicLink()) return '';
      return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
    } catch {
      return '';
    }
  }
}

/**
 * True when the path is inside a conversation store (absolute or relative).
 *
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isHistoryStorePath(filePath) {
  const resolved = resolvePathString(filePath);
  if (!resolved) return false;
  if (pathHasBlockedDir(resolved)) return true;
  return pathHasBlockedDir(resolveExistingRealPath(resolved));
}

/**
 * Ripgrep --glob excludes so a workspace-wide grep does not walk stores.
 *
 * @returns {string[]}
 */
export function historyStoreRipgrepGlobs() {
  return [
    '!**/agent-transcripts/**',
    '!**/chat-history/**',
    '!**/runtime-home/**',
    '!**/sdk-agent-store/**',
  ];
}

/**
 * True when a workspace-relative path is covered by .cursorignore store patterns.
 *
 * @param {unknown} relPath
 * @returns {boolean}
 */
export function matchesHistoryStoreIgnore(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return false;
  if (isHistoryStorePath(normalized)) return true;
  return HISTORY_STORE_IGNORE_PATTERNS.some((pattern) => matchesIgnoreGlob(pattern, normalized));
}

/**
 * True when a shell command names a conversation store path.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function commandTouchesHistoryStore(command) {
  const text = String(command || '');
  if (!text.trim()) return false;
  if (isHistoryStorePath(text) || matchesHistoryStoreIgnore(text)) return true;
  const tokens = text.split(/[\s"'`=;|&<>()[\]{}]+/).filter(Boolean);
  return tokens.some((token) => isHistoryStorePath(token) || matchesHistoryStoreIgnore(token));
}

/**
 * @param {string} pattern
 * @param {string} relPath
 * @returns {boolean}
 */
function matchesIgnoreGlob(pattern, relPath) {
  const spec = String(pattern || '').replace(/\\/g, '/');
  const value = String(relPath || '').replace(/\\/g, '/');
  if (!spec || !value) return false;
  if (spec.startsWith('**/') && spec.endsWith('/**')) {
    const name = spec.slice(3, -3);
    return value.split('/').includes(name);
  }
  const prefix = spec.replace(/\/\*\*$/, '').replace(/\/$/, '');
  return value === prefix || value.startsWith(`${prefix}/`);
}

/**
 * Append missing store ignore patterns to `.cursorignore` / `.rgignore` in a root.
 *
 * @param {string} ignoreFilePath
 * @returns {boolean} true when the file was created or updated
 */
export function syncHistoryStoreIgnoreFile(ignoreFilePath) {
  const target = String(ignoreFilePath || '').trim();
  if (!target) return false;
  let existing = '';
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    existing = '';
  }
  const pruned = existing
    .split(/\r?\n/)
    .filter((line) => !OBSOLETE_HISTORY_STORE_IGNORE_PATTERNS.includes(line.trim()))
    .join('\n')
    .replace(/\s+$/, '');
  const missing = HISTORY_STORE_IGNORE_PATTERNS.filter((pattern) => !pruned.includes(pattern));
  if (!missing.length && pruned === existing.replace(/\s+$/, '') && existing) return false;
  const lines = pruned ? [pruned] : [IGNORE_FILE_HEADER];
  if (missing.length) lines.push(...missing);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

/**
 * Directories named as conversation stores under a workspace root.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findHistoryStoreDirectories(root) {
  const start = String(root || '').trim();
  if (!start) return [];
  /** @type {string[]} */
  const found = [];
  /**
   * @param {string} dir
   * @param {number} depth
   */
  function walk(dir, depth) {
    if (depth > STORE_WALK_MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_WALK_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (BLOCKED_DIR_NAMES.has(entry.name)) found.push(full);
      walk(full, depth + 1);
    }
  }
  walk(start, 0);
  return found;
}

/**
 * Write a local ignore file that hides every file inside a store directory.
 *
 * @param {string} storeDir
 * @returns {boolean}
 */
export function sealHistoryStoreDirectory(storeDir) {
  const dir = String(storeDir || '').trim();
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  let changed = false;
  for (const name of ['.cursorignore', '.rgignore']) {
    const target = path.join(dir, name);
    let existing = '';
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      existing = '';
    }
    const keptLines = existing
      .split(/\r?\n/)
      .filter((line) => !OBSOLETE_NESTED_HISTORY_STORE_IGNORE_PATTERNS.includes(line.trim()));
    const keptExact = new Set(keptLines.map((line) => line.trim()).filter(Boolean));
    const missing = HISTORY_STORE_NESTED_IGNORE_PATTERNS.filter((pattern) => !keptExact.has(pattern));
    const pruned = keptLines.join('\n').replace(/\s+$/, '');
    if (!missing.length && pruned === existing.replace(/\s+$/, '') && existing) continue;
    const lines = pruned ? [pruned] : [NESTED_STORE_IGNORE_HEADER];
    if (missing.length) lines.push(...missing);
    fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
    changed = true;
  }
  return changed;
}

/**
 * Keep Cursor / ripgrep ignore files current in every attached workspace root.
 *
 * @param {unknown} workspaceRoots
 * @returns {string[]}
 */
export function ensureHistoryStoreIgnoreFiles(workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  const updated = [];
  for (const root of roots) {
    const dir = String(root || '').trim();
    if (!dir) continue;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (syncHistoryStoreIgnoreFile(path.join(dir, '.cursorignore'))) updated.push(dir);
    syncHistoryStoreIgnoreFile(path.join(dir, '.rgignore'));
    for (const storeDir of findHistoryStoreDirectories(dir)) {
      sealHistoryStoreDirectory(storeDir);
    }
  }
  return updated;
}

/**
 * User-facing denial for glob / grep / read.
 *
 * @returns {string}
 */
export function historyStoreBlockedMessage() {
  return 'Conversation history is not available through file tools. Use Cretli MCP chat_show or chat_history with the chat id.';
}
