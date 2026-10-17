/**
 * Settings → Delegations subtabs (Limits / Review / Models). The Review subtab
 * holds the Reviewers and Session continuation groups, per review subject.
 *
 * One GET `/api/delegation-settings` feeds all three panels; Save sends a PATCH
 * with only the fields the operator changed. This is the single write path for
 * delegation options — Usage and Watcher only link here. `scope=server` fields
 * are read-only previews of the env value.
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { readBarInputLiveValue } from '../../components/ui/read-bar-input-live-value.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../watcher/watcherWorkspaceScope.js';

const API_PATH = '/api/delegation-settings';
const PAIR_SEPARATOR = '\u0001';

/** Fields per editable subtab, in render order. `kind` selects the control. */
export const DELEGATION_SUBTAB_FIELDS = Object.freeze({
  limits: [
    { field: 'max_depth', kind: 'int', min: 1, max: 8 },
    { field: 'tree_slot_limit', kind: 'int', min: 0 },
    { field: 'run_deadline_implement_ms', kind: 'int', min: 0 },
    { field: 'run_deadline_review_fix_ms', kind: 'int', min: 0 },
    { field: 'cancelling_timeout_ms', kind: 'int', min: 1 },
    { field: 'global_limit', kind: 'int', min: 0 },
    { field: 'queue_max', kind: 'int', min: 0 },
    { field: 'parallel_implement_fanout', kind: 'fanout' },
  ],
  review: [
    { field: 'review_fanout', kind: 'fanout' },
    { field: 'review_allow_uncertified', kind: 'bool' },
    { field: 'codex_review_sandbox', kind: 'bool' },
    { field: 'code_review_phase', kind: 'bool' },
    { field: 'code_review_max_closures', kind: 'int', min: 0 },
    { field: 'reviewer_policy', kind: 'reviewer_policy' },
  ],
  models: [
    { field: 'empty_favorites', kind: 'enum', options: ['deny', 'all'] },
    { field: 'plan_window_enabled', kind: 'bool' },
    { field: 'plan_window_hard_free_percent', kind: 'int', min: 1, max: 20 },
  ],
});

/**
 * Stored only for rollback / `review:other`; superseded by `reviewer_policy`
 * and shown as a read-only migration summary instead of controls.
 */
export const DELEGATION_LEGACY_FIELDS = Object.freeze(['reviewer_pair_enabled', 'reviewer_pair_members', 'reviewer_pair_strict']);

/** Review subjects with their own reviewer policy (`other` stays legacy-only). */
export const REVIEWER_POLICY_SUBJECTS = Object.freeze(['plan', 'code']);

/** @type {{ data: object | null, favorites: Array<{ harness: string, model: string, label: string }> }} */
const state = { data: null, favorites: [], harnesses: [], favoritesAt: 0, favoritesPromise: null, favoritesPaintedFor: null, dirty: new Set() };
/** Favorites change rarely; reuse them across tab entries for this long. */
const FAVORITES_TTL_MS = 60_000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.map((m) => `${m.harness}/${m.model}`).join(', ') : t('settings.delegationSettingsNone');
  }
  if (typeof value === 'boolean') return t(value ? 'settings.delegationSettingsOn' : 'settings.delegationSettingsOff');
  return String(value ?? '');
}

/**
 * Only the fields whose control value differs from the loaded effective value.
 *
 * @param {Record<string, unknown>} baseline effective values from the API
 * @param {Record<string, unknown>} current values read from the form
 * @returns {Record<string, unknown>}
 */
export function buildDelegationPatch(baseline, current) {
  const patch = {};
  for (const [field, value] of Object.entries(current || {})) {
    if (JSON.stringify(value) !== JSON.stringify(baseline?.[field])) patch[field] = value;
  }
  return patch;
}


/**
 * Stored shape of one policy entry (what PATCH sends back).
 *
 * @param {object} entry view entry or form value
 * @returns {{ selection: string, members_source: string, members: Array<{ harness: string, model: string }>, session: string }}
 */
