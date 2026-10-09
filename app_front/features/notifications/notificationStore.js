/**
 * In-app notification centre state store.
 *
 * Deliberately free of DOM code: the browser glue lives in `notificationCenter.js`.
 * Everything here is dependency-injected (requests, clock, listeners) so the
 * fetch/optimistic/rollback semantics can be unit tested in Node.
 *
 * Live protocol (global chat-list WebSocket channel):
 * - the server sends `{ type: 'notificationsChanged', revision, reason }` with no
 *   items, so every frame triggers a full GET;
 * - GETs are coalesced: at most one is in flight and requests arriving meanwhile
 *   share exactly one follow-up;
 * - a frame whose revision is not newer than the applied one is ignored; only
 *   frame-driven GETs use that "not newer -> ignore" rule;
 * - a full GET from reconnect, an explicit panel refresh or a settings reload
 *   forces and may replace state even when the server revision went backwards
 *   (store reset/corrupt -> revision restarts low), so an open tab cannot stay
 *   stale forever;
 * - optimistic read/dismiss/mark-all overlays are re-applied on top of every
 *   snapshot until that snapshot proves the server caught up, and a successful
 *   mutation triggers a coalesced confirming refetch.
 */

/** Notification categories shared with the server store. */
export const NOTIFICATION_CENTER_CATEGORIES = Object.freeze(['chat', 'models', 'cli', 'system']);

/** Preference presets shared with the server store. */
export const NOTIFICATION_CENTER_PRESETS = Object.freeze(['all', 'important', 'custom']);

/** @type {{ preset: string, categories: Record<string, boolean>, showBadge: boolean, sound: boolean }} */
export const DEFAULT_NOTIFICATION_CENTER_PREFERENCES = Object.freeze({
  preset: 'all',
  categories: Object.freeze({ chat: true, models: true, cli: true, system: true }),
  showBadge: true,
  sound: true,
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mirror of the server-side normaliser so the UI and server agree on the shape.
 *
 * @param {unknown} raw
 * @returns {{ preset: string, categories: Record<string, boolean>, showBadge: boolean, sound: boolean }}
 */
export function normalizeNotificationCenterPreferences(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const preset = NOTIFICATION_CENTER_PRESETS.includes(source.preset)
    ? String(source.preset)
    : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.preset;
  const categoriesIn = isPlainObject(source.categories) ? source.categories : {};
  /** @type {Record<string, boolean>} */
  const categories = {};
  for (const id of NOTIFICATION_CENTER_CATEGORIES) {
    categories[id] = typeof categoriesIn[id] === 'boolean'
      ? categoriesIn[id]
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.categories[id];
  }
  return {
    preset,
    categories,
    showBadge: typeof source.showBadge === 'boolean'
      ? source.showBadge
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.showBadge,
    sound: typeof source.sound === 'boolean'
      ? source.sound
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.sound,
  };
}

/**
 * Accept only same-origin, relative navigation targets for a notification action.
 *
 * Absolute URLs (`https://…`), protocol-relative URLs (`//evil`) and dangerous
 * schemes (`javascript:`) are rejected. Backslashes and control characters are
 * rejected too, because some browsers normalise them to path separators.
 *
 * @param {unknown} raw
 * @returns {string} A safe relative path/query, or '' when the value is unsafe.
 */
export function resolveNotificationActionUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 2048) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return '';
  if (value.includes('\\')) return '';
  if (value.startsWith('//')) return '';
  if (value.startsWith('/') || value.startsWith('?')) return value;
  return '';
}

/**
 * Human relative time for the list. Pure so it can be tested without a DOM.
 *
 * @param {unknown} createdAt ISO timestamp
 * @param {number} nowMs
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @returns {string}
 */
