/**
 * Conversation stores that file tools must not search or read.
 * Agents load chat history through Cretli MCP (chat_show / chat_history).
 */

import fs from 'fs';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';

/** Directory names that mark a conversation store anywhere in a path. */
export const HISTORY_STORE_DIR_NAMES = Object.freeze([
  'agent-transcripts',
  'chat-history',
  'runtime-home',
  'sdk-agent-store',
  // SQLite history backend: coordinator/marker control files and the durable pending-command journal.
  'storage-control',
  'storage-pending',
]);

/**
 * Data-directory children that hold the SQLite store file (`cretli-store.sqlite` + WAL/SHM). `storage` is also the
 * name of a source directory (`lib/storage`), so it is matched by its resolved data path, not by name anywhere.
 */
export const HISTORY_STORE_DATA_DIRS = Object.freeze(['storage', 'storage-control', 'storage-pending']);

/** The store file and its WAL/SHM/journal companions, wherever they were copied. */
const SQLITE_STORE_FILE = /(?:^|[\\/])cretli-store\.sqlite(?:-wal|-shm|-journal)?$/i;

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
  'data/storage/**',
  'data/storage-control/**',
  'data/storage-pending/**',
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

const BLOCKED_DIR_NAMES = new Set<string>(HISTORY_STORE_DIR_NAMES);
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

function resolvePathString(filePath: unknown): string {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw.replace(/\\/g, '/');
  }
}

function pathHasBlockedDir(value: string): boolean {
  if (!value) return false;
  return value.split(/[\\/]+/).filter(Boolean).some((part) => BLOCKED_DIR_NAMES.has(part));
}

function resolveExistingRealPath(filePath: string): string {
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
 */
export function isHistoryStorePath(filePath: unknown): boolean {
  const resolved = resolvePathString(filePath);
  if (!resolved) return false;
  if (pathHasBlockedDir(resolved) || isSqliteStorePath(resolved)) return true;
  const real = resolveExistingRealPath(resolved);
  return pathHasBlockedDir(real) || isSqliteStorePath(real);
}

/**
 * The SQLite store file, or anything under the data directory's `storage*` children.
 */
function isSqliteStorePath(value: string): boolean {
  if (!value) return false;
  if (SQLITE_STORE_FILE.test(value)) return true;
  const dataDir = resolveDataPath();
  return HISTORY_STORE_DATA_DIRS.some((name) => {
    const root = path.join(dataDir, name);
    return value === root || value.startsWith(`${root}${path.sep}`);
  });
}

/**
 * Ripgrep --glob excludes so a workspace-wide grep does not walk stores.
 */
export function historyStoreRipgrepGlobs(): string[] {
  return [
    '!**/agent-transcripts/**',
    '!**/chat-history/**',
    '!**/runtime-home/**',
    '!**/sdk-agent-store/**',
    '!**/storage-control/**',
    '!**/storage-pending/**',
    '!**/data/storage/**',
    '!**/cretli-store.sqlite*',
  ];
}

/**
 * True when a workspace-relative path is covered by .cursorignore store patterns.
 */
export function matchesHistoryStoreIgnore(relPath: unknown): boolean {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return false;
  if (isHistoryStorePath(normalized)) return true;
  return HISTORY_STORE_IGNORE_PATTERNS.some((pattern) => matchesIgnoreGlob(pattern, normalized));
}

/**
 * True when a shell command names a conversation store path.
 */
export function commandTouchesHistoryStore(command: unknown): boolean {
  const text = String(command || '');
  if (!text.trim()) return false;
  if (isHistoryStorePath(text) || matchesHistoryStoreIgnore(text)) return true;
  const tokens = text.split(/[\s"'`=;|&<>()[\]{}]+/).filter(Boolean);
  return tokens.some((token) => isHistoryStorePath(token) || matchesHistoryStoreIgnore(token));
}

function matchesIgnoreGlob(pattern: string, relPath: string): boolean {
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
 * @returns true when the file was created or updated
 */
export function syncHistoryStoreIgnoreFile(ignoreFilePath: string): boolean {
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
 */
export function findHistoryStoreDirectories(root: string): string[] {
  const start = String(root || '').trim();
  if (!start) return [];
  const found: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > STORE_WALK_MAX_DEPTH) return;
    let entries: fs.Dirent[] = [];
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
 */
export function sealHistoryStoreDirectory(storeDir: string): boolean {
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
 */
export function ensureHistoryStoreIgnoreFiles(workspaceRoots: unknown): string[] {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  const updated: string[] = [];
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
 */
export function historyStoreBlockedMessage(): string {
  return 'Conversation history is not available through file tools. Use Cretli MCP chat_show or chat_history with the chat id.';
}