export function toStoredPolicy(entry) {
  const selection = entry?.selection === 'fixed_pair' ? 'fixed_pair' : 'auto';
  const membersSource = entry?.members_source === 'configured' ? 'configured' : 'learned';
  return {
    selection,
    members_source: selection === 'auto' ? 'learned' : membersSource,
    members: selection === 'fixed_pair' && membersSource === 'configured'
      ? (Array.isArray(entry?.members) ? entry.members : []).map((m) => ({ harness: m.harness, model: m.model }))
      : [],
    session: ['leaf', 'orchestrator'].includes(entry?.session) ? entry.session : 'fresh',
  };
}

/**
 * One-line effective summary, e.g. "Code review: fixed pair; reuse sessions
 * within this subtask". Pure so it can be tested and refreshed live.
 *
 * @param {string} subject plan | code
 * @param {object} entry
 * @returns {string}
 */
export function summarizeReviewerPolicy(subject, entry) {
  const stored = toStoredPolicy(entry);
  const who = stored.selection === 'auto'
    ? t('settings.reviewerSummaryAuto')
    : stored.members_source === 'configured' ? t('settings.reviewerSummaryConfigured') : t('settings.reviewerSummaryLearned');
  const sessionText = t(`settings.reviewerSummarySession_${stored.session}`);
  return t('settings.reviewerSummary', { subject: t(`settings.reviewerSubject_${subject}`), who, session: sessionText });
}

/**
 * Options of one reviewer-pair member select: none, the saved member when it
 * left the favorites (so it is not dropped silently), then every favorite.
 *
 * @param {string} current `harness<sep>model` or ''
 * @returns {Array<{ value: string, label: string }>}
 */
function memberSelectOptions(current) {
  const options = [{ value: '', label: t('settings.delegationSettingsNone') }];
  const known = state.favorites.some((fav) => `${fav.harness}${PAIR_SEPARATOR}${fav.model}` === current);
  if (current && !known) options.push({ value: current, label: current.split(PAIR_SEPARATOR).join(' / ') });
  for (const fav of state.favorites) options.push({ value: `${fav.harness}${PAIR_SEPARATOR}${fav.model}`, label: `${fav.harness} / ${fav.label}` });
  return options;
}

/**
 * @param {string} subject
 * @param {object} entry
 * @returns {string}
 */
function renderPolicyBlock(subject, entry) {
  const stored = toStoredPolicy(entry);
  const select = (key, options, value) => `<cr-bar-select data-policy-subject="${subject}" data-policy-key="${key}" data-options="${esc(JSON.stringify(options.map((opt) => ({ value: opt, label: t(`settings.reviewerOption_${key}_${opt}`) }))))}" value="${esc(value)}"></cr-bar-select>`;
  const members = stored.members;
  const slot = (index) => {
    const current = members[index] ? `${members[index].harness}${PAIR_SEPARATOR}${members[index].model}` : '';
    const options = memberSelectOptions(current);
    return `<cr-bar-select data-policy-subject="${subject}" data-policy-member="${index}" data-options="${esc(JSON.stringify(options))}" value="${esc(current)}"></cr-bar-select>`;
  };
  const sourceKey = entry?.source === 'policy' ? 'policy' : 'legacy';
  return `
    <section class="cr-card" data-reviewer-policy="${subject}">
      <h3 class="cr-field-label">${esc(t(`settings.reviewerSubject_${subject}_heading`))}</h3>
      <div class="cr-field">
        <span class="cr-field-label">${esc(t('settings.reviewerSelectionLabel'))}</span>
        ${select('selection', ['auto', 'fixed_pair'], stored.selection)}
        <p class="cr-hint">${esc(t('settings.reviewerSelectionHint'))}</p>
      </div>
      <div class="cr-field" data-policy-show="fixed_pair">
        <span class="cr-field-label">${esc(t('settings.reviewerMembersLabel'))}</span>
        ${select('members_source', ['learned', 'configured'], stored.members_source)}
        <div class="cr-row" data-policy-show="configured">${slot(0)}${slot(1)}</div>
        <p class="cr-hint">${esc(t('settings.reviewerMembersHint'))}</p>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${esc(t('settings.reviewerSessionLabel'))}</span>
        ${select('session', ['fresh', 'leaf', 'orchestrator'], stored.session)}
        <p class="cr-hint">${esc(t('settings.reviewerSessionHint'))}</p>
      </div>
      <p class="cr-hint"><span class="cr-badge" data-policy-source="${sourceKey}">${esc(t(`settings.reviewerSource_${sourceKey}`))}</span>
        <strong data-policy-summary="${subject}">${esc(summarizeReviewerPolicy(subject, entry))}</strong></p>
    </section>`;
}

