/**
 * New-chat harness readiness UI rules and request deduplication.
 *
 * Readiness is tri-state:
 *  - true  → harness checked and ready
 *  - false → harness checked and not ready (show its configuration warning)
 *  - null  → not checked yet (show no warning; keep Create disabled)
 *
 * Status requests are tracked per harness so a late response cannot overwrite the UI of a
 * harness the user has already switched away from, nor the newest response for the same harness.
 */

/**
 * @param {unknown} value
 * @param {{ localIds?: Set<string> | null }} [options] optional set of enabled
 *   local `capabilities.chat` plugin ids that must survive normalization. A local
 *   id is only preserved while it is in this set; anything else still collapses to
 *   `sdk` (the pre-plugin behavior).
 * @returns {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen' | 'claude' | string}
 */
export function normalizeNewChatHarnessId(value, options = {}) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  if (raw === 'codebuddy') return 'codebuddy';
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'codex') return 'codex';
  if (raw === 'qwen') return 'qwen';
  if (raw === 'claude') return 'claude';
  const localIds = options && options.localIds instanceof Set ? options.localIds : null;
  if (raw && localIds && localIds.has(raw)) return raw;
  return 'sdk';
}

/**
 * Enabled local `capabilities.chat` plugins from a harness-catalog payload.
 *
 * Only rows that are local, explicitly enabled, and chat-capable are returned;
 * `available` is intentionally not required because a discovered local plugin is
 * always `not_loaded` until the create request loads it. Rows carry only safe
 * metadata (id + label); labels must be rendered as text by the caller.
 *
 * @param {unknown} catalog `{ items: [...] }` from GET /api/harness-catalog/harnesses
 * @returns {Array<{ id: string, label: string }>}
 */
export function listEnabledLocalChatHarnessOptions(catalog) {
  const rows = catalog && typeof catalog === 'object' && Array.isArray(catalog.items)
    ? catalog.items
    : [];
  const seen = new Set();
  /** @type {Array<{ id: string, label: string }>} */
  const options = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.origin !== 'local') continue;
    if (row.enabled !== true) continue;
    if (!row.capabilities || row.capabilities.chat !== true) continue;
    const id = typeof row.id === 'string' ? row.id.trim().toLowerCase() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : id;
    options.push({ id, label });
  }
  return options;
}

/**
 * @param {boolean | null} readiness
 * @param {boolean} [inFlight]
 * @returns {{ ready: boolean, showWarning: boolean, disableCreate: boolean }}
 */
export function resolveNewChatHarnessUiState(readiness, inFlight = false) {
  return {
    ready: readiness === true,
    showWarning: readiness === false,
    disableCreate: inFlight === true || readiness !== true,
  };
}

/**
 * @param {{ harness?: unknown, seq?: unknown } | null | undefined} token
 * @returns {{ harness: string, seq: number } | null}
 */
function parseStatusToken(token) {
  if (!token || typeof token !== 'object') return null;
  const harness = normalizeNewChatHarnessId(token.harness);
  const seq = Number(token.seq);
  if (!Number.isFinite(seq)) return null;
  return { harness, seq };
}

/**
 * Tracks the newest status request per harness. "Latest for a harness" is kept separate from
 * "currently selected", so a late response can warm a non-selected harness' cache without
 * touching the visible hint, button or model picker. In-flight checks are deduplicated per harness.
 */
