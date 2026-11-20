/**
 * Static DOM hosts of the Files panel (declared in public/index.html).
 * The module is loaded lazily, after the shell markup exists.
 */
export const dom = {
  tree: document.getElementById('files-tree'),
  rootLabel: document.getElementById('files-root-label'),
  rootLabelText: document.getElementById('files-root-label-text'),
  rootDropdown: document.getElementById('files-root-dropdown'),
  previewWrap: document.getElementById('files-preview-wrap'),
  previewPath: document.getElementById('files-preview-path'),
  previewContent: document.getElementById('files-preview-content'),
  previewClose: document.getElementById('files-preview-close'),
  mdToggleWrap: document.getElementById('files-preview-markdown-toggle-wrap'),
  mdToggle: /** @type {HTMLInputElement | null} */ (document.getElementById('files-preview-markdown-toggle')),
  diffToggleWrap: document.getElementById('files-preview-diff-toggle-wrap'),
  diffToggle: /** @type {HTMLInputElement | null} */ (document.getElementById('files-preview-diff-toggle')),
  settingsBtn: document.getElementById('files-settings-btn'),
  settingsModal: document.getElementById('files-settings-modal'),
  showHiddenCheckbox: /** @type {HTMLInputElement | null} */ (document.getElementById('files-show-hidden-checkbox')),
  settingsCancel: document.getElementById('files-settings-cancel'),
  settingsSave: document.getElementById('files-settings-save'),
};

export function filesScrollContainer() {
  return document.querySelector('#files-panel .files-tree-wrap');
}