/**
 * @param {object} data API response
 * @returns {string}
 */
function renderReviewerPolicy(data) {
  const view = data.reviewerPolicy || {};
  const migration = view.migration || {};
  const notices = [
    migration.notice === 'strict_leaf_reuse' ? `<p class="cr-hint" data-reviewer-migration-notice>${esc(t('settings.reviewerMigrationStrict'))}</p>` : '',
    migration.applied && migration.notice !== 'strict_leaf_reuse' ? `<p class="cr-hint" data-reviewer-migration-notice>${esc(t('settings.reviewerMigrationPair'))}</p>` : '',
  ].join('');
  const reset = data.source?.reviewer_policy === 'workspace'
    ? `<cr-bar-button class="cr-field-action" data-delegation-reset="reviewer_policy">${esc(t('settings.delegationSettingsUseDefault'))}</cr-bar-button>`
    : '';
  return `
    <div class="cr-field" data-delegation-row="reviewer_policy">
      <span class="cr-field-label">${esc(t('settings.reviewerGroupTitle'))}</span>
      <p class="cr-hint">${esc(t('settings.reviewerScopeHint'))}</p>
      <p class="cr-hint">${esc(t('settings.reviewerImplementFixNote'))}</p>
      ${notices}
      ${REVIEWER_POLICY_SUBJECTS.map((subject) => renderPolicyBlock(subject, view[subject])).join('')}
      <p class="cr-hint">${esc(t('settings.reviewerFallbackHint'))}</p>
      ${reset}
    </div>`;
}

/** Show/hide the conditional controls of every policy block from its current values. */
export function applyReviewerPolicyVisibility(root) {
  root.querySelectorAll('[data-reviewer-policy]').forEach((block) => {
    const selection = String(block.querySelector('[data-policy-key="selection"]')?.value || 'auto');
    const source = String(block.querySelector('[data-policy-key="members_source"]')?.value || 'learned');
    block.querySelectorAll('[data-policy-show]').forEach((el) => {
      const need = el.dataset.policyShow;
      el.hidden = need === 'fixed_pair' ? selection !== 'fixed_pair' : !(selection === 'fixed_pair' && source === 'configured');
    });
    const subject = block.dataset.reviewerPolicy;
    const summary = block.querySelector('[data-policy-summary]');
    if (summary) summary.textContent = summarizeReviewerPolicy(subject, readPolicyBlock(block));
  });
}

/**
 * @param {Element} block
 * @returns {{ selection: string, members_source: string, members: Array<{ harness: string, model: string }>, session: string }}
 */
function readPolicyBlock(block) {
  const members = [0, 1]
    .map((index) => String(block.querySelector(`[data-policy-member="${index}"]`)?.value || ''))
    .filter(Boolean)
    .map((raw) => {
      const [harness, model] = raw.split(PAIR_SEPARATOR);
      return { harness, model };
    });
  return toStoredPolicy({
    selection: block.querySelector('[data-policy-key="selection"]')?.value,
    members_source: block.querySelector('[data-policy-key="members_source"]')?.value,
    members,
    session: block.querySelector('[data-policy-key="session"]')?.value,
  });
}

