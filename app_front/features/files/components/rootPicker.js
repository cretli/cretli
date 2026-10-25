/** Workspace root label, its folder dropdown and the section settings modal. */
import { html, render } from 'lit';
import * as api from '../../../core/api/index.js';
import { initDropdown } from '../../../lib/dropdown.js';
import { initModal } from '../../../lib/modal.js';
import { t } from '../../../i18n/index.js';
import { dom } from '../state/filesDom.js';
import { getShowHiddenFilesEnabled, setShowHiddenFilesEnabled } from '../services/filesPrefs.js';

let dropdownApi = null;
let dropdownBound = false;
let onRootChange = () => {};

export function normalizePathValue(value) {
  if (!value || typeof value !== 'string') return '';
  return value.replaceAll('\\', '/').replace(/\/+$/, '').trim();
}

export function setRootLabelText(text, title = text) {
  const label = dom.rootLabelText || dom.rootLabel;
  if (label) label.textContent = text || '—';
  if (dom.rootLabel) dom.rootLabel.title = title || '';
}

export function closeRootDropdown() {
  dropdownApi?.close();
}

function buildOptions(workspace) {
  const options = [];
  const pushed = new Set();
  if (workspace.workspaceDir) {
    options.push({ value: workspace.workspaceDir, label: `Workspace: ${workspace.workspaceDir}` });
    pushed.add(workspace.workspaceDir);
  }
  for (const folder of workspace.folders || []) {
    const value = String(folder.resolvedPath || '').trim();
    if (!value || pushed.has(value)) continue;
    options.push({ value, label: `${folder.name || value} — ${value}` });
    pushed.add(value);
  }
  return options;
}

function selectFolder(value) {
  api.patchSettings({ workspaceFolder: value }).then((res) => {
    if (!res?.ok) return;
    closeRootDropdown();
    onRootChange();
    window.dispatchEvent(new CustomEvent('cretli-workspace-updated', { detail: { workspaceFolder: value } }));
  }).catch(() => {});
}

function renderRootDropdown(workspace, selectedFolder) {
  if (!dom.rootDropdown) return;
  const options = buildOptions(workspace);
  render(options.map((o) => html`<button type="button" class="files-root-dropdown-item ${selectedFolder === o.value ? 'is-selected' : ''}" title=${o.value} @click=${() => selectFolder(o.value)}>${o.label}</button>`), dom.rootDropdown);
  dom.rootDropdown.hidden = false;
  dropdownApi?.open();
}

function toggleRootDropdown() {
  if (dropdownApi?.isOpen()) {
    closeRootDropdown();
    return;
  }
  Promise.all([api.getWorkspace(), api.getSettings()]).then(([workspace, settings]) => {
    if (!workspace?.ok) return;
    const selectedFolder =
      settings?.ok && typeof settings.workspaceFolder === 'string' && settings.workspaceFolder.trim()
        ? settings.workspaceFolder.trim()
        : workspace.workspaceDir;
    renderRootDropdown(workspace, selectedFolder);
  }).catch(() => {});
}

/** @param {() => void} rebuild re-creates the tree after a root or settings change */
export function initRootDropdown(rebuild) {
  onRootChange = rebuild;
  if (!dom.rootLabel || !dom.rootDropdown || dropdownBound) return;
  dropdownApi = initDropdown({
    triggerEl: dom.rootLabel,
    floatingEl: dom.rootDropdown,
    placement: 'bottom-end',
    matchTriggerWidth: true,
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 220,
    maxHeightPx: 360,
  });
  dom.rootLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRootDropdown();
  });
  dom.rootLabel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleRootDropdown();
  });
  dropdownBound = true;
}

export function initFilesSettingsModal(rebuild) {
  if (!dom.settingsModal) return;
  const modal = initModal(dom.settingsModal, { backdropSelector: '.chat-settings-backdrop' });
  dom.settingsBtn?.addEventListener('click', () => {
    if (dom.showHiddenCheckbox) dom.showHiddenCheckbox.checked = getShowHiddenFilesEnabled();
    modal?.open();
  });
  dom.settingsCancel?.addEventListener('click', () => modal?.close());
  dom.settingsSave?.addEventListener('click', () => {
    setShowHiddenFilesEnabled(!!dom.showHiddenCheckbox?.checked);
    modal?.close();
    rebuild();
  });
}

/** Resolves the root label text for the current workspace/selection. */
/** @param {() => void} [onNoWorkspace] */
export function refreshRootLabel(onNoWorkspace) {
  setRootLabelText(t('files.loading'));
  Promise.all([api.getWorkspace(), api.getSettings()])
    .then(([w, settings]) => {
      if (!w?.ok) {
        setRootLabelText('—');
        onNoWorkspace?.();
        return;
      }
      const workspaceDir = w.workspaceDir || w.cwd || '—';
      const selectedFolder =
        settings?.ok && typeof settings.workspaceFolder === 'string' ? settings.workspaceFolder.trim() : '';
      const selectedNorm = normalizePathValue(selectedFolder);
      if (selectedNorm && selectedNorm !== normalizePathValue(workspaceDir)) {
        setRootLabelText(`${workspaceDir} • ${selectedNorm}`);
        return;
      }
      setRootLabelText(workspaceDir);
    })
    .catch(() => setRootLabelText('—'));
}
