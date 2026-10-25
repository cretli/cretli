/**
 * Managed-path enumeration for offline backup/restore, derived from the single storage registry
 * (docs/storage-registry.json). Only registry `managedPaths` are ever archived or replaced;
 * retained paths (auth, TLS, harness homes), the control directory and unrelated files are never touched.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStorageRegistry } from '../../storage/store-registry.js';
import { isPidAlive } from './control-dir.js';
import { OfflineDataError } from './offline-errors.js';

/** Runtime lock/ownership artifacts: excluded from archives and from restored state. */
const RUNTIME_ARTIFACT_RE = /(^|\/)[^/]*(\.lock|\.lock\.sqlite|\.lock\.claim|\.sock|\.pid|-shm)(\/|$)|(^|\/)\.ledger\.lock(\/|$)/;
const SQLITE_MAIN_RE = /\.(sqlite|sqlite3|db)$/;
const SQLITE_SIDECAR_RE = /^(.*\.(?:sqlite|sqlite3|db))-(wal|journal)$/;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Top-level names that must never appear in a restore plan, whatever a manifest claims. */
const PROTECTED_TOP = new Set([
  'auth.json', 'sessions.json', 'vapid-keys.json', 'key.pem', 'cert.pem', 'ssl', 'tls', 'certs',
  'claude-home', 'codex-home', 'opencode-home', 'cursor-home', 'codebuddy-home', 'qwen-home', 'dsh-home',
  'runtime-home', 'native-homes', 'sdk-agent-store', 'agent-transcripts', 'cursor-share', 'claude-api-home',
]);

/**
 * Cretli-managed secret documents (registry stores classified as credentials). They are registry
 * managed paths, but only an ENCRYPTED backup may carry them (opt-in); plain backups omit them and
 * restore retains the destination's copies. `.env`, login sessions, TLS/SSH material and harness
 * homes are not managed paths at all (see PROTECTED_TOP) and are never exported.
 */