/**
 * Stored-shape baseline of the reviewer policy as displayed (migrated or saved).
 *
 * @param {object | undefined} view API `reviewerPolicy`
 * @returns {Record<string, object>}
 */
export function reviewerPolicyBaseline(view) {
  return Object.fromEntries(REVIEWER_POLICY_SUBJECTS.map((subject) => [subject, toStoredPolicy(view?.[subject])]));
}

/**
 * Subjects to persist: those changed against the baseline, plus subjects that
 * are already saved explicitly (so an untouched saved subject is kept). A
 * subject still derived from the legacy fields is omitted, so saving plan does
 * not silently pin the code subject.
 *
 * @param {object | undefined} view API `reviewerPolicy`
 * @param {Record<string, object>} baseline stored-shape baseline
 * @param {Record<string, object>} current form values per subject
 * @returns {Record<string, object>}
 */
export function selectReviewerPolicySubjects(view, baseline, current) {
  const out = {};
  for (const [subject, policy] of Object.entries(current || {})) {
    const savedExplicitly = view?.[subject]?.source === 'policy';
    if (savedExplicitly || JSON.stringify(policy) !== JSON.stringify(baseline?.[subject])) out[subject] = policy;
  }
  return out;
}

/**
 * Policy value from the rendered blocks plus a validation error, if any. Only
 * the subjects that should be written are returned (see
 * `selectReviewerPolicySubjects`).
 *
 * @param {HTMLElement} root
 * @returns {{ value: Record<string, object>, error: string }}
 */
function readReviewerPolicy(root) {
  const baseline = reviewerPolicyBaseline(state.data?.reviewerPolicy);
  const view = state.data?.reviewerPolicy || {};
  const current = {};
  let error = '';
  root.querySelectorAll('[data-reviewer-policy]').forEach((block) => {
    const policy = readPolicyBlock(block);
    const subject = block.dataset.reviewerPolicy;
    if (policy.selection === 'fixed_pair' && policy.members_source === 'configured') {
      const same = policy.members.length === 2
        && policy.members[0].harness === policy.members[1].harness
        && String(policy.members[0].model).split('::')[0] === String(policy.members[1].model).split('::')[0];
      if (policy.members.length !== 2 || same) {
        error = t('settings.reviewerNeedsTwoDistinct', { subject: t(`settings.reviewerSubject_${subject}`) });
      }
    }
    current[subject] = policy;
  });
  return { value: selectReviewerPolicySubjects(view, baseline, current), error };
}

/**
 * @param {{ field: string, kind: string, min?: number, max?: number, options?: string[] }} spec
 * @param {object} data API response
 * @returns {string}
 */
