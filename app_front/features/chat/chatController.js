import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { normalizeSdkUiMode } from '../../../lib/sdk/sdk-ui-mode.js';
import { resolvePersistedLocalChatTransport, isBlockingPersistedLocalChatHarnessState } from './persistedLocalChatState.js';
import { setActiveChatIdsForEviction } from '../../lib/sdk-chat-history-store.js';
import { migrateChatStorageOutOfLocalStorage } from '../../lib/chatStorageMigration.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from './chatHtmlUtils.js';
import { pickNewChatWorkspaceFile, workspaceListEntryKey } from './newChatWorkspacePick.js';
import {
  buildChatsListApiQuery,
  mergeChatListLoadQuery,
  shouldPruneChatActivityFromListResponse,
} from '../../../lib/chat-list-payload.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  parseChatLocalBootCache,
  readChatLocalBootCache,
  shouldHydrateChatListFromBootCache,
  writeChatLocalBootCache,
} from './chatLocalBootCache.js';
import { readChatLocalBootCacheForColdStart } from './chatLocalBootSync.js';
import {
  getChatBootListHydrationController,
  selectBootRowsMissingFromRuntime,
} from './chatLocalBootAsyncHydrate.js';
import { hydrateChat as hydratePresenceChat } from './agentPresenceStore.js';
import { getUiFreezeCounters, measureFreezeSpan } from '../../lib/uiFreezeCounters.js';
import { pruneChatActivityToKnownIds } from './chatActivityStore.js';
import {
  buildChatListLoadApplyToken,
  buildChatListLoadScopeKey,
  buildChatListLoadSuccessSnapshot,
  decideChatListNetworkLoad,
  isChatListLoadApplyTokenFresh,
  normalizeChatListLoadQuery,
  trimPendingChatListLoadQuery,
} from './chatListLoadFreshness.js';
import { reconcileServerChatsInTimeSlices } from './chatListServerReconcile.js';
import { mergeRuntimeChatListAfterScopedArchiveLoad } from './chatListScopedArchiveMerge.js';
import { scheduleDomWrite } from '../../lib/schedulerYield.js';

