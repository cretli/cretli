import * as api from './core/api/index.js';
import { t } from './i18n/index.js';

/** Labels are resolved lazily via `labelKey` — i18n is initialized after module load. */
const WIDGET_PERMISSION_OPTIONS = Object.freeze([
  { value: 'context', labelKey: 'widget.permContext', defaultChecked: true },
  { value: 'dom', labelKey: 'widget.permDom', defaultChecked: true },
  { value: 'console', labelKey: 'widget.permConsole', defaultChecked: true },
  { value: 'network', labelKey: 'widget.permNetwork', defaultChecked: true },
  { value: 'screenshot', labelKey: 'widget.permScreenshot', defaultChecked: false },
  { value: 'interact', labelKey: 'widget.permInteract', defaultChecked: false },
  { value: 'navigate', labelKey: 'widget.permNavigate', defaultChecked: false },
  { value: 'storage', labelKey: 'widget.permStorage', defaultChecked: false },
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '') || '';
}

function buildSnippet(installation) {
  const src = new URL('/dist/app/embed-widget.bundle.js', window.location.origin).toString();
  return `<script src="${src}" data-installation-id="${installation.id}"></script>`;
}

function formatPermissionLabels(permissions) {
  const selected = new Set(Array.isArray(permissions) ? permissions : []);
  return WIDGET_PERMISSION_OPTIONS
    .filter((option) => selected.has(option.value))
    .map((option) => t(option.labelKey))
    .join(' • ') || t('widgetPanel.noPermissions');
}

function readCheckedPermissions(fieldset) {
  return Array.from(
    fieldset.querySelectorAll('input[type="checkbox"]:checked'),
    (input) => input.value,
  );
}

function createPermissionsFieldset(selectedPermissions = [], className = 'widget-installation-permissions') {
  const fieldset = document.createElement('fieldset');
  fieldset.className = className;
  const legend = document.createElement('legend');
  legend.textContent = t('widget.features');
  fieldset.appendChild(legend);
  const selected = new Set(Array.isArray(selectedPermissions) ? selectedPermissions : []);
  WIDGET_PERMISSION_OPTIONS.forEach((option) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = option.value;
    input.checked = selected.has(option.value)
      || (selected.size === 0 && option.defaultChecked);
    label.append(input, document.createTextNode(` ${t(option.labelKey)}`));
    fieldset.appendChild(label);
  });
  return fieldset;
}

