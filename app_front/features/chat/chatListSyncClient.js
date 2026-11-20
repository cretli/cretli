/**
 * Client side of the chat list sync contract (docs/architecture-list-sync-contract.md).
 *
 * Pure state machine, no DOM and no rendering: it keeps an id-indexed map of list DTOs
 * plus the server position `<epoch>.<seq>`, and applies `GET /api/chats/sync` answers.
 * Every I/O seam is injected (fetchers, timers, online probe, persistence, cross-tab
 * channel) so the retry / reorder / gap / stale / offline / multi-tab rules are unit tested.
 *
 * Rules:
 * - One request in flight; triggers that arrive meanwhile only set a dirty flag and cause
 *   exactly one follow-up (in-flight coalescing, no refetch storm).
 * - A delta applies only when `delta.since <= position.seq < delta.seq`; anything older is a
 *   stale/duplicate response and is dropped; `since > position.seq` is a gap -> resync.
 * - Upserts and removals are idempotent set operations, so duplicate delivery is harmless.
 * - A resync walks `GET /api/chats/page?view=list` into a staging map and swaps it in
 *   atomically; a STALE_CURSOR (409) restarts the walk a bounded number of times, and an
 *   older resync generation is discarded.
 * - Offline: no request is issued; the dirty flag survives and one sync runs on reconnect.
 * - Transient failures (network, 5xx) retry with exponential backoff; 4xx fail terminally and
 *   keep the rows already held.
 * - Scope binding: the server position token `<epoch>.<seq>` does not encode the request scope
 *   (workspace / widget), so the client binds rows, position, persisted snapshots and
 *   cross-tab announcements to the `getScopeKey()` value they were obtained under. A scope
 *   change drops rows + position (forcing a full resync), a response that was requested under
 *   another scope is discarded, and `restore()` refuses a snapshot saved under another scope.
 * - Archive parity: resync walks `archived=tree` (live rows + archived ancestors of live rows).
 *   A delta upserts any touched row, so after applying one the client prunes archived rows
 *   that no longer have a live descendant, which keeps delta state identical to a resync.
 * - `dispose()` stops timers, the channel listener and discards in-flight answers.
 */

const RETRY_BASE_MS = 500;
const RETRY_MAX_ATTEMPTS = 5;
const RESYNC_MAX_RESTARTS = 3;
const RESYNC_MAX_PAGES = 1000;

/** @param {unknown} token @returns {{ epoch: string, seq: number } | null} */
export function parseSyncToken(token) {
  const match = /^([A-Za-z0-9-]{1,64})\.(\d{1,15})$/.exec(String(token ?? ''));
  return match ? { epoch: match[1], seq: Number(match[2]) } : null;
}

/** @param {unknown} value @returns {boolean} */
function isArchivedRow(value) {
  return Boolean(value && String(value.archivedAt || '').trim());
}

/**
 * Drop archived rows that have no live descendant (the `archived=tree` closure), in place.
 *
 * @param {Map<string, object>} rows
 * @returns {number} how many rows were removed
 */
