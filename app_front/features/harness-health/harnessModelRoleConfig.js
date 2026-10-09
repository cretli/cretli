/**
 * Settings → Harness: audited model-role editor panel.
 *
 * Loads `GET /api/harness-model-role-config`, renders the editable view, and
 * wires Preview diff / Save (If-Match) / Reset (with backup). The panel never
 * mutates a locked role and never writes without the server-provided ETag.
 */

import {
  getHarnessModelRoleConfig,
  previewHarnessModelRoleConfig,
  putHarnessModelRoleConfig,
  resetHarnessModelRoleConfig,
} from '../../api.js';
import { t } from '../../i18n/index.js';
import {
  buildModelRoleConfigViewModel,
  computeModelRoleConfigDelta,
  renderModelRoleConfigDiffHtml,
  renderModelRoleConfigHtml,
} from './harnessModelRoleConfigModel.js';

let wired = false;
let loadSeq = 0;
/** @type {object|null} */
let currentModel = null;

/**
 * @returns {HTMLElement|null}
 */
function outputEl() {
  return document.getElementById('harness-model-role-config-output');
}

/**
 * @returns {HTMLElement|null}
 */
function diffEl() {
  return document.getElementById('harness-model-role-config-diff');
}

/**
 * @returns {HTMLElement|null}
 */
function statusEl() {
  return document.getElementById('harness-model-role-config-status');
}

/**
 * @param {string} message
 * @returns {void}
 */
function setStatus(message) {
  const el = statusEl();
  if (el) el.textContent = message || '';
}

/**
 * @param {string} [html]
 * @returns {void}
 */
function setDiff(html) {
  const el = diffEl();
  if (el) el.innerHTML = html || '';
}

/**
 * Read the editor state from the DOM into the desired-state shape.
 *
 * @returns {{ roles: Record<string, Array<{ pattern: string, priority: number }>>, rotation: { mode: string, band: number }, adaptive: { enabled: boolean } }}
 */
function readDesiredState() {
  const out = outputEl();
  /** @type {Record<string, Array<{ pattern: string, priority: number }>>} */
  const roles = {};
  if (out) {
    for (const input of out.querySelectorAll('input[type="checkbox"][data-role][data-pattern]')) {
      if (!(input instanceof HTMLInputElement)) continue;
      const role = String(input.dataset.role || '');
      const pattern = String(input.dataset.pattern || '');
      if (!role || !pattern) continue;
      // Register the role even when every rule is unchecked, so "remove all"
      // is distinct from "this role was not edited".
      if (!roles[role]) roles[role] = [];
      if (!input.checked) continue;
      const priorityInput = out.querySelector(`input[data-priority="${CSS.escape(`${role}:${pattern}`)}"]`);
      const priority = priorityInput instanceof HTMLInputElement ? Number(priorityInput.value) : 0;
      roles[role].push({ pattern, priority: Number.isFinite(priority) ? priority : 0 });
    }
  }
  const modeEl = out?.querySelector('[data-field="rotation-mode"]');
  const bandEl = out?.querySelector('[data-field="rotation-band"]');
  const adaptiveEl = out?.querySelector('[data-field="adaptive-enabled"]');
  return {
    roles,
    rotation: {
      mode: modeEl instanceof HTMLSelectElement ? modeEl.value : 'balanced',
      band: bandEl instanceof HTMLInputElement ? Number(bandEl.value) : 0,
    },
    adaptive: { enabled: adaptiveEl instanceof HTMLInputElement ? adaptiveEl.checked : true },
  };
}

/**
 * @param {string} message
 * @param {string} [tone]
 * @returns {void}
 */
function flash(message, tone) {
  setStatus(message);
  const el = statusEl();
  if (el && tone) el.dataset.tone = tone;
  else if (el) delete el.dataset.tone;
}

/**
 * @param {boolean} [fresh]
 * @returns {Promise<void>}
 */