function renderField(spec, data) {
  const { field } = spec;
  if (spec.kind === 'reviewer_policy') return renderReviewerPolicy(data);
  const value = data.effective?.[field];
  const readOnly = data.scope?.[field] === 'server';
  const source = data.source?.[field] || 'default';
  const id = `delegation-field-${field}`;
  const dis = readOnly ? ' disabled' : '';
  let control = '';
  if (spec.kind === 'bool') {
    control = `<label class="cr-check"><input id="${id}" type="checkbox" data-delegation-field="${field}"${value ? ' checked' : ''}${dis}> ${esc(t(`settings.delegationField_${field}`))}</label>`;
  } else if (spec.kind === 'fanout' || spec.kind === 'enum') {
    const options = spec.kind === 'fanout' ? ['1', '2'] : spec.options;
    const label = (opt) => (spec.kind === 'enum' ? t(`settings.delegationEnum_${field}_${opt}`) : opt);
    control = `<cr-bar-select id="${id}" data-delegation-field="${field}" data-options="${esc(JSON.stringify(options.map((opt) => ({ value: opt, label: label(opt) }))))}" value="${esc(value)}"${dis}></cr-bar-select>`;
  } else if (spec.kind === 'pair') {
    const members = Array.isArray(value) ? value : [];
    const slot = (index) => {
      const current = members[index] ? `${members[index].harness}${PAIR_SEPARATOR}${members[index].model}` : '';
      const options = memberSelectOptions(current);
      return `<cr-bar-select id="${id}-${index}" data-delegation-pair-member="${index}" data-options="${esc(JSON.stringify(options))}" value="${esc(current)}"${dis}></cr-bar-select>`;
    };
    control = `<div class="cr-row">${slot(0)}${slot(1)}</div>`;
  } else {
    control = `<cr-bar-input id="${id}" type="number" data-delegation-field="${field}" min="${spec.min ?? 0}"${spec.max != null ? ` max="${spec.max}"` : ''} value="${esc(value)}"${dis}></cr-bar-input>`;
  }
  const label = spec.kind === 'bool' ? '' : `<span class="cr-field-label">${esc(t(`settings.delegationField_${field}`))}</span>`;
  const reset = !readOnly && source === 'workspace'
    ? `<cr-bar-button class="cr-field-action" data-delegation-reset="${field}">${esc(t('settings.delegationSettingsUseDefault'))}</cr-bar-button>`
    : '';
  return `
    <div class="cr-field" data-delegation-row="${field}">
      ${label}
      ${control}
      <p class="cr-hint">
        <span class="cr-badge" data-delegation-source="${esc(source)}">${esc(t(`settings.delegationSource_${source}`))}</span>
        ${readOnly ? `<span>${esc(t('settings.delegationSettingsServerScope'))}</span>` : ''}
        <span>${esc(t('settings.delegationSettingsEnvDefault'))}: <code>${esc(formatValue(data.envDefault?.[field]))}</code></span>
      </p>
      <p class="cr-hint">${esc(t(`settings.delegationHint_${field}`))}</p>
      ${reset}
    </div>`;
}

/**
 * Read-only per-harness review certification (global env layer from the
 * harness catalog); the allow-uncertified opt-in comes from the effective value.
 *
 * @param {object} data
 * @returns {string}
 */
function renderReviewCertification(data) {
  const rows = (state.harnesses || []).filter((row) => row && row.id && typeof row.review_certified === 'boolean');
  if (rows.length === 0) return '';
  const optIn = data.effective?.review_allow_uncertified === true;
  const items = rows.map((row) => {
    const certified = row.review_certified === true;
    const reason = row.review_certification_reason
      ? t(`settings.reviewCertReason_${row.review_certification_reason}`)
      : t('settings.reviewCertReason_none');
    const status = certified ? t('settings.reviewCertCertified') : t('settings.reviewCertUncertified');
    const tests = row.review_can_run_tests ? t('settings.reviewCertTestsYes') : t('settings.reviewCertTestsNo');
    const optInText = !certified && optIn ? ` · ${esc(t('settings.reviewCertOptInOn'))}` : '';
    return `<li data-review-cert="${esc(row.id)}"><strong>${esc(row.label || row.id)}</strong>: ${esc(status)} (${esc(reason)}) · ${esc(tests)}${optInText}</li>`;
  }).join('');
  return `
    <div class="cr-field" data-review-certification>
      <span class="cr-field-label">${esc(t('settings.reviewCertTitle'))}</span>
      <p class="cr-hint">${esc(t('settings.reviewCertHint'))}</p>
      <ul class="cr-hint">${items}</ul>
    </div>`;
}

/**
 * @param {string} tab
 * @param {object} data
 * @returns {string}
 */
