import { getEmbedWorkspaceOverride } from './embedMode.js';
import { initDropdown } from '../../lib/dropdown.js';
import { t } from '../../i18n/index.js';

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
  let settingsWorkspaceDraftConfig = {};
  let settingsWorkspaceCardsRenderer = null;

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

  function ensureWorkspacesListLoaded() {
    if (Array.isArray(workspacesList) && workspacesList.length > 0) {
      return Promise.resolve(workspacesList);
    }
    if (workspacesListFetchPromise) return workspacesListFetchPromise;

    workspacesListFetchPromise = api
      .getWorkspaces()
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

  const CLONE_KEY_SEPARATOR = '#clone-';

  function normalizePath(pathValue) {
    if (!pathValue || typeof pathValue !== 'string') return '';
    return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
  }

  function isSidebarCloneKey(sidebarKey) {
    if (!sidebarKey || typeof sidebarKey !== 'string') return false;
    return sidebarKey.includes(CLONE_KEY_SEPARATOR);
  }

  function getWorkspaceFileFromSidebarKey(sidebarKey) {
    const key = normalizePath(sidebarKey);
    if (!key) return '';
    if (!isSidebarCloneKey(key)) return key;
    return normalizePath(key.split(CLONE_KEY_SEPARATOR)[0]);
  }

  function createCloneSidebarKey(workspaceFile) {
    const base = normalizePath(workspaceFile);
    if (!base) return '';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return `${base}${CLONE_KEY_SEPARATOR}${id}`;
  }

  function normalizeWorkspaceSidebarConfig(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const next = {};
    Object.entries(raw).forEach(([sidebarKey, value]) => {
      const key = normalizePath(sidebarKey);
      if (!key) return;
      const entry = value && typeof value === 'object' ? value : {};
      const workspaceFile = typeof entry.workspaceFile === 'string' && entry.workspaceFile.trim()
        ? normalizePath(entry.workspaceFile)
        : getWorkspaceFileFromSidebarKey(key);
      next[key] = {
        enabled: entry.enabled === false ? false : true,
        folder: typeof entry.folder === 'string' ? entry.folder.trim() : '',
        workspaceFile,
        label: typeof entry.label === 'string' ? entry.label.trim() : '',
      };
    });
    return next;
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
      const sidebarKey = normalizePath(workspaceItem.workspaceFile || '');
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
    return workspacesList.find(
      (item) => normalizePath(item.workspaceFile) === normalizePath(workspaceFile)
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
        (item) => normalizePath(item.resolvedPath) === currentNorm
      );
      if (folderItem) return folderItem.resolvedPath;
    }
    return dir || (workspaceItem.folders?.[0]?.resolvedPath ?? '');
  }

  function getWorkspaceDirFromFile(workspaceFile) {
    const normalized = normalizePath(workspaceFile);
    if (!normalized) return '';
    const slashIdx = normalized.lastIndexOf('/');
    if (slashIdx <= 0) return '';
    return normalized.slice(0, slashIdx);
  }

  function fillFolderSelect(folderSelect, workspaceItem, preferredFolder) {
    if (!folderSelect) return;
    folderSelect.innerHTML = '';
    if (!workspaceItem) return;

    if (workspaceItem.workspaceDir) {
      const option = document.createElement('option');
      option.value = workspaceItem.workspaceDir;
      option.textContent = t('workspace.parent');
      folderSelect.appendChild(option);
    }

    (workspaceItem.folders || []).forEach((folderItem) => {
      if (folderItem.resolvedPath && normalizePath(folderItem.resolvedPath) !== normalizePath(workspaceItem.workspaceDir)) {
        const option = document.createElement('option');
        option.value = folderItem.resolvedPath;
        option.textContent = folderItem.name;
        folderSelect.appendChild(option);
      }
    });

    const preferred = preferredFolder || workspaceItem.workspaceDir || (workspaceItem.folders?.[0]?.resolvedPath ?? '');
    const matchedOption = Array.from(folderSelect.options).find(
      (option) => normalizePath(option.value) === normalizePath(preferred)
    );
    if (matchedOption) {
      folderSelect.value = matchedOption.value;
      return;
    }
    if (folderSelect.options.length) folderSelect.value = folderSelect.options[0].value;
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

    if (!workspacesList.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-list-item chat-list-item-header';
      empty.textContent = t('workspace.none');
      itemsEl.appendChild(empty);
      return;
    }

    const activeNorm = normalizePath(activeWorkspaceFile);
    workspacesList.forEach((workspaceItem) => {
      const li = document.createElement('li');
      li.className = 'chat-list-item';
      const isActive = activeNorm && normalizePath(workspaceItem.workspaceFile) === activeNorm;
      if (isActive) li.classList.add('is-active');
      li.setAttribute('role', 'option');
      li.setAttribute('tabindex', '-1');
      li.dataset.workspaceFile = workspaceItem.workspaceFile || '';

      const title = document.createElement('span');
      title.className = 'chat-list-item-title';
      title.textContent = workspaceItem.name || workspaceItem.workspaceFile || '(workspace)';
      li.appendChild(title);

      const hint = document.createElement('span');
      hint.className = 'header-workspace-popover-count';
      const count = (workspaceItem.folders || []).length;
      hint.textContent = count
        ? t(count === 1 ? 'workspace.folderCountOne' : 'workspace.folderCountMany', { count })
        : '';
      li.appendChild(hint);

      li.addEventListener('click', () => {
        const folder = resolveFolderForWorkspaceSelection(workspaceItem.workspaceFile || '');
        applyAndRefresh(workspaceItem.workspaceFile || '', folder);
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

  function createWorkspaceCard(workspaceItem, entry, draftConfig, cardsWrap, cardOptions = {}) {
    const workspaceFile = workspaceItem.workspaceFile || '';
    const sidebarKey = normalizePath(cardOptions.sidebarKey || workspaceFile);
    if (!sidebarKey) return;
    const isClone = cardOptions.isClone === true || isSidebarCloneKey(sidebarKey);

    const card = document.createElement('article');
    card.className = 'settings-workspace-card';
    if (isClone) card.classList.add('is-clone');
    card.dataset.workspaceFile = workspaceFile;
    card.dataset.sidebarKey = sidebarKey;

    const headerRow = document.createElement('div');
    headerRow.className = 'settings-workspace-card-header';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'settings-workspace-card-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.enabled !== false;
    const toggleText = document.createElement('span');
    toggleText.textContent = t('workspace.cardEnabled');
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(toggleText);
    headerRow.appendChild(toggleLabel);

    const actions = document.createElement('div');
    actions.className = 'settings-workspace-card-actions';

    if (!isClone) {
      const cloneBtn = document.createElement('button');
      cloneBtn.type = 'button';
      cloneBtn.className = 'settings-workspace-card-action-btn';
      cloneBtn.title = t('workspace.cloneTitle');
      cloneBtn.setAttribute('aria-label', cloneBtn.title);
      cloneBtn.innerHTML = '<span class="mdi mdi-content-copy" aria-hidden="true"></span>';
      cloneBtn.addEventListener('click', () => {
        const newKey = createCloneSidebarKey(workspaceFile);
        if (!newKey) return;
        const sourceEntry = draftConfig[sidebarKey] || entry;
        draftConfig[newKey] = {
          enabled: sourceEntry.enabled !== false,
          folder: sourceEntry.folder || '',
          workspaceFile: normalizePath(workspaceFile),
          label: '',
        };
        createWorkspaceCard(
          workspaceItem,
          draftConfig[newKey],
          draftConfig,
          cardsWrap,
          { sidebarKey: newKey, isClone: true, insertAfter: card }
        );
      });
      actions.appendChild(cloneBtn);
    } else {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'settings-workspace-card-action-btn settings-workspace-card-action-btn--danger';
      deleteBtn.title = t('workspace.deleteCloneTitle');
      deleteBtn.setAttribute('aria-label', deleteBtn.title);
      deleteBtn.innerHTML = '<span class="mdi mdi-delete-outline" aria-hidden="true"></span>';
      deleteBtn.addEventListener('click', () => {
        delete draftConfig[sidebarKey];
        card.remove();
      });
      actions.appendChild(deleteBtn);
    }

    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const pathHint = document.createElement('div');
    pathHint.className = 'settings-workspace-card-path';
    pathHint.textContent = isClone
      ? t('workspace.clonePathPrefix', { path: workspaceFile })
      : workspaceFile;
    card.appendChild(pathHint);

    const nameLabel = document.createElement('label');
    nameLabel.className = 'settings-workspace-card-folder-label';
    nameLabel.textContent = t('workspace.sidebarNameLabel');
    const nameInputId = `settings-workspace-name-${sidebarKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    nameLabel.htmlFor = nameInputId;
    card.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = nameInputId;
    nameInput.className = 'chat-settings-input settings-workspace-card-name';
    nameInput.value = entry.label || '';
    nameInput.placeholder = getWorkspaceDefaultDisplayName(workspaceItem, entry, isClone);
    nameInput.disabled = entry.enabled === false;
    card.appendChild(nameInput);

    const folderLabel = document.createElement('label');
    folderLabel.className = 'settings-workspace-card-folder-label';
    folderLabel.textContent = t('workspace.defaultFolderLabel');
    card.appendChild(folderLabel);

    const folderSelect = document.createElement('select');
    folderSelect.className = 'chat-settings-select settings-workspace-card-folder';
    fillFolderSelect(folderSelect, workspaceItem, entry.folder || '');
    if (folderSelect.options.length === 0) {
      const option = document.createElement('option');
      option.value = getWorkspaceDirFromFile(workspaceFile);
      option.textContent = option.value || t('workspace.noFolders');
      folderSelect.appendChild(option);
    }
    if (!draftConfig[sidebarKey]) {
      draftConfig[sidebarKey] = {
        enabled: entry.enabled !== false,
        folder: entry.folder || '',
        workspaceFile: normalizePath(workspaceFile),
        label: entry.label || '',
      };
    }
    if (!draftConfig[sidebarKey].folder && folderSelect.value) {
      draftConfig[sidebarKey].folder = folderSelect.value;
    }
    folderSelect.disabled = entry.enabled === false;
    card.classList.toggle('is-disabled', entry.enabled === false);
    card.appendChild(folderSelect);

    toggle.addEventListener('change', () => {
      draftConfig[sidebarKey].enabled = !!toggle.checked;
      folderSelect.disabled = !toggle.checked;
      nameInput.disabled = !toggle.checked;
      card.classList.toggle('is-disabled', !toggle.checked);
    });

    nameInput.addEventListener('input', () => {
      draftConfig[sidebarKey].label = (nameInput.value || '').trim();
    });
    nameInput.addEventListener('change', () => {
      draftConfig[sidebarKey].label = (nameInput.value || '').trim();
    });

    folderSelect.addEventListener('change', () => {
      draftConfig[sidebarKey].folder = (folderSelect.value || '').trim();
      if (!draftConfig[sidebarKey].label) {
        nameInput.placeholder = getWorkspaceDefaultDisplayName(
          workspaceItem,
          draftConfig[sidebarKey],
          isClone
        );
      }
    });

    const insertAfter = cardOptions.insertAfter;
    if (insertAfter?.parentNode === cardsWrap) {
      insertAfter.insertAdjacentElement('afterend', card);
      return;
    }
    cardsWrap.appendChild(card);
  }

  function syncWorkspaceDraftFromCards(cardsWrap) {
    if (!cardsWrap) return;
    cardsWrap.querySelectorAll('.settings-workspace-card').forEach((card) => {
      const sidebarKey = normalizePath(card.dataset.sidebarKey || card.dataset.workspaceFile || '');
      if (!sidebarKey || !settingsWorkspaceDraftConfig[sidebarKey]) return;

      const nameInput = card.querySelector('.settings-workspace-card-name');
      if (nameInput instanceof HTMLInputElement) {
        settingsWorkspaceDraftConfig[sidebarKey].label = (nameInput.value || '').trim();
      }

      const folderSelect = card.querySelector('.settings-workspace-card-folder');
      if (folderSelect instanceof HTMLSelectElement) {
        settingsWorkspaceDraftConfig[sidebarKey].folder = (folderSelect.value || '').trim();
      }

      const toggle = card.querySelector('.settings-workspace-card-toggle input[type="checkbox"]');
      if (toggle instanceof HTMLInputElement) {
        settingsWorkspaceDraftConfig[sidebarKey].enabled = toggle.checked;
      }
    });
  }

  function buildWorkspaceSidebarConfigPayload(draftConfig) {
    const payload = {};
    Object.entries(draftConfig).forEach(([sidebarKey, entry]) => {
      const key = normalizePath(sidebarKey);
      if (!key) return;
      const enabled = entry.enabled !== false;
      const folder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const isClone = isSidebarCloneKey(key);
      if (!isClone && enabled && !folder && !label) return;

      payload[key] = {};
      if (!enabled) payload[key].enabled = false;
      if (folder) payload[key].folder = folder;
      if (label) payload[key].label = label;
      if (isClone) {
        payload[key].workspaceFile = normalizePath(
          entry.workspaceFile || getWorkspaceFileFromSidebarKey(key)
        );
      }
    });
    return payload;
  }

  function initSettingsWorkspacePicker() {
    const cardsWrap = document.getElementById('settings-workspace-cards');
    const applyBtn = document.getElementById('settings-workspace-apply');
    const statusEl = document.getElementById('settings-workspace-status');
    if (!cardsWrap || !applyBtn) return;

    function renderCardsFromSettings(settingsData) {
      setWorkspaceSidebarConfig(settingsData?.workspaceSidebarConfig);
      cardsWrap.innerHTML = '';
      settingsWorkspaceDraftConfig = {};
      workspacesList.forEach((workspaceItem) => {
        const sidebarKey = normalizePath(workspaceItem.workspaceFile || '');
        if (!sidebarKey) return;
        const savedEntry = getWorkspaceSidebarEntry(sidebarKey);
        const preferredFolder = resolveFolderForWorkspaceSelection(
          sidebarKey,
          savedEntry?.folder || ''
        );
        settingsWorkspaceDraftConfig[sidebarKey] = {
          enabled: savedEntry?.enabled !== false,
          folder: preferredFolder || '',
          workspaceFile: normalizePath(workspaceItem.workspaceFile || ''),
          label: savedEntry?.label || '',
        };
        createWorkspaceCard(
          workspaceItem,
          settingsWorkspaceDraftConfig[sidebarKey],
          settingsWorkspaceDraftConfig,
          cardsWrap,
          { sidebarKey }
        );

        getCloneSidebarKeysForWorkspace(sidebarKey).forEach((cloneKey) => {
          const cloneEntry = getWorkspaceSidebarEntry(cloneKey);
          const cloneFolder = resolveFolderForWorkspaceSelection(
            cloneKey,
            cloneEntry?.folder || ''
          );
          settingsWorkspaceDraftConfig[cloneKey] = {
            enabled: cloneEntry?.enabled !== false,
            folder: cloneFolder || '',
            workspaceFile: normalizePath(workspaceItem.workspaceFile || ''),
            label: cloneEntry?.label || '',
          };
          createWorkspaceCard(
            workspaceItem,
            settingsWorkspaceDraftConfig[cloneKey],
            settingsWorkspaceDraftConfig,
            cardsWrap,
            { sidebarKey: cloneKey, isClone: true }
          );
        });
      });
      if (!cardsWrap.childElementCount) {
        const empty = document.createElement('div');
        empty.className = 'settings-hint';
        empty.textContent = t('workspace.emptyHint');
        cardsWrap.appendChild(empty);
      }
    }
    settingsWorkspaceCardsRenderer = renderCardsFromSettings;

    applyBtn.addEventListener('click', () => {
      if (applyBtn.disabled) return;
      syncWorkspaceDraftFromCards(cardsWrap);
      applyBtn.disabled = true;
      if (statusEl) {
        statusEl.textContent = t('common.saving');
        statusEl.classList.remove('lan-save-status--error');
      }
      api
        .patchSettings({
          workspaceSidebarConfig: buildWorkspaceSidebarConfigPayload(settingsWorkspaceDraftConfig),
        })
        .then((ok) => {
          if (ok?.ok) {
            setWorkspaceSidebarConfig(ok.workspaceSidebarConfig);
            if (typeof settingsWorkspaceCardsRenderer === 'function') {
              settingsWorkspaceCardsRenderer(ok);
            }
            const activeFile =
              document.getElementById('header-workspace-trigger')?.dataset.workspaceFile || '';
            const activeFolder =
              document.getElementById('header-workspace-trigger')?.dataset.workspaceFolder || '';
            renderWorkspacePopoverItems(activeFile);
            updateWorkspaceTriggerLabel(activeFile, activeFolder);
            window.dispatchEvent(new CustomEvent('cretli-workspace-updated'));
          }
          if (statusEl) {
            statusEl.textContent = ok?.ok ? t('workspace.saved') : t('workspace.saveError');
            statusEl.classList.toggle('lan-save-status--error', !ok?.ok);
          }
        })
        .catch(() => {
          if (statusEl) {
            statusEl.textContent = t('workspace.saveError');
            statusEl.classList.add('lan-save-status--error');
          }
        })
        .finally(() => {
          applyBtn.disabled = false;
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 2000);
        });
    });

    return ensureWorkspacesListLoaded().then(() =>
      api
        .getSettings()
        .then((settingsData) => {
          if (!settingsData?.ok) return;
          renderCardsFromSettings(settingsData);
        })
        .catch(() => {})
    );
  }

  function refreshSettingsWorkspacePicker() {
    if (!workspacesList.length) return;
    api
      .getSettings()
      .then((settingsData) => {
        if (!settingsData?.ok) return;
        if (typeof settingsWorkspaceCardsRenderer === 'function') {
          settingsWorkspaceCardsRenderer(settingsData);
        }
      })
      .catch(() => {});
  }

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
