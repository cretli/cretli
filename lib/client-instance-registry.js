/**
 * In-memory registry of connected SPA client instances.
 */

const OFFLINE_TTL_MS = 120000;
const ONLINE_THRESHOLD_MS = 30000;
const STALE_THRESHOLD_MS = 120000;

/** @type {Map<string, ClientInstanceRecord>} */
const instances = new Map();

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const wsClientsByInstance = new Map();

/**
 * @typedef {Object} ClientInstanceRecord
 * @property {string} id
 * @property {string} label
 * @property {'pwa' | 'browser' | 'embed' | 'unknown'} kind
 * @property {string} ua
 * @property {string|null} ip
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 * @property {string|null} visibility
 * @property {string|null} activePanel
 * @property {string|null} activeChatId
 * @property {number} wsCount
 * @property {boolean} debugRemote
 * @property {boolean} debugUiFreeze
 * @property {number|null} heapMiB
 * @property {number} heartbeatCount
 */

/**
 * @param {string} id
 * @param {Record<string, unknown>} body
 * @param {ClientInstanceRecord|undefined} existing
 * @returns {number}
 */
function resolveClientInstanceWsCount(id, body, existing) {
  const tracked = getTrackedClientInstanceWsCount(id);
  if (tracked > 0) return tracked;
  if (Number.isFinite(Number(body.wsCount))) return Math.max(0, Math.floor(Number(body.wsCount)));
  return existing?.wsCount || 0;
}

/**
 * @param {string} raw
 * @returns {number}
 */
export function getTrackedClientInstanceWsCount(raw) {
  const key = sanitizeId(raw);
  if (!key) return 0;
  const set = wsClientsByInstance.get(key);
  if (!set) return 0;
  for (const ws of set) {
    if (ws.readyState !== 1) set.delete(ws);
  }
  return set.size;
}

/**
 * @param {string} raw
 * @param {import('ws').WebSocket} ws
 */
export function registerClientInstanceWebSocket(raw, ws) {
  const key = sanitizeId(raw);
  if (!key || !ws) return;
  let set = wsClientsByInstance.get(key);
  if (!set) {
    set = new Set();
    wsClientsByInstance.set(key, set);
  }
  set.add(ws);
  setClientInstanceWsCount(key, set.size);
}

/**
 * @param {string} raw
 * @param {import('ws').WebSocket} ws
 */
export function unregisterClientInstanceWebSocket(raw, ws) {
  const key = sanitizeId(raw);
  if (!key || !ws) return;
  const set = wsClientsByInstance.get(key);
  if (!set) return;
  set.delete(ws);
  if (!set.size) wsClientsByInstance.delete(key);
  setClientInstanceWsCount(key, set.size);
}

/**
 * @param {number} lastSeenAt
 * @param {number} [now]
 * @returns {'online' | 'stale' | 'offline'}
 */
export function getClientInstanceStatus(lastSeenAt, now = Date.now()) {
  const ageMs = now - lastSeenAt;
  if (ageMs <= ONLINE_THRESHOLD_MS) return 'online';
  if (ageMs <= STALE_THRESHOLD_MS) return 'stale';
  return 'offline';
}

/**
 * @param {string} raw
 * @returns {string}
 */
function sanitizeId(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
}

/**
 * @param {unknown} value
 * @returns {'pwa' | 'browser' | 'embed' | 'unknown'}
 */
function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'pwa' || kind === 'browser' || kind === 'embed') return kind;
  return 'unknown';
}

/**
 * @param {Pick<ClientInstanceRecord, 'kind' | 'ip' | 'ua'>} record
 * @returns {string}
 */