function renderSubtab(tab, data) {
  const fields = DELEGATION_SUBTAB_FIELDS[tab].map((spec) => renderField(spec, data)).join('');
  const recovery = data.recovery || {};
  const extra = tab === 'models'
    ? `<div class="cr-field" data-delegation-recovery>
        <span class="cr-field-label">${esc(t('settings.delegationRecoveryTitle'))}</span>
        <p class="cr-hint">${esc(t('settings.delegationRecoveryPolicy', {
          first: Number(recovery.startupLockoutMs || 0) / 3600000,
          repeated: Number(recovery.extendedLockoutMs || 0) / 3600000,
          window: Number(recovery.escalationWindowMs || 0) / 3600000,
        }))}</p>
      </div><p class="cr-hint"><a href="#" data-delegation-stats-link="1">${esc(t('settings.delegationSettingsModelStatsLink'))}</a></p>`
    : '';
  return `
    <div class="cr-page-body">
      <p class="cr-hint">${esc(t(`settings.delegationSettings_${tab}Hint`))}</p>
      ${fields}
      ${tab === 'review' ? renderReviewCertification(data) : ''}
      ${extra}
    </div>`;
}

/**
 * @param {string} tab
 * @returns {HTMLElement | null}
 */
function getRoot(tab) {
  return document.getElementById(`settings-delegation-${tab}-root`);
}

/**
 * Status text lives in the shared footer, outside the scroll box.
 *
 * @param {HTMLElement} root
 * @param {string} text
 * @param {'error' | 'success' | ''} tone
 */
function setStatus(root, text, tone = '') {
  const el = document.getElementById('settings-delegation-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

/**
 * Re-render one subtab, or all of them when `only` is omitted.
 *
 * @param {string} [only]
 */
function renderAll(only) {
  if (!state.data) return;
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    if (only && tab !== only) continue;
    const root = getRoot(tab);
    if (!root) continue;
    root.innerHTML = renderSubtab(tab, state.data);
    root.querySelectorAll('cr-bar-select[data-options]').forEach((el) => {
      el.options = JSON.parse(el.dataset.options || '[]');
    });
    applyReviewerPolicyVisibility(root);
  }
}

/**
 * Repaint only subtabs with no unsaved edits, so a refresh never wipes input.
 */
function renderCleanTabs() {
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    if (!state.dirty.has(tab)) renderAll(tab);
  }
}

/**
 * Tabs with unsaved edits are not repainted, but their reviewer-pair selects
 * still need the favorites that arrived after the first paint. Only the option
 * lists change; each select keeps the value the user picked.
 */
function refreshDirtyMemberOptions() {
  for (const tab of state.dirty) {
    const root = getRoot(tab);
    if (!root) continue;
    root.querySelectorAll('cr-bar-select[data-policy-member], cr-bar-select[data-delegation-pair-member]').forEach((el) => {
      const options = memberSelectOptions(String(el.value || ''));
      el.dataset.options = JSON.stringify(options);
      el.options = options;
    });
  }
}

/**
 * @param {Element & { value?: unknown }} el
 * @returns {string}
 */
function readControlValue(el) {
  return el.localName === 'cr-bar-input' ? readBarInputLiveValue(el) : String(el.value ?? '');
}

/**
 * @param {HTMLElement} el
 * @returns {string}
 */
function selectorOfControl(el) {
  if (el.dataset.delegationField) return `[data-delegation-field="${el.dataset.delegationField}"]`;
  if (el.dataset.delegationPairMember) return `[data-delegation-pair-member="${el.dataset.delegationPairMember}"]`;
  if (el.dataset.policyKey) return `[data-policy-subject="${el.dataset.policySubject}"][data-policy-key="${el.dataset.policyKey}"]`;
  return `[data-policy-subject="${el.dataset.policySubject}"][data-policy-member="${el.dataset.policyMember}"]`;
}

/** Re-render all subtabs but keep unsaved control values (language change). */
function rerenderPreservingEdits() {
  const snapshot = {};
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (!root) continue;
    snapshot[tab] = [...root.querySelectorAll('[data-delegation-field], [data-delegation-pair-member], [data-policy-key], [data-policy-member]')]
      .map((el) => ({ el: selectorOfControl(el), value: readControlValue(el), checked: el.checked, type: el.type }));
  }
  renderAll();
  for (const [tab, items] of Object.entries(snapshot)) {
    const root = getRoot(tab);
    for (const item of items) {
      const el = root?.querySelector(item.el);
      if (!el || el.disabled) continue;
      if (item.type === 'checkbox') el.checked = item.checked;
      else el.value = item.value;
    }
    if (root) applyReviewerPolicyVisibility(root);
  }
}

