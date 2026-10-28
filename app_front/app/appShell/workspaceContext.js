import { getEmbedWorkspaceOverride } from './embedMode.js';
import { initDropdown } from '../../lib/dropdown.js';
import { t } from '../../i18n/index.js';
import { createWorkspaceSettings } from './workspaceSettings.js';
import {
  getWorkspaceDirFromFile,
  getWorkspaceFileFromSidebarKey,
  isSidebarCloneKey,
  normalizePath,
  normalizeWorkspaceSidebarConfig,
  resolveWorkspaceItemKey,
} from './workspaceHelpers.js';
import { readChatLocalBootCacheForColdStart } from '../../features/chat/chatLocalBootSync.js';
import {
  VIEW_CONTEXT_STATUS,
  createViewContextStore,
  hasExplicitWorkspace,
} from './viewContext.js';
import { setSharedViewContextStore } from './viewContextBridge.js';
import { buildSpaRoute, parseSpaRoute } from '../../../lib/spa-routes.js';
import { replaceSpaCanonical } from './spaNavigationBridge.js';
import { probeSync, probeStart, probeEnd } from '../../lib/perfProbe.js';

export function createWorkspaceContext(deps = {}) {
  const {
    api,
    refreshTasksList = () => {},
    refreshChatListForWorkspace = () => {},
    ensureFilesPanelInitialized = () => {},
    refreshFilesPanel = () => {},
    refreshGitInfo = () => {},
    updateGithubTabVisibility = () => Promise.resolve(),
    refreshGithubPanel = () => {},
    refreshTodoList = () => {},
    refreshBrowserPanel = () => {},
    onWorkspaceLabelChanged = () => {},
  } = deps;

  let workspacesList = [];
  let workspacesListFetchPromise = null;
  let workspaceSidebarConfig = {};
  let headerRevision = 0;
  let selectionRevision = 0;
  let workspaceWriteQueue = Promise.resolve();

  /**
   * Show why a link's explicit context could not be honored (missing data or
   * a resource owned by another workspace), or that it is still resolving. The
   * popover footer stays inside the workspace menu, so the header itself never
   * lies about the scope.
   *
   * @param {{ code: string, kind?: string, workspaceKey?: string, folderKey?: string }|null|undefined} notice
   */
  function setWorkspaceContextMessage(notice) {
    const el = document.getElementById('header-workspace-message');
    const bar = document.getElementById('sidebar-workspace-bar');
    const trigger = document.getElementById('header-workspace-trigger');
    let text = '';
    let tone = 'error';
    if (notice) {
      const key = notice.kind === 'chat' ? 'workspace.contextConflictChat'
        : notice.kind === 'todo' ? 'workspace.contextConflictTodo'
          : notice.code === 'folder-unavailable' ? 'workspace.contextFolderUnavailable'
            : notice.code === 'pending' ? 'workspace.contextPending'
              : 'workspace.contextMissing';
      text = t(key);
      // Still resolving is informational, not a failure the operator caused.
      if (notice.code === 'pending') tone = 'muted';
    }
    if (trigger && typeof trigger.setAttribute === 'function') {
      if (text) trigger.setAttribute('title', text);
      else trigger.setAttribute('title', t('header.workspaceTitle'));
    }
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('data-tone');
      if (bar && typeof bar.dataset === 'object') {
        delete bar.dataset.viewContextNotice;
        // Same rule as `syncWorkspaceBarVisibility` (workspaceBranchBadge.js).
        const shown = (id) => {
          const node = document.getElementById(id);
          return Boolean(node && !node.hidden);
        };
        bar.hidden = !shown('header-workspace-branch') && !shown('header-git-badge') && !shown('sidebar-worktree-row');
      }
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.setAttribute('data-tone', tone);
    if (bar) {
      bar.hidden = false;
      bar.dataset.viewContextNotice = '1';
    }
  }

  /**
   * Replace stale deep-link ws/folder query params after an operator workspace switch.
   *
   * @param {{ workspaceKey?: string, folderKey?: string } | null | undefined} contextKeys
   */
  function syncOperatorSwitchToLocation(contextKeys) {
    if (typeof window === 'undefined' || !window.location) return;
    const parsed = parseSpaRoute({
      pathname: window.location.pathname || '/',
      search: window.location.search || '',
    });
    if (!parsed || parsed.notFound) return;
    const keys = contextKeys && typeof contextKeys === 'object' ? contextKeys : {};
    const canonical = buildSpaRoute({
      ...parsed,
      context: {
        workspaceKey: String(keys.workspaceKey || '').trim(),
        folderKey: String(keys.folderKey || '').trim(),
      },
      notFound: false,
    });
    replaceSpaCanonical(canonical);
  }

  /**
   * Map the link's opaque route ids onto catalog rows first (no round-trip on
   * warm boot), then fall back to the shared context API so cold links to ids
   * not in the local list still resolve. Unknown/deleted ids answer with the
   * resolver's machine code and never re-point another project.
   *
   * @param {{ workspaceKey: string, folderKey: string }} context
   */
  async function resolveViewContextWorkspace(context) {
    const list = await ensureWorkspacesListLoaded();
    const fromCatalog = findRouteKeyContext(list, context);
    if (fromCatalog) return fromCatalog;
    if (typeof api.getWorkspaceContext !== 'function') return { error: 'workspace-unknown' };
    const data = await api.getWorkspaceContext({
      workspaceKey: context.workspaceKey,
      folderKey: context.folderKey,
    });
    if (data?.ok && (data.workspace || data.folder)) {
      const workspaceFile = data.workspace?.workspaceFile || '';
      const folderPath = data.folder?.resolvedPath
        || (data.workspace?.kind === 'folder' ? workspaceFile : '');
      if (workspaceFile || folderPath) {
        return {
          workspaceFile,
          workspaceFolder: folderPath,
          workspaceKey: data.workspaceKey || '',
          folderKey: data.folderKey || '',
        };
      }
    }
    return { error: data?.error || 'workspace-unknown' };
  }

  /**
   * @param {{ workspaceFile?: string, workspaceFolder?: string }} runtime
   * @returns {Promise<{ workspaceKey: string, folderKey: string } | null>}
   */
  async function resolveContextKeysForRuntime(runtime) {
    const list = await ensureWorkspacesListLoaded();
    return findContextKeysInList(list, runtime);
  }

  /**
   * @param {Array<object>} list
   * @param {{ workspaceFile?: string, workspaceFolder?: string }} runtime
   * @returns {{ workspaceKey: string, folderKey: string } | null}
   */
  function findContextKeysInList(list, runtime) {
    const fileNorm = normalizePath(runtime.workspaceFile);
    if (!fileNorm) return null;
    const folderNorm = normalizePath(runtime.workspaceFolder);
    for (const item of Array.isArray(list) ? list : []) {
      if (normalizePath(item.workspaceFile) !== fileNorm) continue;
      const folder = (item.folders || []).find(
        (entry) => folderNorm && normalizePath(entry.resolvedPath) === folderNorm,
      );
      return { workspaceKey: item.workspaceKey || '', folderKey: folder?.folderKey || '' };
    }
    return null;
  }

  function findRouteKeyContext(list, context) {
    const workspaceKey = context.workspaceKey;
    const folderKey = context.folderKey;
    if (!workspaceKey && !folderKey) return null;
    for (const item of Array.isArray(list) ? list : []) {
      const workspaceMatches = workspaceKey
        ? item.workspaceKey === workspaceKey
          || (item.kind === 'folder' && item.id === `cretli:ws:${workspaceKey}`)
        : true;
      if (!workspaceMatches) continue;
      if (!folderKey) {
        const sidebarKey = resolveWorkspaceItemKey(item) || item.workspaceFile || '';
        const sidebarFolder = getWorkspaceSidebarEntry(sidebarKey)?.folder?.trim() || '';
        let folderDefault;
        if (sidebarFolder) {
          folderDefault = resolveFolderForWorkspaceSelection(sidebarKey, sidebarFolder);
        } else if (item.kind === 'folder') {
          folderDefault = item.workspaceFile || item.workspaceDir || '';
        } else {
          folderDefault = (item.folders || []).find((entry) => entry.enabled !== false)?.resolvedPath || '';
        }
        return {
          workspaceFile: item.workspaceFile || '',
          workspaceFolder: folderDefault,
          workspaceKey: item.workspaceKey || (item.kind === 'folder' ? item.id : ''),
        };
      }
      const folder = (item.folders || []).find((entry) => entry.folderKey === folderKey);
      if (!folder) continue;
      if (folder.exists === false) {
        return { error: 'folder-unavailable', workspaceFile: '', workspaceFolder: '' };
      }
      return {
        workspaceFile: item.workspaceFile || '',
        workspaceFolder: folder.resolvedPath || '',
        workspaceKey: item.workspaceKey || (item.kind === 'folder' ? item.id : ''),
        folderKey: folder.folderKey || '',
      };
    }
    return null;
  }

  /**
   * The route-driven local context: applied to this tab's header scope and
   * panels only. It never writes settings — the global default workspace is a
   * separate, operator-owned choice (navigation plan stage 2).
   *
   * @param {object} state snapshot from the view-context store
   */
  function clearHeaderWorkspaceDatasets() {
    const trigger = document.getElementById('header-workspace-trigger');
    if (!trigger) return;
    trigger.dataset.workspaceFile = '';
    trigger.dataset.workspaceFolder = '';
    updateWorkspaceTriggerLabel('', '');
  }

  /**
   * Whether the header already shows exactly this workspace file and folder.
   * The datasets are cleared while a link is pending/missing, so a recovering
   * context never matches and still takes the full apply.
   *
   * @param {string} workspaceFile
   * @param {string} workspaceFolder
   * @returns {boolean}
   */
  function isWorkspaceAlreadyApplied(workspaceFile, workspaceFolder) {
    const trigger = document.getElementById('header-workspace-trigger');
    if (!trigger) return false;
    const shownFile = normalizePath(trigger.dataset.workspaceFile);
    const shownFolder = normalizePath(trigger.dataset.workspaceFolder);
    if (!shownFile && !shownFolder) return false;
    return shownFile === normalizePath(workspaceFile) && shownFolder === normalizePath(workspaceFolder);
  }

  function applyResolvedViewContext(state) {
    if (state?.status === VIEW_CONTEXT_STATUS.RESOLVED
      && (state.runtime.workspaceFile || state.runtime.workspaceFolder)) {
      setWorkspaceContextMessage(null);
      if (state.source === 'user') {
        // Header refresh already ran in applyLocalWorkspace; only broadcast the store.
      } else {
        const folder = state.runtime.workspaceFolder
          || resolveFolderForWorkspaceSelection(state.runtime.workspaceFile, '');
        // Every tab switch re-resolves the route context. When it lands on the
        // workspace the header already shows, repainting and refetching tasks,
        // agents, chats, workspace info and GitHub visibility is pure waste:
        // real workspace changes still go through the full path below.
        if (isWorkspaceAlreadyApplied(state.runtime.workspaceFile, folder)) {
          probeSync('shell.workspaceApply.skipped', () => {});
        } else {
          probeSync('shell.workspaceApply', () => {
            applyLocalWorkspace(state.runtime.workspaceFile, folder, { fromViewContext: true });
          });
        }
      }
    } else if (state?.status === VIEW_CONTEXT_STATUS.PENDING
      && hasExplicitWorkspace(state.context)) {
      // Slow is not missing: the link keeps its own URL and the header says the
      // scope is still resolving, so the empty panels read as pending, not as
      // the (different) workspace the global cwd would have shown.
      clearHeaderWorkspaceDatasets();
      setWorkspaceContextMessage({ code: 'pending' });
    } else if (state?.status === VIEW_CONTEXT_STATUS.MISSING_TARGET
      || state?.status === VIEW_CONTEXT_STATUS.CONFLICT) {
      clearHeaderWorkspaceDatasets();
      setWorkspaceContextMessage(state.conflict || { code: 'missing-data' });
    }
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('cretli-view-context-changed', { detail: state }));
    }
  }

  const viewContextStore = createViewContextStore({
    readLocation: () => (typeof window === 'undefined' || !window.location
      ? null
      : { pathname: window.location.pathname || '/', search: window.location.search || '' }),
    resolveWorkspace: (context) => resolveViewContextWorkspace(context),
    canonicalize: (canonicalPath) => {
      replaceSpaCanonical(canonicalPath);
    },
    onApplied: (state) => applyResolvedViewContext(state),
    getDefaultContext: async () => {
      const trigger = document.getElementById('header-workspace-trigger');
      return {
        workspaceFile: trigger?.dataset?.workspaceFile || '',
        workspaceFolder: trigger?.dataset?.workspaceFolder || '',
      };
    },
    getContextKeysForRuntime: (runtime) => resolveContextKeysForRuntime(runtime),
  });
  setSharedViewContextStore(viewContextStore);

  /**
   * Cold-start fast path: install a locally cached workspace list so the sidebar can group
   * the cached chats before `GET /api/workspaces` answers. A non-empty live list always
   * wins, and the next `ensureWorkspacesListLoaded()` still revalidates from the server.
   *
   * @param {unknown[]} list
   * @returns {boolean}
   */
  function seedWorkspacesList(list) {
    if (!Array.isArray(list) || list.length === 0) return false;
    if (Array.isArray(workspacesList) && workspacesList.length > 0) return false;
    workspacesList = list;
    return true;
  }

  function applyEmbedWorkspaceContext(installation = null) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const queryPayload = getEmbedWorkspaceOverride(window.location.search || '');
    const payload = installation && typeof installation === 'object'
      ? {
          workspaceFile: installation.workspaceFile || '',
          workspaceFolder: installation.workspaceFolder || '',
        }
      : queryPayload;
    if (!payload) return;

    window.__crWorkspaceOverride = {
      workspaceFile: payload.workspaceFile || '',
      workspaceFolder: payload.workspaceFolder || '',
    };
    if (installation && typeof installation.model === 'string') {
      window.__crEmbedModel = installation.model.trim();
    }

    const trigger = document.getElementById('header-workspace-trigger');
    const label = document.getElementById('header-workspace-label');
    if (trigger) {
      trigger.dataset.workspaceFile = payload.workspaceFile || '';
      trigger.dataset.workspaceFolder = payload.workspaceFolder || '';
    }
    if (!label) return;

    const fileName = (payload.workspaceFile || '').split('/').pop() || '';
    const folderName = (payload.workspaceFolder || '').split('/').pop() || '';
    if (fileName && folderName) label.textContent = `${fileName} - ${folderName}`;
    else if (fileName) label.textContent = fileName;
    else if (folderName) label.textContent = folderName;
    onWorkspaceLabelChanged();
  }

  function initWorkspaceHeader() {
    return api
      .getWorkspace()
      .then((data) => {
        const dirEl = document.getElementById('workspace-dir');
        const foldersEl = document.getElementById('folders');
        if (dirEl) {
          dirEl.textContent = data.ok
            ? data.workspaceDir
            : data.error || data.cwd || t('workspace.loadError');
        }
        if (foldersEl) {
          const names = data.ok && data.folders?.length ? data.folders.map((f) => f.name) : [];
          foldersEl.replaceChildren(...names.map((name) => {
            const item = document.createElement('li');
            item.textContent = name;
            return item;
          }));
          const field = document.getElementById('folders-field');
          if (field) field.hidden = names.length === 0;
        }
      })
      .catch(() => {
        const dirEl = document.getElementById('workspace-dir');
        if (dirEl) dirEl.textContent = t('workspace.loadError');
      });
  }

  function ensureWorkspacesListLoaded(options = {}) {
    const refresh = options.refresh === true;
    const scan = options.scan === true;
    const sync = options.sync === true;
    if (!refresh && !scan && !sync && Array.isArray(workspacesList) && workspacesList.length > 0) {
      return Promise.resolve(workspacesList);
    }
    if (!refresh && !scan && !sync && workspacesListFetchPromise) return workspacesListFetchPromise;
    workspacesListFetchPromise = api
      .getWorkspaces({ refresh, scan, sync })
      .then((wsData) => {
        workspacesList = wsData?.ok && Array.isArray(wsData.workspaces) ? wsData.workspaces : [];
        return workspacesList;
      })
      .catch(() => {
        // Keep a previously seeded/live list on a failed revalidation so an offline cold
        // start still groups its cached chats instead of falling back to the empty state.
        if (!Array.isArray(workspacesList) || workspacesList.length === 0) workspacesList = [];
        return workspacesList;
      })
      .finally(() => {
        workspacesListFetchPromise = null;
      });
    return workspacesListFetchPromise;
  }

  function setWorkspaceSidebarConfig(rawConfig) {
    workspaceSidebarConfig = normalizeWorkspaceSidebarConfig(rawConfig);
  }

  function getWorkspaceSidebarEntry(sidebarKey) {
    return workspaceSidebarConfig[normalizePath(sidebarKey)] || null;
  }

  function isWorkspaceEnabledInSidebar(sidebarKey) {
    const entry = getWorkspaceSidebarEntry(sidebarKey);
    if (!entry) return true;
    return entry.enabled !== false;
  }

  function getWorkspaceSidebarFolder(sidebarKey) {
    const entry = getWorkspaceSidebarEntry(sidebarKey);
    if (!entry || !entry.folder) return '';
    return entry.folder;
  }

  function getCloneSidebarKeysForWorkspace(workspaceFile) {
    const sourceFile = normalizePath(workspaceFile);
    if (!sourceFile) return [];
    return Object.keys(workspaceSidebarConfig).filter((sidebarKey) => {
      if (!isSidebarCloneKey(sidebarKey)) return false;
      const entry = workspaceSidebarConfig[sidebarKey];
      const cloneSource = normalizePath(entry?.workspaceFile || getWorkspaceFileFromSidebarKey(sidebarKey));
      return cloneSource === sourceFile;
    });
  }

  function getWorkspaceDefaultDisplayName(workspaceItem, entry, isClone) {
    const workspaceFile = workspaceItem?.workspaceFile || entry?.workspaceFile || '';
    if (isClone) {
      const folderName = resolveFolderName(workspaceFile, entry?.folder || '');
      const baseName = resolveWorkspaceName(workspaceFile);
      return folderName ? `${baseName} • ${folderName}` : t('workspace.cloneSuffix', { name: baseName });
    }
    return resolveWorkspaceName(workspaceFile);
  }

  function resolveSidebarDisplayName(sidebarKey, workspaceItem, entryOverride = null) {
    const entry = entryOverride || getWorkspaceSidebarEntry(sidebarKey);
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    if (label) return label;
    const isClone = isSidebarCloneKey(sidebarKey);
    return getWorkspaceDefaultDisplayName(workspaceItem, entry, isClone);
  }

  function findSidebarKeyByWorkspaceContext(workspaceFile, workspaceFolder) {
    const fileNorm = normalizePath(workspaceFile);
    const folderNorm = normalizePath(workspaceFolder);
    if (!fileNorm) return '';

    for (const sidebarKey of Object.keys(workspaceSidebarConfig)) {
      if (!isSidebarCloneKey(sidebarKey)) continue;
      const entry = workspaceSidebarConfig[sidebarKey];
      const sourceFile = normalizePath(entry?.workspaceFile || getWorkspaceFileFromSidebarKey(sidebarKey));
      if (sourceFile !== fileNorm) continue;
      const entryFolder = normalizePath(resolveFolderForWorkspaceSelection(sidebarKey, entry?.folder || ''));
      if (entryFolder === folderNorm) return sidebarKey;
    }

    if (isWorkspaceEnabledInSidebar(fileNorm)) return fileNorm;
    return fileNorm;
  }

  function buildExpandedWorkspacesList() {
    const items = [];
    workspacesList.forEach((workspaceItem) => {
      const sidebarKey = resolveWorkspaceItemKey(workspaceItem);
      if (!sidebarKey) return;
      if (!isWorkspaceEnabledInSidebar(sidebarKey)) return;

      items.push({
        ...workspaceItem,
        sidebarKey,
        isClone: false,
        name: resolveSidebarDisplayName(sidebarKey, workspaceItem),
      });

      getCloneSidebarKeysForWorkspace(sidebarKey).forEach((cloneKey) => {
        if (!isWorkspaceEnabledInSidebar(cloneKey)) return;
        const entry = getWorkspaceSidebarEntry(cloneKey);
        items.push({
          ...workspaceItem,
          sidebarKey: cloneKey,
          isClone: true,
          name: resolveSidebarDisplayName(cloneKey, workspaceItem, entry),
        });
      });
    });
    return items;
  }

  function findWorkspaceItem(workspaceFile) {
    const key = normalizePath(workspaceFile);
    return workspacesList.find(
      (item) => normalizePath(item.id) === key || normalizePath(item.workspaceFile) === key
    );
  }

  function resolveWorkspaceName(workspaceFile) {
    const workspaceItem = findWorkspaceItem(workspaceFile);
    if (workspaceItem?.name) return workspaceItem.name;
    if (!workspaceFile) return '—';
    return workspaceFile.replace(/.*\//, '').replace(/\.code-workspace$/, '');
  }

  function resolveFolderName(workspaceFile, workspaceFolder) {
    const workspaceItem = findWorkspaceItem(workspaceFile);
    if (!workspaceFolder || !workspaceItem) return '';
    if (normalizePath(workspaceItem.workspaceDir) === normalizePath(workspaceFolder)) {
      return t('workspace.workspace');
    }
    const folderItem = (workspaceItem.folders || []).find(
      (item) => normalizePath(item.resolvedPath) === normalizePath(workspaceFolder)
    );
    return folderItem ? folderItem.name : workspaceFolder.replace(/.*[/\\]/, '') || '—';
  }

  function updateWorkspaceTriggerLabel(workspaceFile, workspaceFolder) {
    const trigger = document.getElementById('header-workspace-trigger');
    const labelEl = document.getElementById('header-workspace-label');
    if (!trigger || !labelEl) return;

    const changed = normalizePath(trigger.dataset.workspaceFile) !== normalizePath(workspaceFile)
      || normalizePath(trigger.dataset.workspaceFolder) !== normalizePath(workspaceFolder);
    trigger.dataset.workspaceFile = workspaceFile || '';
    trigger.dataset.workspaceFolder = workspaceFolder || '';

    const sidebarKey = findSidebarKeyByWorkspaceContext(workspaceFile, workspaceFolder);
    const workspaceItem = findWorkspaceItem(workspaceFile);
    const entry = getWorkspaceSidebarEntry(sidebarKey);
    const hasCustomLabel = typeof entry?.label === 'string' && entry.label.trim();
    const workspaceName = resolveSidebarDisplayName(sidebarKey, workspaceItem, entry);
    const folderName = resolveFolderName(workspaceFile, workspaceFolder);
    if (hasCustomLabel) {
      labelEl.textContent = entry.label.trim();
    } else {
      labelEl.textContent = folderName ? `${workspaceName} • ${folderName}` : workspaceName || '—';
    }
    onWorkspaceLabelChanged();
    if (changed) {
      headerRevision += 1;
      window.dispatchEvent(new CustomEvent('cretli-active-workspace-changed', {
        detail: { workspaceFile: workspaceFile || '', workspaceFolder: workspaceFolder || '' },
      }));
    }
  }

  /**
   * Picks the folder for a newly selected workspace: keeps the current one when it
   * also exists in the new workspace, otherwise falls back to the workspace parent
   * directory (workspaceDir).
   */
  function pickFolderForWorkspace(workspaceItem, currentFolder) {
    if (!workspaceItem) return '';
    const dir = workspaceItem.workspaceDir || '';
    if (currentFolder) {
      const currentNorm = normalizePath(currentFolder);
      if (currentNorm && normalizePath(dir) === currentNorm) return dir;
      const folderItem = (workspaceItem.folders || []).find(
        (item) => item.enabled !== false && normalizePath(item.resolvedPath) === currentNorm
      );
      if (folderItem) return folderItem.resolvedPath;
    }
    return dir || (workspaceItem.folders || []).find((folder) => folder.enabled !== false)?.resolvedPath || '';
  }

  function refreshUiAfterWorkspaceChange(workspaceFile, workspaceFolder) {
    updateWorkspaceTriggerLabel(workspaceFile, workspaceFolder);
    // Async span: initWorkspaceHeader resolves after the fetch and header paint.
    const headerProbe = probeStart('shell.initWorkspaceHeader');
    void initWorkspaceHeader().finally(() => probeEnd(headerProbe));
    refreshTasksList();
    refreshChatListForWorkspace();

    const filesPanel = document.getElementById('files-panel');
    if (filesPanel?.classList.contains('active')) {
      ensureFilesPanelInitialized();
      refreshFilesPanel();
    }

    const gitPanel = document.getElementById('git-panel');
    if (gitPanel?.classList.contains('active')) {
      refreshGitInfo();
    }

    updateGithubTabVisibility().then(() => {
      const githubPanel = document.getElementById('github-panel');
      if (githubPanel?.classList.contains('active')) {
        refreshGithubPanel();
      }
    });

    const todoPanel = document.getElementById('todo-panel');
    if (todoPanel?.classList.contains('active')) {
      refreshTodoList();
    }

    // The Browser channel is scoped to the workspace on the server, so a panel
    // that is currently visible must rebuild its session list and live socket.
    const browserPanel = document.getElementById('browser-panel');
    if (browserPanel?.classList.contains('active')) {
      refreshBrowserPanel();
    }
  }

  function resolveFolderForWorkspaceSelection(sidebarKey, preferredFolder = '') {
    const workspaceFile = getWorkspaceFileFromSidebarKey(sidebarKey);
    const preferred = (preferredFolder || '').trim() || getWorkspaceSidebarFolder(sidebarKey);
    // A chat's folder (or the configured sidebar folder) is authoritative even
    // when the catalog is incomplete. Never replace it with the workspace-file
    // parent directory, which is often shared by several unrelated projects.
    if (preferred) return preferred;
    const workspaceItem = findWorkspaceItem(workspaceFile);
    const pickedFolder = pickFolderForWorkspace(workspaceItem, preferred);
    if (pickedFolder) return pickedFolder;
    if (preferred) return preferred;
    return getWorkspaceDirFromFile(workspaceFile);
  }

  /**
   * @param {string} workspaceFile
   * @param {string} workspaceFolder
   * @param {{ persistGlobal?: boolean }} [options] persistGlobal is reserved
   *   for the explicit "global default workspace" control; ordinary view
   *   switches never write settings.
   */
  function switchWorkspace(workspaceFile, workspaceFolder, options = {}) {
    const normalizedWorkspaceFile = (workspaceFile || '').trim();
    if (!normalizedWorkspaceFile) return Promise.resolve(false);
    // An operator-driven switch retires the deep-link target: the old URL
    // must not keep reporting ownership conflicts afterwards.
    viewContextStore.clearRouteTarget();

    const preferredFolder = (workspaceFolder || '').trim();
    const immediateFolder = resolveFolderForWorkspaceSelection(normalizedWorkspaceFile, preferredFolder);
    if (immediateFolder) {
      return applyAndRefresh(normalizedWorkspaceFile, immediateFolder, options);
    }

    return ensureWorkspacesListLoaded().then(() => {
      const loadedFolder = resolveFolderForWorkspaceSelection(normalizedWorkspaceFile, preferredFolder);
      return applyAndRefresh(normalizedWorkspaceFile, loadedFolder, options);
    });
  }

  /**
   * Normal view switch: this tab's context changes, panels refetch with the
   * explicit scope, nothing is written to the shared settings (a second tab
   * keeps its own workspace and URL).
   *
   * @param {string} workspaceFile
   * @param {string} workspaceFolder
   * @returns {boolean}
   */
  function applyLocalWorkspace(workspaceFile, workspaceFolder, options = {}) {
    const normalizedWorkspaceFile = (workspaceFile || '').trim();
    if (!normalizedWorkspaceFile) return false;
    const normalizedWorkspaceFolder = (workspaceFolder || '').trim();
    selectionRevision += 1;
    const applyRevision = selectionRevision;
    const paintHeader = () => {
      updateWorkspaceTriggerLabel(normalizedWorkspaceFile, normalizedWorkspaceFolder);
      setWorkspaceContextMessage(null);
      refreshUiAfterWorkspaceChange(normalizedWorkspaceFile, normalizedWorkspaceFolder);
    };
    if (options.fromViewContext !== true) {
      const runtime = { workspaceFile: normalizedWorkspaceFile, workspaceFolder: normalizedWorkspaceFolder };
      // Stamp the store before panels refetch: Todo (and other scoped panels)
      // read the runtime paths from it, so painting first would reload the
      // previous workspace and nothing would refresh once the keys resolve.
      const cachedKeys = findContextKeysInList(workspacesList, runtime);
      viewContextStore.applyUserWorkspaceSelection(runtime, cachedKeys);
      paintHeader();
      const finish = (keys) => {
        if (applyRevision !== selectionRevision) return false;
        if (!sameContextKeys(keys, cachedKeys)) viewContextStore.applyUserWorkspaceSelection(runtime, keys);
        syncOperatorSwitchToLocation(keys);
        return true;
      };
      return resolveContextKeysForRuntime(runtime).then(finish).catch(() => finish(cachedKeys));
    }
    paintHeader();
    return true;
  }

  function sameContextKeys(a, b) {
    return (a?.workspaceKey || '') === (b?.workspaceKey || '')
      && (a?.folderKey || '') === (b?.folderKey || '');
  }

  function applyAndRefresh(workspaceFile, workspaceFolder, options = {}) {
    if (options.persistGlobal !== true) {
      return Promise.resolve(applyLocalWorkspace(workspaceFile, workspaceFolder)).then((value) => value);
    }
    const normalizedWorkspaceFile = (workspaceFile || '').trim();
    const normalizedWorkspaceFolder = (workspaceFolder || '').trim();
    const revision = ++selectionRevision;
    const trigger = document.getElementById('header-workspace-trigger');
    const previousFile = trigger?.dataset?.workspaceFile || '';
    const previousFolder = trigger?.dataset?.workspaceFolder || '';
    // Scope panels immediately, before the operator can open Todo while the
    // settings write is still pending. Serialize writes so the server cannot
    // end up on an older selection when requests finish out of order.
    updateWorkspaceTriggerLabel(normalizedWorkspaceFile, normalizedWorkspaceFolder);
    const appliedHeaderRevision = headerRevision;
    const restoreOnFailure = () => {
      if (revision === selectionRevision && appliedHeaderRevision === headerRevision) {
        updateWorkspaceTriggerLabel(previousFile, previousFolder);
      }
      return false;
    };
    const write = workspaceWriteQueue.catch(() => {}).then(() => {
      if (revision !== selectionRevision) return false;
      return api.patchSettings({
        workspaceFile: normalizedWorkspaceFile,
        workspaceFolder: normalizedWorkspaceFolder,
      });
    });
    workspaceWriteQueue = write;
    return write
      .then((result) => {
        if (result === false || revision !== selectionRevision) return false;
        if (result?.ok === false) return restoreOnFailure();
        const runtime = { workspaceFile: normalizedWorkspaceFile, workspaceFolder: normalizedWorkspaceFolder };
        viewContextStore.applyUserWorkspaceSelection(runtime, findContextKeysInList(workspacesList, runtime));
        refreshUiAfterWorkspaceChange(normalizedWorkspaceFile, normalizedWorkspaceFolder);
        return true;
      })
      .catch(restoreOnFailure);
  }

  function renderWorkspacePopoverItems(activeWorkspaceFile) {
    const itemsEl = document.getElementById('header-workspace-items');
    if (!itemsEl) return;
    itemsEl.innerHTML = '';

    const expanded = buildExpandedWorkspacesList();
    if (!expanded.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-list-item chat-list-item-header';
      empty.textContent = t('workspace.none');
      itemsEl.appendChild(empty);
      return;
    }

    const activeNorm = normalizePath(activeWorkspaceFile);
    expanded.forEach((workspaceItem) => {
      const li = document.createElement('li');
      li.className = 'chat-list-item';
      const itemKey = resolveWorkspaceItemKey(workspaceItem);
      const isActive = activeNorm && itemKey === activeNorm;
      if (isActive) li.classList.add('is-active');
      li.setAttribute('role', 'option');
      li.setAttribute('tabindex', '-1');
      li.dataset.workspaceFile = workspaceItem.workspaceFile || workspaceItem.id || '';

      const title = document.createElement('span');
      title.className = 'chat-list-item-title';
      title.textContent = workspaceItem.name || workspaceItem.workspaceFile || '(workspace)';
      li.appendChild(title);

      const hint = document.createElement('span');
      hint.className = 'header-workspace-popover-count';
      const enabledCount = (workspaceItem.folders || []).filter((folder) => folder.enabled !== false).length;
      hint.textContent = enabledCount
        ? t(enabledCount === 1 ? 'workspace.folderCountOne' : 'workspace.folderCountMany', { count: enabledCount })
        : '';
      li.appendChild(hint);

      li.addEventListener('click', () => {
        const folder = resolveFolderForWorkspaceSelection(workspaceItem.sidebarKey || itemKey);
        void switchWorkspace(workspaceItem.workspaceFile || workspaceItem.id || '', folder);
        workspacePopoverApi?.close?.();
      });

      itemsEl.appendChild(li);
    });
  }

  let workspacePopoverApi = null;

  /**
   * Load the workspace list + settings and render the popover items, without
   * opening the dropdown. Shared by the legacy (hidden) trigger and the
   * visible branch chip in the header.
   *
   * @returns {Promise<boolean>} whether the content was rendered
   */
  function refreshWorkspaceQuickMenuContent() {
    return Promise.all([ensureWorkspacesListLoaded(), api.getSettings()])
      .then(([, settingsData]) => {
        const workspaceFile = settingsData?.ok ? settingsData.workspaceFile || '' : '';
        renderWorkspacePopoverItems(workspaceFile);
        return true;
      })
      .catch(() => false);
  }

  function initWorkspacePopover() {
    const trigger = document.getElementById('header-workspace-trigger');
    const popover = document.getElementById('header-workspace-popover');
    if (!trigger || !popover) return Promise.resolve();

    workspacePopoverApi = initDropdown({
      triggerEl: trigger,
      floatingEl: popover,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 220,
      maxHeightPx: 360,
    });

    trigger.addEventListener('click', () => {
      if (workspacePopoverApi?.isOpen()) {
        workspacePopoverApi.close();
        return;
      }
      refreshWorkspaceQuickMenuContent().then((ok) => {
        if (ok) workspacePopoverApi?.open();
      });
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      trigger.click();
    });

    window.addEventListener('cretli-request-workspace', (event) => {
      const workspaceFile = String(event?.detail?.workspaceFile || '').trim();
      const workspaceFolder = String(event?.detail?.workspaceFolder || '').trim();
      if (!workspaceFile) return;
      void switchWorkspace(workspaceFile, workspaceFolder);
    });

    window.addEventListener('cretli-workspace-updated', (event) => {
      // The Files root picker explicitly selects a folder; other occurrences
      // of this event only announce workspace catalog/configuration changes.
      if (typeof event?.detail?.workspaceFolder === 'string') {
        updateWorkspaceTriggerLabel(event.detail.workspaceFile || trigger.dataset.workspaceFile || '',
          event.detail.workspaceFolder);
      }
      const revision = headerRevision;
      api
        .getSettings()
        .then((data) => {
          if (!data?.ok) return;
          setWorkspaceSidebarConfig(data.workspaceSidebarConfig);
          if (revision !== headerRevision) return;
          // Settings are shared across clients; a background reload of sidebar
          // configuration must not change this client's selected workspace.
          if (!trigger.dataset.workspaceFile
            && hasExplicitWorkspace(viewContextStore.getState().context)) {
            // A deep-linked context is still resolving; the global default in
            // settings must not pre-empt it.
            return;
          }
          refreshUiAfterWorkspaceChange(trigger.dataset.workspaceFile || data.workspaceFile || '',
            trigger.dataset.workspaceFolder || data.workspaceFolder || '');
        })
        .catch(() => {});
    });

    const bootRevision = headerRevision;
    // Boot deep link: resolve the route context before the settings default
    // can stamp this tab's scope. An explicit `ws`/`folder` in the URL wins
    // and is applied locally; a link without context falls back to the
    // (separate) global default below. Neither path writes settings.
    void viewContextStore.applyRouteContext();
    return api
      .getSettings()
      .then((settingsData) => {
        const workspaceFile = settingsData.ok ? settingsData.workspaceFile || '' : '';
        const workspaceFolder = settingsData.ok ? settingsData.workspaceFolder || '' : '';
        setWorkspaceSidebarConfig(settingsData?.workspaceSidebarConfig);
        if (bootRevision !== headerRevision) return;
        if (hasExplicitWorkspace(viewContextStore.getState().context)) {
          // The route owns this tab's context; settings is only the fallback
          // for OTHER consumers. Do not repaint the explicit scope with it.
          return;
        }
        const bootCached = typeof localStorage !== 'undefined'
          ? readChatLocalBootCacheForColdStart(localStorage)
          : null;
        const bootContext = bootCached?.workspaceContext;
        const bootDiffersFromSettings = bootContext && (
          normalizePath(bootContext.workspaceFile) !== normalizePath(workspaceFile)
          || normalizePath(bootContext.workspaceFolder) !== normalizePath(workspaceFolder)
        );
        updateWorkspaceTriggerLabel(workspaceFile, workspaceFolder);
        viewContextStore.markDefaultReady({ workspaceFile, workspaceFolder });
        if (bootDiffersFromSettings) refreshChatListForWorkspace();
      })
      .catch(() => {});
  }

  const {
    initSettingsWorkspacePicker,
    refreshSettingsWorkspacePicker,
  } = createWorkspaceSettings({
    api,
    getWorkspacesList: () => workspacesList,
    setWorkspaceSidebarConfig,
    getWorkspaceSidebarEntry,
    getCloneSidebarKeysForWorkspace,
    getWorkspaceDefaultDisplayName,
    resolveFolderForWorkspaceSelection,
    findWorkspaceItem,
    ensureWorkspacesListLoaded,
    renderWorkspacePopoverItems,
    updateWorkspaceTriggerLabel,
  });

  return {
    applyEmbedWorkspaceContext,
    applyLocalWorkspace,
    initWorkspaceHeader,
    initWorkspacePopover,
    refreshWorkspaceQuickMenuContent,
    initSettingsWorkspacePicker,
    refreshSettingsWorkspacePicker,
    switchWorkspace,
    getSidebarWorkspaceFolder: (sidebarKey) => resolveFolderForWorkspaceSelection(sidebarKey, ''),
    getWorkspacesList: () => buildExpandedWorkspacesList(),
    ensureWorkspacesListLoaded,
    seedWorkspacesList,
    getViewContextState: () => viewContextStore.getState(),
    applyRouteContext: () => viewContextStore.applyRouteContext(),
    whenViewContextReady: () => viewContextStore.whenReady(),
    setWorkspaceSidebarConfig,
  };
}
