/**
 * Settings → Harness: audited model-role editor panel.
 *
 * Loads `GET /api/harness-model-role-config`, renders the editable view, and
 * wires Preview diff / Save (If-Match) / Reset (with backup). The panel never
 * mutates a locked role and never writes without the server-provided ETag.
 */

import {
  getHarnessModelRoleConfig,
  getModelPickOverrides,
  previewHarnessModelRoleConfig,
  putHarnessModelRoleConfig,
  putModelPickOverride,
  resetHarnessModelRoleConfig,
  resetModelPickOverrides,
  revokeModelPickOverride,
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
    const [snapshot, overridesSnapshot] = await Promise.all([
      getHarnessModelRoleConfig(fresh),
      getModelPickOverrides().catch(() => null),
    ]);
    if (seq !== loadSeq) return;
    if (!snapshot?.ok) {
      out.replaceChildren();
      setDiff('');
      flash(snapshot?.error || t('harnessModelRole.loadFailed'), 'error');
      return;
    }
    currentModel = buildModelRoleConfigViewModel({
      ...snapshot,
      overrides: overridesSnapshot?.overrides || [],
      overridesEtag: overridesSnapshot?.etag || '',
    }, t);
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
 * Read the compact create form and submit one audited override. The server
 * stamps `createdBy`, `source` and `createdAt`; this only sends the operator's
 * intent.
 *
 * @returns {Promise<void>}
 */
async function createOverride() {
  const out = outputEl();
  if (!currentModel || !out) return;
  /** @param {string} name */
  const field = (name) => out.querySelector(`[data-override-field="${name}"]`);
  const value = (name) => String(field(name)?.value || '').trim();
  const ttlHours = Math.max(1, Math.min(720, Number(value('ttlHours')) || 24));
  const body = {
    action: value('action'),
    targetHarness: value('targetHarness'),
    targetModel: value('targetModel'),
    targetRole: value('targetRole'),
    reason: value('reason'),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
  };
  flash(t('harnessModelRole.saving'));
  try {
    const result = await putModelPickOverride(body, currentModel.overridesEtag);
    if (!result?.ok) {
      flash(result?.conflict ? t('harnessModelRole.conflict') : (result?.error || t('harnessModelRole.overridesSaveFailed')), 'error');
      return;
    }
    await loadHarnessModelRoleConfig(true);
    flash(t('harnessModelRole.overridesCreated'), 'success');
  } catch {
    flash(t('harnessModelRole.overridesSaveFailed'), 'error');
  }
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function revokeOverride(id) {
  if (!currentModel || !id) return;
  flash(t('harnessModelRole.saving'));
  try {
    const result = await revokeModelPickOverride(id, currentModel.overridesEtag, 'revoked from Settings');
    if (!result?.ok) {
      flash(result?.conflict ? t('harnessModelRole.conflict') : (result?.error || t('harnessModelRole.saveFailed')), 'error');
      return;
    }
    await loadHarnessModelRoleConfig(true);
    flash(t('harnessModelRole.overridesRevoked'), 'success');
  } catch {
    flash(t('harnessModelRole.saveFailed'), 'error');
  }
}

/**
 * @returns {Promise<void>}
 */
async function resetOverrides() {
  if (!currentModel) return;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
    && !window.confirm(t('harnessModelRole.resetConfirm'))) return;
  flash(t('harnessModelRole.overridesResetting'));
  try {
    const result = await resetModelPickOverrides(currentModel.overridesEtag);
    if (!result?.ok) {
      flash(result?.conflict ? t('harnessModelRole.conflict') : (result?.error || t('harnessModelRole.resetFailed')), 'error');
      return;
    }
    await loadHarnessModelRoleConfig(true);
    flash(t('harnessModelRole.overridesResetDone', { backup: result.backupPath || '—' }), 'success');
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
  // The override list is re-rendered on every load, so a delegated listener on
  // the section survives the re-render.
  section.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const revokeId = target.closest('[data-override-revoke]')?.getAttribute('data-override-revoke');
    if (revokeId) {
      void revokeOverride(revokeId);
      return;
    }
    if (target.closest('[data-override-create]')) {
      void createOverride();
      return;
    }
    if (target.closest('[data-override-reset]')) {
      void resetOverrides();
    }
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