/**
 * Enabled favorites across harnesses, for the reviewer pair selectors.
 * Cached for FAVORITES_TTL_MS and de-duplicated while in flight, so repeated
 * tab entries do not re-issue the per-harness requests.
 *
 * @returns {Promise<Array<{ harness: string, model: string, label: string }>>}
 */
function loadFavorites() {
  if (state.favoritesAt && Date.now() - state.favoritesAt < FAVORITES_TTL_MS) return Promise.resolve(state.favorites);
  if (state.favoritesPromise) return state.favoritesPromise;
  state.favoritesPromise = (async () => {
    const catalog = await api('/api/harness-catalog/harnesses');
    const harnesses = (catalog.json?.items || []).map((item) => String(item?.id || '')).filter(Boolean);
    const lists = await Promise.all(harnesses.map(async (harness) => {
      const res = await api(`/api/harness-catalog/models?harness=${encodeURIComponent(harness)}&enabled_only=1`);
      return (res.json?.items || [])
        .filter((item) => item && item.id)
        .map((item) => ({ harness, model: String(item.id), label: String(item.label || item.id) }));
    }));
    state.harnesses = catalog.json?.items || [];
    state.favorites = lists.flat();
    state.favoritesAt = Date.now();
    return state.favorites;
  })().finally(() => { state.favoritesPromise = null; });
  return state.favoritesPromise;
}

/**
 * @param {HTMLElement} root
 * @returns {{ values: Record<string, unknown>, error: string }}
 */
function readSubtab(root, tab) {
  const values = {};
  let error = '';
  for (const spec of DELEGATION_SUBTAB_FIELDS[tab]) {
    if (state.data?.scope?.[spec.field] === 'server') continue;
    if (spec.kind === 'reviewer_policy') {
      const policy = readReviewerPolicy(root);
      if (policy.error) error = policy.error;
      // Nothing changed and nothing was explicitly saved: omit the field so the
      // PATCH never pins a legacy-derived subject by accident.
      if (Object.keys(policy.value).length > 0) values[spec.field] = policy.value;
      continue;
    }
    if (spec.kind === 'pair') {
      const members = [0, 1]
        .map((index) => String(root.querySelector(`[data-delegation-pair-member="${index}"]`)?.value || ''))
        .filter(Boolean)
        .map((raw) => {
          const [harness, model] = raw.split(PAIR_SEPARATOR);
          return { harness, model };
        });
      if (members.length === 1) error = t('settings.delegationSettingsPairNeedsTwo');
      values[spec.field] = members;
      continue;
    }
    const el = root.querySelector(`[data-delegation-field="${spec.field}"]`);
    if (!el) continue;
    if (spec.kind === 'bool') values[spec.field] = el.checked === true;
    else if (spec.kind === 'int' || spec.kind === 'fanout') {
      const num = Number.parseInt(readControlValue(el), 10);
      if (!Number.isSafeInteger(num) || num < (spec.min ?? 1) || (spec.max != null && num > spec.max)) {
        error = t('settings.delegationSettingsInvalidNumber', { field: t(`settings.delegationField_${spec.field}`) });
      }
      values[spec.field] = num;
    } else values[spec.field] = readControlValue(el);
  }
  return { values, error };
}

