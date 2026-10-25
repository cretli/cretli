/**
 * Server-code freshness: a content manifest of the backend sources plus the
 * pure diff and episode rules built on top of it.
 *
 * A long-lived server can run for hours while `server.js` and the sources under
 * `lib/` on disk already contain newer code, and symptoms then look like logic
 * bugs.
 * `serverInstanceToken` proves a *restart* happened, not that the running code
 * is current, and the HMR/dist path only covers the front.
 *
 * Why content hashes and not mtime: `touch`, a formatter that rewrites identical
 * bytes and WSL clock skew all move mtime without changing behaviour, while a
 * same-size edit with a preserved (or rolled-back) mtime, a deletion and a
 * rename stay invisible to it. mtime may one day gate *which* files are worth
 * reading, but it never decides whether a change is reported: every periodic
 * pass re-reads and re-hashes the whole inventory.
 *
 * Everything here is pure over injected inputs (fs adapter, clock, baseline,
 * acknowledgements), so the acceptance rules are unit-testable without touching
 * a real filesystem or waiting for a timer.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

/** Backend sources at the project root, relative and posix-normalised. */
export const SERVER_CODE_ENTRY_FILES = Object.freeze(['server.js']);

/** Top-level directories walked recursively for backend sources. */
export const SERVER_CODE_SCAN_DIRS = Object.freeze(['lib', 'harnesses']);

/** Only these suffixes belong to the backend manifest. */
export const SERVER_CODE_EXTENSIONS = Object.freeze(['.js', '.ts']);

/**
 * Never backend code: third-party dependencies, runtime state, built front
 * assets, front sources (the front has its own `frontAssetVersion` path) and VCS
 * metadata. A change confined to these must not raise the flag.
 */
export const SERVER_CODE_IGNORED_DIRS = Object.freeze([
  'node_modules',
  'data',
  'public',
  'app_front',
  '.git',
]);

/** Notification fingerprint prefix for this producer's episodes. */
export const CODE_FRESHNESS_EPISODE_PREFIX = 'server:code-freshness';

/** Detector states. `unknown` is missing data, never a zeroed-out `fresh`. */
export const CODE_FRESHNESS_STATES = Object.freeze(['fresh', 'stale', 'unknown']);

/** Violation kinds emitted by this detector. */
export const CODE_FRESHNESS_VIOLATION_KIND = 'backend-code-stale';

/**
 * @typedef {{ name: string, isDirectory?: boolean | (() => boolean) }} CodeFsEntry
 * @typedef {{
 *   readDirectory: (dirPath: string) => Promise<CodeFsEntry[]>,
 *   readFile: (filePath: string) => Promise<string | Uint8Array>,
 * }} CodeFsAdapter
 */

/**
 * @param {string} filePath
 * @returns {string}
 */
function toRelPath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

/**
 * Whether a path belongs to the running backend. Pure over the path string so
 * the exclusion rules are testable without any filesystem.
 *
 * @param {string} relPath relative to the project root (posix or win32 separators)
 * @returns {boolean}
 */
export function isServerCodePath(relPath) {
  const rel = toRelPath(relPath);
  if (!rel) return false;
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => SERVER_CODE_IGNORED_DIRS.includes(segment))) return false;
  if (segments.length === 1) return SERVER_CODE_ENTRY_FILES.includes(rel);
  if (!SERVER_CODE_SCAN_DIRS.includes(segments[0])) return false;
  return SERVER_CODE_EXTENSIONS.some((suffix) => rel.endsWith(suffix));
}

/**
 * @param {CodeFsEntry | null | undefined} entry
 * @returns {boolean}
 */
function isDirectoryEntry(entry) {
  if (!entry) return false;
  if (typeof entry.isDirectory === 'function') return entry.isDirectory() === true;
  return entry.isDirectory === true;
}

/**
 * Content hash of one file. UTF-8 strings and raw bytes hash identically, so an
 * injected adapter may return either.
 *
 * @param {string | Uint8Array} content
 * @returns {string}
 */
export function hashFileContent(content) {
  const buffer = Buffer.isBuffer(content)
    ? content
    : (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content ?? []));
  return createHash('sha256').update(buffer).digest('hex');
}

/** Default adapter: the real filesystem, read asynchronously so a full pass
 *  never blocks the event loop. */
export const nodeCodeFsAdapter = Object.freeze({
  async readDirectory(dirPath) {
    return (await readdir(dirPath, { withFileTypes: true }))
      .map((entry) => ({ name: String(entry.name), isDirectory: () => entry.isDirectory() }));
  },
  async readFile(filePath) {
    return readFile(filePath);
  },
});

