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
} from '../../core/api/index.js';
import '../../components/ui/index.js';
import { readBarInputLiveValue } from '../../components/ui/read-bar-input-live-value.js';
import { t } from '../../i18n/index.js';
import { initHarnessOrderDrag } from '../chat/harnessOrderDrag.js';
import {
  buildModelRoleConfigViewModel,
  computeModelRoleConfigDelta,
  renderModelRoleConfigDiffHtml,
  renderModelRoleConfigHtml,
} from './harnessModelRoleConfigModel.js';

let wired = false;
let loadSeq = 0;
/** @type {Record<string, any>|null} */
let currentModel = null;
/** @type {{ harness: string, model: string } | null} */
let pendingPrefill = null;

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
    for (const box of out.querySelectorAll('cr-checkbox[data-role][data-pattern]')) {
      const role = String(box.dataset.role || '');
      const pattern = String(box.dataset.pattern || '');
      if (!role || !pattern) continue;
      // Register the role even when every rule is unchecked, so "remove all"
      // is distinct from "this role was not edited".
      if (!roles[role]) roles[role] = [];
      if (!box.checked) continue;
      const priorityInput = out.querySelector(`cr-bar-input[data-priority="${CSS.escape(`${role}:${pattern}`)}"]`);
      const priority = Number(readBarInputLiveValue(priorityInput));
      roles[role].push({ pattern, priority: Number.isFinite(priority) ? priority : 0 });
    }
  }
  const mode = String(out?.querySelector('[data-field="rotation-mode"]')?.value || 'balanced');
  const band = Number(readBarInputLiveValue(out?.querySelector('[data-field="rotation-band"]')));
  const adaptiveEl = out?.querySelector('[data-field="adaptive-enabled"]');
  return {
    roles,
    rotation: { mode, band: Number.isFinite(band) ? band : 0 },
    adaptive: { enabled: adaptiveEl ? adaptiveEl.checked === true : true },
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
 * `cr-bar-select` options are a property; the renderer ships them as JSON.
 *
 * @param {ParentNode} root
 * @returns {void}
 */
function hydrateSelectOptions(root) {
  for (const select of root.querySelectorAll('cr-bar-select[data-options]')) {
    try {
      select.options = JSON.parse(select.getAttribute('data-options') || '[]');
    } catch {
      select.options = [];
    }
  }
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
    hydrateSelectOptions(out);
    setDiff('');
    flash('');
    applyPendingPrefill();
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
    /** @type {Record<string, any>} */
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
    /** @type {Record<string, any>} */
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
    /** @type {Record<string, any>} */
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
  const value = (name) => {
    const el = field(name);
    return String((el?.tagName === 'CR-BAR-INPUT' ? readBarInputLiveValue(el) : el?.value) || '').trim();
  };
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
    /** @type {Record<string, any>} */
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
    /** @type {Record<string, any>} */
    const result = await revokeModelPickOverride(id, currentModel.overridesEtag, 'revoked from Settings');
    if (!result?.ok) {
      flash(result?.conflict ? t('harnessModelRole.conflict') : (result?.error || t('harnessModelRole.saveFailed')), 'error');
      return;
    }
    await loadHarnessModelRoleConfig(true);
    flash(t('harnessModelRole.overridesRevokeSuccess'), 'success');
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
    /** @type {Record<string, any>} */
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
 * After a drag the visual order is the intent: write it back as priorities
 * 0..n-1 so the saved delta reproduces exactly what the user sees. Ties from
 * the policy baseline are dropped on purpose; they have no defined order.
 *
 * @param {HTMLElement} list
 * @returns {void}
 */
function renumberRolePriorities(list) {
  let rank = 0;
  for (const input of list.querySelectorAll('.harness-model-role-priority')) {
    input.value = String(rank);
    rank += 1;
  }
  flash(t('harnessModelRole.reorderedHint'));
}

/**
 * Add a model family to a role as a checked rule row. Nothing is persisted
 * until Save, so the usual Preview / Save flow covers the new rule.
 *
 * @param {Element|null} box
 * @returns {void}
 */
function addRoleFamily(box) {
  const role = String(box?.getAttribute('data-role-add') || '');
  const select = box?.querySelector('[data-role-add-pattern]');
  const priorityInput = box?.querySelector('[data-role-add-priority]');
  const pattern = String(select?.value || '');
  const rules = box?.parentElement?.querySelector('.harness-model-role-rules');
  if (!role || !pattern || !rules) return;
  const priority = Math.max(0, Number(readBarInputLiveValue(priorityInput)) || 0);
  const row = document.createElement('div');
  row.className = 'cr-sort-row harness-model-role-rule';
  row.dataset.roleRow = pattern;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'harness-setup-drag';
  handle.setAttribute('aria-label', t('harnessModelRole.reorderHandle', { pattern }));
  const grip = document.createElement('span');
  grip.className = 'mdi mdi-drag';
  grip.setAttribute('aria-hidden', 'true');
  handle.append(grip);
  const check = document.createElement('cr-checkbox');
  check.className = 'harness-model-role-check';
  check.setAttribute('checked', '');
  check.dataset.role = role;
  check.dataset.pattern = pattern;
  check.textContent = pattern;
  const badge = document.createElement('span');
  badge.className = 'cr-badge';
  badge.textContent = t('harnessModelRole.addedPending');
  const prio = document.createElement('cr-bar-input');
  prio.setAttribute('type', 'number');
  prio.setAttribute('min', '0');
  prio.setAttribute('step', '1');
  prio.className = 'harness-model-role-priority';
  prio.dataset.priority = `${role}:${pattern}`;
  prio.value = String(priority);
  row.append(handle, check, badge, prio);
  // Keep the list in priority order: land before the first row that is tried later.
  const later = [...rules.querySelectorAll('.harness-model-role-priority')]
    .find((input) => Number(readBarInputLiveValue(input)) > priority);
  rules.insertBefore(row, later ? later.closest('.harness-model-role-rule') : null);
  select.options = (select.options || []).filter((option) => option.value !== pattern);
  select.value = '';
  flash(t('harnessModelRole.addedHint'));
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
  // One delegated drag host for every role list; the panel is re-rendered on
  // each load, so listeners must live on the stable output element.
  initHarnessOrderDrag({
    listEl: outputEl(),
    rowSelector: '.harness-model-role-rule',
    handleSelector: '.harness-setup-drag',
    containerSelector: '.harness-model-role-rules',
    rowId: (row) => String(row.dataset.roleRow || ''),
    onOrderChange: (_ids, list) => renumberRolePriorities(list),
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
    const addBtn = target.closest('[data-role-add-btn]');
    if (addBtn) {
      addRoleFamily(addBtn.closest('[data-role-add]'));
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

/**
 * Fill the override form with a model and bring it into view.
 *
 * @returns {void}
 */
function applyPendingPrefill() {
  const out = outputEl();
  if (!pendingPrefill || !out) return;
  const form = out.querySelector('.harness-model-override-form');
  if (!form) return;
  const { harness, model } = pendingPrefill;
  pendingPrefill = null;
  const harnessInput = form.querySelector('[data-override-field="targetHarness"]');
  const modelInput = form.querySelector('[data-override-field="targetModel"]');
  if (harnessInput) harnessInput.value = harness;
  if (modelInput) modelInput.value = model;
  const prefer = form.querySelector('[data-override-field="action"]');
  if (prefer) prefer.value = 'prefer';
  form.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Entry point for the per-model "roles" shortcut in the model lists: the
 * override form gets the model prefilled once the panel is rendered.
 *
 * @param {{ harness: string, model: string }} target
 * @returns {void}
 */
export function prefillModelRoleOverride(target) {
  pendingPrefill = { harness: String(target.harness || ''), model: String(target.model || '') };
  const out = outputEl();
  if (out && out.childElementCount > 0) applyPendingPrefill();
}
