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

/**
 * @param {{
 *   getChats: () => object[],
 *   getSession: () => { sessionId?: string, generation?: number },
 *   getIdbEpoch?: () => number,
 *   onHydrated?: () => void,
 *   listIdbArchived?: typeof listChatMetadataChatRecords,
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
    return mergeArchiveCatalogRows(runtimeArchived, idbRows);
  }

  /**
   * @param {string} [workspaceKey]
   * @returns {object[]}
   */
  function getArchiveCatalogForWorkspace(workspaceKey = '') {
    const catalog = getMergedArchiveCatalog();
    if (!workspaceKey) return catalog;
    return catalog.filter((row) => deriveWorkspaceKey(row) === workspaceKey);
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
  };
}