/**
 * Sorted inventory of backend source paths, relative to `rootDir`.
 *
 * @param {{ rootDir: string, fsAdapter?: CodeFsAdapter }} input
 * @returns {Promise<string[]>} rejects when a directory cannot be listed
 */
export async function collectServerCodePaths({ rootDir, fsAdapter = nodeCodeFsAdapter }) {
  const found = [];
  const rootEntries = await fsAdapter.readDirectory(rootDir);
  const rootFileNames = new Set(
    (Array.isArray(rootEntries) ? rootEntries : [])
      .filter((entry) => entry && !isDirectoryEntry(entry))
      .map((entry) => String(entry.name)),
  );
  for (const name of SERVER_CODE_ENTRY_FILES) {
    if (rootFileNames.has(name) && isServerCodePath(name)) found.push(name);
  }
  for (const dirName of SERVER_CODE_SCAN_DIRS) {
    const stack = [dirName];
    while (stack.length) {
      const relDir = stack.pop();
      let entries;
      try {
        entries = await fsAdapter.readDirectory(path.join(rootDir, relDir));
      } catch (error) {
        // A top-level source directory that does not exist (e.g. `harnesses/`
        // before the plugin migration) is an empty inventory, not a read failure;
        // its files then show up as removed against the baseline if it vanishes.
        if (relDir === dirName && error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        const name = String(entry?.name || '');
        if (!name) continue;
        const rel = `${relDir}/${name}`;
        if (isDirectoryEntry(entry)) {
          // Prune ignored directories before descending: they are never read, so
          // an unreadable `node_modules` cannot turn the scan into `unknown`.
          // `isServerCodePath` stays the file-level rule.
          if (SERVER_CODE_IGNORED_DIRS.includes(name)) continue;
          stack.push(rel);
          continue;
        }
        if (isServerCodePath(rel)) found.push(rel);
      }
    }
  }
  return found.sort();
}

/**
 * Walk, read and hash every backend source. Never throws: a directory that
 * cannot be listed or a file that cannot be read yields `status: 'unknown'` with
 * a partial manifest. Diffing a partial manifest would report every missing file
 * as deleted, so callers must treat `unknown` as "no measurement", not as data.
 *
 * @param {{ rootDir: string, fsAdapter?: CodeFsAdapter }} input
 * @returns {Promise<{ status: 'ok' | 'unknown', manifest: Record<string, string>, failures: string[] }>}
 */
export async function scanServerCodeManifest({ rootDir, fsAdapter = nodeCodeFsAdapter }) {
  /** @type {Record<string, string>} */
  const manifest = {};
  /** @type {string[]} */
  const failures = [];
  let paths = [];
  try {
    paths = await collectServerCodePaths({ rootDir, fsAdapter });
  } catch {
    return { status: 'unknown', manifest: {}, failures: ['inventory'] };
  }
  for (const rel of paths) {
    try {
      const content = await fsAdapter.readFile(path.join(rootDir, rel));
      manifest[rel] = hashFileContent(content);
      continue;
    } catch {
      failures.push(rel);
    }
  }
  return { status: failures.length ? 'unknown' : 'ok', manifest, failures };
}

/**
 * @param {Record<string, string> | null | undefined} manifest
 * @returns {Record<string, string>}
 */
function asManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    const rel = toRelPath(key);
    if (!rel) continue;
    out[rel] = String(value ?? '');
  }
  return out;
}

/**
 * Compare two manifests by content and inventory. Deletions and renames are
 * inventory facts, so they are detected without reading anything; the caller
 * decides what a rename costs (it is one removal plus one addition).
 *
 * @param {{ baseline?: Record<string, string>, current?: Record<string, string> }} input
 * @returns {{ changed: string[], removed: string[], added: string[], changedCount: number, signature: string }}
 */
export function diffCodeManifest({ baseline, current } = {}) {
  const before = asManifest(baseline);
  const after = asManifest(current);
  const changed = [];
  const removed = [];
  const added = [];
  for (const [rel, hash] of Object.entries(before)) {
    if (!(rel in after)) {
      removed.push(rel);
      continue;
    }
    if (after[rel] !== hash) changed.push(rel);
  }
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) added.push(rel);
  }
  changed.sort();
  removed.sort();
  added.sort();
  const signature = createHash('sha256')
    .update([
      ...changed.map((rel) => `=${rel}:${after[rel]}`),
      ...removed.map((rel) => `-${rel}`),
      ...added.map((rel) => `+${rel}:${after[rel]}`),
    ].sort().join('\n'))
    .digest('hex')
    .slice(0, 32);
  return { changed, removed, added, changedCount: changed.length + removed.length + added.length, signature };
}

