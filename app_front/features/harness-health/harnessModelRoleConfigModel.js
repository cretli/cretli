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
 * `cr-bar-select` takes its options as a property, so the renderer emits them as
 * JSON and the controller assigns them after the markup is inserted
 * (`hydrateSelectOptions`).
 *
 * @param {string} attrs extra, already escaped attributes
 * @param {Array<{ value: string, label: string }>} options
 * @param {string} value
 * @returns {string}
 */
function selectHtml(attrs, options, value) {
  return `<cr-bar-select ${attrs} value="${h(value)}" data-options="${h(JSON.stringify(options))}"></cr-bar-select>`;
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
    })).sort((left, right) => (left.priority - right.priority) || (left.pattern < right.pattern ? -1 : 1));
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
    availableAliases: Array.isArray(source.availableAliases) ? source.availableAliases.map(text) : [],
    rotation: source.rotation || { mode: 'balanced', band: 0.05 },
    defaultRotation: source.defaultRotation || { mode: 'balanced', band: 0.05 },
    adaptive: source.adaptive || { enabled: true },
    defaultAdaptive: source.defaultAdaptive || { enabled: true },
    // Explore lives in the same file but is read-only in this panel.
    explore: source.explore || null,
    defaultExplore: source.defaultExplore || null,
    // Audited overrides are a separate store, merged by the controller.
    overrides: Array.isArray(source.overrides) ? source.overrides.map((row) => ({
      id: text(row.id),
      scope: text(row.scope || 'global'),
      action: text(row.action),
      targetHarness: text(row.targetHarness),
      targetModel: text(row.targetModel),
      targetRole: text(row.targetRole),
      reason: text(row.reason),
      createdBy: text(row.createdBy),
      source: text(row.source),
      createdAt: text(row.createdAt),
      expiresAt: text(row.expiresAt),
      revokedAt: text(row.revokedAt),
    })) : [],
    overridesEtag: text(source.overridesEtag || ''),
    exploreStatus: source.exploreStatus && typeof source.exploreStatus === 'object' ? source.exploreStatus : null,
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
    + `<span class="cr-badge harness-model-role-badge" data-tone="${h(model.state)}">${h(t('harnessModelRole.stateBadge', { state: model.state }))}</span>`
    + `<span class="cr-badge harness-model-role-badge">${h(t('harnessModelRole.etagBadge', { etag: model.etag.slice(0, 12) }))}</span>`
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

  parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.intro'))}</p>`);
  for (const role of model.roles) {
    const active = role.options.filter((option) => option.checked);
    parts.push(`<cr-collapsible class="harness-model-role-group" data-role="${h(role.role)}">`);
    parts.push(`<span slot="heading"><span class="harness-model-role-name">${h(role.label)}</span> `
      + `<span class="harness-model-role-count">${h(t('harnessModelRole.activeCount', { count: role.locked ? role.preserved.length : active.length }))}</span></span>`
      + (role.locked ? `<span slot="meta" class="cr-badge harness-model-role-badge" data-tone="warning">${h(t('harnessModelRole.lockedBadge'))}</span>` : ''));
    if (!role.locked) {
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.orderHint'))}</p>`);
    }
    if (role.locked) {
      parts.push(`<p class="harness-model-role-hint" data-tone="warning">${h(t('harnessModelRole.roleLocked'))}</p>`);
      parts.push('<ul class="harness-model-role-preserved">');
      for (const row of role.preserved) {
        parts.push(`<li>${h(row.pattern)} <span class="harness-model-role-sub">${h(row.deny ? t('harnessModelRole.deny') : (row.reason ? t(`harnessModelRole.reason_${row.reason}`) : row.mode))}</span></li>`);
      }
      parts.push('</ul>');
    } else {
      if (role.legacyOverride) {
        parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.legacyOverride'))}</p>`);
      }
      parts.push('<div class="cr-sort-list harness-model-role-rules">');
      for (const option of role.options) {
        parts.push(`<div class="cr-sort-row harness-model-role-rule" data-role-row="${h(option.pattern)}">`
          + `<button type="button" class="harness-setup-drag" aria-label="${h(t('harnessModelRole.reorderHandle', { pattern: option.pattern }))}"><span class="mdi mdi-drag" aria-hidden="true"></span></button>`
          + `<cr-checkbox class="harness-model-role-check" data-role="${h(role.role)}" data-pattern="${h(option.pattern)}"${option.checked ? ' checked' : ''}>${h(option.pattern)}</cr-checkbox>`
          + (option.removable ? `<span class="cr-badge">${h(t('harnessModelRole.operatorRule'))}</span>` : '')
          + `<cr-bar-input type="number" min="0" step="1" class="harness-model-role-priority" data-priority="${h(role.role)}:${h(option.pattern)}" value="${h(option.priority)}" aria-label="${h(t('harnessModelRole.priorityLabel', { pattern: option.pattern }))}"></cr-bar-input>`
          + '</div>');
      }
      parts.push('</div>');
      const taken = new Set(role.options.map((option) => option.pattern));
      const addable = (model.availableAliases || []).filter((alias) => !taken.has(alias));
      if (addable.length > 0) {
        parts.push(`<div class="cr-row harness-model-role-add" data-role-add="${h(role.role)}">`
          + selectHtml(`data-role-add-pattern aria-label="${h(t('harnessModelRole.addFamilyLabel'))}"`, [{ value: '', label: t('harnessModelRole.addFamilyPlaceholder') }, ...addable.map((alias) => ({ value: alias, label: alias }))], '')
          + `<cr-bar-input type="number" min="0" step="1" value="5" class="harness-model-role-priority" data-role-add-priority aria-label="${h(t('harnessModelRole.addFamilyPriority'))}"></cr-bar-input>`
          + `<cr-bar-button data-role-add-btn>${h(t('harnessModelRole.addFamilyButton'))}</cr-bar-button>`
          + '</div>');
      }
    }
    parts.push('</cr-collapsible>');
  }

  parts.push('<div class="harness-model-role-tuning">');
  parts.push(`<div class="cr-field"><span class="cr-field-label">${h(t('harnessModelRole.rotationMode'))}</span>`
    + selectHtml('data-field="rotation-mode"', ['off', 'balanced', 'explore'].map((mode) => ({ value: mode, label: t(`harnessModelRole.rotation_${mode}`) })), model.rotation?.mode || 'balanced')
    + '</div>');
  parts.push(`<div class="cr-field"><span class="cr-field-label">${h(t('harnessModelRole.rotationBand'))}</span>`
    + `<cr-bar-input type="number" min="0" step="0.01" class="harness-model-role-band" data-field="rotation-band" value="${h(model.rotation?.band ?? 0)}"></cr-bar-input></div>`);
  parts.push(`<cr-checkbox data-field="adaptive-enabled"${model.adaptive?.enabled === true ? ' checked' : ''}>${h(t('harnessModelRole.adaptiveEnabled'))}</cr-checkbox>`);
  if (model.explore) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.exploreReadOnly', { mode: model.explore.mode }))}</p>`);
  }
  parts.push('</div>');

  parts.push(renderOverridesHtml(model, t));
  parts.push(renderExploreStatusHtml(model, t));

  parts.push('</div>');
  return parts.join('');
}

