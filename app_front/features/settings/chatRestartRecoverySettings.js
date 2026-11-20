/**
 * Settings → Chat and agents → Restart recovery.
 *
 * Edits `chatRestartRecoveryMode` (all workspaces) and the per-workspace
 * override `chatRestartRecoveryWorkspace` through `PATCH /api/settings`, and lists
 * which harnesses passed the live validation that automatic resume requires.
 */

import { t } from '../../i18n/index.js';
import { getSettings, patchSettings } from '../../core/api/index.js';

const MODES = ['off', 'manual', 'automatic'];
const MODE_KEYS = {
  off: 'settings.restartRecoveryModeOff',
  manual: 'settings.restartRecoveryModeManual',
  automatic: 'settings.restartRecoveryModeAutomatic',
};

/** @param {unknown} value */
function normalizeMode(value) {
  return MODES.includes(/** @type {string} */ (value)) ? /** @type {string} */ (value) : 'manual';
}

/** Wires the section once; no-op when the markup is absent. */
export function initChatRestartRecoverySettings() {
  const globalSelect = /** @type {any} */ (document.getElementById('chat-recovery-mode'));
  const workspaceField = document.getElementById('chat-recovery-workspace-field');
  const workspaceSelect = /** @type {any} */ (document.getElementById('chat-recovery-workspace-mode'));
  const statusEl = document.getElementById('chat-recovery-status');
  const adaptersEl = document.getElementById('chat-recovery-adapters');
  if (!globalSelect) return;

  let workspaceFolder = '';
  let savedGlobal = 'manual';
  /** @type {string} '' = inherit the global mode */
  let savedWorkspace = '';

  globalSelect.options = MODES.map((mode) => ({ value: mode, label: t(MODE_KEYS[mode]) }));
  if (workspaceSelect) {
    workspaceSelect.options = [
      { value: '', label: t('settings.restartRecoveryInherit') },
      ...MODES.map((mode) => ({ value: mode, label: t(MODE_KEYS[mode]) })),
    ];
  }

  /**
   * @param {string} [text]
   * @param {boolean} [isError]
   */
  function setStatus(text = '', isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  /** @param {any} json */
  function applyState(json) {
    const cfg = json?.chatRestartRecovery || {};
    workspaceFolder = typeof json?.workspaceFolder === 'string' ? json.workspaceFolder : '';
    savedGlobal = normalizeMode(cfg.mode);
    const override = workspaceFolder ? cfg.workspaces?.[workspaceFolder] : '';
    savedWorkspace = MODES.includes(override) ? override : '';
    globalSelect.value = savedGlobal;
    if (workspaceSelect) workspaceSelect.value = savedWorkspace;
    if (workspaceField) workspaceField.hidden = !workspaceFolder;
    renderAdapters(json?.chatRestartRecoveryAdapters);
  }

  /** @param {unknown} rows */
  function renderAdapters(rows) {
    if (!adaptersEl) return;
    adaptersEl.textContent = '';
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const item = document.createElement('li');
      const state = row.validated ? t('settings.restartRecoveryAdapterValidated') : t('settings.restartRecoveryAdapterPending');
      const version = row.sdkVersion ? ` (${t('settings.restartRecoveryAdapterVersion', { version: row.sdkVersion })})` : '';
      item.textContent = `${row.harness}${version}: ${state}`;
      item.dataset.validated = row.validated ? 'true' : 'false';
      adaptersEl.appendChild(item);
    }
    if (list.length && !list.some((row) => row.validated)) {
      const note = document.createElement('li');
      note.textContent = t('settings.restartRecoveryNoValidated');
      adaptersEl.appendChild(note);
    }
  }

  /** @param {Record<string, unknown>} patch */
  async function save(patch) {
    setStatus(t('settings.restartRecoverySaving'));
    try {
      const json = await patchSettings(patch);
      if (json && json.ok === false) throw new Error(json.error || 'save_failed');
      savedGlobal = normalizeMode(globalSelect.value);
      savedWorkspace = workspaceSelect && MODES.includes(workspaceSelect.value) ? workspaceSelect.value : '';
      setStatus(t('settings.restartRecoverySaved'));
    } catch (err) {
      globalSelect.value = savedGlobal;
      if (workspaceSelect) workspaceSelect.value = savedWorkspace;
      setStatus(err?.message || t('settings.restartRecoverySaveFailed'), true);
    }
  }

  globalSelect.addEventListener('change', () => {
    void save({ chatRestartRecoveryMode: normalizeMode(globalSelect.value) });
  });
  workspaceSelect?.addEventListener('change', () => {
    if (!workspaceFolder) return;
    // An empty mode clears the override so the workspace follows the global mode.
    void save({ chatRestartRecoveryWorkspace: { workspaceFolder, mode: MODES.includes(workspaceSelect.value) ? workspaceSelect.value : '' } });
  });

  getSettings()
    .then(applyState)
    .catch(() => {
      // Keep the defaults when settings cannot be loaded; saving still works.
      applyState({});
    });
}