export const CREDENTIAL_PATHS = Object.freeze([
  'mcp-secrets.json', 'mcp-integration-secret.json', 'push-subscriptions.json', 'widget-installations.json',
]);

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isCredentialPath(rel) {
  return CREDENTIAL_PATHS.includes(rel);
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isRuntimeArtifact(rel) {
  return RUNTIME_ARTIFACT_RE.test(rel);
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isSqliteMain(rel) {
  return SQLITE_MAIN_RE.test(rel) && !isRuntimeArtifact(rel);
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isSqliteSidecar(rel) {
  return SQLITE_SIDECAR_RE.test(rel);
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
  const body = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * @param {string} rel
 * @returns {string} safe POSIX relative path
 * @throws {OfflineDataError} on traversal, absolute or protected paths
 */
export function assertSafeRel(rel) {
  const text = String(rel || '');
  if (!text || text.includes('\\') || text.includes('\0') || path.posix.isAbsolute(text)
    || path.posix.normalize(text) !== text || text.split('/').includes('..')) {
    throw new OfflineDataError('UNSAFE_PATH', `unsafe managed path: ${JSON.stringify(text)}`);
  }
  if (PROTECTED_TOP.has(text.split('/')[0])) {
    throw new OfflineDataError('PROTECTED_PATH', `path is retained and never archived/replaced: ${text}`);
  }
  return text;
}

/**
 * @param {object} [registry]
 * @returns {{ storeId: string, pattern: string, regex: RegExp, backendKind: string, schemaVersion: unknown, marker: string }[]}
 */
export function managedPatterns(registry = getStorageRegistry()) {
  /** @type {any[]} */
  const out = [];
  for (const store of /** @type {any[]} */ (/** @type {any} */ (registry).stores)) {
    for (const pattern of store.managedPaths || []) {
      if (isRuntimeArtifact(pattern.replace(/\*+/g, 'x'))) continue;
      out.push({
        storeId: store.id,
        pattern,
        regex: patternToRegex(pattern),
        backendKind: store.backend?.kind || '',
        schemaVersion: store.backend?.schemaVersion ?? null,
        marker: store.bootstrapMarker?.path || '',
      });
    }
  }
  return out;
}

/**
 * Registry store owning a relative path, or null when the path is not managed.
 *
 * @param {string} rel
 * @param {ReturnType<typeof managedPatterns>} patterns
 */
export function ownerOf(rel, patterns) {
  return patterns.find((p) => p.regex.test(rel)) || null;
}

/**
 * @param {string} dir
 * @param {string} rootDir
 * @param {string[]} out
 * @param {string[]} skipped
 */
function walk(dir, rootDir, out, skipped) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT' || /** @type {any} */ (err)?.code === 'ENOTDIR') return;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    if (entry.isSymbolicLink()) { skipped.push(`${rel} (symlink)`); continue; }
    if (entry.isDirectory()) walk(abs, rootDir, out, skipped);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * Existing managed files under `dataDir`. SQLite -wal/-journal sidecars are only listed with
 * `includeSidecars` (restore must remove stale ones; backup folds them via the backup API).
 *
 * @param {string} dataDir
 * @param {{ registry?: object, includeSidecars?: boolean }} [options]
 * @returns {{ files: { rel: string, storeId: string }[], skipped: string[] }}
 */
export function enumerateManaged(dataDir, options = {}) {
  const patterns = managedPatterns(options.registry);
  /** @type {Set<string>} */
  const roots = new Set();
  for (const p of patterns) {
    const staticParts = [];
    for (const seg of p.pattern.split('/')) {
      if (seg.includes('*')) break;
      staticParts.push(seg);
    }
    roots.add(staticParts.join('/'));
  }
  const found = [];
  const skipped = [];
  for (const root of roots) {
    const abs = path.join(dataDir, root);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) { skipped.push(`${root} (symlink)`); continue; }
    if (st.isFile()) found.push(root);
    else if (st.isDirectory()) walk(abs, dataDir, found, skipped);
  }
  const seen = new Set();
  const files = [];
  for (const rel of found.sort()) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (isRuntimeArtifact(rel)) continue;
    if (!options.includeSidecars && isSqliteSidecar(rel)) continue;
    const owner = ownerOf(rel, patterns);
    if (!owner) continue;
    try { assertSafeRel(rel); } catch { skipped.push(`${rel} (protected)`); continue; }
    files.push({ rel, storeId: owner.storeId });
  }
  return { files, skipped };
}

/**
 * @param {string} file
 * @returns {string} hex sha-256
 */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * @param {string} file
 * @returns {boolean} true when the file starts with the SQLite magic header
 */
export function hasSqliteMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.equals(SQLITE_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Refuse to proceed unless every writer is provably stopped and cleanly flushed.
 * Active or unknown writer -> typed refusal. Dead-owner lock leftovers are runtime artifacts and ignored.
 *
 * @param {string} dataDir
 * @param {{ registry?: object }} [options]
 * @throws {OfflineDataError} ACTIVE_WRITER | UNKNOWN_WRITER
 */
export function assertWritersStopped(dataDir, options = {}) {
  const ownerMeta = path.join(dataDir, 'delegation-owner.lock', 'owner.json');
  if (fs.existsSync(path.join(dataDir, 'delegation-owner.lock'))) {
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(ownerMeta, 'utf8')).pid); } catch { /* unreadable */ }
    if (!pid) throw new OfflineDataError('UNKNOWN_WRITER', 'delegation-owner.lock exists without a readable owner', { path: 'delegation-owner.lock' });
    if (isPidAlive(pid)) throw new OfflineDataError('ACTIVE_WRITER', `delegation store owner pid ${pid} is running; stop the server first`, { pid });
  }
  const watch = path.join(dataDir, 'webpack-cli-watch-lock.json');
  if (fs.existsSync(watch)) {
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(watch, 'utf8')).pid); } catch { /* unreadable */ }
    if (!pid) throw new OfflineDataError('UNKNOWN_WRITER', 'webpack-cli-watch-lock.json has no readable owner', { path: 'webpack-cli-watch-lock.json' });
    if (isPidAlive(pid)) throw new OfflineDataError('ACTIVE_WRITER', `front-end watcher pid ${pid} is running`, { pid });
  }
  if (fs.existsSync(path.join(dataDir, 'usage', '.ledger.lock'))) {
    throw new OfflineDataError('UNKNOWN_WRITER', 'usage ledger lock present; its holder is unknown (remove it only after confirming no writer runs)', { path: 'usage/.ledger.lock' });
  }
  // A SQLite database that was not cleanly closed leaves a non-empty WAL or a shared-memory file.
  const { files } = enumerateManaged(dataDir, { registry: options.registry, includeSidecars: true });
  for (const { rel } of files) {
    if (!isSqliteSidecar(rel)) continue;
    const base = rel.replace(/-(wal|journal)$/, '');
    if (fs.statSync(path.join(dataDir, rel)).size > 0) {
      throw new OfflineDataError('UNKNOWN_WRITER', `${base} was not cleanly closed (${rel} is not empty)`, { path: rel });
    }
  }
  for (const rel of fs.readdirSync(dataDir)) {
    if (/\.(sqlite|sqlite3|db)-shm$/.test(rel) && !isRuntimeArtifactIgnorable(rel)) {
      throw new OfflineDataError('UNKNOWN_WRITER', `${rel} exists: a database connection may still be open`, { path: rel });
    }
  }
}

/**
 * A -shm file of a managed database means an open (or crashed) connection; only an empty -shm next to
 * a missing -wal is tolerated as a leftover.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isRuntimeArtifactIgnorable(name) {
  return /\.lock\.sqlite-shm$/.test(name);
}
