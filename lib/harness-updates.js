/**
 * Read-only upstream version checks for harness npm packages (npm registry).
 *
 * Network runs only on explicit `?check=1` or an opt-in background worker.
 * Snapshot reads never touch the network.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './persist/atomic-write.js';
import { resolveDataPath } from './runtime-paths.js';
import { ensureWritableDir } from './ensure-writable-dir.js';
import { getHarnessVersionInventory } from './harness-versions.js';
import { getHarnessUpdateCheckSettings, loadSettings } from './persist/settings.js';
import { isTermuxLike } from './codex/codex-termux-net.js';

export const UPDATE_STATUS_SCHEMA_VERSION = 1;
export const UPDATE_STATUS_FILE_NAME = 'harness-update-status.json';
export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_FETCH_TIMEOUT_MS = 12_000;
export const UPDATE_FAILURE_BACKOFF_MS = 15 * 60 * 1000;

/** @type {Promise<unknown>} */
let writeQueue = Promise.resolve();
/** @type {Promise<object> | null} */
let inFlightRefresh = null;

/**
 * @template T
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
export function withHarnessUpdateStoreLock(fn) {
  const run = writeQueue.then(() => fn());
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * @param {{ statusPath?: string }} [options]
 * @returns {string}
 */
export function resolveHarnessUpdateStatusPath(options = {}) {
  return options.statusPath || resolveDataPath(UPDATE_STATUS_FILE_NAME);
}

/**
 * @returns {boolean}
 */
export function isDockerLikeEnvironment() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  const cgroup = process.env.CRETLI_IN_DOCKER;
  if (cgroup === '1' || cgroup === 'true') return true;
  return false;
}

/**
 * @returns {boolean}
 */
export function isTermuxLikeEnvironment() {
  if (isTermuxLike()) return true;
  return false;
}

/**
 * @param {string} raw
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | null, raw: string } | null}
 */
export function parseSemver(raw) {
  const text = String(raw || '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    raw: match[0],
  };
}

/**
 * @param {{ major: number, minor: number, patch: number, prerelease: string | null }} version
 * @returns {boolean}
 */
