import { t } from '../../i18n/index.js';
import '../../components/ui/index.js';
import {
  CLONE_KEY_SEPARATOR,
  createCloneSidebarKey,
  fillFolderSelect,
  getWorkspaceDirFromFile,
  getWorkspaceFileFromSidebarKey,
  isSidebarCloneKey,
  normalizePath,
  overlayDiffersFromFile,
  resolveWorkspaceItemKey,
} from './workspaceHelpers.js';

/**
 * @param {Element | null} el
 * @returns {boolean}
 */
function isBarInput(el) {
  return el instanceof HTMLInputElement || el?.tagName === 'CR-BAR-INPUT';
}

/**
 * @param {Element | null} el
 * @returns {boolean}
 */
function isFolderSelectControl(el) {
  return el instanceof HTMLSelectElement || el?.tagName === 'CR-BAR-SELECT';
}

/**
 * @param {{ variant?: string, title: string, icon: string, onClick: () => void }} options
 * @returns {HTMLElement}
 */
function createIconButton(options) {
  const btn = document.createElement('cr-icon-button');
  if (options.variant) btn.setAttribute('variant', options.variant);
  btn.title = options.title;
  btn.setAttribute('aria-label', options.title);
  btn.innerHTML = `<span class="mdi ${options.icon}" aria-hidden="true"></span>`;
  btn.addEventListener('click', options.onClick);
  return btn;
}

/**
 * @param {Element | null} el
 * @returns {string}
 */
function readControlValue(el) {
  if (!el) return '';
  return String(el.value || '').trim();
}

/**
 * Settings → Workspace cards, registry add/remove, folder overlay and optional write-back.
 *
 * @param {object} deps
 */