function normalizePath(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * Fingerprint of everything the chat list renders from the runtime rows (sidebar, chat bar,
 * list modal, boot cache) plus the per-workspace archive counts. Two loads whose fingerprint
 * matches produced the same visible list, so the expensive repaint can be skipped.
 * Runtime-only fields (`pane`, `ws`, `_buffer`, `_fromBootCache`) are deliberately excluded.
 *
 * @param {object[] | null | undefined} list
 * @param {Record<string, number> | null | undefined} archivedCounts
 * @returns {string}
 */
function chatListRepaintSignature(list, archivedCounts) {
  const parts = [];
  for (const chat of Array.isArray(list) ? list : []) {
    if (!chat || !chat.id) continue;
    parts.push([
      chat.id,
      chat.title || '',
      chat.titleSource || '',
      chat.model || '',
      chat.workspaceFile || '',
      chat.workspaceFolder || '',
      chat.createdAt || '',
      chat.updatedAt || '',
      chat.archivedAt || '',
      chat.forkParentChatId || '',
      chat.forkKind || '',
      chat.widgetPinnedUrl || '',
      chat.todoId || '',
      chat.sdkAgentId || '',
      chat.agentTransport || '',
      chat.sdkMode || '',
      chat.sdkUiMode || '',
      chat.sdkSystemPrompt || '',
      chat.harnessState?.code || '',
      chat.isTemporary === true ? '1' : '0',
      chat.watcherPinned === true ? '1' : '0',
      Array.isArray(chat.summaries) ? chat.summaries.length : 0,
    ].join('\u0000'));
  }
  const counts = archivedCounts && typeof archivedCounts === 'object' ? archivedCounts : {};
  const countParts = Object.keys(counts)
    .sort()
    .map((key) => `${key}=${counts[key]}`);
  return `${parts.join('\u0001')}#${countParts.join('\u0002')}`;
}

export function createChatController(deps) {
  const {
    api,
    CHAT_BUFFER_MAX,
    LAST_CHAT_ID_KEY,
    getChats,
    getActiveChatId,
    setActiveChatId,
    getWorkspaces,
    setWorkspaces,
    getSelectedWorkspaceFile,
    setSelectedWorkspaceFile,
    getSelectedWorkspaceFolder,
    setSelectedWorkspaceFolder,
    getSelectedModel,
    setSelectedModel,
    readChatBufferForChatRestore,
    updateFolderSelect,
    renderModelSelectOptions,
    renderChatList,
    updateChatBarSelect,
    selectChat,
    syncBackgroundChatConnections,
    bindChatVisibilityAndReconnect,
    startChatBackgroundMonitor,
    startGlobalChatPingLoop,
    ensureChatConnection,
    teardownBlockedChatRuntime,
    teardownChatRuntime,
    openTerminal,
    getChatsForCurrentWorkspace,
    setChatStatus,
    onAfterBootHydrate,
    onAfterChatsLoad,
    onPresenceHydrate,
    scheduleBootCachePersist,
    getBootMetadataAdapter,
    getBootIdbEpoch,
    getBootActivitySession,
    onArchiveCatalogHydrate,
    invalidateArchiveCatalog,
  } = deps;
  let chatsLoadPromise = null;
  /** @type {object | null} */
  let pendingLoadQuery = null;
  /** Scope key for the in-flight GET /api/chats (see chatListLoadFreshness.js). */
  let inFlightLoadScopeKey = null;
  /** @type {import('./chatListLoadFreshness.js').ChatListLoadSuccessSnapshot | null} */
  let lastSuccessfulListLoad = null;
  /** @type {Record<string, number>} */
  let archivedCounts = Object.create(null);
  /** Whether the cold-start local snapshot was already considered this page life. */
  let chatBootCacheHydrated = false;
  /**
   * True while the runtime list is still an unconfirmed boot-cache slice — i.e. it was
   * hydrated from the local snapshot and no `GET /api/chats` response has reconciled it yet.
   * Only this state is allowed to skip a subset-shrink persist (F1); a server-confirmed list
   * always persists, so a real deletion (41 -> 40) removes the ghost rows from IDB.
   */
  let chatBootCacheUnconfirmed = false;
  /** Whether async boot hydration is already scheduled or finished for this page life. */
  let chatBootAsyncHydrateStarted = false;
  /** Last workspace context seen in the boot snapshot (used when the settings fetch is slow). */
  let rememberedWorkspaceContext = { workspaceFile: '', workspaceFolder: '' };

  function readHeaderWorkspaceContext() {
    if (typeof document === 'undefined') return { workspaceFile: '', workspaceFolder: '' };
    const trigger = document.getElementById('header-workspace-trigger');
    return {
      workspaceFile: typeof trigger?.dataset?.workspaceFile === 'string' ? trigger.dataset.workspaceFile : '',
      workspaceFolder: typeof trigger?.dataset?.workspaceFolder === 'string' ? trigger.dataset.workspaceFolder : '',
    };
  }

  /**
   * The server's active workspace arrives with the settings fetch, which is async. Restoring
   * the last known workspace from the boot snapshot lets `getChatsForCurrentWorkspace`
   * filter the cached list on the very first frame; the later settings fetch overwrites the
   * dataset when the value actually changed.
   *
   * @param {{ workspaceFile?: string, workspaceFolder?: string } | null | undefined} context
   */
  function headerWorkspaceMatches(context, header = readHeaderWorkspaceContext()) {
    if (!context) return true;
    return normalizePath(header.workspaceFile) === normalizePath(context.workspaceFile)
      && normalizePath(header.workspaceFolder) === normalizePath(context.workspaceFolder);
  }

  function restoreHeaderWorkspaceContext(context) {
    if (typeof document === 'undefined' || !context) return;
    const trigger = document.getElementById('header-workspace-trigger');
    if (!trigger?.dataset) return;
    if (trigger.dataset.workspaceFile || trigger.dataset.workspaceFolder) return;
    if (context.workspaceFile) trigger.dataset.workspaceFile = context.workspaceFile;
    if (context.workspaceFolder) trigger.dataset.workspaceFolder = context.workspaceFolder;
  }

  function readLastActiveChatId() {
    if (typeof localStorage === 'undefined') return '';
    try {
      return readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '');
    } catch (_) {
      return '';
    }
  }

  function isEmbedModeActive() {
    return typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
  }

  /**
   * Cold-start fast path: seed the runtime list (and the last active chat) from the local
   * snapshot so the list and the active pane render before `GET /api/chats` answers. The
   * server response then reconciles the same row objects in place, so there is no flicker.
   * Runs at most once per page life.
   *
   * @param {{ preferChatId?: string, skipAutoSelect?: boolean, skipCache?: boolean }} [query]
   * @returns {boolean} whether cached rows were applied
   */
  function hydrateChatListFromLocalBootCache(query = {}) {
    const runtimeChats = getChats();
    const skipCache = query.skipCache === true;
    const cached = skipCache
      ? null
      : readChatLocalBootCacheForColdStart(typeof localStorage !== 'undefined' ? localStorage : null);
    const shouldHydrate = shouldHydrateChatListFromBootCache({
      alreadyHydrated: chatBootCacheHydrated,
      skipCache,
      runtimeChatCount: runtimeChats.length,
      cachedChatCount: cached ? cached.chats.length : 0,
    });
    chatBootCacheHydrated = true;
    if (!shouldHydrate || !cached) return false;
    // The rows below come straight from the local snapshot; until `GET /api/chats`
    // reconciles them the runtime list is an unconfirmed slice and must not shrink IDB.
    chatBootCacheUnconfirmed = true;
    if (getWorkspaces().length === 0 && cached.workspaces.length > 0) {
      setWorkspaces(cached.workspaces);
    }
    rememberedWorkspaceContext = {
      workspaceFile: cached.workspaceContext.workspaceFile,
      workspaceFolder: cached.workspaceContext.workspaceFolder,
    };
    const headerBeforeRestore = readHeaderWorkspaceContext();
    restoreHeaderWorkspaceContext(cached.workspaceContext);
    runtimeChats.length = 0;
    /** @type {string[]} Ids whose remembered presence is new to the cached row. */
    const presenceDirtyIds = [];
    cached.chats.forEach((chat) => {
      chat._fromBootCache = true;
      // The boot snapshot drops every `_` field, so a cached row never carries presence.
      // A WS snapshot that landed before this list was seeded is still authoritative for it.
      if (hydratePresenceChat(chat)) presenceDirtyIds.push(chat.id);
      runtimeChats.push(chat);
    });
    setActiveChatIdsForEviction(runtimeChats.map((chat) => chat.id));
    renderChatList();
    if (presenceDirtyIds.length > 0 && typeof onPresenceHydrate === 'function') {
      onPresenceHydrate(presenceDirtyIds);
    }
    if (
      (headerBeforeRestore.workspaceFile || headerBeforeRestore.workspaceFolder)
      && !headerWorkspaceMatches(cached.workspaceContext, headerBeforeRestore)
    ) {
      refreshChatListForWorkspace();
    }
    const preferChatId = typeof query.preferChatId === 'string' ? query.preferChatId.trim() : '';
    if (preferChatId && !runtimeChats.some((chat) => chat.id === preferChatId)) {
      if (!chatBootAsyncHydrateStarted) {
        chatBootAsyncHydrateStarted = true;
        const activeBeforeHydrate = getActiveChatId();
        // Defer one microtask: `loadChatsFromServer` bumps the list revision later in this
        // same synchronous pass, which would immediately invalidate a guard captured now and
        // silently drop the IDB read. Deferring lets the hydration guard be captured after
        // that bump, so `?chat=` outside the sync window is really hydrated (F2).
        Promise.resolve()
          .then(() => hydrateMissingBootRowsFromAdapter({ forceIdb: true }))
          .then(() => {
            if (!getChats().some((chat) => chat.id === preferChatId)) return;
            const activeNow = getActiveChatId();
            // The IDB read is async: if the user (or another restore path) already selected a
            // chat in the meantime, never override that explicit choice with `?chat=`.
            if (activeNow && activeNow !== activeBeforeHydrate) return;
            setActiveChatId(preferChatId);
            updateChatBarSelect();
            const skipAutoSelect = query.skipAutoSelect === true || isEmbedModeActive();
            if (!skipAutoSelect) selectChat(preferChatId);
          })
          .catch((err) => {
            console.warn('[chat] boot hydrate for ?chat= failed:', err?.message || err);
          });
      }
      updateChatBarSelect();
      return true;
    }
    const visibleChats = runtimeChats.filter((chat) => !chat.archivedAt);
    let nextActiveId = '';
    if (preferChatId && runtimeChats.some((chat) => chat.id === preferChatId)) {
      nextActiveId = preferChatId;
    } else {
      const lastId = readLastActiveChatId() || cached.activeChatId;
      if (lastId && visibleChats.some((chat) => chat.id === lastId)) nextActiveId = lastId;
      else if (visibleChats.length > 0) nextActiveId = visibleChats[0].id;
    }
    if (nextActiveId) setActiveChatId(nextActiveId);
    updateChatBarSelect();
    const skipAutoSelect = query.skipAutoSelect === true || isEmbedModeActive();
    if (!skipAutoSelect && getActiveChatId()) selectChat(getActiveChatId());
    scheduleAsyncBootCacheHydration();
    return true;
  }

  function readLocalStorageRef() {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  }

  function syncBootHydrationControllerScope() {
    const hydration = getChatBootListHydrationController();
    if (typeof getBootActivitySession === 'function') {
      hydration.setSessionScope(getBootActivitySession());
    }
    if (typeof getBootIdbEpoch === 'function') {
      hydration.setIdbEpoch(getBootIdbEpoch());
    }
  }

  /**
   * @param {{ forceIdb?: boolean }} [options]
   */
  async function hydrateMissingBootRowsFromAdapter(options = {}) {
    syncBootHydrationControllerScope();
    const hydration = getChatBootListHydrationController();
    const bootGuard = hydration.captureGuard();
    const isRunActive = hydration.captureRunEpoch();
    const storage = readLocalStorageRef();
    let fullDoc = readChatLocalBootCache(storage);
    const adapter = typeof getBootMetadataAdapter === 'function' ? getBootMetadataAdapter() : null;
    const shouldReadIdb = options.forceIdb === true
      || !fullDoc
      || fullDoc.chats.length <= getChats().length;
    if (shouldReadIdb && adapter) {
      try {
        if (options.forceIdb === true && typeof adapter.refreshMetaKeyFromIdb === 'function') {
          await adapter.refreshMetaKeyFromIdb(CHAT_LOCAL_BOOT_CACHE_KEY);
        } else if (typeof adapter.ensurePrime === 'function') {
          await adapter.ensurePrime();
        }
      } catch (_) {}
      if (!isRunActive() || !hydration.isGuardFresh(bootGuard)) return false;
      const raw = typeof adapter.read === 'function' ? adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY) : null;
      const fromIdb = parseChatLocalBootCache(raw);
      if (fromIdb && (!fullDoc || fromIdb.chats.length > fullDoc.chats.length)) {
        fullDoc = fromIdb;
      }
    }
    if (!isRunActive() || !hydration.isGuardFresh(bootGuard)) return false;
    if (!fullDoc) return false;
    const runtimeChats = getChats();
    const existingIds = new Set(runtimeChats.map((chat) => chat?.id).filter(Boolean));
    const missing = selectBootRowsMissingFromRuntime(fullDoc, existingIds);
    if (missing.length === 0) return false;
    let appliedCount = 0;
    const result = await hydration.hydrateRows(missing, (row) => {
      row._fromBootCache = true;
      if (hydratePresenceChat(row)) {
        if (typeof onPresenceHydrate === 'function') onPresenceHydrate([row.id]);
      }
      runtimeChats.push(row);
      appliedCount += 1;
    }, undefined, { guard: bootGuard, isRunActive });
    if (appliedCount > 0 && !result.cancelled && hydration.isGuardFresh(bootGuard) && isRunActive()) {
      setActiveChatIdsForEviction(runtimeChats.map((chat) => chat.id));
      const paint = () => {
        renderChatList();
        updateChatBarSelect();
      };
      if (scheduleDomWrite(paint) == null) paint();
      return true;
    }
    return false;
  }

  /**
   * Hydrate remaining boot rows after the synchronous bootstrap (IDB or legacy LS).
   */
  function scheduleAsyncBootCacheHydration() {
    if (chatBootAsyncHydrateStarted) return;
    chatBootAsyncHydrateStarted = true;
    void hydrateMissingBootRowsFromAdapter();
  }

  /** Peer tab wrote a newer boot snapshot — merge missing rows without durable echo. */
  function applyPeerBootCacheRevision() {
    void hydrateMissingBootRowsFromAdapter({ forceIdb: true });
  }

  function teardownUnconfirmedBootCacheChat(chat) {
    if (typeof teardownChatRuntime === 'function') {
      teardownChatRuntime(chat);
      return;
    }
    if (typeof teardownBlockedChatRuntime === 'function') {
      teardownBlockedChatRuntime(chat);
    }
  }

  /** Collect boot-cache input from current runtime state (no storage writes). */
  function collectChatListBootCacheInput() {
    const headerContext = readHeaderWorkspaceContext();
    const workspaceContext = headerContext.workspaceFile || headerContext.workspaceFolder
      ? headerContext
      : rememberedWorkspaceContext;
    if (workspaceContext?.workspaceFile || workspaceContext?.workspaceFolder) {
      rememberedWorkspaceContext = {
        workspaceFile: workspaceContext.workspaceFile || '',
        workspaceFolder: workspaceContext.workspaceFolder || '',
      };
    }
    return {
      chats: getChats(),
      workspaces: getWorkspaces(),
      activeChatId: getActiveChatId() || readLastActiveChatId(),
      workspaceContext,
      // Explicit provenance for the persist guard: only an unconfirmed boot-cache slice may
      // skip a subset-shrink write. After a server response reconciles the list this flips
      // to 'server', so a real deletion still prunes IDB (F1).
      source: chatBootCacheUnconfirmed ? 'boot-cache' : 'server',
    };
  }

  /** Snapshot the freshly reconciled list for the next cold start. Best effort. */
  function persistChatListBootCache() {
    if (typeof scheduleBootCachePersist === 'function') {
      scheduleBootCachePersist();
      return true;
    }
    if (typeof localStorage === 'undefined') return false;
    return writeChatLocalBootCache(localStorage, collectChatListBootCacheInput());
  }

  function renderWorkspacesSelects() {
    const workspaces = getWorkspaces();
    const workspaceSel = document.getElementById('chat-new-workspace-select');
    const folderSel = document.getElementById('chat-new-folder-select');
    const modelSel = document.getElementById('chat-new-model-select');
    if (workspaces.length === 0) {
      if (workspaceSel) workspaceSel.innerHTML = '';
      if (folderSel) folderSel.innerHTML = '';
      if (modelSel) {
        modelSel.innerHTML = `<option value="auto">${escapeHtml(t('workspace.none'))}</option>`;
      }
      return;
    }
    const trigger = document.getElementById('header-workspace-trigger');
    const nextWorkspaceFile = pickNewChatWorkspaceFile({
      workspaces,
      selectedWorkspaceFile: getSelectedWorkspaceFile() || '',
      headerWorkspaceFile: trigger?.dataset?.workspaceFile || '',
    });
    if (nextWorkspaceFile) setSelectedWorkspaceFile(nextWorkspaceFile);
    if (workspaceSel) {
      workspaceSel.innerHTML = workspaces
        .map((w) => {
          const key = workspaceListEntryKey(w);
          return (
            '<option value="' +
            escapeHtml(key) +
            '">' +
            escapeHtml(w.name) +
            ' (' +
            (w.folders || []).map((f) => f.name).join(', ') +
            ')</option>'
          );
        })
        .join('');
      workspaceSel.value = getSelectedWorkspaceFile() || '';
    }
    updateFolderSelect(getSelectedWorkspaceFile());
    if (folderSel) {
      const preferredFolder = getSelectedWorkspaceFolder() || '';
      const preferredOption = Array.from(folderSel.options).find(
        (option) => normalizePath(option.value) === normalizePath(preferredFolder)
      );
      if (preferredOption) {
        folderSel.value = preferredOption.value;
        setSelectedWorkspaceFolder(preferredOption.value);
      } else if (folderSel.value) {
        setSelectedWorkspaceFolder(folderSel.value);
      }
    }
    if (modelSel) modelSel.value = getSelectedModel() || 'auto';
    if (modelSel && typeof renderModelSelectOptions === 'function') {
      renderModelSelectOptions(modelSel, getSelectedModel() || 'auto');
    }
  }

  function loadWorkspaces() {
    return api.getWorkspaces().then((data) => {
      if (!data.ok || !Array.isArray(data.workspaces)) return;
      setWorkspaces(data.workspaces);
      renderWorkspacesSelects();
    });
  }

  /** Scope key of the most recently settled GET /api/chats (for pending trim). */
  let lastCompletedListLoadScopeKey = null;

  /**
   * Client-only effects when the freshness policy skips a network reload.
   *
   * @param {{ skipAutoSelect: boolean, preferChatId: string, includeArchived: boolean }} opts
   */
  function applyListLoadClientEffects(opts) {
    const chats = getChats();
    const visibleChats = chats.filter((chat) => !chat.archivedAt);
    if (opts.preferChatId && chats.some((chat) => chat.id === opts.preferChatId)) {
      setActiveChatId(opts.preferChatId);
    } else if (!opts.skipAutoSelect) {
      const lastId = typeof localStorage !== 'undefined'
        ? readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '')
        : null;
      const validLast = lastId && visibleChats.some((chat) => chat.id === lastId);
      const autoSelectChats = visibleChats.filter((chat) => chat?.watcherPinned !== true);
      if (validLast) {
        setActiveChatId(lastId);
      } else if (autoSelectChats.length > 0 && !autoSelectChats.some((chat) => chat.id === getActiveChatId())) {
        setActiveChatId(autoSelectChats[0].id);
      }
    }
    updateChatBarSelect();
    if (!opts.skipAutoSelect && getActiveChatId()) selectChat(getActiveChatId());
    if (opts.includeArchived && typeof onArchiveCatalogHydrate === 'function') {
      void onArchiveCatalogHydrate();
    }
  }

  function invalidateListLoadFreshness() {
    lastSuccessfulListLoad = null;
    lastCompletedListLoadScopeKey = null;
    if (typeof invalidateArchiveCatalog === 'function') {
      try {
        invalidateArchiveCatalog();
      } catch (_) {}
    }
  }

  /**
   * Runs a queued follow-up load after an in-flight GET finishes (actual request scope, not merged).
   *
   * @param {string} completedScopeKey
   */
  function drainPendingChatListLoadAfterComplete(completedScopeKey) {
    lastCompletedListLoadScopeKey = completedScopeKey;
    const next = pendingLoadQuery;
    pendingLoadQuery = null;
    if (!next) return;
    const trimmed = trimPendingChatListLoadQuery(completedScopeKey, next);
    if (!trimmed) return;
    void loadChatsFromServer(trimmed);
  }

  function loadChatsFromServer(query = {}) {
    // Render the cached list (and open the last active chat from IndexedDB) before any
    // network wait; the request below only reconciles it.
    // Task 0.1: time the synchronous hydrate separately from the poll and the
    // full archive render. No-op while the freeze diagnostics flag is off.
    const hydrateCounters = getUiFreezeCounters();
    if (!hydrateCounters) {
      hydrateChatListFromLocalBootCache(query);
    } else {
      hydrateCounters.bump('boot-cache.hydrate.attempts');
      const hydrated = measureFreezeSpan('boot-cache.hydrate', {}, () =>
        hydrateChatListFromLocalBootCache(query)
      );
      if (hydrated) hydrateCounters.bump('boot-cache.hydrates');
    }
    if (typeof onAfterBootHydrate === 'function') {
      try {
        onAfterBootHydrate();
      } catch (_) {}
    }
    const normalized = normalizeChatListLoadQuery(query);
    const skipAutoSelect = normalized.skipAutoSelect
      || (typeof document !== 'undefined' && document.body?.classList.contains('embed-mode'));
    const includeArchived = normalized.includeArchived;
    const apiQuery = buildChatsListApiQuery({
      includeArchived,
      pinnedTo: normalized.pinnedTo,
      archiveWorkspace: normalized.archiveWorkspace,
    });
    const preferChatId = normalized.preferChatId;
    const hydrationCtrl = getChatBootListHydrationController();
    const session = typeof getBootActivitySession === 'function' ? getBootActivitySession() : {};
    const networkDecision = decideChatListNetworkLoad({
      nowMs: Date.now(),
      normalized,
      hasInFlight: chatsLoadPromise != null,
      inFlightScopeKey: inFlightLoadScopeKey,
      lastSuccess: lastSuccessfulListLoad,
      session,
      listRevision: hydrationCtrl.getListRevision(),
    });
    if (networkDecision === 'skip-fresh') {
      applyListLoadClientEffects({ skipAutoSelect, preferChatId, includeArchived });
      return Promise.resolve();
    }
    if (networkDecision === 'join-in-flight') {
      pendingLoadQuery = mergeChatListLoadQuery(pendingLoadQuery || {}, query);
      return chatsLoadPromise;
    }
    if (chatsLoadPromise) {
      pendingLoadQuery = mergeChatListLoadQuery(pendingLoadQuery || {}, query);
      return chatsLoadPromise;
    }
    const loadArchiveWorkspace = normalized.archiveWorkspace;
    const startedScopeKey = buildChatListLoadScopeKey(normalized);
    inFlightLoadScopeKey = startedScopeKey;
    const hydrationCtrlAtStart = getChatBootListHydrationController();
    hydrationCtrlAtStart.bumpListRevision();
    const listRevisionAtLoadStart = hydrationCtrlAtStart.getListRevision();
    const loadApplyToken = buildChatListLoadApplyToken(session, listRevisionAtLoadStart);
    chatsLoadPromise = api.getChats(apiQuery).then(async (data) => {
      const hydrationCtrl = getChatBootListHydrationController();
      const applySession = typeof getBootActivitySession === 'function' ? getBootActivitySession() : {};
      if (!isChatListLoadApplyTokenFresh(loadApplyToken, applySession, hydrationCtrl.getListRevision())) {
        return;
      }
      if (!data.ok || !Array.isArray(data.chats)) return;
      hydrationCtrl.bumpListRevision();
      const listRevisionAfterResponseBump = hydrationCtrl.getListRevision();
      const loadApplyTokenForReconcile = buildChatListLoadApplyToken(
        applySession,
        listRevisionAfterResponseBump,
      );
      if (typeof invalidateArchiveCatalog === 'function') {
        try {
          invalidateArchiveCatalog();
        } catch (_) {}
      }
      const chats = getChats();
      const repaintBefore = chatListRepaintSignature(chats, archivedCounts);
      archivedCounts =
        data.archivedCounts && typeof data.archivedCounts === 'object'
          ? data.archivedCounts
          : Object.create(null);
      const runtimeById = new Map(chats.map((chat) => [chat.id, chat]));
      /** @type {object[]} Existing chats that flipped from non-blocking to blocking in this refresh. */
      const blockedTransitions = [];
      /** @type {object[]} Existing chats that flipped from blocking to non-blocking in this refresh. */
      const restoredTransitions = [];
      /** @type {string[]} New rows whose remembered presence changed their visible status. */
      const presenceDirtyIds = [];
      let serverChats = data.chats;
      if (
        data.linkedChat?.id
        && !serverChats.some((chat) => chat.id === data.linkedChat.id)
      ) {
        serverChats = [...serverChats, data.linkedChat];
      }
      const serverChatIds = new Set(serverChats.map((chat) => chat.id));
      // Task 2.1: only a full, authoritative index (server `fullIndex: true`)
      // may drop activity for chats that are genuinely gone. Boot snapshots,
      // widget-scoped lists and pinned lookups must not prune.
      if (shouldPruneChatActivityFromListResponse(data)) {
        pruneChatActivityToKnownIds(serverChatIds, { authoritative: true });
      }
      const staleBootCacheChats = chats.filter(
        (chat) => chat?._fromBootCache === true && chat.id && !serverChatIds.has(chat.id)
      );
      for (const chat of staleBootCacheChats) {
        teardownUnconfirmedBootCacheChat(chat);
      }
      const reconcileCtx = {
        readChatBufferForChatRestore,
        chatBufferMax: CHAT_BUFFER_MAX,
        blockedTransitions,
        restoredTransitions,
        hydratePresenceChat,
        presenceDirtyIds,
      };
      const isApplyFresh = () => {
        const sessionNow = typeof getBootActivitySession === 'function' ? getBootActivitySession() : {};
        return isChatListLoadApplyTokenFresh(
          loadApplyTokenForReconcile,
          sessionNow,
          hydrationCtrl.getListRevision(),
        );
      };
      const reconciled = await reconcileServerChatsInTimeSlices(
        serverChats,
        runtimeById,
        reconcileCtx,
        { isApplyFresh },
      );
      if (reconciled.cancelled || !isApplyFresh()) return;
      const nextChats = reconciled.rows;
      const liveOrphans = chats.filter((chat) => {
        if (!chat?.id) return false;
        if (chat._fromBootCache === true) return false;
        if (nextChats.some((entry) => entry.id === chat.id)) return false;
        if (chat.pane) return true;
        const readyState = chat.ws?.readyState;
        return readyState === 0 || readyState === 1;
      });
      if (liveOrphans.length > 0) {
        nextChats.push(...liveOrphans);
      }
      const mergedRows = loadArchiveWorkspace
        ? mergeRuntimeChatListAfterScopedArchiveLoad(chats, nextChats, loadArchiveWorkspace)
        : nextChats;
      chats.length = 0;
      mergedRows.forEach((chat) => chats.push(chat));
      // The runtime list is now server-reconciled: from here on a persist may honestly
      // shrink IDB (real deletions), so the subset-shrink guard must no longer apply (F1).
      chatBootCacheUnconfirmed = false;
      const repaintNeeded = chatListRepaintSignature(chats, archivedCounts) !== repaintBefore;
      setActiveChatIdsForEviction(mergedRows.map((c) => c.id));
      void migrateChatStorageOutOfLocalStorage(mergedRows.map((c) => c.id));
      // An idempotent reconcile (a live frame for state the list already shows, a title the
      // live sync already patched in place) must not rebuild the list modal. `updateChatBarSelect`
      // and the boot-cache write below stay unconditional: the active chat can change anyway.
      if (repaintNeeded) {
        const paint = () => renderChatList();
        if (scheduleDomWrite(paint) == null) paint();
      }
      // `chatListRepaintSignature` deliberately ignores runtime fields, so a hydrated
      // presence row can land on a list that is otherwise unchanged and skip the repaint.
      // The in-place sidebar refresh is what makes that status visible anyway.
      if (presenceDirtyIds.length > 0 && typeof onPresenceHydrate === 'function') {
        onPresenceHydrate(presenceDirtyIds);
      }
      const visibleChats = mergedRows.filter((chat) => !chat.archivedAt);
      const activeIdBeforeSelect = getActiveChatId();
      if (
        activeIdBeforeSelect
        && staleBootCacheChats.some((chat) => chat.id === activeIdBeforeSelect)
      ) {
        const lastId = typeof localStorage !== 'undefined'
          ? readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '')
          : '';
        const validLast = lastId && visibleChats.some((chat) => chat.id === lastId);
        if (validLast) {
          setActiveChatId(lastId);
        } else if (visibleChats.length > 0) {
          setActiveChatId(visibleChats[0].id);
        } else {
          setActiveChatId(null);
        }
      }
      if (preferChatId && mergedRows.some((chat) => chat.id === preferChatId)) {
        setActiveChatId(preferChatId);
      } else if (!skipAutoSelect) {
        const lastId = typeof localStorage !== 'undefined'
          ? readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '')
          : null;
        const validLast = lastId && visibleChats.some((chat) => chat.id === lastId);
        // Never auto-open the durable watcher chat: it is an observability feed,
        // not the user's working conversation.
        const autoSelectChats = visibleChats.filter((chat) => chat?.watcherPinned !== true);
        if (validLast) {
          setActiveChatId(lastId);
        } else if (autoSelectChats.length > 0 && !autoSelectChats.some((chat) => chat.id === getActiveChatId())) {
          setActiveChatId(autoSelectChats[0].id);
        }
      }
      updateChatBarSelect();
      if (!skipAutoSelect && getActiveChatId()) selectChat(getActiveChatId());
      persistChatListBootCache();
      // A live/resume list refresh mutates an already-hydrated chat in place, so a
      // `skipAutoSelect` pass never reaches selectChat/openTerminal. When a chat just
      // turned blocking, swap any mounted SDK pane for the blocked notice and tear its
      // live socket down. Only a real non-blocking -> blocking edge triggers this, so
      // unblocked/not_loaded rows keep their existing lifecycle untouched.
      for (const chat of blockedTransitions) {
        if (chat.pane?.isConnected === true && typeof openTerminal === 'function') {
          openTerminal(chat);
        }
        if (typeof teardownBlockedChatRuntime === 'function') {
          teardownBlockedChatRuntime(chat);
        } else if (typeof ensureChatConnection === 'function') {
          ensureChatConnection(chat);
        }
      }
      // A chat that turned non-blocking while its minimal blocked notice was mounted must
      // be rebuilt through the ordinary pane path: a mounted notice is a connected pane, so
      // `openTerminal` would otherwise return early. `openTerminal` removes the stale notice
      // and rebuilds exactly one normal pane. Only a real blocking -> non-blocking edge with
      // a mounted pane is queued — never a routine non-blocking refresh or a new chat.
      for (const chat of restoredTransitions) {
        if (chat.pane?.isConnected === true && typeof openTerminal === 'function') {
          openTerminal(chat);
        }
      }
      syncBackgroundChatConnections();
      bindChatVisibilityAndReconnect();
      startChatBackgroundMonitor();
      startGlobalChatPingLoop();
      lastSuccessfulListLoad = buildChatListLoadSuccessSnapshot(
        startedScopeKey,
        Date.now(),
        applySession,
        hydrationCtrl.getListRevision(),
      );
    }).catch((err) => {
      console.warn('[chat] list load failed:', err?.message || err);
    }).finally(() => {
      inFlightLoadScopeKey = null;
      chatsLoadPromise = null;
      drainPendingChatListLoadAfterComplete(startedScopeKey);
      // A push-inbox record for a chat that was not in the (often boot-cache
      // seeded) list must be replayed once the server list has reconciled, so the
      // chat row exists and the record is not lost.
      if (typeof onAfterChatsLoad === 'function') {
        try {
          onAfterChatsLoad();
        } catch (_) {}
      }
    });
    return chatsLoadPromise;
  }

  function isChatsListLoadInFlight() {
    return chatsLoadPromise != null;
  }

  /**
   * Applies one `chatsChanged` reason:'title' frame in place: patches a single row so the
   * sidebar, chat bar, list modal and boot cache repaint without `GET /api/chats`.
   * `updatedAt` is left alone — the list sorts by creation date, so the row never moves, and
   * the next real reload re-reads the server value.
   *
   * @param {string} chatId
   * @param {string} title
   * @param {string} titleSource
   * @returns {boolean} false when this client has no such row, so the caller reloads the list
   */
  function patchChatTitle(chatId, title, titleSource) {
    const id = typeof chatId === 'string' ? chatId.trim() : '';
    const nextTitle = typeof title === 'string' ? title : '';
    if (!id || !nextTitle) return false;
    const chat = getChats().find((entry) => entry?.id === id);
    if (!chat) return false;
    const nextSource = typeof titleSource === 'string' ? titleSource.trim() : '';
    if (chat.title === nextTitle && (chat.titleSource || '') === nextSource) return true;
    chat.title = nextTitle;
    if (nextSource) chat.titleSource = nextSource;
    else delete chat.titleSource;
    renderChatList();
    persistChatListBootCache();
    return true;
  }

  function selectChatController(id) {
    const chats = getChats();
    const chat = chats.find((c) => c.id === id);
    if (chat) openTerminal(chat);
    setActiveChatId(id);
    if (chat?.cursorSessionId && chat.pane) ensureChatConnection(chat);
    if (typeof localStorage !== 'undefined') {
      try {
        writeStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, id);
      } catch {}
    }
    document
      .querySelectorAll('.chat-tab-pane')
      .forEach((p) => p.classList.toggle('active', p.dataset.chatId === id));
    updateChatBarSelect();
    setChatStatus(chat ? chat._connectionStatus || 'disconnected' : 'disconnected');
    persistChatListBootCache();
  }

  function refreshChatListForWorkspace(options = {}) {
    const filtered = getChatsForCurrentWorkspace();
    const activeChatId = getActiveChatId();
    const stillVisible = activeChatId && filtered.some((c) => c.id === activeChatId);
    if (!stillVisible && options.preserveActiveChat !== true) {
      setActiveChatId(filtered.length ? filtered[0].id : null);
      selectChat(getActiveChatId());
      return;
    }
    updateChatBarSelect();
    if (!activeChatId) return;
    const chat = getChats().find((c) => c.id === activeChatId);
    if (!chat) return;
    setChatStatus(chat._connectionStatus || 'disconnected');
  }

  function initChatPanelBridge() {
    const workspaceSel = document.getElementById('chat-new-workspace-select');
    const folderSel = document.getElementById('chat-new-folder-select');
    const modelSel = document.getElementById('chat-new-model-select');
    if (workspaceSel) {
      workspaceSel.addEventListener('change', () => {
        setSelectedWorkspaceFile(workspaceSel.value || null);
        updateFolderSelect(getSelectedWorkspaceFile());
        const nextFolderSel = document.getElementById('chat-new-folder-select');
        setSelectedWorkspaceFolder(nextFolderSel?.value || null);
      });
    }
    if (folderSel) {
      folderSel.addEventListener('change', () => {
        setSelectedWorkspaceFolder(folderSel.value || null);
      });
    }
    if (modelSel) {
      modelSel.addEventListener('change', () => {
        setSelectedModel(modelSel.value || 'auto');
      });
    }
  }

  return {
    loadWorkspaces,
    renderWorkspacesSelects,
    loadChatsFromServer,
    isChatsListLoadInFlight,
    patchChatTitle,
    getArchivedCounts: () => archivedCounts,
    selectChat: selectChatController,
    refreshChatListForWorkspace,
    initChatPanelBridge,
    persistChatListBootCache,
    getBootCachePersistInput: collectChatListBootCacheInput,
    applyPeerBootCacheRevision,
    invalidateListLoadFreshness,
  };
}