export function isPrereleaseVersion(version) {
  return Boolean(version?.prerelease);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return comparePrereleaseIdent(left.prerelease, right.prerelease);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function comparePrereleaseIdent(left, right) {
  const lParts = left.split('.');
  const rParts = right.split('.');
  const len = Math.max(lParts.length, rParts.length);
  for (let i = 0; i < len; i += 1) {
    const l = lParts[i];
    const r = rParts[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l) ? Number(l) : NaN;
    const rNum = /^\d+$/.test(r) ? Number(r) : NaN;
    if (Number.isFinite(lNum) && Number.isFinite(rNum)) {
      if (lNum !== rNum) return lNum - rNum;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} spec
 * @returns {boolean}
 */
export function isPinnedPrereleaseSpec(spec) {
  const trimmed = String(spec || '').trim();
  if (!trimmed || /^[\^~>=<]/.test(trimmed)) return false;
  const parsed = parseSemver(trimmed.replace(/^=/, ''));
  return Boolean(parsed?.prerelease);
}

/**
 * @param {string} version
 * @param {string} spec
 * @returns {boolean}
 */
export function satisfiesDeclaredSpec(version, spec) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return false;
  const parsed = parseSemver(version);
  if (!parsed) return false;
  if (trimmed.startsWith('^')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    if (parsed.major !== base.major) return false;
    if (base.major > 0) return compareSemver(version, base.raw) >= 0;
    if (base.minor > 0) {
      if (parsed.minor !== base.minor) return false;
      return compareSemver(version, base.raw) >= 0;
    }
    if (parsed.minor !== 0) return false;
    return parsed.patch >= base.patch;
  }
  if (trimmed.startsWith('~')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    if (parsed.major !== base.major || parsed.minor !== base.minor) return false;
    return compareSemver(version, base.raw) >= 0;
  }
  const exact = parseSemver(trimmed.replace(/^=/, ''));
  if (!exact) return false;
  return compareSemver(version, exact.raw) === 0;
}

/**
 * @param {string} installed
 * @param {string} declaredSpec
 * @param {string} harness
 * @returns {'stable' | 'prerelease'}
 */
export function resolveUpdateChannel(installed, declaredSpec, harness) {
  if (harness === 'claude') return 'stable';
  if (isPinnedPrereleaseSpec(declaredSpec)) return 'prerelease';
  const parsed = parseSemver(installed);
  if (parsed && parsed.prerelease) return 'prerelease';
  return 'stable';
}

/**
 * @param {string} installed
 * @param {string} latest
 * @param {string} declaredSpec
 * @param {string} harness
 * @returns {'npm-update' | 'manifest-bump' | 'current'}
 */
export function classifyUpdateMode(installed, latest, declaredSpec, harness) {
  if (!installed || !latest) return 'current';
  if (compareSemver(latest, installed) <= 0) return 'current';
  if (harness === 'claude') return 'manifest-bump';
  if (isPinnedPrereleaseSpec(declaredSpec)) return 'manifest-bump';
  if (satisfiesDeclaredSpec(latest, declaredSpec)) return 'npm-update';
  return 'manifest-bump';
}

/**
 * Newest published version inside a channel, ignoring the declared range.
 *
 * Update detection must be able to see an out-of-range major (a `manifest-bump`
 * candidate), so the range filter belongs to `classifyUpdateMode`, not to the
 * candidate picker. Channel rules: `stable` drops prereleases, `prerelease`
 * keeps every semver (a stable release still outranks a prerelease of the same
 * core, so it wins when it is the newest).
 *
 * @param {string[]} versions
 * @param {'stable' | 'prerelease'} channel
 * @returns {string} '' when no version matches the channel
 */
export function pickLatestVersionInChannel(versions, channel) {
  let best = '';
  for (const candidate of versions) {
    const parsed = parseSemver(candidate);
    if (!parsed) continue;
    if (channel === 'stable' && parsed.prerelease) continue;
    if (!best || compareSemver(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * Newest version inside the declared range and channel.
 *
 * Range-scoped on purpose (used when a caller wants the best installable
 * candidate); upstream update *detection* uses `pickLatestVersionInChannel` so
 * an out-of-range release is still visible.
 *
 * @param {string[]} versions
 * @param {string} declaredSpec
 * @param {'stable' | 'prerelease'} channel
 * @returns {string}
 */
export function pickLatestMatchingVersion(versions, declaredSpec, channel) {
  const spec = String(declaredSpec || '').trim();
  if (!spec) return '';
  let best = '';
  for (const candidate of versions) {
    const parsed = parseSemver(candidate);
    if (!parsed) continue;
    if (!satisfiesDeclaredSpec(candidate, spec)) continue;
    if (channel === 'stable' && parsed.prerelease) continue;
    if (!best || compareSemver(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * @param {object} row
 * @returns {boolean}
 */
export function shouldCheckPackageUpdates(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.status === 'external' || row.status === 'missing' || row.status === 'n/a') return false;
  if (row.canUpdate !== true && !row.declaredSpec) return false;
  if (!row.declaredSpec && row.requiredBy) return false;
  return Boolean(row.name);
}

/**
 * @param {string} packageName
 * @returns {string}
 */
export function npmRegistryPackageUrl(packageName) {
  const encoded = encodeURIComponent(String(packageName || '').trim());
  return `https://registry.npmjs.org/${encoded}`;
}

/**
 * @param {object} payload
 * @returns {string[]}
 */
export function versionKeysFromPackument(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const versions = payload.versions;
  if (!versions || typeof versions !== 'object') return [];
  return Object.keys(versions);
}

/**
 * @param {object} doc
 * @returns {object}
 */
function emptyUpdateDocument() {
  return {
    schemaVersion: UPDATE_STATUS_SCHEMA_VERSION,
    checkedAt: null,
    cacheExpiresAt: null,
    nextAttemptAfter: null,
    packages: {},
    lastError: null,
  };
}

/**
 * @param {unknown} parsed
 * @returns {object}
 */
function normalizeUpdateDocument(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyUpdateDocument();
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  const packagesRaw = doc.packages && typeof doc.packages === 'object' ? doc.packages : {};
  /** @type {Record<string, object>} */
  const packages = {};
  for (const [name, row] of Object.entries(packagesRaw)) {
    if (!row || typeof row !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (row);
    packages[name] = {
      installed: rec.installed ?? null,
      latest: rec.latest ?? null,
      mode: rec.mode ?? null,
      behind: rec.behind === true,
      channel: rec.channel === 'prerelease' ? 'prerelease' : 'stable',
      error: typeof rec.error === 'string' ? rec.error : null,
    };
  }
  return {
    schemaVersion: UPDATE_STATUS_SCHEMA_VERSION,
    checkedAt: typeof doc.checkedAt === 'string' ? doc.checkedAt : null,
    cacheExpiresAt: typeof doc.cacheExpiresAt === 'string' ? doc.cacheExpiresAt : null,
    nextAttemptAfter: typeof doc.nextAttemptAfter === 'string' ? doc.nextAttemptAfter : null,
    packages,
    lastError: typeof doc.lastError === 'string' ? doc.lastError : null,
  };
}

/**
 * @param {{ statusPath?: string }} [options]
 * @returns {object}
 */
export function readHarnessUpdateStatusSync(options = {}) {
  const filePath = resolveHarnessUpdateStatusPath(options);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeUpdateDocument(JSON.parse(raw));
  } catch {
    return emptyUpdateDocument();
  }
}

/**
 * @param {object} doc
 * @param {{ statusPath?: string }} [options]
 * @returns {string}
 */
function writeHarnessUpdateStatusSync(doc, options = {}) {
  const filePath = resolveHarnessUpdateStatusPath(options);
  ensureWritableDir(path.dirname(filePath));
  writeJsonAtomic(filePath, doc);
  return filePath;
}

/**
 * @param {object} doc
 * @param {() => number} now
 * @returns {boolean}
 */
export function isUpdateCacheFresh(doc, now) {
  if (!doc?.cacheExpiresAt) return false;
  const expires = Date.parse(doc.cacheExpiresAt);
  if (!Number.isFinite(expires)) return false;
  return now() < expires;
}

/**
 * @param {object} doc
 * @param {() => number} now
 * @returns {boolean}
 */
export function isUpdateBackoffActive(doc, now) {
  if (!doc?.nextAttemptAfter) return false;
  const next = Date.parse(doc.nextAttemptAfter);
  if (!Number.isFinite(next)) return false;
  return now() < next;
}

/**
 * @param {string} packageName
 * @param {object} row
 * @param {string} harness
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} deps
 * @returns {Promise<object>}
 */
export async function resolvePackageUpdateRow(packageName, row, harness, deps = {}) {
  const installed = row.installed || '';
  const declaredSpec = row.declaredSpec || '';
  const base = {
    installed: installed || null,
    latest: null,
    mode: 'current',
    behind: false,
    channel: resolveUpdateChannel(installed, declaredSpec, harness),
    error: null,
  };
  if (!shouldCheckPackageUpdates(row)) return base;
  if (!declaredSpec) {
    return { ...base, error: 'no_declared_spec' };
  }
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : UPDATE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(npmRegistryPackageUrl(packageName), {
      signal: deps.signal || controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    return { ...base, error: `registry_http_${response?.status || 0}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  const channel = resolveUpdateChannel(installed, declaredSpec, harness);
  // Pick the newest channel release first, without the declared range: an
  // out-of-range major is exactly what `classifyUpdateMode` needs to see to
  // report a `manifest-bump`. `dist-tags.latest` stays as the fallback for a
  // packument whose `versions` map has no usable entry.
  const latest = pickLatestVersionInChannel(versionKeysFromPackument(payload), channel)
    || String(payload?.['dist-tags']?.latest || '').trim()
    || '';
  if (!latest) {
    return { ...base, channel, error: 'no_matching_upstream' };
  }
  const mode = classifyUpdateMode(installed, latest, declaredSpec, harness);
  const behind = Boolean(installed) && compareSemver(latest, installed) > 0;
  return {
    installed: installed || null,
    latest,
    mode,
    behind,
    channel,
    error: null,
  };
}

/**
 * @param {object} inventory
 * @param {{
 *   statusPath?: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   force?: boolean,
 * }} [options]
 * @returns {Promise<{ doc: object, statusPath?: string, fromCache: boolean }>}
 */
export async function refreshHarnessUpdateStatus(inventory, options = {}) {
  const now = typeof options.now === 'function' ? options.now : (() => Date.now());
  const statusPath = resolveHarnessUpdateStatusPath(options);
  const existing = readHarnessUpdateStatusSync({ statusPath });
  if (!options.force && isUpdateCacheFresh(existing, now)) {
    return { doc: existing, statusPath, fromCache: true };
  }
  if (!options.force && isUpdateBackoffActive(existing, now)) {
    return { doc: existing, statusPath, fromCache: true };
  }
  if (inFlightRefresh) {
    const doc = await inFlightRefresh;
    return { doc, statusPath, fromCache: false };
  }
  const work = (async () => {
    /** @type {Record<string, object>} */
    const packages = {};
    let lastError = null;
    const harnesses = Array.isArray(inventory?.harnesses) ? inventory.harnesses : [];
    for (const entry of harnesses) {
      const harness = String(entry?.harness || '');
      const rows = Array.isArray(entry?.packages) ? entry.packages : [];
      for (const row of rows) {
        if (!shouldCheckPackageUpdates(row)) continue;
        const name = String(row.name || '');
        if (!name || packages[name]) continue;
        try {
          packages[name] = await resolvePackageUpdateRow(name, row, harness, {
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          packages[name] = {
            installed: row.installed ?? null,
            latest: null,
            mode: 'current',
            behind: false,
            channel: resolveUpdateChannel(row.installed || '', row.declaredSpec || '', harness),
            error: lastError,
          };
        }
      }
    }
    const checkedAtMs = now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    // `resolvePackageUpdateRow` reports failures as row errors instead of
    // throwing, so a registry outage would otherwise leave `lastError` null and
    // freeze the snapshot for the full cache TTL. Any failed row trips the
    // short backoff and expires the cache so the next window can retry.
    const failedRowError = Object.values(packages)
      .map((pkg) => pkg?.error)
      .find((message) => Boolean(message));
    const lastFailure = failedRowError || lastError || null;
    const nextAttemptAfter = lastFailure
      ? new Date(checkedAtMs + UPDATE_FAILURE_BACKOFF_MS).toISOString()
      : null;
    const cacheExpiresAt = lastFailure
      ? null
      : new Date(checkedAtMs + UPDATE_CACHE_TTL_MS).toISOString();
    const doc = {
      schemaVersion: UPDATE_STATUS_SCHEMA_VERSION,
      checkedAt,
      cacheExpiresAt,
      nextAttemptAfter,
      packages,
      lastError: lastFailure,
    };
    await withHarnessUpdateStoreLock(() => {
      writeHarnessUpdateStatusSync(doc, { statusPath });
    });
    return doc;
  })();
  inFlightRefresh = work;
  try {
    const doc = await work;
    return { doc, statusPath, fromCache: false };
  } finally {
    inFlightRefresh = null;
  }
}

/**
 * @param {object} inventory
 * @param {object} updateDoc
 * @returns {object}
 */
export function mergeUpdatesIntoInventory(inventory, updateDoc) {
  const packagesMap = updateDoc?.packages && typeof updateDoc.packages === 'object'
    ? updateDoc.packages
    : {};
  const harnesses = (Array.isArray(inventory?.harnesses) ? inventory.harnesses : []).map((entry) => {
    const rows = (Array.isArray(entry?.packages) ? entry.packages : []).map((row) => {
      const update = packagesMap[row.name];
      if (!update) return row;
      return {
        ...row,
        installed: row.installed ?? update.installed,
        latest: update.latest,
        mode: update.mode,
        behind: update.behind,
        channel: update.channel,
        ...(update.error ? { updateError: update.error } : {}),
      };
    });
    return { ...entry, packages: rows };
  });
  return {
    ...inventory,
    harnesses,
    updateCheckedAt: updateDoc?.checkedAt ?? null,
    updateCacheExpiresAt: updateDoc?.cacheExpiresAt ?? null,
  };
}

/**
 * @param {object} payload
 * @returns {object}
 */
export function buildUpdateEnvironmentNotes(payload) {
  const docker = isDockerLikeEnvironment();
  const termux = isTermuxLikeEnvironment();
  /** @type {string[]} */
  const notes = [];
  if (docker) notes.push('Container installs are informational only; rebuild the image to pick up package bumps.');
  if (termux) notes.push('Termux does not apply native Codex platform installs with --force.');
  if (!notes.length) return payload;
  return {
    ...payload,
    updateEnvironment: { docker, termux, notes },
  };
}

/**
 * Inventory merged with the cached update snapshot.
 *
 * `check` asks the registry only when the snapshot is stale: a fresh (~6 h)
 * cache is served as-is with `updateFromCache: true`. `force` bypasses both the
 * cache TTL and the failure backoff and is the only way to guarantee a network
 * round trip. `check` without `force` never emits a request while the cache is
 * fresh.
 *
 * @param {{
 *   persist?: boolean,
 *   check?: boolean,
 *   force?: boolean,
 *   snapshotPath?: string,
 *   statusPath?: string,
 *   inventory?: typeof getHarnessVersionInventory,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * } & object} [options]
 * @returns {Promise<object>}
 */
export async function getHarnessVersionInventoryWithUpdates(options = {}) {
  const inventoryFn = options.inventory || getHarnessVersionInventory;
  const inventory = await inventoryFn(options);
  const statusPath = resolveHarnessUpdateStatusPath(options);
  const now = typeof options.now === 'function' ? options.now : (() => Date.now());
  if (options.check === true) {
    const { doc, statusPath: writtenPath, fromCache } = await refreshHarnessUpdateStatus(inventory, {
      statusPath,
      fetchImpl: options.fetchImpl,
      now,
      force: options.force === true,
      timeoutMs: options.timeoutMs,
    });
    const merged = mergeUpdatesIntoInventory(inventory, doc);
    return buildUpdateEnvironmentNotes({
      ...merged,
      updateStatusPath: writtenPath,
      updateFromCache: fromCache,
    });
  }
  const doc = readHarnessUpdateStatusSync({ statusPath });
  const merged = mergeUpdatesIntoInventory(inventory, doc);
  return buildUpdateEnvironmentNotes({
    ...merged,
    updateStatusPath: fs.existsSync(statusPath) ? statusPath : undefined,
    updateFromCache: isUpdateCacheFresh(doc, now),
  });
}

/**
 * Background sweep entry (opt-in via settings).
 *
 * @param {{
 *   settings?: object,
 *   inventory?: typeof getHarnessVersionInventory,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   statusPath?: string,
 * }} [options]
 * @returns {Promise<object | null>}
 */
export async function sweepHarnessUpdateChecks(options = {}) {
  const cfg = getHarnessUpdateCheckSettings(options.settings || loadSettings());
  if (!cfg.enabled) return { enabled: false, skipped: true };
  const inventoryFn = options.inventory || getHarnessVersionInventory;
  try {
    const inventory = await inventoryFn({ persist: false });
    const result = await refreshHarnessUpdateStatus(inventory, {
      statusPath: options.statusPath,
      fetchImpl: options.fetchImpl,
      now: options.now,
      force: false,
    });
    return { enabled: true, skipped: false, ...result };
  } catch {
    return { enabled: true, skipped: false, error: 'sweep_failed' };
  }
}
