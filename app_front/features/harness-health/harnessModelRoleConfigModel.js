/**
 * Settings → Harness: audited model-role editor view model and renderer.
 *
 * DOM-free so the unit tests can import it under Node. The caller owns
 * translation: the renderer receives a `t()` function. The delta computation is
 * the mirror of the server's editable view — it only emits `set`/`remove` for
 * verified alias rules that actually differ from the policy baseline, so a save
 * never rewrites an unchanged rule or an unknown field.
 */

import { escapeHtml } from '../usage/usageCharts.js';

/** Roles the editor exposes, in picker order. */
export const MODEL_ROLE_CONFIG_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

const ROLE_LABEL_KEYS = Object.freeze({
  plan: 'harnessModelRole.rolePlan',
  implement: 'harnessModelRole.roleImplement',
  review: 'harnessModelRole.roleReview',
  fix: 'harnessModelRole.roleFix',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value == null ? '' : value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function h(value) {
  return escapeHtml(text(value));
}

/**
 * @param {string} role
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function roleLabel(role, t) {
  return t(ROLE_LABEL_KEYS[role] || role);
}

/**
 * Build the editable, DOM-free model for the panel.
 *
 * @param {object|null} snapshot GET /api/harness-model-role-config payload
 * @param {(key: string, values?: object) => string} t
 * @returns {object}
 */
export function buildModelRoleConfigViewModel(snapshot, t = (key) => key) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const roles = MODEL_ROLE_CONFIG_ROLES.map((role) => {
    const view = source.roles && typeof source.roles === 'object' ? source.roles[role] || {} : {};
    const ruleMap = new Map((Array.isArray(view.rules) ? view.rules : []).map((row) => [text(row.pattern), Number(row.priority) || 0]));
    const policyRules = Array.isArray(view.policyRules) ? view.policyRules : [];
    const policyMap = new Map(policyRules.map((row) => [text(row.pattern), Number(row.priority) || 0]));
    const patterns = [...new Set([...policyMap.keys(), ...ruleMap.keys()])]
      .filter(Boolean)
      .sort();
    const options = patterns.map((pattern) => ({
      pattern,
      priority: ruleMap.has(pattern) ? ruleMap.get(pattern) : (policyMap.get(pattern) ?? 0),
      checked: ruleMap.has(pattern),
      source: ruleMap.has(pattern) ? text((view.rules || []).find((row) => text(row.pattern) === pattern)?.source) : 'policy',
      removable: !policyMap.has(pattern),
    }));
    return {
      role,
      label: roleLabel(role, t),
      locked: view.locked === true,
      legacyOverride: view.legacyOverride === true,
      policyRules: policyRules.map((row) => ({ pattern: text(row.pattern), priority: Number(row.priority) || 0 })),
      options,
      rules: Array.isArray(view.rules) ? view.rules.map((row) => ({ pattern: text(row.pattern), priority: Number(row.priority) || 0 })) : [],
      preserved: Array.isArray(view.preserved) ? view.preserved.map((row) => ({
        pattern: text(row.pattern),
        mode: text(row.mode),
        deny: row.deny === true,
        reason: text(row.reason),
      })) : [],
    };
  });
  return {
    state: text(source.state || 'missing'),
    error: text(source.error),
    etag: text(source.etag),
    unknownTopLevelKeys: Array.isArray(source.unknownTopLevelKeys) ? source.unknownTopLevelKeys.map(text) : [],
    roles,
    rotation: source.rotation || { mode: 'balanced', band: 0.05 },
    defaultRotation: source.defaultRotation || { mode: 'balanced', band: 0.05 },
    adaptive: source.adaptive || { enabled: true },
    defaultAdaptive: source.defaultAdaptive || { enabled: true },
    // Explore lives in the same file but is read-only in this panel.
    explore: source.explore || null,
    defaultExplore: source.defaultExplore || null,
    weights: source.weights || {},
    defaultWeights: source.defaultWeights || {},
  };
}

/**
 * Compute the per-role delta relative to the policy baseline. Order-independent
 * by construction: `remove` is the policy patterns absent from the desired set,
 * `set` only carries desired patterns that are new or whose priority differs.
 *
 * @param {{ policy: Array<{ pattern: string, priority?: number }>, desired: Array<{ pattern: string, priority?: number }> }} input
 * @returns {{ set?: Record<string, { priority: number }>, remove?: string[] } | null}
 */
export function computeRoleDelta(input) {
  const policy = new Map((input?.policy || []).map((row) => [text(row.pattern), Number(row.priority) || 0]));
  const desired = new Map();
  for (const row of input?.desired || []) {
    const pattern = text(row.pattern);
    if (!pattern) continue;
    desired.set(pattern, Number(row.priority) || 0);
  }
  /** @type {Record<string, { priority: number }>} */
  const set = {};
  const remove = [];
  for (const [pattern, priority] of [...desired].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (!policy.has(pattern) || policy.get(pattern) !== priority) set[pattern] = { priority };
  }
  for (const pattern of [...policy.keys()].sort()) {
    if (!desired.has(pattern)) remove.push(pattern);
  }
  if (Object.keys(set).length === 0 && remove.length === 0) return null;
  const delta = {};
  if (Object.keys(set).length > 0) delta.set = set;
  if (remove.length > 0) delta.remove = remove;
  return delta;
}

/**
 * Compute the full delta for a desired editor state. Locked roles are skipped
 * (the server would reject them) and rotation/adaptive are only emitted when
 * they actually differ.
 *
 * @param {{
 *   model: object,
 *   desired: {
 *     roles: Record<string, Array<{ pattern: string, priority?: number }>>,
 *     rotation?: { mode: string, band: number },
 *     adaptive?: { enabled: boolean },
 *   },
 * }} input
 * @returns {object}
 */
export function computeModelRoleConfigDelta(input) {
  const model = input?.model || {};
  const desired = input?.desired || {};
  /** @type {Record<string, object>} */
  const roles = {};
  for (const role of MODEL_ROLE_CONFIG_ROLES) {
    const view = (model.roles || []).find((row) => row.role === role);
    if (!view || view.locked) continue;
    // A role that is not present in the desired state was not touched; a
    // present-but-empty list means "remove every policy rule for this role".
    if (!Object.prototype.hasOwnProperty.call(desired.roles || {}, role)) continue;
    const roleDelta = computeRoleDelta({
      policy: view.policyRules || [],
      desired: desired.roles?.[role] || [],
    });
    if (roleDelta) roles[role] = roleDelta;
  }
  const delta = {};
  if (Object.keys(roles).length > 0) delta.roles = roles;
  if (desired.rotation && (desired.rotation.mode !== model.rotation?.mode || Number(desired.rotation.band) !== Number(model.rotation?.band))) {
    delta.rotation = { mode: desired.rotation.mode, band: Number(desired.rotation.band) };
  }
  if (desired.adaptive && desired.adaptive.enabled !== (model.adaptive?.enabled === true)) {
    delta.adaptive = { enabled: desired.adaptive.enabled === true };
  }
  return delta;
}

/**
 * @param {object} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderModelRoleConfigHtml(model, t) {
  const parts = [];
  parts.push('<div class="harness-model-role">');
  parts.push('<div class="harness-model-role-meta">'
    + `<span class="harness-model-role-badge" data-tone="${h(model.state)}">${h(t('harnessModelRole.stateBadge', { state: model.state }))}</span>`
    + `<span class="harness-model-role-badge">${h(t('harnessModelRole.etagBadge', { etag: model.etag.slice(0, 12) }))}</span>`
    + '</div>');
  if (model.state === 'invalid') {
    const detail = model.error ? ` — ${h(model.error)}` : '';
    parts.push(`<p class="harness-model-role-alert" data-tone="error">${h(t('harnessModelRole.configInvalid'))}${detail}</p>`);
  } else if (model.state === 'missing') {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.configMissing'))}</p>`);
  }
  if (model.unknownTopLevelKeys.length > 0) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.unknownKeys', { keys: model.unknownTopLevelKeys.join(', ') }))}</p>`);
  }

  for (const role of model.roles) {
    parts.push(`<fieldset class="harness-model-role-group" data-role="${h(role.role)}">`);
    parts.push(`<legend>${h(role.label)}</legend>`);
    if (role.locked) {
      parts.push(`<p class="harness-model-role-hint" data-tone="warning">${h(t('harnessModelRole.roleLocked'))}</p>`);
      parts.push('<ul class="harness-model-role-preserved">');
      for (const row of role.preserved) {
        parts.push(`<li>${h(row.pattern)} <span class="harness-model-role-sub">${h(row.deny ? t('harnessModelRole.deny') : row.mode || row.reason)}</span></li>`);
      }
      parts.push('</ul>');
    } else {
      if (role.legacyOverride) {
        parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.legacyOverride'))}</p>`);
      }
      parts.push('<div class="harness-model-role-rules">');
      for (const option of role.options) {
        parts.push('<label class="cr-check harness-model-role-rule">'
          + `<input type="checkbox" data-role="${h(role.role)}" data-pattern="${h(option.pattern)}"${option.checked ? ' checked' : ''}>`
          + `<span>${h(option.pattern)}</span>`
          + `<input type="number" min="0" step="1" class="harness-model-role-priority" data-priority="${h(role.role)}:${h(option.pattern)}" value="${h(option.priority)}" aria-label="${h(t('harnessModelRole.priorityLabel', { pattern: option.pattern }))}">`
          + (option.removable ? `<span class="harness-model-role-sub">${h(t('harnessModelRole.operatorRule'))}</span>` : '')
          + '</label>');
      }
      parts.push('</div>');
    }
    parts.push('</fieldset>');
  }

  parts.push('<div class="harness-model-role-tuning">');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${h(t('harnessModelRole.rotationMode'))}</span>`
    + `<select class="harness-model-role-select" data-field="rotation-mode">`
    + ['off', 'balanced', 'explore'].map((mode) => `<option value="${mode}"${model.rotation?.mode === mode ? ' selected' : ''}>${h(t(`harnessModelRole.rotation_${mode}`))}</option>`).join('')
    + '</select></label>');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${h(t('harnessModelRole.rotationBand'))}</span>`
    + `<input type="number" min="0" step="0.01" class="harness-model-role-band" data-field="rotation-band" value="${h(model.rotation?.band ?? 0)}"></label>`);
  parts.push(`<label class="cr-check"><input type="checkbox" data-field="adaptive-enabled"${model.adaptive?.enabled === true ? ' checked' : ''}>`
    + `<span>${h(t('harnessModelRole.adaptiveEnabled'))}</span></label>`);
  if (model.explore) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.exploreReadOnly', { mode: model.explore.mode }))}</p>`);
  }
  parts.push('</div>');

  parts.push('</div>');
  return parts.join('');
}

/**
 * Render the server-computed diff (what a save would change).
 *
 * @param {object|null} diff
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderModelRoleConfigDiffHtml(diff, t) {
  if (!diff || typeof diff !== 'object') return '';
  const parts = ['<div class="harness-model-role-diff">'];
  if (diff.blocked === true) {
    parts.push(`<p class="harness-model-role-alert" data-tone="error">${h(t('harnessModelRole.diffBlocked'))}</p>`);
  }
  if (diff.changed !== true) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.diffNone'))}</p>`);
    parts.push('</div>');
    return parts.join('');
  }
  for (const [role, roleDiff] of Object.entries(diff.roles || {})) {
    parts.push(`<div class="harness-model-role-diff-row"><strong>${h(role)}</strong>`);
    for (const row of roleDiff.added || []) {
      parts.push(`<span class="harness-model-role-badge" data-tone="added">+ ${h(row.pattern)} (${h(row.priority)})</span>`);
    }
    for (const row of roleDiff.removed || []) {
      parts.push(`<span class="harness-model-role-badge" data-tone="removed">− ${h(row.pattern)}</span>`);
    }
    for (const row of roleDiff.updated || []) {
      parts.push(`<span class="harness-model-role-badge" data-tone="updated">~ ${h(row.pattern)} ${h(row.from)}→${h(row.to)}</span>`);
    }
    parts.push('</div>');
  }
  if (diff.rotation) {
    parts.push(`<div class="harness-model-role-diff-row"><strong>${h(t('harnessModelRole.rotationMode'))}</strong>`
      + `<span class="harness-model-role-badge" data-tone="updated">${h(diff.rotation.from?.mode)} → ${h(diff.rotation.to?.mode)}</span></div>`);
  }
  if (diff.adaptive) {
    parts.push(`<div class="harness-model-role-diff-row"><strong>${h(t('harnessModelRole.adaptiveEnabled'))}</strong>`
      + `<span class="harness-model-role-badge" data-tone="updated">${h(String(diff.adaptive.from?.enabled))} → ${h(String(diff.adaptive.to?.enabled))}</span></div>`);
  }
  if (diff.weights) {
    for (const [role, row] of Object.entries(diff.weights)) {
      parts.push(`<div class="harness-model-role-diff-row"><strong>${h(role)}</strong>`
        + `<span class="harness-model-role-badge" data-tone="updated">${h(t('harnessModelRole.weightsChanged', {
          from: `${row.from?.cost}/${row.from?.quality}/${row.from?.speed}`,
          to: `${row.to?.cost}/${row.to?.quality}/${row.to?.speed}`,
        }))}</span></div>`);
    }
  }
  parts.push('</div>');
  return parts.join('');
}