/** Fetch and paint all three panels. */
export async function refreshDelegationSettings() {
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (root) root.textContent = t('settings.delegationSettingsLoading');
  }
  // Favorites fan out one request per harness; they must not hold the first paint.
  const favoritesLoad = loadFavorites().catch(() => null);
  const { status, json } = await api(API_PATH);
  if (status !== 200 || !json?.ok) {
    for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
      const root = getRoot(tab);
      if (root) {
        // A missing JSON body usually means the server predates this endpoint (404 HTML).
        const detail = json?.error || `HTTP ${status}`;
        root.textContent = `${t('settings.delegationSettingsLoadFailed')} (${detail})`;
      }
    }
    return;
  }
  state.data = json;
  // Tabs with unsaved edits keep their controls; the rest pick up fresh values.
  renderCleanTabs();
  const favorites = await favoritesLoad;
  // Repaint once the reviewer-pair options arrive (cached favorites need no repaint).
  if (favorites && favorites !== state.favoritesPaintedFor) {
    state.favoritesPaintedFor = favorites;
    renderCleanTabs();
    refreshDirtyMemberOptions();
  }
}

/**
 * @param {HTMLElement} root
 * @param {Record<string, unknown>} patch
 * @param {string} tab subtab being saved
 */
async function savePatch(root, patch, tab) {
  const { status, json } = await api(API_PATH, { method: 'PATCH', body: patch });
  if (status !== 200 || !json?.ok) return setStatus(root, json?.error || t('settings.delegationSettingsSaveFailed'), 'error');
  state.data = json;
  state.dirty.delete(tab);
  // Only the saved subtab is repainted so unsaved edits elsewhere survive.
  renderAll(tab);
  setStatus(root, t('settings.delegationSettingsSaved'), 'success');
  return undefined;
}

/** Wire subtab switching, Save/reset and cross-panel links once. */
export function initDelegationSettings() {
  if (state.bound) return;
  state.bound = true;
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (!root) continue;
    root.addEventListener('click', async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-delegation-stats-link]')) {
        event.preventDefault();
        openDelegationSubtabLink('stats');
        return;
      }
      const reset = target.closest('[data-delegation-reset]');
      if (reset) {
        await savePatch(root, { [reset.dataset.delegationReset]: null }, tab);
        return;
      }
    });
    const markDirty = () => {
      state.dirty.add(tab);
      applyReviewerPolicyVisibility(root);
    };
    root.addEventListener('input', markDirty);
    root.addEventListener('change', markDirty);
    root.addEventListener('cr-change', markDirty);
  }
  // The Save footer is a sibling of the scroll box and saves the visible subtab.
  document.getElementById('settings-delegation-save')?.addEventListener('click', async () => {
    const tab = Object.keys(DELEGATION_SUBTAB_FIELDS).find((key) => !getRoot(key)?.closest('[hidden]'));
    const root = tab ? getRoot(tab) : null;
    if (!root) return;
    const { values, error } = readSubtab(root, tab);
    if (error) return setStatus(root, error, 'error');
    const patch = buildDelegationPatch({ ...state.data?.effective, reviewer_policy: reviewerPolicyBaseline(state.data?.reviewerPolicy) }, values);
    if (Object.keys(patch).length === 0) return setStatus(root, t('settings.delegationSettingsNoChanges'));
    return savePatch(root, patch, tab);
  });
  // Links from Usage / Watcher (no second write path, just navigation).
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('[data-delegation-subtab-link]') : null;
    if (!link) return;
    event.preventDefault();
    openDelegationSubtabLink(link.dataset.delegationSubtabLink);
  });
  window.addEventListener('cr-lang-changed', () => rerenderPreservingEdits());
}

/**
 * Open Settings → Delegations on a subtab; `stats` jumps to the Usage tab's
 * Model × role outcomes block instead.
 *
 * @param {string} tab
 */
export function openDelegationSubtabLink(tab) {
  if (tab === 'stats') {
    document.querySelector('#settings-tabs .settings-tab[data-settings-tab="usage"]')?.click();
    document.getElementById('delegation-stats-title')?.scrollIntoView?.({ block: 'start' });
    return;
  }
  const target = tab === 'center' ? 'delegations' : `delegations-${tab}`;
  document.querySelector(`#settings-delegation-tabs .settings-tab[data-settings-tab="${target}"]`)?.click()
    || document.querySelector('#settings-tabs .settings-tab[data-settings-tab="delegations"]')?.click();
}