/**
 * Stable episode key: this server instance plus the change set. The same files
 * changing back to the same content replays the same key (so the notification
 * store dedupes it and one episode never notifies twice), while a different
 * change set is a genuinely new episode.
 *
 * @param {{ instanceToken?: string, signature?: string }} input
 * @returns {string}
 */
export function codeFreshnessEpisodeKey({ instanceToken = '', signature = '' } = {}) {
  const token = String(instanceToken || '').trim();
  const sig = String(signature || '').trim();
  if (!sig) return '';
  return `${CODE_FRESHNESS_EPISODE_PREFIX}:${token || 'unknown-instance'}:${sig}`;
}

/**
 * @returns {{ changed: string[], removed: string[], added: string[], changedCount: number, signature: string }}
 */
function emptyDiff() {
  return { changed: [], removed: [], added: [], changedCount: 0, signature: '' };
}

/**
 * Pure episode rules: scan status + diff -> detector state, the stable episode
 * key, that episode's state and the violations to report.
 *
 * Episode state is `open` while the change set is on disk, `acked` once the
 * operator dismissed this episode's notification (dismissal is the ack the
 * notification centre already persists), and `closed` when the content is
 * restored — the latter needs no restart, which is the point of comparing
 * against the startup baseline instead of a timestamp. Reopen rule: a *new*
 * change set is a new key, so it notifies again even if the previous episode was
 * acked; a replay of the same key does not.
 *
 * @param {{
 *   scanStatus?: 'ok' | 'unknown',
 *   diff?: ReturnType<typeof diffCodeManifest>,
 *   instanceToken?: string,
 *   previousEpisode?: { key?: string, openedAt?: number } | null,
 *   acknowledgedEpisodeKeys?: string[],
 *   now?: number,
 * }} [input]
 * @returns {{
 *   state: 'fresh' | 'stale' | 'unknown',
 *   changedCount: number | null,
 *   episodeKey: string,
 *   episodeState: 'open' | 'acked' | 'closed' | 'unknown',
 *   staleSinceAt: string | null,
 *   openedAt: number | null,
 *   violations: Array<Record<string, unknown>>,
 * }}
 */
export function describeCodeFreshness(input = {}) {
  const {
    scanStatus = 'ok',
    diff = emptyDiff(),
    instanceToken = '',
    previousEpisode = null,
    acknowledgedEpisodeKeys = [],
    now = Date.now(),
  } = input;

  // Missing data is `unknown`: no violation, no count, and nothing downstream may
  // read it as zero or as a reason to act.
  if (scanStatus !== 'ok') {
    return {
      state: 'unknown',
      changedCount: null,
      episodeKey: '',
      episodeState: 'unknown',
      staleSinceAt: null,
      openedAt: null,
      violations: [],
    };
  }
  const changedCount = Math.max(0, Number(diff?.changedCount) || 0);
  if (changedCount === 0) {
    return {
      state: 'fresh',
      changedCount: 0,
      episodeKey: '',
      episodeState: 'closed',
      staleSinceAt: null,
      openedAt: null,
      violations: [],
    };
  }
  const episodeKey = codeFreshnessEpisodeKey({ instanceToken, signature: diff?.signature });
  const continuing = previousEpisode && String(previousEpisode.key || '') === episodeKey
    && Number.isFinite(Number(previousEpisode.openedAt));
  const openedAt = continuing ? Number(previousEpisode.openedAt) : now;
  const acknowledged = acknowledgedEpisodeKeys
    .map((key) => String(key || '').trim())
    .filter(Boolean)
    .includes(episodeKey);
  return {
    state: 'stale',
    changedCount,
    episodeKey,
    episodeState: acknowledged ? 'acked' : 'open',
    staleSinceAt: new Date(openedAt).toISOString(),
    openedAt,
    violations: [{
      kind: CODE_FRESHNESS_VIOLATION_KIND,
      episodeKey,
      state: acknowledged ? 'acked' : 'open',
      openedAt,
      changedCount,
    }],
  };
}

/**
 * The message has to tell the truth: the backend *may* need a restart, because a
 * change under `lib/` can equally be picked up by the next lazy import.
 *
 * @param {number | null} changedCount
 * @returns {{ title: string, body: string }}
 */
export function formatCodeFreshnessMessage(changedCount) {
  const count = Number.isFinite(Number(changedCount)) ? Math.max(0, Math.floor(Number(changedCount))) : 0;
  const files = count === 1 ? '1 backend file' : `${count} backend files`;
  return {
    title: 'Backend changed since start',
    body: `${files} changed on disk since this server process started; a restart may be required.`,
  };
}