export function pruneArchivedWithoutLiveDescendants(rows) {
  const keep = new Set();
  for (const row of rows.values()) {
    if (isArchivedRow(row)) continue;
    const seen = new Set();
    let parentId = typeof row.forkParentChatId === 'string' ? row.forkParentChatId.trim() : '';
    while (parentId && !seen.has(parentId) && !keep.has(parentId)) {
      seen.add(parentId);
      const parent = rows.get(parentId);
      if (!parent || !isArchivedRow(parent)) break;
      keep.add(parentId);
      parentId = typeof parent.forkParentChatId === 'string' ? parent.forkParentChatId.trim() : '';
    }
  }
  let removed = 0;
  for (const [id, row] of [...rows]) {
    if (isArchivedRow(row) && !keep.has(id)) {
      rows.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** Thrown inside one sync round when the scope changed while the request was in flight. */
class ScopeChangedError extends Error {}

/** @param {unknown} err @returns {boolean} */
function isRetryable(err) {
  const status = Number(err && err.status);
  if (!status) return true;
  return status >= 500 || status === 408 || status === 429;
}

/**
 * @param {{
 *   fetchSync: (since: string) => Promise<object>,
 *   fetchPage: (query: { cursor?: string }) => Promise<object>,
 *   onChange?: (info: { reason: string, rows: Map<string, object>, position: { epoch: string, seq: number } | null }) => void,
 *   isOnline?: () => boolean,
 *   persist?: { load: () => Promise<object | null>, save: (snapshot: object) => Promise<void> },
 *   channel?: { postMessage: (message: object) => void, onmessage: ((event: { data: object }) => void) | null },
 *   getScopeKey?: () => string,
 *   archiveMode?: 'tree' | 'include',
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   retryBaseMs?: number,
 *   retryMaxAttempts?: number,
 * }} deps
 */
export function createChatListSyncClient(deps) {
  const {
    fetchSync,
    fetchPage,
    onChange = () => {},
    isOnline = () => true,
    persist = null,
    channel = null,
    getScopeKey = () => '',
    archiveMode = 'tree',
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    retryBaseMs = RETRY_BASE_MS,
    retryMaxAttempts = RETRY_MAX_ATTEMPTS,
  } = deps;
  /** @type {Map<string, object>} */
  let rows = new Map();
  /** @type {{ epoch: string, seq: number } | null} */
  let position = null;
  let inFlight = null;
  let dirty = false;
  let resyncGeneration = 0;
  let retryTimer = null;
  let attempts = 0;
  let terminalError = null;
  let disposed = false;
  /** Scope key the held rows/position were obtained under (null while nothing is held). */
  let heldScope = null;
  const stats = { syncRequests: 0, pageRequests: 0, resyncs: 0, deltasApplied: 0, staleDropped: 0, gaps: 0, scopeResets: 0, pruned: 0 };

  function currentScope() {
    try {
      return String(getScopeKey() ?? '');
    } catch (_) {
      return '';
    }
  }

  function emit(reason) {
    if (disposed) return;
    try {
      onChange({ reason, rows, position });
    } catch (_) {}
    if (persist && position) {
      persist.save({ position, scopeKey: heldScope ?? currentScope(), rows: [...rows.values()] }).catch(() => {});
    }
  }

  function announce() {
    if (!channel || !position || disposed) return;
    try {
      channel.postMessage({ type: 'list-applied', epoch: position.epoch, seq: position.seq, scopeKey: heldScope ?? '' });
    } catch (_) {}
  }

  /**
   * Drop rows and position when the scope differs from the one they were obtained under, so the
   * next round is a full resync and rows of the old scope are never shown for the new one.
   */
  function enforceScope() {
    if (heldScope === null || heldScope === currentScope()) return false;
    rows = new Map();
    position = null;
    heldScope = null;
    resyncGeneration += 1;
    stats.scopeResets += 1;
    emit('scope');
    return true;
  }

  /**
   * @param {object} delta `mode: 'delta'` answer
   * @returns {'applied' | 'stale' | 'gap'}
   */
  function applyDelta(delta) {
    const target = Number(delta.seq);
    const since = Number(delta.since);
    if (!position || delta.epoch !== position.epoch) return 'gap';
    if (target <= position.seq) return 'stale';
    if (since > position.seq) return 'gap';
    for (const dto of Array.isArray(delta.upserts) ? delta.upserts : []) {
      if (dto && typeof dto.id === 'string') rows.set(dto.id, dto);
    }
    for (const id of Array.isArray(delta.removed) ? delta.removed : []) rows.delete(id);
    position = { epoch: position.epoch, seq: target };
    if (archiveMode === 'tree') stats.pruned += pruneArchivedWithoutLiveDescendants(rows);
    stats.deltasApplied += 1;
    return 'applied';
  }

  async function resync(scope) {
    resyncGeneration += 1;
    const generation = resyncGeneration;
    stats.resyncs += 1;
    for (let restart = 0; restart <= RESYNC_MAX_RESTARTS; restart += 1) {
      const staging = new Map();
      let startToken = null;
      let cursor = '';
      let restartWalk = false;
      for (let page = 0; page < RESYNC_MAX_PAGES; page += 1) {
        let answer;
        try {
          stats.pageRequests += 1;
          answer = await fetchPage({ cursor });
        } catch (err) {
          if (err && err.status === 409) { restartWalk = true; break; }
          throw err;
        }
        if (generation !== resyncGeneration || disposed) return false;
        if (currentScope() !== scope) throw new ScopeChangedError('scope changed during resync');
        const parsed = parseSyncToken(answer.sync);
        if (!parsed) throw Object.assign(new Error('Page without sync token'), { status: 502 });
        if (!startToken) startToken = parsed;
        else if (parsed.epoch !== startToken.epoch) { restartWalk = true; break; }
        for (const dto of Array.isArray(answer.chats) ? answer.chats : []) {
          if (dto && typeof dto.id === 'string') staging.set(dto.id, dto);
        }
        cursor = answer.nextCursor || '';
        if (!cursor) break;
      }
      if (restartWalk) continue;
      rows = staging;
      position = startToken;
      heldScope = scope;
      return true;
    }
    throw Object.assign(new Error('Resync kept restarting'), { status: 503 });
  }

  async function runOnce() {
    const scope = currentScope();
    if (!position) {
      if (await resync(scope)) emit('resync');
      return;
    }
    stats.syncRequests += 1;
    const answer = await fetchSync(`${position.epoch}.${position.seq}`);
    if (disposed) return;
    if (currentScope() !== scope) throw new ScopeChangedError('scope changed during sync');
    if (answer.mode === 'noop') return;
    if (answer.mode === 'delta') {
      const outcome = applyDelta(answer);
      if (outcome === 'applied') { emit('delta'); return; }
      if (outcome === 'stale') { stats.staleDropped += 1; return; }
      stats.gaps += 1;
    }
    // resync (server-declared) or a client-detected gap
    position = null;
    if (await resync(scope)) emit('resync');
  }

  function scheduleRetry() {
    if (attempts >= retryMaxAttempts) {
      terminalError = new Error('Sync retries exhausted');
      return;
    }
    const wait = retryBaseMs * 2 ** attempts;
    attempts += 1;
    retryTimer = setTimeoutFn(() => { retryTimer = null; requestSync(); }, wait);
  }

  /**
   * Ask for a sync. Safe to call from every frame: coalesces into at most one request in
   * flight plus one follow-up.
   *
   * @returns {Promise<void>}
   */
  function requestSync() {
    if (disposed) return Promise.resolve();
    enforceScope();
    dirty = true;
    if (!isOnline()) return Promise.resolve();
    if (inFlight) return inFlight;
    if (retryTimer != null) { clearTimeoutFn(retryTimer); retryTimer = null; }
    if (terminalError) attempts = 0;
    terminalError = null;
    inFlight = (async () => {
      try {
        while (dirty && isOnline()) {
          dirty = false;
          try {
            await runOnce();
            attempts = 0;
          } catch (err) {
            // A request that fails after dispose() must not arm a retry timer or touch state.
            if (disposed) break;
            dirty = true;
            // A scope change is not a failure: drop the stale state and run the next round at once.
            if (err instanceof ScopeChangedError) {
              enforceScope();
              continue;
            }
            if (isRetryable(err)) scheduleRetry();
            else terminalError = err;
            break;
          }
        }
      } finally {
        inFlight = null;
      }
      if (terminalError) dirty = false;
      else if (!retryTimer && dirty && isOnline()) await requestSync();
      else if (!retryTimer) announce();
    })();
    return inFlight;
  }

  /** Restore a persisted snapshot (offline boot); the next sync resumes from its position. */
  async function restore() {
    if (!persist) return false;
    const snapshot = await persist.load().catch(() => null);
    const parsed = snapshot && parseSyncToken(`${snapshot.position?.epoch}.${snapshot.position?.seq}`);
    if (disposed || !parsed || position) return false;
    // A snapshot saved under another scope must never seed this one: the token cannot tell them apart.
    const scope = currentScope();
    if (String(snapshot.scopeKey ?? '') !== scope) return false;
    heldScope = scope;
    rows = new Map((snapshot.rows || []).filter((d) => d && typeof d.id === 'string').map((d) => [d.id, d]));
    position = parsed;
    emit('restore');
    return true;
  }

  if (channel) {
    channel.onmessage = (event) => {
      const message = event && event.data;
      if (!message || message.type !== 'list-applied' || disposed) return;
      // Another tab on a different scope says nothing about our rows.
      if (String(message.scopeKey ?? '') !== currentScope()) return;
      // Another tab already applied this position: only sync when we are behind or on another epoch.
      const behind = !position || position.epoch !== message.epoch || position.seq < Number(message.seq);
      if (behind) requestSync();
    };
  }

  return {
    requestSync,
    restore,
    setOnline(online) {
      if (online) requestSync();
    },
    getRows: () => rows,
    getPosition: () => position,
    getStats: () => ({ ...stats }),
    getScopeKey: () => heldScope,
    /** Stop timers and the channel listener; later calls become no-ops and in-flight answers are discarded. */
    dispose() {
      disposed = true;
      resyncGeneration += 1;
      if (retryTimer != null) { clearTimeoutFn(retryTimer); retryTimer = null; }
      if (channel) channel.onmessage = null;
      dirty = false;
    },
    getError: () => terminalError,
    isIdle: () => inFlight == null && retryTimer == null,
  };
}