function buildClientInstanceDeviceKey(record) {
  const kind = record.kind || 'unknown';
  const ip = record.ip || '';
  const ua = String(record.ua || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${kind}|${ip}|${ua}`;
}

/**
 * Removes older registry rows for the same physical client (kind + IP + UA).
 * @param {string} canonicalId
 * @param {ClientInstanceRecord} record
 */
function pruneDuplicateClientInstances(canonicalId, record) {
  const deviceKey = buildClientInstanceDeviceKey(record);
  for (const [otherId, other] of instances.entries()) {
    if (otherId === canonicalId) continue;
    if (buildClientInstanceDeviceKey(other) !== deviceKey) continue;
    instances.delete(otherId);
    wsClientsByInstance.delete(otherId);
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {string|null} ip
 * @returns {ClientInstanceRecord|null}
 */
export function upsertClientInstance(body, ip = null) {
  const id = sanitizeId(body?.clientInstanceId);
  if (!id) return null;
  const now = Date.now();
  const existing = instances.get(id);
  /** @type {ClientInstanceRecord} */
  const record = {
    id,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : existing?.label || id.slice(0, 8),
    kind: normalizeKind(body.kind) !== 'unknown' ? normalizeKind(body.kind) : existing?.kind || 'unknown',
    ua: typeof body.ua === 'string' ? body.ua.slice(0, 500) : existing?.ua || '',
    ip: ip || existing?.ip || null,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    visibility: typeof body.visibility === 'string' ? body.visibility.slice(0, 32) : existing?.visibility || null,
    activePanel: typeof body.activePanel === 'string' ? body.activePanel.slice(0, 32) : existing?.activePanel || null,
    activeChatId: typeof body.activeChatId === 'string' ? body.activeChatId.slice(0, 64) : existing?.activeChatId || null,
    wsCount: resolveClientInstanceWsCount(id, body, existing),
    debugRemote: body.debugRemote === true,
    debugUiFreeze: body.debugUiFreeze === true,
    heapMiB: Number.isFinite(Number(body.heapMiB)) ? Math.max(0, Math.round(Number(body.heapMiB))) : existing?.heapMiB ?? null,
    heartbeatCount: (existing?.heartbeatCount || 0) + 1,
  };
  instances.set(id, record);
  pruneDuplicateClientInstances(id, record);
  pruneOfflineInstances(now);
  return record;
}

/**
 * @param {number} [now]
 */
export function pruneOfflineInstances(now = Date.now()) {
  for (const [id, record] of instances.entries()) {
    if (now - record.lastSeenAt > OFFLINE_TTL_MS) instances.delete(id);
  }
}

/**
 * @param {string} id
 * @returns {ClientInstanceRecord|null}
 */
export function getClientInstance(id) {
  pruneOfflineInstances();
  const key = sanitizeId(id);
  if (!key) return null;
  return instances.get(key) || null;
}

/**
 * @param {number} [now]
 * @returns {Array<ClientInstanceRecord & { status: 'online' | 'stale' | 'offline' }>}
 */
export function listClientInstances(now = Date.now()) {
  pruneOfflineInstances(now);
  /** @type {Map<string, ClientInstanceRecord>} */
  const byDevice = new Map();
  for (const record of instances.values()) {
    const deviceKey = buildClientInstanceDeviceKey(record);
    const existing = byDevice.get(deviceKey);
    if (!existing || record.lastSeenAt >= existing.lastSeenAt) {
      byDevice.set(deviceKey, record);
    }
  }
  return [...byDevice.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((record) => ({
      ...record,
      status: getClientInstanceStatus(record.lastSeenAt, now),
    }));
}

/**
 * @param {string} id
 * @param {number} wsCount
 */
export function setClientInstanceWsCount(id, wsCount) {
  const key = sanitizeId(id);
  if (!key) return;
  const record = instances.get(key);
  if (!record) return;
  record.wsCount = Math.max(0, Math.floor(Number(wsCount) || 0));
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidClientInstanceId(raw) {
  return sanitizeId(raw).length >= 8;
}

/**
 * Resets registry (tests only).
 */
export function resetClientInstanceRegistryForTests() {
  instances.clear();
  wsClientsByInstance.clear();
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeClientInstanceIdForFile(raw) {
  const id = sanitizeId(raw);
  if (!id) return 'unknown';
  return id;
}