export function createNewChatHarnessStatusTracker() {
  /** @type {Map<string, number>} */
  const seqByHarness = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inFlightByHarness = new Map();
  /** Set of selection keys that have already had a status request dispatched/settled */
  const settledSelectionKeys = new Set();
  let activeSelectionKey = '';
  let selectionCounter = 0;

  /**
   * @param {{ harness?: unknown, seq?: unknown } | null | undefined} token
   * @returns {boolean}
   */
  function isLatestToken(token) {
    const parsed = parseStatusToken(token);
    if (!parsed) return false;
    return parsed.seq === (seqByHarness.get(parsed.harness) || 0);
  }

  return {
    /**
     * Mark a new explicit selection for a harness.
     *
     * @param {unknown} harness
     * @returns {string} selectionKey
     */
    selectHarness(harness) {
      const resolved = normalizeNewChatHarnessId(harness);
      selectionCounter += 1;
      activeSelectionKey = `${resolved}:${selectionCounter}`;
      return activeSelectionKey;
    },

    /**
     * @returns {string}
     */
    getActiveSelectionKey() {
      return activeSelectionKey;
    },

    /**
     * Check if the current selection has already settled or has a check initiated.
     *
     * @param {unknown} harness
     * @returns {boolean}
     */
    isSelectionSettled(harness) {
      const resolved = normalizeNewChatHarnessId(harness);
      if (!activeSelectionKey.startsWith(`${resolved}:`)) return false;
      return settledSelectionKeys.has(activeSelectionKey);
    },

    /**
     * Mark the current selection as settled.
     *
     * @param {unknown} harness
     */
    markSelectionSettled(harness) {
      const resolved = normalizeNewChatHarnessId(harness);
      if (activeSelectionKey.startsWith(`${resolved}:`)) {
        settledSelectionKeys.add(activeSelectionKey);
      }
    },

    /**
     * Invalidate settled status checks so a forced re-check can run.
     *
     * @param {unknown} [harness]
     */
    invalidate(harness) {
      if (harness) {
        const resolved = normalizeNewChatHarnessId(harness);
        inFlightByHarness.delete(resolved);
        for (const key of settledSelectionKeys) {
          if (key.startsWith(`${resolved}:`)) settledSelectionKeys.delete(key);
        }
        return;
      }
      inFlightByHarness.clear();
      settledSelectionKeys.clear();
    },

    /**
     * @param {unknown} harness
     * @returns {{ harness: string, seq: number }}
     */
    begin(harness) {
      const resolved = normalizeNewChatHarnessId(harness);
      const seq = (seqByHarness.get(resolved) || 0) + 1;
      seqByHarness.set(resolved, seq);
      return { harness: resolved, seq };
    },

    /**
     * Whether the token is the newest request for its own harness, regardless of what is
     * currently selected. This is the gate for writing the per-harness readiness cache.
     *
     * @param {{ harness?: unknown, seq?: unknown } | null | undefined} token
     * @returns {boolean}
     */
    isLatest(token) {
      return isLatestToken(token);
    },

    /**
     * A response may reach the UI only when it is the newest request for its harness and that
     * harness is still selected.
     *
     * @param {{ harness?: unknown, seq?: unknown } | null | undefined} token
     * @param {unknown} selectedHarness
     * @returns {boolean}
     */
    isCurrent(token, selectedHarness) {
      const parsed = parseStatusToken(token);
      if (!parsed || !isLatestToken(token)) return false;
      return parsed.harness === normalizeNewChatHarnessId(selectedHarness);
    },

    /**
     * @param {unknown} harness
     * @returns {Promise<unknown> | undefined}
     */
    getInFlight(harness) {
      return inFlightByHarness.get(normalizeNewChatHarnessId(harness));
    },

    /**
     * @param {unknown} harness
     * @param {Promise<unknown>} promise
     */
    setInFlight(harness, promise) {
      const resolved = normalizeNewChatHarnessId(harness);
      inFlightByHarness.set(resolved, promise);
    },

    /**
     * Clear the in-flight slot for a harness.
     *
     * When `promise` is given, only clear it if it still owns the slot; a newer in-flight
     * promise must survive the older check settling.
     *
     * @param {unknown} harness
     * @param {Promise<unknown>} [promise]
     */
    clearInFlight(harness, promise) {
      const resolved = normalizeNewChatHarnessId(harness);
      if (promise !== undefined && inFlightByHarness.get(resolved) !== promise) return;
      inFlightByHarness.delete(resolved);
    },
  };
}

