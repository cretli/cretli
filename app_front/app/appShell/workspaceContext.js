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

export function createWorkspaceContext(deps = {}) {
  const {
    api,
    refreshTasksList = () => {},
    refreshAgentsList = () => {},
    refreshChatListForWorkspace = () => {},
    ensureFilesPanelInitialized = () => {},
    refreshFilesPanel = () => {},
    refreshGitInfo = () => {},
    updateGithubTabVisibility = () => Promise.resolve(),
    refreshGithubPanel = () => {},
    refreshTodoList = () => {},
    onWorkspaceLabelChanged = () => {},
  } = deps;

  let workspacesList = [];
  let workspacesListFetchPromise = null;
  let workspaceSidebarConfig = {};

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
            ? t('workspace.dir', { dir: data.workspaceDir })
            : data.error || data.cwd || t('workspace.loadError');
        }
        if (foldersEl) {
          foldersEl.textContent = data.ok && data.folders?.length
            ? t('workspace.folders', { folders: data.folders.map((f) => f.name).join(', ') })
            : '';
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
        workspacesList = [];
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
    initWorkspaceHeader();
    refreshTasksList();
    refreshAgentsList();
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
  }

  function resolveFolderForWorkspaceSelection(sidebarKey, preferredFolder = '') {
    const workspaceFile = getWorkspaceFileFromSidebarKey(sidebarKey);
    const preferred = (preferredFolder || '').trim() || getWorkspaceSidebarFolder(sidebarKey);
    const workspaceItem = findWorkspaceItem(workspaceFile);
    const pickedFolder = pickFolderForWorkspace(workspaceItem, preferred);
    if (pickedFolder) return pickedFolder;
    if (preferred) return preferred;
    return getWorkspaceDirFromFile(workspaceFile);
  }

  function switchWorkspace(workspaceFile, workspaceFolder) {
    const normalizedWorkspaceFile = (workspaceFile || '').trim();
    if (!normalizedWorkspaceFile) return Promise.resolve(false);

    const preferredFolder = (workspaceFolder || '').trim();
    const immediateFolder = resolveFolderForWorkspaceSelection(normalizedWorkspaceFile, preferredFolder);
    if (immediateFolder) {
      return applyAndRefresh(normalizedWorkspaceFile, immediateFolder);
    }

    return ensureWorkspacesListLoaded().then(() => {
      const loadedFolder = resolveFolderForWorkspaceSelection(normalizedWorkspaceFile, preferredFolder);
      return applyAndRefresh(normalizedWorkspaceFile, loadedFolder);
    });
  }

  function applyAndRefresh(workspaceFile, workspaceFolder) {
    const normalizedWorkspaceFile = (workspaceFile || '').trim();
    const normalizedWorkspaceFolder = (workspaceFolder || '').trim();
    return api
      .patchSettings({
        workspaceFile: normalizedWorkspaceFile,
        workspaceFolder: normalizedWorkspaceFolder,
      })
      .then(() => {
        refreshUiAfterWorkspaceChange(normalizedWorkspaceFile, normalizedWorkspaceFolder);
        return true;
      })
      .catch(() => false);
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
        applyAndRefresh(workspaceItem.workspaceFile || workspaceItem.id || '', folder);
        workspacePopoverApi?.close?.();
      });

      itemsEl.appendChild(li);
    });
  }

  let workspacePopoverApi = null;

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
      Promise.all([ensureWorkspacesListLoaded(), api.getSettings()])
        .then(([, settingsData]) => {
          const workspaceFile = settingsData?.ok ? settingsData.workspaceFile || '' : '';
          renderWorkspacePopoverItems(workspaceFile);
          workspacePopoverApi?.open();
        })
        .catch(() => {});
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

    window.addEventListener('cretli-workspace-updated', () => {
      api
        .getSettings()
        .then((data) => {
          if (!data?.ok) return;
          setWorkspaceSidebarConfig(data.workspaceSidebarConfig);
          refreshUiAfterWorkspaceChange(data.workspaceFile || '', data.workspaceFolder || '');
        })
        .catch(() => {});
    });

    return api
      .getSettings()
      .then((settingsData) => {
        const workspaceFile = settingsData.ok ? settingsData.workspaceFile || '' : '';
        const workspaceFolder = settingsData.ok ? settingsData.workspaceFolder || '' : '';
        setWorkspaceSidebarConfig(settingsData?.workspaceSidebarConfig);
        updateWorkspaceTriggerLabel(workspaceFile, workspaceFolder);
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
    initWorkspaceHeader,
    initWorkspacePopover,
    initSettingsWorkspacePicker,
    refreshSettingsWorkspacePicker,
    switchWorkspace,
    getSidebarWorkspaceFolder: (sidebarKey) => resolveFolderForWorkspaceSelection(sidebarKey, ''),
    getWorkspacesList: () => buildExpandedWorkspacesList(),
    ensureWorkspacesListLoaded,
  };
}
