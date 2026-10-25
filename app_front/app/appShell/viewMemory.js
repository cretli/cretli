/**
 * Per-view UI memory (navigation plan stage 5).
 *
 * Remembers list filters, search, sort, tree expansions, scroll anchors and
 * focus per view key. Validation, TTL and size caps keep broken storage from
 * blocking boot.
 */

export const VIEW_MEMORY_VERSION = 1;
export const VIEW_MEMORY_STORAGE_KEY = 'cretli-view-memory-v1';
export const VIEW_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VIEW_MEMORY_MAX_BYTES = 256 * 1024;

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null | undefined} route
 * @param {{ workspaceKey?: string, folderKey?: string }} [contextOverride]
 * @returns {string}
 */
export function buildViewKey(route, contextOverride) {
  const panel = trimmed(route?.panel) || 'chat';
  const settingsTab = panel === 'settings' ? trimmed(route?.settingsTab) : '';
  const subview = trimmed(route?.subview);
  const context = contextOverride || route?.context || {};
  const workspaceKey = trimmed(context.workspaceKey);
  const folderKey = trimmed(context.folderKey);
  const resourceType = trimmed(route?.resource?.type);
  const resourceId = trimmed(route?.resource?.id);
  return [
    workspaceKey,
    folderKey,
    panel,
    settingsTab,
    subview,
    resourceType,
    resourceId,
  ].join('|');
}

/**
 * @param {unknown} raw
 * @param {number} now
 * @returns {Record<string, object> | null}
 */
export function parseViewMemoryStore(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw || raw.length > VIEW_MEMORY_MAX_BYTES) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Number(parsed.version) !== VIEW_MEMORY_VERSION) return null;
  const entries = parsed.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  /** @type {Record<string, object>} */
  const out = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof key !== 'string' || !key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const updatedAt = Number(value.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt > VIEW_MEMORY_TTL_MS) continue;
    out[key] = value.state && typeof value.state === 'object' ? { ...value.state } : {};
  }
  return out;
}

/**
 * @param {Record<string, object>} entries
 * @param {number} [now]
 * @returns {string}
 */
export function serializeViewMemoryStore(entries, now = Date.now()) {
  /** @type {Record<string, { updatedAt: number, state: object }>} */
  const wrapped = {};
  for (const [key, state] of Object.entries(entries || {})) {
    if (!key || !state || typeof state !== 'object') continue;
    wrapped[key] = { updatedAt: now, state };
  }
  let text = JSON.stringify({ version: VIEW_MEMORY_VERSION, entries: wrapped });
  if (text.length <= VIEW_MEMORY_MAX_BYTES) return text;
  const keys = Object.keys(wrapped).sort((a, b) => wrapped[b].updatedAt - wrapped[a].updatedAt);
  while (text.length > VIEW_MEMORY_MAX_BYTES && keys.length > 0) {
    const drop = keys.shift();
    if (drop) delete wrapped[drop];
    text = JSON.stringify({ version: VIEW_MEMORY_VERSION, entries: wrapped });
  }
  return text;
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {Record<string, object>}
 */
export function readViewMemoryEntries(storage) {
  if (!storage) return {};
  try {
    return parseViewMemoryStore(storage.getItem(VIEW_MEMORY_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * @param {Storage | null | undefined} storage
 * @param {string} viewKey
 * @returns {object | null}
 */
export function readViewMemorySlice(storage, viewKey) {
  const key = trimmed(viewKey);
  if (!key) return null;
  const entries = readViewMemoryEntries(storage);
  return entries[key] ? { ...entries[key] } : null;
}

/**
 * @param {Storage | null | undefined} storage
 * @param {string} viewKey
 * @param {object} slice
 * @param {number} [now]
 */
export function writeViewMemorySlice(storage, viewKey, slice, now = Date.now()) {
  const key = trimmed(viewKey);
  if (!key || !storage) return;
  const entries = readViewMemoryEntries(storage);
  entries[key] = slice && typeof slice === 'object' ? { ...slice } : {};
  try {
    storage.setItem(
      VIEW_MEMORY_STORAGE_KEY,
      serializeViewMemoryStore(entries, now),
    );
  } catch {
    // Ignore quota errors; the live view still works.
  }
}

/**
 * @param {object | null | undefined} slice
 * @param {() => void} paint
 */
export function restoreViewMemoryAfterPaint(slice, paint) {
  if (!slice || typeof paint !== 'function') return;
  const run = () => {
    try {
      paint(slice);
    } catch {
      // Restoration must never break navigation.
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run));
    return;
  }
  setTimeout(run, 0);
}
