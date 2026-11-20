/**
 * Runtime archive catalog: RAM + IDB reads, sliced hydration into `getChats()` (7.1).
 */

import { listChatMetadataChatRecords } from './chatMetadataIdb.js';
import {
  buildWorkspaceSearchChatPool,
  hydrateArchiveRowsIntoRuntime,
  listArchivedRowsFromRuntime,
  mergeArchiveCatalogRows,
  projectMetadataRecordsToRows,
  selectArchiveRowsMissingFromRuntime,
} from './chatArchiveDataSource.js';
import { getChatBootListHydrationController } from './chatLocalBootAsyncHydrate.js';
import { deriveWorkspaceKey } from './chatMetadataIdbSchema.js';

/** Search reuses one server archive read for this long. */
export const ARCHIVE_SEARCH_CATALOG_TTL_MS = 30_000;

/**
 * @param {{
 *   getChats: () => object[],
 *   getSession: () => { sessionId?: string, generation?: number },
 *   getIdbEpoch?: () => number,
 *   onHydrated?: () => void,
 *   listIdbArchived?: typeof listChatMetadataChatRecords,
 *   fetchArchivedRows?: () => Promise<object[]>,
 *   now?: () => number,
 * }} deps
 */
export function createChatArchiveCatalog(deps) {
  const getChats = deps.getChats;
  const getSession = deps.getSession;
  const listIdbArchived = typeof deps.listIdbArchived === 'function'
    ? deps.listIdbArchived
    : listChatMetadataChatRecords;
  /** @type {Promise<void> | null} */
  let idbLoadPromise = null;
  /** @type {object[] | null} */
  let idbArchivedRows = null;
  /** @type {number} */
  let idbLoadEpoch = -1;
  /** @type {{ sessionId: string, generation: number } | null} */
  let idbLoadScope = null;
  /** @type {Promise<{ applied: number, cancelled: boolean }> | null} */
  let hydratePromise = null;
  /** @type {any[]} Server archive rows; never pushed into `getChats()`. */
  let searchCatalogRows = [];
  let searchCatalogLoadedAt = -Infinity;
  /** @type {Promise<void> | null} */
  let searchCatalogPromise = null;
  let catalogVersion = 0;
  /** @type {{ key: string, merged: any[], byWorkspace: Map<string, any[]> } | null} */
  let catalogMemo = null;

  function readSessionScope() {
    const session = getSession() || {};
    return {
      sessionId: typeof session.sessionId === 'string' ? session.sessionId : '',
      generation: Number.isFinite(Number(session.generation)) ? Math.floor(Number(session.generation)) : 0,
    };
  }

  function invalidateIdbCache() {
    idbArchivedRows = null;
    idbLoadPromise = null;
    idbLoadScope = null;
    idbLoadEpoch = -1;
    catalogVersion += 1;
  }

  /**
   * @returns {Promise<object[]>}
   */
  async function ensureIdbArchivedRows() {
    const scope = readSessionScope();
    if (!scope.sessionId) return [];
    const epoch = typeof deps.getIdbEpoch === 'function' ? Number(deps.getIdbEpoch()) || 0 : 0;
    if (
      idbArchivedRows
      && idbLoadScope
      && idbLoadScope.sessionId === scope.sessionId
      && idbLoadScope.generation === scope.generation
      && idbLoadEpoch === epoch
    ) {
      return idbArchivedRows;
    }
    if (idbLoadPromise) return idbLoadPromise.then(() => idbArchivedRows || []);
    const loadScope = { sessionId: scope.sessionId, generation: scope.generation };
    const loadEpoch = epoch;
    idbLoadPromise = listIdbArchived(scope, { archivedOnly: true })
      .then(async (records) => {
        const isLoadScopeFresh = () => {
          const current = readSessionScope();
          const currentEpoch = typeof deps.getIdbEpoch === 'function' ? Number(deps.getIdbEpoch()) || 0 : 0;
          return current.sessionId === loadScope.sessionId
            && current.generation === loadScope.generation
            && currentEpoch === loadEpoch;
        };
        if (!isLoadScopeFresh()) {
          return [];
        }
        const projected = await projectMetadataRecordsToRows(records, { isApplyFresh: isLoadScopeFresh });
        if (!isLoadScopeFresh() || projected.cancelled) {
          return [];
        }
        idbLoadScope = loadScope;
        idbLoadEpoch = loadEpoch;
        idbArchivedRows = projected.rows;
        catalogVersion += 1;
        return idbArchivedRows;
      })
      .catch(() => {
        invalidateIdbCache();
        return [];
      })
      .finally(() => {
        idbLoadPromise = null;
      });
    return idbLoadPromise.then(() => idbArchivedRows || []);
  }

  /**
   * @returns {object[]}
   */
  function getMergedArchiveCatalog() {
    const runtimeArchived = listArchivedRowsFromRuntime(getChats());
    const scope = readSessionScope();
    const epoch = typeof deps.getIdbEpoch === 'function' ? Number(deps.getIdbEpoch()) || 0 : 0;
    const idbRows = (
      idbArchivedRows
      && idbLoadScope
      && idbLoadScope.sessionId === scope.sessionId
      && idbLoadScope.generation === scope.generation
      && idbLoadEpoch === epoch
    )
      ? idbArchivedRows
      : [];
    return mergeArchiveCatalogRows(runtimeArchived, [...searchCatalogRows, ...idbRows]);
  }

  /**
   * Search filters every workspace group on each keystroke, so the merged catalog and its
   * per-workspace split are built once per change instead of once per group.
   */
  function readCatalogMemo() {
    const key = `${catalogVersion}:${listArchivedRowsFromRuntime(getChats()).length}`;
    if (catalogMemo?.key === key) return catalogMemo;
    const merged = /** @type {any[]} */ (getMergedArchiveCatalog());
    /** @type {Map<string, any[]>} */
    const byWorkspace = new Map();
    for (const row of merged) {
      const workspaceKey = deriveWorkspaceKey(row);
      const rows = byWorkspace.get(workspaceKey);
      if (rows) rows.push(row);
      else byWorkspace.set(workspaceKey, [row]);
    }
    catalogMemo = { key, merged, byWorkspace };
    return catalogMemo;
  }

  /**
   * Load archived rows for search without adding them to the runtime list, which drives
   * sockets, polling and sidebar rendering and must stay at the size of the live list.
   *
   * @returns {Promise<void>}
   */
  async function refreshSearchCatalog() {
    if (typeof deps.fetchArchivedRows !== 'function') return;
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    if (now() - searchCatalogLoadedAt < ARCHIVE_SEARCH_CATALOG_TTL_MS) return;
    if (searchCatalogPromise) return searchCatalogPromise;
    searchCatalogPromise = deps.fetchArchivedRows()
      .then((rows) => {
        searchCatalogRows = Array.isArray(rows) ? rows : [];
        searchCatalogLoadedAt = now();
        catalogVersion += 1;
        if (typeof deps.onHydrated === 'function') deps.onHydrated();
      })
      .catch(() => {})
      .finally(() => {
        searchCatalogPromise = null;
      });
    return searchCatalogPromise;
  }

  /**
   * A search hit acts like any other row once opened, so it joins the runtime list on demand.
   *
   * @param {string} chatId
   * @returns {any}
   */
  function adoptCatalogRow(chatId) {
    const chats = /** @type {any[]} */ (getChats());
    const existing = chats.find((chat) => chat?.id === chatId);
    if (existing) return existing;
    const row = readCatalogMemo().merged.find((entry) => entry?.id === chatId);
    if (!row) return null;
    const adopted = { ...row, _fromArchiveCatalog: true };
    chats.push(adopted);
    return adopted;
  }

  /**
   * @param {string} [workspaceKey]
   * @returns {object[]}
   */
  function getArchiveCatalogForWorkspace(workspaceKey = '') {
    const memo = readCatalogMemo();
    if (!workspaceKey) return memo.merged;
    return memo.byWorkspace.get(workspaceKey) || [];
  }

  /**
   * Hydrate catalog rows missing from runtime (non-blocking slices).
   *
   * @returns {Promise<{ applied: number, cancelled: boolean }>}
   */
  async function hydrateMissingArchiveIntoRuntime() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      await ensureIdbArchivedRows();
      const hydration = getChatBootListHydrationController();
      const guard = hydration.captureGuard();
      const isRunActive = hydration.captureRunEpoch();
      const runtimeIds = new Set(getChats().map((chat) => chat?.id).filter(Boolean));
      const missing = selectArchiveRowsMissingFromRuntime(getMergedArchiveCatalog(), runtimeIds);
      if (missing.length === 0) return { applied: 0, cancelled: false };
      const result = await hydrateArchiveRowsIntoRuntime(missing, (row) => {
        row._fromArchiveCatalog = true;
        getChats().push(row);
      }, { guard, isRunActive });
      if (result.applied > 0 && !result.cancelled && typeof deps.onHydrated === 'function') {
        try {
          deps.onHydrated();
        } catch (_) {}
      }
      return result;
    })().finally(() => {
      hydratePromise = null;
    });
    return hydratePromise;
  }

  /**
   * @param {object[]} workspaceChats
   * @param {string} [workspaceKey]
   * @returns {object[]}
   */
  function buildSearchPoolForWorkspace(workspaceChats, workspaceKey = '') {
    const extra = getArchiveCatalogForWorkspace(workspaceKey);
    return buildWorkspaceSearchChatPool(workspaceChats, extra);
  }

  return {
    invalidateIdbCache,
    ensureIdbArchivedRows,
    getMergedArchiveCatalog,
    getArchiveCatalogForWorkspace,
    hydrateMissingArchiveIntoRuntime,
    buildSearchPoolForWorkspace,
    refreshSearchCatalog,
    adoptCatalogRow,
  };
}