export function formatNotificationRelativeTime(createdAt, nowMs, t) {
  const created = Date.parse(typeof createdAt === 'string' ? createdAt : '');
  if (!Number.isFinite(created) || typeof t !== 'function') return '';
  const diff = Math.max(0, Number(nowMs) - created);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('notifications.timeJustNow');
  if (minutes < 60) return t('notifications.timeMinutes', { count: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('notifications.timeHours', { count: String(hours) });
  const days = Math.floor(hours / 24);
  return t('notifications.timeDays', { count: String(days) });
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeItem(raw) {
  if (!isPlainObject(raw)) return null;
  const id = String(raw.id || '').trim();
  const category = String(raw.category || '').trim();
  if (!id || !NOTIFICATION_CENTER_CATEGORIES.includes(category)) return null;
  return {
    id,
    category,
    severity: String(raw.severity || 'info').trim() || 'info',
    title: String(raw.title || ''),
    body: String(raw.body || ''),
    actionUrl: String(raw.actionUrl || ''),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    readAt: typeof raw.readAt === 'string' ? raw.readAt : null,
    dismissedAt: typeof raw.dismissedAt === 'string' ? raw.dismissedAt : null,
    fingerprint: String(raw.fingerprint || ''),
  };
}

/**
 * @typedef {{
 *   fetchList: (category?: string) => Promise<object>,
 *   markRead: (payload: { id?: string, all?: boolean }) => Promise<object>,
 *   dismiss: (payload: { id?: string, all?: boolean }) => Promise<object>,
 * }} NotificationStoreApi
 */

/**
 * Create a notification centre store.
 *
 * @param {{
 *   api?: Partial<NotificationStoreApi>,
 *   preferences?: unknown,
 *   now?: () => number,
 *   onChange?: (state: object) => void,
 *   onNewItems?: (info: { ids: string[], items: object[] }) => void,
 *   logger?: { log?: Function } | null,
 * }} [deps]
 */
export function createNotificationStore(deps = {}) {
  const api = deps.api || {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  const onNewItems = typeof deps.onNewItems === 'function' ? deps.onNewItems : () => {};
  const logger = deps.logger && typeof deps.logger.log === 'function' ? deps.logger : null;

  /** Latest server list before overlays (already filtered by server preferences). @type {object[]} */
  let serverItems = [];
  /** Rendered list = `serverItems` with the optimistic overlays applied. @type {object[]} */
  let items = [];
  /** Unread count reported by the last server snapshot (used when no overlay is pending). */
  let serverUnreadCount = 0;
  let unreadCount = 0;
  /** `-1` means "never loaded from the server". */
  let revision = -1;
  let preferences = normalizeNotificationCenterPreferences(deps.preferences);
  let initialized = false;
  /** @type {Set<string>} */
  let knownIds = new Set();
  let error = '';

  // Optimistic overlays. They are re-applied on top of every snapshot until that
  // snapshot proves the server has caught up; see `reconcileOverlays`. Each entry
  // keeps the last known row so reconcile can tell a genuinely gone row from one
  // that is merely invisible under the current category/preset filter, and a
  // `token` so a failure removes exactly its own optimistic effect.
  /** @type {Map<string, { readAt: string, row: object | null, token: number }>} */
  let readOverlay = new Map();
  /** @type {Map<string, { row: object | null, token: number }>} */
  let hiddenOverlay = new Map();
  let overlayTokenSeq = 0;

  /**
   * Mirror of the server `notificationMatchesPreferences` so reconcile can tell
   * whether an absent row is genuinely gone or merely invisible under the
   * current category/preset filter. The GET payload is already preference
   * filtered, so an invisible row carries no server state.
   *
   * @param {unknown} prefs
   * @param {object | null | undefined} row
   * @returns {boolean}
   */
  function notificationItemMatchesPreferences(prefs, row) {
    const normalized = normalizeNotificationCenterPreferences(prefs);
    const category = String(row?.category || '').trim();
    if (!NOTIFICATION_CENTER_CATEGORIES.includes(category)) return false;
    if (normalized.preset === 'custom' && normalized.categories[category] !== true) return false;
    if (normalized.preset === 'important') {
      const severity = String(row?.severity || '').trim();
      return severity === 'important' || severity === 'warning' || severity === 'error';
    }
    return true;
  }

  // Fetch coalescing: at most one GET in flight, one queued follow-up.
  /** @type {Promise<object> | null} */
  let fetchInFlight = null;
  /** @type {object | null} */
  let queuedFetchOptions = null;

  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();

  function snapshotState() {
    return {
      items: items.map((row) => ({ ...row })),
      unreadCount,
      revision,
      preferences: normalizeNotificationCenterPreferences(preferences),
      initialized,
      error,
    };
  }

  function emitChange() {
    const state = snapshotState();
    try {
      onChange(state);
    } catch (err) {
      logger?.log?.('notifications', 'onChange listener failed', { error: String(err?.message || err) });
    }
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (err) {
        logger?.log?.('notifications', 'store listener failed', { error: String(err?.message || err) });
      }
    }
    return state;
  }

  /** @returns {boolean} whether any optimistic overlay is currently suppressing state. */
  function hasOverlays() {
    return hiddenOverlay.size > 0 || readOverlay.size > 0;
  }

  /**
   * Re-apply the optimistic overlays over the latest raw server list and cache
   * the rendered list + badge. Because the raw list is never mutated by an
   * optimistic action, dropping an overlay restores exactly that action's effect
   * without touching a newer snapshot.
   *
   * @returns {void}
   */
  function refreshItems() {
    items = applyOverlays(serverItems);
    if (preferences.showBadge !== true) {
      unreadCount = 0;
    } else if (hasOverlays()) {
      // The server count does not know about local optimistic changes; recompute
      // from the overlaid rows so the badge never contradicts the list.
      unreadCount = items.reduce((count, row) => count + (row.readAt ? 0 : 1), 0);
    } else {
      unreadCount = serverUnreadCount;
    }
  }

  /**
   * Re-apply optimistic read/dismiss over a raw server list.
   *
   * @param {object[]} source
   * @returns {object[]}
   */
  function applyOverlays(source) {
    let next = source;
    if (hiddenOverlay.size > 0) {
      next = next.filter((row) => !hiddenOverlay.has(row.id));
    }
    if (readOverlay.size > 0) {
      next = next.map((row) => {
        if (row.readAt) return row;
        const entry = readOverlay.get(row.id);
        if (!entry) return row;
        return { ...row, readAt: entry.readAt };
      });
    }
    return next;
  }

  /**
   * Drop an overlay once the applied server snapshot proves it landed. A read
   * overlay clears when the row is read or gone; a dismiss overlay clears when
   * the row is gone. An absent row only clears the overlay when the current
   * preferences would have included it: the GET payload is already preference
   * filtered, so a filtered-out row is invisible rather than known-dismissed.
   * Until then the overlay keeps suppressing, so a stale in-flight GET cannot
   * revert it.
   *
   * @param {object[]} serverRows
   * @returns {void}
   */
  function reconcileOverlays(serverRows) {
    const byId = new Map(serverRows.map((row) => [row.id, row]));
    for (const [id, entry] of [...hiddenOverlay]) {
      if (byId.has(id)) continue;
      if (entry.row && !notificationItemMatchesPreferences(preferences, entry.row)) continue;
      hiddenOverlay.delete(id);
    }
    for (const [id, entry] of [...readOverlay]) {
      const row = byId.get(id);
      if (row) {
        if (row.readAt) readOverlay.delete(id);
        continue;
      }
      if (entry.row && !notificationItemMatchesPreferences(preferences, entry.row)) continue;
      readOverlay.delete(id);
    }
  }

  /**
   * Apply a `GET /api/notifications` payload. Returns the ids that are genuinely
   * new and unread for the sound trigger (never on the first snapshot).
   *
   * Staleness rule: a frame-driven GET uses `force: false`, so an equal or lower
   * revision is still applied only when equal; a lower one is ignored. A full GET
   * from reconnect, an explicit panel refresh or a settings reload passes
   * `force: true` and replaces the state even when the server revision went
   * backwards (store file reset/corrupt -> revision restarts low), because
   * otherwise an open tab would stay stale forever. Optimistic overlays are
   * always re-applied on top.
   *
   * @param {object} payload
   * @param {{ force?: boolean }} [options]
   * @returns {{ ok: boolean, initial?: boolean, stale?: boolean, newIds?: string[], error?: string }}
   */
  function applySnapshot(payload, options = {}) {
    if (!payload || payload.ok !== true) {
      error = 'notifications_unavailable';
      emitChange();
      return { ok: false, error };
    }
    const nextRevision = Number.isFinite(Number(payload.revision))
      ? Math.max(0, Math.floor(Number(payload.revision)))
      : revision;
    // A slower request must not roll the store back to an older server state,
    // unless the caller explicitly forces a full resync (reconnect/refresh).
    if (initialized && options.force !== true && Number.isFinite(nextRevision) && nextRevision < revision) {
      return { ok: true, stale: true };
    }
    const nextServerItems = Array.isArray(payload.items)
      ? payload.items.map(normalizeItem).filter(Boolean)
      : [];
    const nextPreferences = payload.preferences
      ? normalizeNotificationCenterPreferences(payload.preferences)
      : preferences;
    const wasInitialized = initialized;
    serverItems = nextServerItems;
    serverUnreadCount = Number.isFinite(Number(payload.unreadCount))
      ? Math.max(0, Math.floor(Number(payload.unreadCount)))
      : 0;
    preferences = nextPreferences;
    // Reconcile against the raw server rows before rendering: an overlay that the
    // snapshot just proved landed must not hide/re-read a row in this same pass.
    reconcileOverlays(nextServerItems);
    refreshItems();
    /** @type {string[]} */
    const newIds = [];
    if (wasInitialized) {
      for (const row of items) {
        if (row.readAt) continue;
        if (knownIds.has(row.id)) continue;
        newIds.push(row.id);
      }
    }
    // Known ids cover every server row ever observed, including the ones an
    // overlay currently hides, so a row revealed again by a failed mutation or a
    // filter change never fires the sound a second time.
    for (const row of nextServerItems) knownIds.add(row.id);
    revision = nextRevision;
    initialized = true;
    error = '';
    if (wasInitialized && newIds.length > 0) {
      const newIdSet = new Set(newIds);
      try {
        onNewItems({
          ids: newIds.slice(),
          items: items.filter((row) => newIdSet.has(row.id)).map((row) => ({ ...row })),
        });
      } catch (err) {
        logger?.log?.('notifications', 'onNewItems listener failed', { error: String(err?.message || err) });
      }
    }
    emitChange();
    return { ok: true, initial: !wasInitialized, newIds };
  }

  /**
   * Run one GET and apply it.
   *
   * @param {{ category?: string, reason?: string, force?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function runFetch(options = {}) {
    try {
      const payload = await api.fetchList(options.category);
      return applySnapshot(payload, { force: options.force === true });
    } catch (err) {
      error = String(err?.message || err);
      emitChange();
      return { ok: false, error };
    }
  }

  /**
   * Drain the fetch queue: one GET in flight, everything requested meanwhile
   * coalesced into exactly one follow-up.
   *
   * @returns {Promise<object>}
   */
  async function drainFetchQueue() {
    let result = { ok: false, error: 'no_api' };
    try {
      while (queuedFetchOptions) {
        const current = queuedFetchOptions;
        queuedFetchOptions = null;
        result = await runFetch(current);
      }
    } finally {
      fetchInFlight = null;
    }
    return result;
  }

  /**
   * Full GET. Resolves to the apply result; network failures are reported, not thrown.
   *
   * @param {{ category?: string, reason?: string, force?: boolean }} [options]
   * @returns {Promise<object>}
   */
  function fetchNow(options = {}) {
    if (typeof api.fetchList !== 'function') return Promise.resolve({ ok: false, error: 'no_api' });
    queuedFetchOptions = queuedFetchOptions
      ? { ...queuedFetchOptions, ...options, force: Boolean(queuedFetchOptions.force || options.force) }
      : { ...options };
    if (!fetchInFlight) {
      fetchInFlight = drainFetchQueue();
    }
    return fetchInFlight;
  }

  /**
   * Handle a live `notificationsChanged` frame: only a newer revision causes a GET.
   * Frame-driven GETs never force, so they cannot replace newer state.
   *
   * @param {{ revision?: unknown, reason?: unknown }} [frame]
   * @returns {Promise<{ ok: boolean, ignored: boolean, result?: object }>}
   */
  async function handleChangedFrame(frame = {}) {
    const nextRevision = Number(frame?.revision);
    if (!Number.isFinite(nextRevision)) return { ok: true, ignored: true };
    if (initialized && nextRevision <= revision) return { ok: true, ignored: true };
    const result = await fetchNow({ reason: typeof frame?.reason === 'string' ? frame.reason : 'changed', force: false });
    return { ok: true, ignored: false, result };
  }

  /**
   * @param {unknown} id
   * @returns {{ ok: true, changed: boolean } | { ok: false, error: string }}
   */
  async function markRead(id) {
    const target = String(id || '').trim();
    if (!target) return { ok: false, error: 'missing_target' };
    const index = items.findIndex((row) => row.id === target);
    if (index < 0) return { ok: false, error: 'not_found' };
    const wasUnread = !items[index].readAt;
    const readAt = new Date(now()).toISOString();
    const token = ++overlayTokenSeq;
    const previous = readOverlay.get(target) || null;
    if (wasUnread) {
      const source = serverItems.find((row) => row.id === target) || items[index];
      readOverlay.set(target, { readAt, row: { ...source }, token });
    }
    refreshItems();
    emitChange();
    try {
      const response = await api.markRead({ id: target });
      if (Number.isFinite(Number(response?.revision))) revision = Math.max(revision, Math.floor(Number(response.revision)));
      error = '';
      emitChange();
      // Converge to server state; the overlay keeps the row read until the
      // confirming snapshot arrives, so a stale GET cannot revert it.
      void fetchNow({ reason: 'read-confirm' });
      return { ok: true, changed: response?.changed !== false };
    } catch (err) {
      // Drop only this operation's optimistic effect from the CURRENT state and
      // converge with one coalesced refetch; a snapshot applied meanwhile stays.
      const current = readOverlay.get(target);
      if (current && current.token === token) {
        if (previous) readOverlay.set(target, previous);
        else readOverlay.delete(target);
      }
      error = String(err?.message || err);
      refreshItems();
      emitChange();
      void fetchNow({ reason: 'read-failed' });
      return { ok: false, error };
    }
  }

  /**
   * Mark every row that is unread at click time. The captured ids, not "all
   * future rows", are overlaid read: an item published while the request is in
   * flight stays unread, counts in the badge and is reported as new for the
   * sound, and the overlay clears once the server confirms each captured id (or
   * that id disappears).
   *
   * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, error: string }>}
   */
  async function markAllRead() {
    const unreadTargets = items.filter((row) => !row.readAt);
    if (unreadTargets.length === 0) return { ok: true, changed: false };
    const readAt = new Date(now()).toISOString();
    const token = ++overlayTokenSeq;
    /** @type {Map<string, object | null>} */
    const previousEntries = new Map();
    for (const row of unreadTargets) {
      previousEntries.set(row.id, readOverlay.get(row.id) || null);
      const source = serverItems.find((item) => item.id === row.id) || row;
      readOverlay.set(row.id, { readAt, row: { ...source }, token });
    }
    refreshItems();
    emitChange();
    try {
      const response = await api.markRead({ all: true });
      if (Number.isFinite(Number(response?.revision))) revision = Math.max(revision, Math.floor(Number(response.revision)));
      error = '';
      emitChange();
      void fetchNow({ reason: 'read-all-confirm' });
      return { ok: true, changed: response?.changed !== false };
    } catch (err) {
      for (const [id, previous] of previousEntries) {
        const current = readOverlay.get(id);
        if (!current || current.token !== token) continue;
        if (previous) readOverlay.set(id, previous);
        else readOverlay.delete(id);
      }
      error = String(err?.message || err);
      refreshItems();
      emitChange();
      void fetchNow({ reason: 'read-all-failed' });
      return { ok: false, error };
    }
  }

  /**
   * @param {unknown} id
   * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, error: string }>}
   */
  async function dismiss(id) {
    const target = String(id || '').trim();
    if (!target) return { ok: false, error: 'missing_target' };
    const index = items.findIndex((row) => row.id === target);
    if (index < 0) return { ok: false, error: 'not_found' };
    const token = ++overlayTokenSeq;
    const previous = hiddenOverlay.get(target) || null;
    const source = serverItems.find((row) => row.id === target) || items[index];
    hiddenOverlay.set(target, { row: { ...source }, token });
    refreshItems();
    emitChange();
    try {
      const response = await api.dismiss({ id: target });
      if (Number.isFinite(Number(response?.revision))) revision = Math.max(revision, Math.floor(Number(response.revision)));
      error = '';
      emitChange();
      void fetchNow({ reason: 'dismiss-confirm' });
      return { ok: true, changed: response?.changed !== false };
    } catch (err) {
      const current = hiddenOverlay.get(target);
      if (current && current.token === token) {
        if (previous) hiddenOverlay.set(target, previous);
        else hiddenOverlay.delete(target);
      }
      error = String(err?.message || err);
      refreshItems();
      emitChange();
      void fetchNow({ reason: 'dismiss-failed' });
      return { ok: false, error };
    }
  }

  /**
   * Dismiss every row the list shows (only the read ones when `readOnly`) in one request.
   *
   * @param {{ readOnly?: boolean }} [options]
   * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, error: string }>}
   */
  async function dismissAll(options = {}) {
    const readOnly = options.readOnly === true;
    const targets = items.filter((row) => !readOnly || row.readAt);
    if (targets.length === 0) return { ok: true, changed: false };
    const token = ++overlayTokenSeq;
    /** @type {Map<string, object | null>} */
    const previousEntries = new Map();
    for (const row of targets) {
      previousEntries.set(row.id, hiddenOverlay.get(row.id) || null);
      const source = serverItems.find((item) => item.id === row.id) || row;
      hiddenOverlay.set(row.id, { row: { ...source }, token });
    }
    refreshItems();
    emitChange();
    try {
      const response = await api.dismiss({ all: true, readOnly });
      if (Number.isFinite(Number(response?.revision))) revision = Math.max(revision, Math.floor(Number(response.revision)));
      error = '';
      emitChange();
      void fetchNow({ reason: 'dismiss-all-confirm' });
      return { ok: true, changed: response?.changed !== false };
    } catch (err) {
      for (const [id, previous] of previousEntries) {
        const current = hiddenOverlay.get(id);
        if (!current || current.token !== token) continue;
        if (previous) hiddenOverlay.set(id, previous);
        else hiddenOverlay.delete(id);
      }
      error = String(err?.message || err);
      refreshItems();
      emitChange();
      void fetchNow({ reason: 'dismiss-all-failed' });
      return { ok: false, error };
    }
  }

  /**
   * Update local preferences (after a successful settings save) and refetch, because
   * the server filters items/unread by preference. This is an explicit user action,
   * so the refetch forces and may replace a lower server revision.
   *
   * @param {unknown} next
   * @param {{ refetch?: boolean }} [options]
   */
  function applyPreferences(next, options = {}) {
    preferences = normalizeNotificationCenterPreferences(next);
    refreshItems();
    emitChange();
    if (options.refetch !== false) void fetchNow({ reason: 'preferences', force: true });
    return preferences;
  }

  return {
    getState: snapshotState,
    getItems: () => items.map((row) => ({ ...row })),
    getUnreadCount: () => unreadCount,
    getRevision: () => revision,
    getPreferences: () => normalizeNotificationCenterPreferences(preferences),
    isInitialized: () => initialized,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applySnapshot,
    fetchNow,
    handleChangedFrame,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
    applyPreferences,
  };
}

/** @type {ReturnType<typeof createNotificationStore> | null} */
let defaultStore = null;

/**
 * The singleton wired at app start (see `notificationCenter.js`). Chat transport
 * frames reach the store through this accessor without importing the UI module.
 *
 * @returns {ReturnType<typeof createNotificationStore> | null}
 */
export function getNotificationStore() {
  return defaultStore;
}

/**
 * @param {ReturnType<typeof createNotificationStore> | null} store
 * @returns {void}
 */
export function setNotificationStore(store) {
  defaultStore = store || null;
}