export function createWorkspaceSettings(deps = {}) {
  const {
    api,
    getWorkspacesList,
    setWorkspaceSidebarConfig,
    getWorkspaceSidebarEntry,
    getCloneSidebarKeysForWorkspace,
    getWorkspaceDefaultDisplayName,
    resolveFolderForWorkspaceSelection,
    ensureWorkspacesListLoaded,
    renderWorkspacePopoverItems,
    updateWorkspaceTriggerLabel,
  } = deps;

  let settingsWorkspaceDraftConfig = {};
  let settingsWorkspaceCardsRenderer = null;
  const persistDraft = {
    save: () => Promise.resolve(),
  };

  function foldersFromWorkspaceItem(workspaceItem, savedEntry) {
    const fromOverlay = savedEntry?.folders && Object.keys(savedEntry.folders).length
      ? savedEntry.folders
      : {};
    const folders = { ...fromOverlay };
    (workspaceItem.folders || []).forEach((folderItem) => {
      const key = normalizePath(folderItem.resolvedPath);
      if (!key || folders[key]) return;
      folders[key] = {
        enabled: folderItem.enabled !== false,
        name: folderItem.name || '',
        source: folderItem.source === 'cursor' ? 'cursor' : 'cretli',
      };
    });
    return folders;
  }

  function renderFolderRows(listEl, sidebarKey, workspaceItem) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const folders = settingsWorkspaceDraftConfig[sidebarKey]?.folders || {};
    const paths = Object.keys(folders);
    if (!paths.length) {
      const empty = document.createElement('div');
      empty.className = 'settings-workspace-folder-empty';
      empty.textContent = t('workspace.noFolders');
      listEl.appendChild(empty);
      return;
    }
    paths.forEach((resolvedPath) => {
      const meta = folders[resolvedPath];
      const row = document.createElement('div');
      row.className = 'settings-workspace-folder-row';
      if (meta.enabled === false) row.classList.add('is-disabled');
      const live = (workspaceItem.folders || []).find(
        (folder) => normalizePath(folder.resolvedPath) === normalizePath(resolvedPath)
      );
      if (live && live.exists === false) row.classList.add('is-missing');

      const toggle = document.createElement('cr-checkbox');
      toggle.className = 'cr-check';
      toggle.checked = meta.enabled !== false;
      toggle.addEventListener('change', () => {
        settingsWorkspaceDraftConfig[sidebarKey].folders[resolvedPath].enabled = toggle.checked;
        row.classList.toggle('is-disabled', !toggle.checked);
        refreshDefaultFolderSelect(sidebarKey, workspaceItem);
        persistDraft.save();
      });

      const body = document.createElement('div');
      body.className = 'settings-workspace-folder-body';
      const name = document.createElement('div');
      name.className = 'settings-workspace-folder-name';
      name.textContent = meta.name || resolvedPath.split('/').pop() || resolvedPath;
      const pathHint = document.createElement('div');
      pathHint.className = 'settings-workspace-folder-path';
      pathHint.textContent = resolvedPath;
      const badges = document.createElement('div');
      badges.className = 'settings-workspace-folder-badges';
      const sourceBadge = document.createElement('span');
      sourceBadge.textContent = meta.source === 'cursor'
        ? t('workspace.folderSourceCursor')
        : t('workspace.folderSourceCretli');
      badges.appendChild(sourceBadge);
      if (live && live.exists === false) {
        const missing = document.createElement('span');
        missing.textContent = t('workspace.folderMissing');
        badges.appendChild(missing);
      }
      body.appendChild(name);
      body.appendChild(pathHint);
      body.appendChild(badges);

      const removeBtn = createIconButton({
        variant: 'danger',
        title: t('workspace.removeFolderTitle'),
        icon: 'mdi-delete-outline',
        onClick: () => {
          delete settingsWorkspaceDraftConfig[sidebarKey].folders[resolvedPath];
          renderFolderRows(listEl, sidebarKey, workspaceItem);
          refreshDefaultFolderSelect(sidebarKey, workspaceItem);
          persistDraft.save();
        },
      });

      row.appendChild(toggle);
      row.appendChild(body);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
  }

  function refreshDefaultFolderSelect(sidebarKey, workspaceItem) {
    const card = document.querySelector(`.settings-workspace-card[data-sidebar-key="${CSS.escape(sidebarKey)}"]`);
    const folderSelect = card?.querySelector('.settings-workspace-card-folder');
    if (!isFolderSelectControl(folderSelect)) return;
    const synthetic = {
      ...workspaceItem,
      folders: Object.entries(settingsWorkspaceDraftConfig[sidebarKey]?.folders || {}).map(([resolvedPath, meta]) => ({
        name: meta.name,
        resolvedPath,
        enabled: meta.enabled !== false,
        source: meta.source,
      })),
    };
    fillFolderSelect(folderSelect, synthetic, settingsWorkspaceDraftConfig[sidebarKey]?.folder || '');
    settingsWorkspaceDraftConfig[sidebarKey].folder = readControlValue(folderSelect);
  }

  function createWorkspaceCard(workspaceItem, entry, draftConfig, cardsWrap, cardOptions = {}) {
    const workspaceFile = workspaceItem.workspaceFile || workspaceItem.id || '';
    const sidebarKey = normalizePath(cardOptions.sidebarKey || resolveWorkspaceItemKey(workspaceItem));
    if (!sidebarKey) return;
    const isClone = cardOptions.isClone === true || isSidebarCloneKey(sidebarKey);
    const kind = workspaceItem.kind === 'folders' ? 'folders' : 'file';

    const card = document.createElement('article');
    card.className = 'settings-workspace-card cr-card';
    if (isClone) card.classList.add('is-clone');
    if (kind === 'folders') card.classList.add('is-folders');
    card.dataset.workspaceFile = workspaceFile;
    card.dataset.sidebarKey = sidebarKey;
    card.dataset.kind = kind;

    const headerRow = document.createElement('div');
    headerRow.className = 'settings-workspace-card-header';

    const toggle = document.createElement('cr-checkbox');
    toggle.className = 'settings-workspace-card-toggle cr-check';
    toggle.checked = entry.enabled !== false;
    toggle.textContent = t('workspace.cardEnabled');
    headerRow.appendChild(toggle);

    const actions = document.createElement('div');
    actions.className = 'settings-workspace-card-actions';

    if (!isClone) {
      actions.appendChild(createIconButton({
        title: t('workspace.cloneTitle'),
        icon: 'mdi-content-copy',
        onClick: () => {
          const newKey = createCloneSidebarKey(workspaceFile);
          if (!newKey) return;
          const sourceEntry = draftConfig[sidebarKey] || entry;
          draftConfig[newKey] = {
            enabled: sourceEntry.enabled !== false,
            folder: sourceEntry.folder || '',
            workspaceFile: normalizePath(workspaceFile),
            label: '',
            folders: { ...(sourceEntry.folders || {}) },
          };
          createWorkspaceCard(
            workspaceItem,
            draftConfig[newKey],
            draftConfig,
            cardsWrap,
            { sidebarKey: newKey, isClone: true, insertAfter: card }
          );
        },
      }));
    }

    actions.appendChild(createIconButton({
      variant: 'danger',
      title: isClone ? t('workspace.deleteCloneTitle') : t('workspace.removeWorkspaceTitle'),
      icon: 'mdi-delete-outline',
      onClick: () => {
        delete draftConfig[sidebarKey];
        card.remove();
        if (!isClone) {
          draftConfig[`${CLONE_KEY_SEPARATOR}removed:${sidebarKey}`] = { removed: true };
        }
      },
    }));
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const pathHint = document.createElement('div');
    pathHint.className = 'settings-workspace-card-path';
    if (isClone) {
      pathHint.textContent = t('workspace.clonePathPrefix', { path: workspaceFile });
    } else if (kind === 'folders') {
      pathHint.textContent = t('workspace.foldersOnlyHint');
    } else {
      pathHint.textContent = workspaceFile;
    }
    card.appendChild(pathHint);

    const nameField = document.createElement('div');
    nameField.className = 'settings-field cr-field';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'settings-field-label cr-field-label';
    nameLabel.textContent = t('workspace.sidebarNameLabel');
    const nameInput = document.createElement('cr-bar-input');
    nameInput.className = 'settings-workspace-card-name';
    nameInput.setAttribute('aria-label', t('workspace.sidebarNameLabel'));
    nameInput.value = entry.label || '';
    nameInput.placeholder = getWorkspaceDefaultDisplayName(workspaceItem, entry, isClone);
    nameInput.disabled = entry.enabled === false;
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    const folderField = document.createElement('div');
    folderField.className = 'settings-field cr-field';
    const folderLabel = document.createElement('label');
    folderLabel.className = 'settings-field-label cr-field-label';
    folderLabel.textContent = t('workspace.defaultFolderLabel');
    const folderSelect = document.createElement('cr-bar-select');
    folderSelect.className = 'settings-workspace-card-folder';
    folderSelect.setAttribute('aria-label', t('workspace.defaultFolderLabel'));
    fillFolderSelect(folderSelect, {
      ...workspaceItem,
      folders: Object.entries(entry.folders || {}).map(([resolvedPath, meta]) => ({
        name: meta.name,
        resolvedPath,
        enabled: meta.enabled !== false,
      })),
    }, entry.folder || '');
    if (!Array.isArray(folderSelect.options) || folderSelect.options.length === 0) {
      const fallbackPath = getWorkspaceDirFromFile(workspaceItem);
      folderSelect.options = [{
        value: fallbackPath,
        label: fallbackPath || t('workspace.noFolders'),
      }];
      folderSelect.value = fallbackPath;
    }
    folderField.appendChild(folderLabel);
    folderField.appendChild(folderSelect);
    card.appendChild(folderField);
    if (!draftConfig[sidebarKey]) {
      draftConfig[sidebarKey] = {
        enabled: entry.enabled !== false,
        folder: entry.folder || '',
        workspaceFile: normalizePath(workspaceFile),
        label: entry.label || '',
        folders: { ...(entry.folders || {}) },
      };
    }
    if (!draftConfig[sidebarKey].folder && folderSelect.value) {
      draftConfig[sidebarKey].folder = folderSelect.value;
    }
    folderSelect.disabled = entry.enabled === false;
    card.classList.toggle('is-disabled', entry.enabled === false);

    const foldersField = document.createElement('div');
    foldersField.className = 'settings-field cr-field';
    const foldersLabel = document.createElement('div');
    foldersLabel.className = 'settings-field-label cr-field-label';
    foldersLabel.textContent = t('workspace.foldersListLabel');
    foldersField.appendChild(foldersLabel);

    const folderList = document.createElement('div');
    folderList.className = 'settings-workspace-folder-list';
    foldersField.appendChild(folderList);
    card.appendChild(foldersField);
    renderFolderRows(folderList, sidebarKey, workspaceItem);

    const addFolderRow = document.createElement('div');
    addFolderRow.className = 'settings-workspace-add-folder-row cr-row';
    const addFolderInput = document.createElement('cr-bar-input');
    addFolderInput.placeholder = t('workspace.addFolderPlaceholder');
    addFolderInput.setAttribute('aria-label', t('workspace.addFolderPlaceholder'));
    addFolderInput.disabled = entry.enabled === false;
    const addFolderBtn = document.createElement('cr-bar-button');
    addFolderBtn.setAttribute('variant', 'primary');
    addFolderBtn.textContent = t('workspace.addFolderToCard');
    addFolderBtn.disabled = entry.enabled === false;
    addFolderBtn.addEventListener('click', () => {
      if (addFolderBtn.disabled) return;
      const folderPath = normalizePath(addFolderInput.value);
      if (!folderPath) return;
      draftConfig[sidebarKey].folders[folderPath] = {
        enabled: true,
        name: folderPath.split('/').pop() || folderPath,
        source: 'cretli',
      };
      addFolderInput.value = '';
      renderFolderRows(folderList, sidebarKey, workspaceItem);
      refreshDefaultFolderSelect(sidebarKey, workspaceItem);
      persistDraft.save();
    });
    addFolderRow.appendChild(addFolderInput);
    addFolderRow.appendChild(addFolderBtn);
    card.appendChild(addFolderRow);

    toggle.addEventListener('change', () => {
      draftConfig[sidebarKey].enabled = !!toggle.checked;
      folderSelect.disabled = !toggle.checked;
      nameInput.disabled = !toggle.checked;
      addFolderInput.disabled = !toggle.checked;
      addFolderBtn.disabled = !toggle.checked;
      card.classList.toggle('is-disabled', !toggle.checked);
      persistDraft.save();
    });
    nameInput.addEventListener('input', () => {
      draftConfig[sidebarKey].label = readControlValue(nameInput);
    });
    nameInput.addEventListener('change', () => {
      draftConfig[sidebarKey].label = readControlValue(nameInput);
      persistDraft.save();
    });
    folderSelect.addEventListener('cr-change', () => {
      draftConfig[sidebarKey].folder = readControlValue(folderSelect);
      persistDraft.save();
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
      if (isBarInput(nameInput)) {
        settingsWorkspaceDraftConfig[sidebarKey].label = readControlValue(nameInput);
      }
      const folderSelect = card.querySelector('.settings-workspace-card-folder');
      if (isFolderSelectControl(folderSelect)) {
        settingsWorkspaceDraftConfig[sidebarKey].folder = readControlValue(folderSelect);
      }
      const toggle = card.querySelector('.settings-workspace-card-toggle');
      if (toggle && 'checked' in toggle) {
        settingsWorkspaceDraftConfig[sidebarKey].enabled = !!toggle.checked;
      }
    });
  }

  function buildWorkspaceSidebarConfigPayload(draftConfig) {
    const payload = {};
    Object.entries(draftConfig).forEach(([sidebarKey, entry]) => {
      if (entry?.removed) return;
      const key = normalizePath(sidebarKey);
      if (!key) return;
      const enabled = entry.enabled !== false;
      const folder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const isClone = isSidebarCloneKey(key);
      const folders = {};
      Object.entries(entry.folders || {}).forEach(([folderPath, meta]) => {
        const resolvedPath = normalizePath(folderPath);
        if (!resolvedPath) return;
        folders[resolvedPath] = {
          enabled: meta.enabled !== false,
          name: meta.name || '',
          source: meta.source === 'cursor' ? 'cursor' : 'cretli',
        };
      });
      const hasFolders = Object.keys(folders).length > 0;
      if (!isClone && enabled && !folder && !label && !hasFolders) return;
      payload[key] = {};
      if (!enabled) payload[key].enabled = false;
      if (folder) payload[key].folder = folder;
      if (label) payload[key].label = label;
      if (hasFolders) payload[key].folders = folders;
      if (isClone) {
        payload[key].workspaceFile = normalizePath(
          entry.workspaceFile || getWorkspaceFileFromSidebarKey(key)
        );
      }
    });
    return payload;
  }

  function collectRemovedWorkspaceIds(draftConfig, currentItems) {
    const currentKeys = new Set(currentItems.map((item) => resolveWorkspaceItemKey(item)));
    const remaining = new Set();
    Object.keys(draftConfig).forEach((key) => {
      if (draftConfig[key]?.removed) return;
      if (isSidebarCloneKey(key)) return;
      remaining.add(normalizePath(key));
    });
    return [...currentKeys].filter((key) => key && !remaining.has(key));
  }

  function setStatus(statusEl, text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('lan-save-status--error', !!isError);
  }

  function initSettingsWorkspacePicker() {
    const cardsWrap = document.getElementById('settings-workspace-cards');
    const applyBtn = document.getElementById('settings-workspace-apply');
    const statusEl = document.getElementById('settings-workspace-status');
    const addFolderInput = document.getElementById('settings-workspace-add-folder-input');
    const addFolderBtn = document.getElementById('settings-workspace-add-folder');
    const addFileInput = document.getElementById('settings-workspace-add-file-input');
    const addFileBtn = document.getElementById('settings-workspace-add-file');
    const syncBtn = document.getElementById('settings-workspace-sync');
    const scanToggle = document.getElementById('settings-workspace-scan');
    if (!cardsWrap || !applyBtn) return;

    function renderCardsFromSettings(settingsData) {
      setWorkspaceSidebarConfig(settingsData?.workspaceSidebarConfig);
      cardsWrap.innerHTML = '';
      settingsWorkspaceDraftConfig = {};
      const list = getWorkspacesList();
      list.forEach((workspaceItem) => {
        const sidebarKey = resolveWorkspaceItemKey(workspaceItem);
        if (!sidebarKey) return;
        const savedEntry = getWorkspaceSidebarEntry(sidebarKey);
        const preferredFolder = resolveFolderForWorkspaceSelection(
          sidebarKey,
          savedEntry?.folder || ''
        );
        settingsWorkspaceDraftConfig[sidebarKey] = {
          enabled: savedEntry?.enabled !== false,
          folder: preferredFolder || '',
          workspaceFile: normalizePath(workspaceItem.workspaceFile || workspaceItem.id || ''),
          label: savedEntry?.label || '',
          folders: foldersFromWorkspaceItem(workspaceItem, savedEntry),
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
            workspaceFile: normalizePath(workspaceItem.workspaceFile || workspaceItem.id || ''),
            label: cloneEntry?.label || '',
            folders: foldersFromWorkspaceItem(workspaceItem, cloneEntry),
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

    persistDraft.save = () => {
      const cards = document.getElementById('settings-workspace-cards');
      syncWorkspaceDraftFromCards(cards);
      const payload = buildWorkspaceSidebarConfigPayload(settingsWorkspaceDraftConfig);
      return api
        .patchSettings({ workspaceSidebarConfig: payload })
        .then((ok) => {
          if (!ok?.ok) {
            setStatus(statusEl, t('workspace.saveError'), true);
            return;
          }
          setWorkspaceSidebarConfig(ok.workspaceSidebarConfig);
          setStatus(statusEl, t('workspace.saved'), false);
          return ensureWorkspacesListLoaded({ refresh: true }).then(() => {
            window.dispatchEvent(new CustomEvent('cretli-workspace-updated'));
          });
        })
        .catch(() => setStatus(statusEl, t('workspace.saveError'), true));
    };

    function reloadAndRender(options = {}) {
      return ensureWorkspacesListLoaded({ refresh: true, ...options }).then(() =>
        api.getSettings().then((settingsData) => {
          if (!settingsData?.ok) return;
          renderCardsFromSettings(settingsData);
        })
      );
    }

    function addPath(inputEl, addAs) {
      const pathValue = String(inputEl?.value || '').trim();
      if (!pathValue) return;
      setStatus(statusEl, t('common.saving'), false);
      api
        .patchSettings({ workspaceAddPath: pathValue, workspaceAddAs: addAs })
        .then((ok) => {
          if (!ok?.ok) {
            setStatus(statusEl, ok?.error || t('workspace.saveError'), true);
            return;
          }
          if (inputEl) inputEl.value = '';
          return reloadAndRender().then(() => setStatus(statusEl, t('workspace.saved'), false));
        })
        .catch(() => setStatus(statusEl, t('workspace.saveError'), true));
    }

    addFolderBtn?.addEventListener('click', () => addPath(addFolderInput, 'folder'));
    addFileBtn?.addEventListener('click', () => addPath(addFileInput, 'file'));
    syncBtn?.addEventListener('click', () => {
      setStatus(statusEl, t('workspace.syncing'), false);
      reloadAndRender({
        sync: true,
        scan: !!(scanToggle && scanToggle.checked),
      })
        .then(() => setStatus(statusEl, t('workspace.synced'), false))
        .catch(() => setStatus(statusEl, t('workspace.saveError'), true));
    });

    applyBtn.addEventListener('click', () => {
      if (applyBtn.disabled) return;
      syncWorkspaceDraftFromCards(cardsWrap);
      applyBtn.disabled = true;
      setStatus(statusEl, t('common.saving'), false);
      const list = getWorkspacesList();
      const removedIds = collectRemovedWorkspaceIds(settingsWorkspaceDraftConfig, list);
      const payload = buildWorkspaceSidebarConfigPayload(settingsWorkspaceDraftConfig);
      const writebackIds = list
        .filter((item) => item.kind === 'file')
        .filter((item) => overlayDiffersFromFile(
          settingsWorkspaceDraftConfig[resolveWorkspaceItemKey(item)]?.folders,
          item
        ))
        .map((item) => item.workspaceFile);
      const shouldWriteback = writebackIds.length > 0
        && window.confirm(t('workspace.writebackConfirm', { files: writebackIds.map((file) => file.split('/').pop()).join(', ') }));
      let chain = Promise.resolve();
      removedIds.forEach((id) => {
        chain = chain.then(() => api.patchSettings({ workspaceRemoveId: id }));
      });
      chain
        .then(() => api.patchSettings({ workspaceSidebarConfig: payload }))
        .then(async (ok) => {
          if (!ok?.ok) {
            setStatus(statusEl, t('workspace.saveError'), true);
            return;
          }
          if (shouldWriteback) {
            for (const workspaceFile of writebackIds) {
              await api.writeWorkspaceFileFolders(workspaceFile);
            }
          }
          setWorkspaceSidebarConfig(ok.workspaceSidebarConfig);
          await reloadAndRender();
          const activeFile = document.getElementById('header-workspace-trigger')?.dataset.workspaceFile || '';
          const activeFolder = document.getElementById('header-workspace-trigger')?.dataset.workspaceFolder || '';
          renderWorkspacePopoverItems(activeFile);
          updateWorkspaceTriggerLabel(activeFile, activeFolder);
          window.dispatchEvent(new CustomEvent('cretli-workspace-updated'));
          setStatus(statusEl, t('workspace.saved'), false);
        })
        .catch(() => setStatus(statusEl, t('workspace.saveError'), true))
        .finally(() => {
          applyBtn.disabled = false;
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 2000);
        });
    });

    return ensureWorkspacesListLoaded({ refresh: true }).then(() =>
      api.getSettings().then((settingsData) => {
        if (!settingsData?.ok) return;
        renderCardsFromSettings(settingsData);
      }).catch(() => {})
    );
  }

  function refreshSettingsWorkspacePicker() {
    return ensureWorkspacesListLoaded({ refresh: true }).then(() =>
      api.getSettings().then((settingsData) => {
        if (!settingsData?.ok) return;
        if (typeof settingsWorkspaceCardsRenderer === 'function') {
          settingsWorkspaceCardsRenderer(settingsData);
        }
      }).catch(() => {})
    );
  }

  return {
    initSettingsWorkspacePicker,
    refreshSettingsWorkspacePicker,
  };
}