function groupInstallationsByWorkspace(installations) {
  const groups = new Map();
  installations.forEach((installation) => {
    const key = `${normalizePath(installation.workspaceFile)}|${normalizePath(installation.workspaceFolder)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        workspaceFile: installation.workspaceFile || '',
        workspaceFolder: installation.workspaceFolder || '',
        items: [],
      });
    }
    groups.get(key).items.push(installation);
  });
  return groups;
}

let refreshPanel = null;

export function refreshWidgetPanel() {
  if (typeof refreshPanel === 'function') refreshPanel();
}

export function initWidgetPanel(deps = {}) {
  const {
    getActiveWorkspaceFile = () => '',
    getActiveWorkspaceFolder = () => '',
    getWorkspacesList = () => [],
    getPreferredWorkspaceFolder = () => '',
    ensureWorkspacesListLoaded = () => Promise.resolve(),
  } = deps;

  const list = document.getElementById('widget-panel-installations-list');
  const createButton = document.getElementById('widget-panel-create');
  const status = document.getElementById('widget-panel-status');
  const workspaceSelect = document.getElementById('widget-panel-workspace-select');
  const workspaceFileInput = document.getElementById('widget-panel-workspace-file');
  const workspaceFolderInput = document.getElementById('widget-panel-workspace-folder');
  const nameInput = document.getElementById('widget-panel-name');
  const modelInput = document.getElementById('widget-panel-model');
  const originsInput = document.getElementById('widget-panel-origins');
  if (!list || !createButton || !workspaceSelect) return;

  const setStatus = (message, isError = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('lan-save-status--error', isError);
  };

  const applyWorkspaceSelection = (sidebarKey) => {
    const workspaces = getWorkspacesList();
    const item = workspaces.find((entry) => entry.sidebarKey === sidebarKey);
    if (!item) return;

    if (workspaceFileInput) workspaceFileInput.value = item.workspaceFile || '';
    if (workspaceFolderInput) {
      workspaceFolderInput.value = getPreferredWorkspaceFolder(sidebarKey) || item.workspaceDir || '';
    }
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = item.name || '';
    }
  };

  const syncWorkspaceSelect = () => {
    const workspaces = getWorkspacesList();
    const activeFile = normalizePath(getActiveWorkspaceFile());
    const activeFolder = normalizePath(getActiveWorkspaceFolder());
    const previous = workspaceSelect.value;

    workspaceSelect.innerHTML = '';
    if (!workspaces.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('widgetPanel.noWorkspaces');
      workspaceSelect.appendChild(option);
      workspaceSelect.disabled = true;
      return;
    }

    workspaceSelect.disabled = false;
    workspaces.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.sidebarKey;
      option.textContent = item.name || item.workspaceFile || 'Workspace';
      workspaceSelect.appendChild(option);
    });

    const matched = workspaces.find((item) => {
      if (normalizePath(item.workspaceFile) !== activeFile) return false;
      const folder = normalizePath(getPreferredWorkspaceFolder(item.sidebarKey) || item.workspaceDir || '');
      return folder === activeFolder;
    });
    const nextKey = matched?.sidebarKey || previous || workspaces[0]?.sidebarKey || '';
    if (nextKey) workspaceSelect.value = nextKey;
    applyWorkspaceSelection(workspaceSelect.value);
  };

  const renderInstallationCard = (installation, refresh) => {
    const card = document.createElement('article');
    card.className = 'widget-installation-card';

    const title = document.createElement('strong');
    title.textContent = installation.name;
    card.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'settings-hint';
    meta.textContent = (installation.allowedOrigins || []).join(' • ') || t('widgetPanel.noOrigins');
    card.appendChild(meta);

    const permissionsHint = document.createElement('p');
    permissionsHint.className = 'settings-hint widget-installation-permissions-summary';
    permissionsHint.textContent = formatPermissionLabels(installation.permissions);
    card.appendChild(permissionsHint);

    const editSection = document.createElement('div');
    editSection.className = 'widget-installation-edit';
    editSection.hidden = true;

    const originsLabel = document.createElement('label');
    originsLabel.textContent = t('widget.allowedOrigins');
    editSection.appendChild(originsLabel);

    const originsInput = document.createElement('textarea');
    originsInput.className = 'quick-commands-textarea';
    originsInput.rows = 3;
    originsInput.value = (installation.allowedOrigins || []).join('\n');
    editSection.appendChild(originsInput);

    const permissionsFieldset = createPermissionsFieldset(
      installation.permissions,
      'widget-installation-permissions widget-installation-edit-permissions',
    );
    editSection.appendChild(permissionsFieldset);

    const reauthHint = document.createElement('p');
    reauthHint.className = 'settings-hint';
    reauthHint.textContent = t('widgetPanel.reauthHint');
    editSection.appendChild(reauthHint);

    const editActions = document.createElement('div');
    editActions.className = 'quick-commands-save-row';

    const saveEditButton = document.createElement('button');
    saveEditButton.type = 'button';
    saveEditButton.className = 'chat-settings-btn-primary';
    saveEditButton.textContent = t('widgetPanel.saveChanges');

    const cancelEditButton = document.createElement('button');
    cancelEditButton.type = 'button';
    cancelEditButton.className = 'chat-settings-btn-secondary';
    cancelEditButton.textContent = t('common.cancel');

    editActions.append(saveEditButton, cancelEditButton);
    editSection.appendChild(editActions);
    card.appendChild(editSection);

    const snippet = document.createElement('textarea');
    snippet.className = 'quick-commands-textarea widget-panel-snippet';
    snippet.rows = 3;
    snippet.readOnly = true;
    snippet.value = buildSnippet(installation);
    card.appendChild(snippet);

    const actions = document.createElement('div');
    actions.className = 'quick-commands-save-row';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'chat-settings-btn-secondary';
    copyButton.textContent = t('widgetPanel.copyCode');
    copyButton.addEventListener('click', () => {
      void navigator.clipboard?.writeText(snippet.value);
      copyButton.textContent = t('app.copied');
      setTimeout(() => {
        copyButton.textContent = t('widgetPanel.copyCode');
      }, 1500);
    });
    actions.appendChild(copyButton);

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'chat-settings-btn-secondary';
    editButton.textContent = t('widgetPanel.editScope');
    editButton.addEventListener('click', () => {
      const isOpen = !editSection.hidden;
      editSection.hidden = isOpen;
      editButton.textContent = isOpen ? t('widgetPanel.editScope') : t('widgetPanel.closeEdit');
      if (!isOpen) originsInput.focus();
    });
    actions.appendChild(editButton);

    saveEditButton.addEventListener('click', async () => {
      const allowedOrigins = originsInput.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const permissions = readCheckedPermissions(permissionsFieldset);
      if (allowedOrigins.length === 0) {
        setStatus(t('widgetPanel.originRequired'), true);
        return;
      }
      saveEditButton.disabled = true;
      cancelEditButton.disabled = true;
      setStatus(t('common.saving'));
      try {
        const data = await api.updateWidgetInstallation(installation.id, {
          allowedOrigins,
          permissions,
        });
        if (!data?.ok) throw new Error(data?.error || t('widgetPanel.saveFailed'));
        setStatus(t('widgetPanel.updated'));
        await refresh();
      } catch (error) {
        setStatus(error?.message || t('widgetPanel.saveFailed'), true);
      } finally {
        saveEditButton.disabled = false;
        cancelEditButton.disabled = false;
      }
    });

    cancelEditButton.addEventListener('click', () => {
      originsInput.value = (installation.allowedOrigins || []).join('\n');
      permissionsFieldset.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = (installation.permissions || []).includes(input.value);
      });
      editSection.hidden = true;
      editButton.textContent = t('widgetPanel.editScope');
    });

    const enabledLabel = document.createElement('label');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = installation.enabled !== false;
    enabled.addEventListener('change', async () => {
      enabled.disabled = true;
      try {
        await api.updateWidgetInstallation(installation.id, { enabled: enabled.checked });
        await refresh();
      } catch (error) {
        setStatus(error?.message || t('widgetPanel.toggleFailed'), true);
        enabled.checked = !enabled.checked;
      } finally {
        enabled.disabled = false;
      }
    });
    enabledLabel.append(enabled, document.createTextNode(` ${t('widgetPanel.enabled')}`));
    actions.appendChild(enabledLabel);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-settings-btn-danger';
    deleteButton.textContent = t('common.delete');
    deleteButton.addEventListener('click', async () => {
      if (!window.confirm(t('widgetPanel.deleteConfirm', { name: installation.name }))) return;
      await api.deleteWidgetInstallation(installation.id);
      await refresh();
    });
    actions.appendChild(deleteButton);
    card.appendChild(actions);
    return card;
  };

  const render = (installations) => {
    list.innerHTML = '';
    if (!installations.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint';
      empty.textContent = t('widgetPanel.empty');
      list.appendChild(empty);
      return;
    }

    const groups = groupInstallationsByWorkspace(installations);
    groups.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'widget-panel-installation-group';

      const heading = document.createElement('h4');
      const workspaceLabel = group.workspaceFile.replace(/.*\//, '').replace(/\.code-workspace$/, '')
        || 'Workspace';
      const folderLabel = group.workspaceFolder.replace(/.*[/\\]/, '') || '';
      heading.textContent = folderLabel ? `${workspaceLabel} / ${folderLabel}` : workspaceLabel;
      section.appendChild(heading);

      if (group.workspaceFile) {
        const pathHint = document.createElement('p');
        pathHint.className = 'settings-hint';
        pathHint.textContent = [group.workspaceFile, group.workspaceFolder].filter(Boolean).join(' • ');
        section.appendChild(pathHint);
      }

      group.items.forEach((installation) => {
        section.appendChild(renderInstallationCard(installation, refresh));
      });
      list.appendChild(section);
    });
  };

  const refresh = async () => {
    try {
      await ensureWorkspacesListLoaded();
      syncWorkspaceSelect();
      const data = await api.listWidgetInstallations();
      if (!data?.ok) throw new Error(data?.error || t('widgetPanel.loadFailed'));
      render(Array.isArray(data.installations) ? data.installations : []);
    } catch (error) {
      setStatus(error?.message || t('widgetPanel.loadFailed'), true);
    }
  };

  refreshPanel = refresh;

  workspaceSelect.addEventListener('change', () => {
    applyWorkspaceSelection(workspaceSelect.value);
  });

  createButton.addEventListener('click', async () => {
    const name = nameInput?.value.trim() || '';
    const workspaceFile = workspaceFileInput?.value.trim() || '';
    const workspaceFolder = workspaceFolderInput?.value.trim() || '';
    const model = modelInput?.value.trim() || '';
    const originsText = originsInput?.value || '';
    const allowedOrigins = originsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const permissions = Array.from(
      document.querySelectorAll('.widget-panel-permissions input:checked'),
      (input) => input.value,
    );
    if (!name || !workspaceFile || !workspaceFolder || allowedOrigins.length === 0) {
      setStatus(t('widgetPanel.createFormIncomplete'), true);
      return;
    }

    createButton.disabled = true;
    setStatus(t('widgetPanel.creating'));
    try {
      const data = await api.createWidgetInstallation({
        name,
        workspaceFile,
        workspaceFolder,
        model: model || null,
        allowedOrigins,
        permissions,
        enabled: true,
      });
      if (!data?.ok) throw new Error(data?.error || t('widgetPanel.createFailed'));
      setStatus(t('widgetPanel.created'));
      if (nameInput) nameInput.value = '';
      if (originsInput) originsInput.value = '';
      await refresh();
    } catch (error) {
      setStatus(error?.message || t('widgetPanel.createFailed'), true);
    } finally {
      createButton.disabled = false;
    }
  });

  void refresh();
}