/**
 * Whether a model catalog payload is successful enough to cache.
 *
 * A failed payload (for example `{ ok: false, models: [] }`) must never be stored as a
 * success, otherwise a later open would keep reusing the failure instead of retrying.
 *
 * @param {unknown} data
 * @returns {boolean}
 */
export function isSuccessfulCatalog(data) {
  if (!data || typeof data !== 'object') return false;
  const payload = /** @type {{ ok?: unknown, models?: unknown }} */ (data);
  if (payload.ok === false) return false;
  if (payload.ok === true) return true;
  return Array.isArray(payload.models);
}

/**
 * Whether a successful catalog payload actually contains at least one model.
 *
 * @param {unknown} data
 * @returns {boolean}
 */
export function catalogHasModels(data) {
  if (!data || typeof data !== 'object') return false;
  const payload = /** @type {{ ok?: unknown, models?: unknown }} */ (data);
  return payload.ok === true && Array.isArray(payload.models) && payload.models.length > 0;
}

/**
 * Readiness that must be confirmed by a harness catalog.
 *
 * A raw `true` (for example OpenCode reporting its credentials are fine) is downgraded to
 * `null` (unknown) until a successful catalog with at least one model has been fetched for the
 * same catalog/settings generation. Returning `null` keeps Create disabled without showing a
 * misleading warning. `false` and `null` pass through unchanged.
 *
 * @param {unknown} rawReadiness
 * @param {unknown} catalog
 * @returns {boolean | null}
 */
export function resolveCatalogConfirmedReadiness(rawReadiness, catalog) {
  if (rawReadiness !== true) {
    return rawReadiness === false ? false : null;
  }
  return catalogHasModels(catalog) ? true : null;
}

/**
 * In-flight deduplication and cache for model catalogs requested in the new-chat modal.
 */
export function createNewChatCatalogCache() {
  /** @type {Map<string, unknown>} */
  const cachedCatalogs = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inFlightCatalogs = new Map();

  return {
    /**
     * @param {unknown} harness
     * @returns {boolean}
     */
    has(harness) {
      return cachedCatalogs.has(normalizeNewChatHarnessId(harness));
    },

    /**
     * @param {unknown} harness
     * @returns {unknown}
     */
    get(harness) {
      return cachedCatalogs.get(normalizeNewChatHarnessId(harness));
    },

    /**
     * @param {unknown} harness
     * @param {unknown} data
     */
    set(harness, data) {
      cachedCatalogs.set(normalizeNewChatHarnessId(harness), data);
    },

    /**
     * @param {unknown} [harness]
     */
    clear(harness) {
      if (harness) {
        const resolved = normalizeNewChatHarnessId(harness);
        cachedCatalogs.delete(resolved);
        inFlightCatalogs.delete(resolved);
        return;
      }
      cachedCatalogs.clear();
      inFlightCatalogs.clear();
    },

    /**
     * @template T
     * @param {unknown} harness
     * @param {() => Promise<T>} fetcher
     * @returns {Promise<T>}
     */
    fetchDeduped(harness, fetcher) {
      const resolved = normalizeNewChatHarnessId(harness);
      if (cachedCatalogs.has(resolved)) {
        return Promise.resolve(/** @type {T} */ (cachedCatalogs.get(resolved)));
      }
      const existing = inFlightCatalogs.get(resolved);
      if (existing) {
        return /** @type {Promise<T>} */ (existing);
      }
      const promise = Promise.resolve()
        .then(() => fetcher())
        .then((data) => {
          // Cache only successful payloads; a failure must stay retryable.
          if (isSuccessfulCatalog(data)) {
            cachedCatalogs.set(resolved, data);
          }
          return data;
        })
        .finally(() => {
          if (inFlightCatalogs.get(resolved) === promise) {
            inFlightCatalogs.delete(resolved);
          }
        });
      inFlightCatalogs.set(resolved, promise);
      return /** @type {Promise<T>} */ (promise);
    },
  };
}