/**
 * Render the audited override list plus the compact create form. The server
 * still owns the author/time fields; this form only collects the operator's
 * intent.
 *
 * @param {object} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderOverridesHtml(model, t) {
  const overrides = Array.isArray(model.overrides) ? model.overrides : [];
  const parts = ['<div class="harness-model-overrides">'];
  parts.push(`<h4>${h(t('harnessModelRole.overridesTitle'))}</h4>`);
  parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.overridesHint'))}</p>`);
  if (overrides.length === 0) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.overridesEmpty'))}</p>`);
  } else {
    parts.push('<ul class="harness-model-override-list">');
    for (const row of overrides) {
      const active = !row.revokedAt && Date.parse(row.expiresAt) > Date.now();
      const target = [row.targetHarness, row.targetModel, row.targetRole].filter(Boolean).join(' / ') || '—';
      parts.push(`<li data-override-id="${h(row.id)}">`
        + `<span class="cr-badge harness-model-role-badge" data-tone="${active ? 'active' : 'revoked'}">${h(active ? t('harnessModelRole.overridesActive') : t('harnessModelRole.overridesRevoked'))}</span>`
        + `<strong>${h(row.action)}</strong> ${h(target)}`
        + `<span class="harness-model-role-sub">${h(row.reason)}</span>`
        + `<span class="harness-model-role-sub">${h(t('harnessModelRole.overridesCreatedBy'))}: ${h(row.createdBy)} · ${h(t('harnessModelRole.overridesExpires'))}: ${h(row.expiresAt)}</span>`
        + (active ? `<cr-bar-button data-override-revoke="${h(row.id)}">${h(t('harnessModelRole.overridesRevoke'))}</cr-bar-button>` : '')
        + '</li>');
    }
    parts.push('</ul>');
  }
  parts.push('<div class="harness-model-override-form">');
  const field = (labelKey, control) => `<div class="cr-field"><span class="cr-field-label">${h(t(labelKey))}</span>${control}</div>`;
  parts.push(field('harnessModelRole.overridesAction', selectHtml('data-override-field="action"', [
    { value: 'prefer', label: t('harnessModelRole.overridesPrefer') },
    { value: 'exclude', label: t('harnessModelRole.overridesExclude') },
    { value: 'explicit-orchestrator', label: t('harnessModelRole.overridesExplicit') },
  ], 'exclude')));
  parts.push(field('harnessModelRole.overridesTargetHarness', '<cr-bar-input type="text" data-override-field="targetHarness"></cr-bar-input>'));
  parts.push(field('harnessModelRole.overridesTargetModel', '<cr-bar-input type="text" data-override-field="targetModel"></cr-bar-input>'));
  parts.push(field('harnessModelRole.overridesTargetRole', selectHtml('data-override-field="targetRole"', [
    { value: '', label: t('harnessModelRole.overridesAnyRole') },
    ...MODEL_ROLE_CONFIG_ROLES.map((role) => ({ value: role, label: roleLabel(role, t) })),
  ], '')));
  parts.push(field('harnessModelRole.overridesReason', '<cr-bar-input type="text" data-override-field="reason"></cr-bar-input>'));
  parts.push(field('harnessModelRole.overridesTtlHours', '<cr-bar-input type="number" min="1" max="720" step="1" value="24" data-override-field="ttlHours"></cr-bar-input>'));
  parts.push(`<div class="cr-row"><cr-bar-button variant="primary" data-override-create>${h(t('harnessModelRole.overridesCreate'))}</cr-bar-button>`
    + `<cr-bar-button data-override-reset>${h(t('harnessModelRole.reset'))}</cr-bar-button></div>`);
  parts.push('</div>');
  parts.push('</div>');
  return parts.join('');
}

/**
 * Render the read-only explore status. Rotation cold-start stays a distinct
 * ranking signal; the out-of-band ledger is the attempt list below.
 *
 * @param {object} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderExploreStatusHtml(model, t) {
  const status = model.exploreStatus;
  if (!status || typeof status !== 'object') return '';
  const parts = ['<div class="harness-model-explore-status">'];
  parts.push(`<h4>${h(t('harnessModelRole.exploreStatusTitle'))}</h4>`);
  parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.exploreStatusHint'))}</p>`);
  parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.exploreOpenReservations'))}: ${h((status.open || []).length)}`
    + ` · ${h(t('harnessModelRole.exploreAttempts'))}: ${h(status.attemptCount || 0)}`
    + ` · ${h(t('harnessModelRole.exploreConsumed'))}: ${h(status.consumed || 0)}</p>`);
  if (Array.isArray(status.recent) && status.recent.length > 0) {
    parts.push(`<p class="harness-model-role-sub">${h(t('harnessModelRole.exploreRecent'))}: ${h(status.recent.map((row) => `${row.pairKey || ''}:${row.status || row.outcome || ''}`).join(', '))}</p>`);
  }
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