export async function loadHarnessModelRoleConfig(fresh = false) {
  const out = outputEl();
  if (!out) return;
  const seq = ++loadSeq;
  flash(t('harnessModelRole.loading'));
  try {
    const snapshot = await getHarnessModelRoleConfig(fresh);
    if (seq !== loadSeq) return;
    if (!snapshot?.ok) {
      out.replaceChildren();
      setDiff('');
      flash(snapshot?.error || t('harnessModelRole.loadFailed'), 'error');
      return;
    }
    currentModel = buildModelRoleConfigViewModel(snapshot, t);
    out.innerHTML = renderModelRoleConfigHtml(currentModel, t);
    setDiff('');
    flash('');
  } catch {
    if (seq !== loadSeq) return;
    flash(t('harnessModelRole.loadFailed'), 'error');
  }
}

/**
 * @returns {Promise<void>}
 */
async function preview() {
  if (!currentModel) return;
  const delta = computeModelRoleConfigDelta({ model: currentModel, desired: readDesiredState() });
  flash(t('harnessModelRole.previewing'));
  try {
    const result = await previewHarnessModelRoleConfig(delta);
    if (!result?.ok) {
      flash(result?.error || t('harnessModelRole.previewFailed'), 'error');
      return;
    }
    setDiff(renderModelRoleConfigDiffHtml(result.diff, t));
    flash(result.diff?.changed ? t('harnessModelRole.previewReady') : t('harnessModelRole.diffNone'));
  } catch {
    flash(t('harnessModelRole.previewFailed'), 'error');
  }
}

/**
 * @returns {Promise<void>}
 */
async function save() {
  if (!currentModel) return;
  const delta = computeModelRoleConfigDelta({ model: currentModel, desired: readDesiredState() });
  flash(t('harnessModelRole.saving'));
  try {
    const result = await putHarnessModelRoleConfig(delta, currentModel.etag);
    if (result?.ok) {
      setDiff(renderModelRoleConfigDiffHtml(result.diff, t));
      flash(t('harnessModelRole.saved'), 'success');
      await loadHarnessModelRoleConfig(true);
      setDiff(renderModelRoleConfigDiffHtml(result.diff, t));
      flash(t('harnessModelRole.saved'), 'success');
      return;
    }
    if (result?.conflict === true) {
      flash(t('harnessModelRole.conflict'), 'error');
    } else if (result?.state === 'invalid') {
      flash(t('harnessModelRole.writeBlockedInvalid'), 'error');
    } else {
      flash(result?.error || t('harnessModelRole.saveFailed'), 'error');
    }
  } catch {
    flash(t('harnessModelRole.saveFailed'), 'error');
  }
}

/**
 * @returns {Promise<void>}
 */
async function reset() {
  if (!currentModel) return;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
    && !window.confirm(t('harnessModelRole.resetConfirm'))) return;
  flash(t('harnessModelRole.resetting'));
  try {
    const result = await resetHarnessModelRoleConfig(currentModel.etag);
    if (!result?.ok) {
      flash(result?.conflict ? t('harnessModelRole.conflict') : (result?.error || t('harnessModelRole.resetFailed')), 'error');
      return;
    }
    setDiff(renderModelRoleConfigDiffHtml(result.diff, t));
    await loadHarnessModelRoleConfig(true);
    flash(result.backupPath
      ? t('harnessModelRole.resetDoneBackup', { backup: result.backupPath })
      : t('harnessModelRole.resetDone'), 'success');
  } catch {
    flash(t('harnessModelRole.resetFailed'), 'error');
  }
}

/**
 * @returns {void}
 */
export function initHarnessModelRoleConfig() {
  const section = document.getElementById('harness-model-role-config-section');
  if (!section || wired) return;
  wired = true;
  document.getElementById('harness-model-role-config-preview')?.addEventListener('click', () => {
    void preview();
  });
  document.getElementById('harness-model-role-config-save')?.addEventListener('click', () => {
    void save();
  });
  document.getElementById('harness-model-role-config-reset')?.addEventListener('click', () => {
    void reset();
  });
  window.addEventListener('cr-lang-changed', () => {
    if (currentModel) void loadHarnessModelRoleConfig(true);
  });
}

/**
 * Called when the Harness settings tab becomes active. Loads lazily and never
 * more than once per session unless the user refreshes.
 *
 * @returns {void}
 */
export function refreshHarnessModelRoleConfigPanel() {
  const out = outputEl();
  if (!out || out.childElementCount === 0) void loadHarnessModelRoleConfig(false);
}
