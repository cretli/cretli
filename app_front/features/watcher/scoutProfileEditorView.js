/**
 * Workspace Watcher — Scout profile editor (pure).
 *
 * Renders the stage 5.2 editing surface for one Scout profile: the template
 * catalog, the profile form, the draft/effective-config preview and the restore
 * diff confirmation. Like `scoutProfilesView.js` this module never touches the
 * DOM and imports no SCSS, so every renderer is unit-testable in Node. The
 * settings panel owns the event delegation, the API calls and the dirty state.
 *
 * The editor keeps its own action namespace (`SCOUT_EDITOR_ACTIONS`), separate
 * from the list (`SCOUT_PROFILE_ACTIONS` in `scoutProfilesView.js`), so a
 * rendered editor button can never be dispatched by the list handler and vice
 * versa. Fields always render from explicit draft values; they never fall back
 * to "all categories from the catalog" at render time.
 */

import { t } from '../../i18n/index.js';
import { escapeWatcherAttr, escapeWatcherHtml } from './watcherDashboard.js';

/**
 * Every action the editor surface can render. The settings panel must wire each
 * one; the UI test asserts this list and the panel source stay in sync so a
 * rendered editor button can never be a dead action.
 */
export const SCOUT_EDITOR_ACTIONS = Object.freeze([
  'new-profile',
  'edit',
  'save',
  'cancel',
  'close',
  'from-template',
  'template-pick',
  'preview',
  'restore-diff',
  'restore-confirm',
  'restore-cancel',
  'reload-profile',
  'overwrite',
  'add-include',
  'remove-include',
  'add-exclude',
  'remove-exclude',
]);

/**
 * Client mirrors of the closed server sets. Kept local so the module has no
 * server import and stays testable in Node; the values must match
 * `WORKSPACE_SCOUT_CATEGORIES` / `WORKSPACE_SCOUT_PROFILE_SOURCES`.
 */
export const SCOUT_EDITOR_CATEGORIES = Object.freeze([
  'bug',
  'improvement',
  'refactor',
  'security',
  'opportunity',
  'documentation',
]);
export const SCOUT_EDITOR_SOURCES = Object.freeze([
  'diff',
  'gitHistory',
  'todoMarkers',
  'testResults',
  'logs',
]);
export const SCOUT_EDITOR_SCHEDULE_MODES = Object.freeze(['manual', 'interval']);
export const SCOUT_EDITOR_SCOPE_MODES = Object.freeze(['changes', 'area']);
/**
 * Canonical harness ids (mirrors `VALID_TRANSPORTS`). The allowed-harnesses
 * checkbox group is seeded from this closed set so a profile can narrow its
 * executor even when the stored list starts empty; an already-saved id outside
 * the set is appended so a save never silently drops it.
 */
export const SCOUT_EDITOR_HARNESSES = Object.freeze([
  'sdk',
  'openrouter',
  'opencode',
  'codebuddy',
  'deepseek',
  'codex',
  'qwen',
  'claude',
]);

/**
 * Thresholds mirroring `lib/persist/workspace-watchers-persist.js`. Kept in sync
 * so `scoutEditorFieldErrors` reports the same rejection the server would make
 * instead of letting a save fail at the API.
 */
const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 8000;
const MAX_GLOB_LENGTH = 500;
const MAX_GLOBS = 200;
const MAX_PER_DAY = 100;
const MAX_FINDINGS_PER_SCAN = 200;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Preview field order; mirrors the keys `resolveEffectiveScoutConfig` returns. */
const PREVIEW_CONFIG_FIELDS = Object.freeze([
  'objective',
  'instructions',
  'categories',
  'scope',
  'sources',
  'executor',
  'schedule',
  'limits',
]);

/** Bounded matched-file list so one wide scope cannot blow up the preview card. */
const PREVIEW_MAX_FILES = 40;

/**
 * Deep clone through JSON. The draft must never share a reference with a
 * profile, a template or the frozen catalog, so a later edit cannot leak into
 * another surface.
 *
 * @param {unknown} value
 * @returns {any}
 */
function deepCopy(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * A fresh, empty draft shape. Every array is a new instance.
 *
 * @returns {object}
 */
export function draftDefaults() {
  return {
    name: '',
    description: '',
    objective: '',
    instructions: '',
    enabled: false,
    archivedAt: '',
    templateId: '',
    templateVersion: '',
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
    sources: [...SCOUT_EDITOR_SOURCES],
    categories: [...SCOUT_EDITOR_CATEGORIES],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: DEFAULT_INTERVAL_HOURS },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: DEFAULT_TIMEOUT_MS },
  };
}

/**
 * Build an editable draft from a stored profile. Always a deep copy: the draft
 * never aliases `profile.scope.include`, `profile.sources`, etc.
 *
 * @param {object | null | undefined} profile
 * @returns {object}
 */
export function draftFromProfile(profile) {
  const base = draftDefaults();
  const source = profile && typeof profile === 'object' ? profile : {};
  const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
  const executor = source.executor && typeof source.executor === 'object' ? source.executor : {};
  const schedule = source.schedule && typeof source.schedule === 'object' ? source.schedule : {};
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  return {
    ...base,
    // Identity and revision are kept on the draft so the editor can send the
    // exact CAS token; they are stripped from the PATCH body.
    id: asText(source.id),
    revision: Number.isFinite(Number(source.revision)) ? Math.floor(Number(source.revision)) : 1,
    name: asText(source.name),
    description: asText(source.description),
    objective: asText(source.objective),
    instructions: asText(source.instructions),
    enabled: source.enabled === true,
    archivedAt: asText(source.archivedAt),
    templateId: asText(source.templateId),
    templateVersion: asText(source.templateVersion),
    scope: {
      mode: SCOUT_EDITOR_SCOPE_MODES.includes(asText(scope.mode)) ? asText(scope.mode) : base.scope.mode,
      base: asText(scope.base) || base.scope.base,
      include: Array.isArray(scope.include) ? [...scope.include] : [],
      exclude: Array.isArray(scope.exclude) ? [...scope.exclude] : [],
    },
    sources: Array.isArray(source.sources) ? [...source.sources] : [...base.sources],
    categories: Array.isArray(source.categories) ? [...source.categories] : [...base.categories],
    executor: {
      auto: executor.auto !== false,
      harness: asText(executor.harness),
      model: asText(executor.model),
      allowedHarnesses: Array.isArray(executor.allowedHarnesses) ? [...executor.allowedHarnesses] : [],
    },
    schedule: {
      mode: SCOUT_EDITOR_SCHEDULE_MODES.includes(asText(schedule.mode)) ? asText(schedule.mode) : base.schedule.mode,
      intervalHours: Number.isFinite(Number(schedule.intervalHours))
        ? Number(schedule.intervalHours)
        : base.schedule.intervalHours,
    },
    limits: {
      maxPerDay: Number.isFinite(Number(limits.maxPerDay)) ? Number(limits.maxPerDay) : base.limits.maxPerDay,
      maxFindingsPerScan: Number.isFinite(Number(limits.maxFindingsPerScan))
        ? Number(limits.maxFindingsPerScan)
        : base.limits.maxFindingsPerScan,
      timeoutMs: Number.isFinite(Number(limits.timeoutMs)) ? Number(limits.timeoutMs) : base.limits.timeoutMs,
    },
  };
}

/**
 * Build an editable draft from a template (optionally with caller overrides).
 * A template only seeds the task definition: the draft is always `enabled:false`
 * with a manual schedule and never aliases a template array.
 *
 * @param {object | null | undefined} template
 * @param {object} [overrides]
 * @returns {object}
 */
export function draftFromTemplate(template, overrides = {}) {
  const base = draftDefaults();
  const tpl = template && typeof template === 'object' ? template : {};
  const scope = tpl.scope && typeof tpl.scope === 'object' ? tpl.scope : {};
  const draft = {
    ...base,
    name: asText(tpl.name),
    description: asText(tpl.description),
    objective: asText(tpl.objective),
    instructions: asText(tpl.instructions),
    templateId: asText(tpl.id),
    templateVersion: String(tpl.version == null ? '' : tpl.version),
    scope: {
      mode: SCOUT_EDITOR_SCOPE_MODES.includes(asText(scope.mode)) ? asText(scope.mode) : base.scope.mode,
      base: asText(scope.base) || base.scope.base,
      include: Array.isArray(scope.include) ? [...scope.include] : [],
      exclude: Array.isArray(scope.exclude) ? [...scope.exclude] : [],
    },
    sources: Array.isArray(tpl.sources) ? [...tpl.sources] : [...base.sources],
    categories: Array.isArray(tpl.categories) ? [...tpl.categories] : [...base.categories],
    enabled: false,
    schedule: { mode: 'manual', intervalHours: base.schedule.intervalHours },
  };
  return applyDraftOverrides(draft, overrides);
}

/**
 * Merge caller overrides into a draft immutably. Nested object fields merge one
 * level deep (so `{ name }` or `{ scope: { include } }` both work) and every
 * array is copied.
 *
 * @param {object} draft
 * @param {object} [overrides]
 * @returns {object}
 */
export function applyDraftOverrides(draft, overrides = {}) {
  const next = deepCopy(draft && typeof draft === 'object' ? draft : {});
  const source = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      next[key] = [...value];
    } else if (value && typeof value === 'object') {
      const base = next[key] && typeof next[key] === 'object' && !Array.isArray(next[key]) ? next[key] : {};
      const merged = { ...base, ...deepCopy(value) };
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (Array.isArray(nestedValue)) merged[nestedKey] = [...nestedValue];
      }
      next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Immutable dotted-path edit. `applyDraftEdit(draft, 'scope.include', [...])`
 * returns a new draft and leaves the input untouched.
 *
 * @param {object} draft
 * @param {string} patchName
 * @param {unknown} value
 * @returns {object}
 */
export function applyDraftEdit(draft, patchName, value) {
  const next = deepCopy(draft && typeof draft === 'object' ? draft : {});
  const path = String(patchName || '').split('.').filter(Boolean);
  if (path.length === 0) return next;
  let cursor = next;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = Array.isArray(value) ? [...value] : value;
  return next;
}

/**
 * Readable reason a scope glob is unacceptable, or an empty string. Mirrors
 * `invalidScoutGlobReason` on the server.
 *
 * @param {unknown} value
 * @returns {string}
 */
function invalidGlobReason(value) {
  if (typeof value !== 'string') return 'text';
  const glob = value.trim();
  if (!glob) return 'empty';
  if (glob.length > MAX_GLOB_LENGTH) return 'too_long';
  for (let index = 0; index < glob.length; index += 1) {
    const code = glob.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return 'control';
  }
  if (glob.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(glob)) return 'absolute';
  if (glob.split(/[\\/]/).includes('..')) return 'escape';
  return '';
}

/**
 * Client-side validation of a draft. Returns `{ field: errorMessage }` and never
 * throws, so the form can show inline errors without losing any value. Uses the
 * same thresholds and closed sets as `validateWorkspaceScoutProfile`.
 *
 * @param {object | null | undefined} draft
 * @returns {Record<string, string>}
 */
export function scoutEditorFieldErrors(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  /** @type {Record<string, string>} */
  const errors = {};

  const name = asText(source.name);
  if (!name) errors.name = t('settings.watcherScoutFieldErrors_nameRequired');
  else if (name.length > MAX_NAME_LENGTH) {
    errors.name = t('settings.watcherScoutFieldErrors_nameTooLong', { max: MAX_NAME_LENGTH });
  }

  const objective = asText(source.objective);
  if (!objective) errors.objective = t('settings.watcherScoutFieldErrors_objectiveRequired');
  else if (objective.length > MAX_TEXT_LENGTH) {
    errors.objective = t('settings.watcherScoutFieldErrors_textTooLong', { field: 'objective', max: MAX_TEXT_LENGTH });
  }

  for (const field of ['description', 'instructions']) {
    const value = asText(source[field]);
    if (value.length > MAX_TEXT_LENGTH) {
      errors[field] = t('settings.watcherScoutFieldErrors_textTooLong', { field, max: MAX_TEXT_LENGTH });
    }
  }

  if (!Array.isArray(source.categories) || source.categories.filter(Boolean).length === 0) {
    errors.categories = t('settings.watcherScoutFieldErrors_categoriesRequired');
  }

  const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
  for (const field of ['include', 'exclude']) {
    const list = Array.isArray(scope[field]) ? scope[field] : [];
    if (list.length > MAX_GLOBS) {
      errors[`scope.${field}`] = t('settings.watcherScoutFieldErrors_tooManyGlobs', { max: MAX_GLOBS });
      continue;
    }
    for (const glob of list) {
      const reason = invalidGlobReason(glob);
      if (reason) {
        errors[`scope.${field}`] = t(`settings.watcherScoutFieldErrors_glob_${reason}`);
        break;
      }
    }
  }

  const scheduleMode = asText(source.schedule?.mode) || 'manual';
  if (scheduleMode === 'interval') {
    const hours = Number(source.schedule?.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      errors['schedule.intervalHours'] = t('settings.watcherScoutFieldErrors_intervalInvalid');
    }
  }

  const limitCaps = {
    maxPerDay: MAX_PER_DAY,
    maxFindingsPerScan: MAX_FINDINGS_PER_SCAN,
    timeoutMs: MAX_TIMEOUT_MS,
  };
  for (const [field, cap] of Object.entries(limitCaps)) {
    const raw = source.limits?.[field];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      errors[`limits.${field}`] = t('settings.watcherScoutFieldErrors_limitInvalid');
    } else if (value > cap) {
      errors[`limits.${field}`] = t('settings.watcherScoutFieldErrors_limitTooHigh', { max: cap });
    }
  }

  const harness = asText(source.executor?.harness);
  const allowed = Array.isArray(source.executor?.allowedHarnesses)
    ? source.executor.allowedHarnesses.map((value) => asText(value)).filter(Boolean)
    : [];
  if (harness && allowed.length > 0 && !allowed.includes(harness)) {
    errors['executor.harness'] = t('settings.watcherScoutFieldErrors_harnessNotAllowed', { harness });
  }

  return errors;
}

/**
 * Whether at least one validation error belongs to a field rendered inside the
 * Advanced `<details>` section. The panel uses this to force the section open so
 * a rejected save can never hide its own message behind a collapsed section.
 *
 * @param {Record<string, string>} [fieldErrors]
 * @returns {boolean}
 */
export function scoutEditorAdvancedFieldError(fieldErrors) {
  const errors = fieldErrors && typeof fieldErrors === 'object' ? fieldErrors : {};
  return Object.keys(errors).some((field) => (
    field === 'sources'
    || field === 'categories'
    || field.startsWith('executor.')
    || field.startsWith('limits.')
  ));
}

/**
 * Human label for a preview provenance badge key (`default` / `template` /
 * `profile`). Unknown keys fall back to the raw key.
 *
 * @param {unknown} source
 * @returns {string}
 */
export function scoutProvenanceText(source) {
  const key = asText(source) || 'default';
  const i18nKey = `settings.watcherScoutProvenance_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * Human label for a preview blocker code, falling back to the raw code.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function scoutBlockerText(code) {
  const key = asText(code);
  if (!key) return '';
  const i18nKey = `settings.watcherScoutBlocker_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * One editor action button. Uses the shared `.watcher-scout-action` styling.
 *
 * @param {string} action
 * @param {string} label
 * @param {{ scoutId?: string, disabled?: boolean, icon?: string }} [options]
 * @returns {string}
 */
export function renderScoutEditorButton(action, label, options = {}) {
  const id = asText(options.scoutId);
  const icon = asText(options.icon) || 'mdi-pencil';
  return `<button type="button" class="watcher-scout-action" data-scout-editor-action="${escapeWatcherAttr(action)}"`
    + (id ? ` data-scout-id="${escapeWatcherAttr(id)}"` : '')
    + (options.disabled === true ? ' disabled aria-disabled="true"' : '')
    + '>'
    + `<span class="mdi ${escapeWatcherAttr(icon)}" aria-hidden="true"></span>`
    + `<span class="watcher-scout-action-label">${escapeWatcherHtml(label)}</span>`
    + '</button>';
}

/**
 * Inline validation message for one field. Always `role="alert"` so a screen
 * reader announces the rejection without moving focus.
 *
 * @param {Record<string, string>} fieldErrors
 * @param {string} field
 * @returns {string}
 */
function fieldErrorHtml(fieldErrors, field) {
  const message = asText(fieldErrors?.[field]);
  if (!message) return '';
  return `<p class="cr-hint watcher-scout-field-error" role="alert"`
    + ` data-scout-field-error="${escapeWatcherAttr(field)}">${escapeWatcherHtml(message)}</p>`;
}

/**
 * A labelled text/number input bound to a dotted draft path.
 *
 * @param {object} options
 * @returns {string}
 */
function renderField(options) {
  const id = `watcher-scout-editor-${options.id}`;
  const type = options.type || 'text';
  const value = options.value == null ? '' : String(options.value);
  const attrs = [
    `id="${escapeWatcherAttr(id)}"`,
    `data-scout-editor-field="${escapeWatcherAttr(options.path)}"`,
    `type="${escapeWatcherAttr(type)}"`,
    `value="${escapeWatcherAttr(value)}"`,
  ];
  if (options.min != null) attrs.push(`min="${escapeWatcherAttr(options.min)}"`);
  if (options.max != null) attrs.push(`max="${escapeWatcherAttr(options.max)}"`);
  if (options.step != null) attrs.push(`step="${escapeWatcherAttr(options.step)}"`);
  if (options.placeholder) attrs.push(`placeholder="${escapeWatcherAttr(options.placeholder)}"`);
  if (options.disabled === true) attrs.push('disabled');
  return '<div class="cr-field">'
    + `<label class="cr-field-label" for="${escapeWatcherAttr(id)}">${escapeWatcherHtml(options.label)}</label>`
    + `<input ${attrs.join(' ')}>`
    + fieldErrorHtml(options.fieldErrors || {}, options.path)
    + '</div>';
}

/**
 * One checkbox group rendered as a native `<fieldset>`/`<legend>`.
 *
 * @param {object} options
 * @returns {string}
 */
function renderCheckboxGroup(options) {
  const selected = new Set(
    (Array.isArray(options.selected) ? options.selected : []).map((value) => asText(value)),
  );
  const rows = options.options.map((option) => {
    const value = asText(option.value);
    return `<label class="cr-check"><input type="checkbox"`
      + ` data-scout-editor-toggle="${escapeWatcherAttr(options.toggle)}"`
      + ` value="${escapeWatcherAttr(value)}"`
      + (selected.has(value) ? ' checked' : '')
      + (options.disabled === true ? ' disabled' : '')
      + `> ${escapeWatcherHtml(option.label)}</label>`;
  }).join('');
  return '<fieldset class="cr-field watcher-scout-editor-group">'
    + `<legend>${escapeWatcherHtml(options.legend)}</legend>`
    + (options.hint ? `<p class="cr-hint">${escapeWatcherHtml(options.hint)}</p>` : '')
    + `<div class="watcher-check-list">${rows}</div>`
    + fieldErrorHtml(options.fieldErrors || {}, options.errorField || '')
    + '</fieldset>';
}

/**
 * One include/exclude glob list with add/remove actions.
 *
 * @param {object} options
 * @returns {string}
 */
function renderGlobList(options) {
  const values = Array.isArray(options.values) ? options.values : [];
  const rows = values.map((glob, index) => (
    '<div class="cr-row watcher-scout-editor-list-row">'
    + `<input type="text" data-scout-editor-list-field="${escapeWatcherAttr(options.path)}"`
    + ` data-scout-editor-index="${index}" value="${escapeWatcherAttr(String(glob ?? ''))}"`
    + ' placeholder="lib/**">'
    + `<button type="button" class="watcher-scout-action" data-scout-editor-action="${escapeWatcherAttr(options.removeAction)}"`
    + ` data-scout-editor-index="${index}">`
    + '<span class="mdi mdi-close" aria-hidden="true"></span>'
    + `<span class="watcher-scout-action-label">${escapeWatcherHtml(t('settings.watcherScoutEditorRemove'))}</span>`
    + '</button>'
    + '</div>'
  )).join('');
  return '<div class="cr-field watcher-scout-editor-list-field">'
    + `<span class="cr-field-label">${escapeWatcherHtml(options.label)}</span>`
    + `<div class="watcher-scout-editor-list" data-scout-editor-list="${escapeWatcherAttr(options.path)}">${rows}</div>`
    + renderScoutEditorButton(options.addAction, t('settings.watcherScoutEditorAdd'), { icon: 'mdi-plus' })
    + fieldErrorHtml(options.fieldErrors || {}, options.path)
    + '</div>';
}

/**
 * @param {object} view
 * @returns {string}
 */
function renderEditorToolbar(view) {
  const profiles = Array.isArray(view.profiles) ? view.profiles.filter(Boolean) : [];
  const selectedId = asText(view.selectedId);
  const selected = profiles.find((profile) => asText(profile?.id) === selectedId) || null;
  const options = profiles.map((profile) => {
    const id = asText(profile?.id);
    const name = asText(profile?.name) || id;
    return `<option value="${escapeWatcherAttr(id)}"${id === selectedId ? ' selected' : ''}>${escapeWatcherHtml(name)}</option>`;
  }).join('');
  const canRestore = Boolean(selected && asText(selected.templateId));
  const busy = view.busy === true;
  return '<div class="cr-card watcher-form watcher-scout-editor-card" data-scout-editor>'
    + '<div class="watcher-scout-editor-head">'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutEditorTitle'))}</h4>`
    + '<div class="watcher-scout-profile-actions">'
    + renderScoutEditorButton('new-profile', t('settings.watcherScoutEditorNew'), { icon: 'mdi-plus', disabled: busy })
    + renderScoutEditorButton('from-template', t('settings.watcherScoutEditorFromTemplate'), { icon: 'mdi-file-document-outline', disabled: busy })
    + '</div></div>'
    + '<p class="cr-hint">' + escapeWatcherHtml(t('settings.watcherScoutEditorHint')) + '</p>'
    + '<div class="cr-row watcher-scout-editor-picker">'
    + '<div class="cr-field">'
    + '<label class="cr-field-label" for="watcher-scout-editor-select">'
    + escapeWatcherHtml(t('settings.watcherScoutEditorPickProfile'))
    + '</label>'
    + `<select id="watcher-scout-editor-select" data-scout-editor-select>`
    + `<option value="">${escapeWatcherHtml(t('settings.watcherScoutEditorNoProfile'))}</option>`
    + options
    + '</select></div>'
    + '<div class="watcher-scout-profile-actions">'
    + renderScoutEditorButton('edit', t('settings.watcherScoutEditorEdit'), { scoutId: selectedId, icon: 'mdi-pencil', disabled: busy || !selectedId })
    + renderScoutEditorButton('preview', t('settings.watcherScoutPreviewOpen'), { scoutId: selectedId, icon: 'mdi-eye-outline', disabled: busy || !selectedId })
    + renderScoutEditorButton('restore-diff', t('settings.watcherScoutRestoreOpen'), { scoutId: selectedId, icon: 'mdi-history', disabled: busy || !canRestore })
    + '</div></div>'
    + '</div>';
}

/**
 * @param {object} view
 * @returns {string}
 */
function renderEditorForm(view) {
  const draft = view.draft;
  const mode = asText(view.mode) || 'edit';
  const fieldErrors = view.fieldErrors && typeof view.fieldErrors === 'object' ? view.fieldErrors : {};
  const busy = view.busy === true;
  const scoutId = asText(view.originalProfile?.id) || asText(view.selectedId);
  const titleKey = mode === 'create'
    ? 'settings.watcherScoutEditorModeCreate'
    : (mode === 'from-template' ? 'settings.watcherScoutEditorModeTemplate' : 'settings.watcherScoutEditorModeEdit');
  const casConflict = view.casConflict === true
    ? '<div class="message watcher-scout-cas" data-tone="error" role="alert" data-scout-cas-conflict>'
      + `<p>${escapeWatcherHtml(t('settings.watcherScoutEditorCasConflict'))}</p>`
      + '<div class="cr-row watcher-scout-profile-actions">'
      + renderScoutEditorButton('reload-profile', t('settings.watcherScoutEditorReloadProfile'), { scoutId, icon: 'mdi-refresh' })
      + renderScoutEditorButton('overwrite', t('settings.watcherScoutEditorOverwrite'), { scoutId, icon: 'mdi-content-save-alert-outline' })
      + '</div></div>'
    : '';
  const error = asText(view.error)
    ? `<div class="message watcher-scout-error" data-tone="error" role="alert" data-scout-editor-error>${escapeWatcherHtml(view.error)}</div>`
    : '';
  // Every rejected field is summarized above the form, so a field inside the
  // collapsed Advanced section can never be the only place its error is shown.
  const fieldErrorKeys = Object.keys(fieldErrors);
  const errorSummary = fieldErrorKeys.length > 0
    ? '<div class="message watcher-scout-editor-errors" data-tone="error" role="alert" data-scout-editor-errors>'
      + `<p>${escapeWatcherHtml(t('settings.watcherScoutEditorErrorsSummary'))}</p>`
      + '<ul>'
      + fieldErrorKeys.map((field) => (
        `<li data-scout-error-field="${escapeWatcherAttr(field)}">${escapeWatcherHtml(fieldErrors[field])}</li>`
      )).join('')
      + '</ul></div>'
    : '';
  // Automatic executor selection owns the mode: the explicit fields are disabled
  // while it is on, so the draft can never carry a value the runner ignores.
  const executorAuto = draft.executor.auto !== false;
  const advancedOpenAttr = view.advancedOpen === true ? ' open' : '';
  const dirty = view.dirty === true
    ? `<p class="cr-status watcher-scout-editor-dirty" role="status">${escapeWatcherHtml(t('settings.watcherScoutEditorDirty'))}</p>`
    : '';
  const templateNote = asText(draft.templateId)
    ? `<p class="cr-hint watcher-scout-editor-template" data-scout-editor-template="${escapeWatcherAttr(draft.templateId)}">`
      + escapeWatcherHtml(t('settings.watcherScoutEditorTemplateNote', {
        id: draft.templateId,
        version: draft.templateVersion || '1',
      }))
      + '</p>'
    : '';

  const scopeModeOptions = SCOUT_EDITOR_SCOPE_MODES.map((scopeMode) => (
    `<option value="${escapeWatcherAttr(scopeMode)}"${scopeMode === draft.scope.mode ? ' selected' : ''}>`
    + `${escapeWatcherHtml(t(`settings.watcherScoutScopeMode_${scopeMode}`))}</option>`
  )).join('');
  const scheduleModeOptions = SCOUT_EDITOR_SCHEDULE_MODES.map((scheduleMode) => (
    `<option value="${escapeWatcherAttr(scheduleMode)}"${scheduleMode === draft.schedule.mode ? ' selected' : ''}>`
    + `${escapeWatcherHtml(t(`settings.watcherScoutScheduleMode_${scheduleMode}`))}</option>`
  )).join('');
  const sourceOptions = SCOUT_EDITOR_SOURCES.map((sourceId) => ({
    value: sourceId,
    label: t(`settings.watcherScoutSource_${sourceId}`),
  }));
  const categoryOptions = SCOUT_EDITOR_CATEGORIES.map((category) => ({
    value: category,
    label: t(`settings.watcherScoutCategory_${category}`),
  }));

  return `<div class="cr-card watcher-form watcher-scout-editor-card" data-scout-editor data-scout-editor-mode="${escapeWatcherAttr(mode)}">`
    + '<div class="watcher-scout-editor-head">'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t(titleKey))}</h4>`
    + '<div class="watcher-scout-profile-actions">'
    + renderScoutEditorButton('preview', t('settings.watcherScoutPreviewOpen'), { icon: 'mdi-eye-outline', disabled: busy })
    + renderScoutEditorButton('save', t('settings.watcherScoutEditorSave'), { icon: 'mdi-content-save', disabled: busy })
    + renderScoutEditorButton('cancel', t('settings.watcherScoutEditorCancel'), { icon: 'mdi-undo', disabled: busy })
    + renderScoutEditorButton('close', t('settings.watcherScoutEditorClose'), { icon: 'mdi-close', disabled: busy })
    + '</div></div>'
    + casConflict
    + error
    + errorSummary
    + dirty
    + templateNote
    + '<section class="watcher-section">'
    + `<h5 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutEditorBasic'))}</h5>`
    + renderField({ id: 'name', path: 'name', label: t('settings.watcherScoutEditorName'), value: draft.name, fieldErrors })
    + renderField({ id: 'objective', path: 'objective', label: t('settings.watcherScoutEditorObjective'), value: draft.objective, fieldErrors })
    + '<div class="cr-field">'
    + `<label class="cr-field-label" for="watcher-scout-editor-instructions">${escapeWatcherHtml(t('settings.watcherScoutEditorInstructions'))}</label>`
    + `<textarea id="watcher-scout-editor-instructions" data-scout-editor-field="instructions" rows="5">${escapeWatcherHtml(draft.instructions)}</textarea>`
    + fieldErrorHtml(fieldErrors, 'instructions')
    + '</div>'
    + '</section>'
    + '<section class="watcher-section">'
    + `<h5 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutEditorScope'))}</h5>`
    + '<div class="watcher-scout-editor-grid">'
    + '<div class="cr-field">'
    + `<label class="cr-field-label" for="watcher-scout-editor-scope-mode">${escapeWatcherHtml(t('settings.watcherScoutEditorScopeMode'))}</label>`
    + `<select id="watcher-scout-editor-scope-mode" data-scout-editor-field="scope.mode">${scopeModeOptions}</select>`
    + '</div>'
    + renderField({ id: 'scope-base', path: 'scope.base', label: t('settings.watcherScoutEditorScopeBase'), value: draft.scope.base, fieldErrors, placeholder: 'main' })
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutScopeBaseHelp'))}</p>`
    + '</div>'
    + renderGlobList({
      path: 'scope.include',
      label: t('settings.watcherScoutEditorInclude'),
      values: draft.scope.include,
      addAction: 'add-include',
      removeAction: 'remove-include',
      fieldErrors,
    })
    + renderGlobList({
      path: 'scope.exclude',
      label: t('settings.watcherScoutEditorExclude'),
      values: draft.scope.exclude,
      addAction: 'add-exclude',
      removeAction: 'remove-exclude',
      fieldErrors,
    })
    + '</section>'
    + '<section class="watcher-section">'
    + `<h5 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutEditorSchedule'))}</h5>`
    + '<div class="watcher-scout-editor-grid">'
    + '<div class="cr-field">'
    + `<label class="cr-field-label" for="watcher-scout-editor-schedule-mode">${escapeWatcherHtml(t('settings.watcherScoutEditorScheduleMode'))}</label>`
    + `<select id="watcher-scout-editor-schedule-mode" data-scout-editor-field="schedule.mode">${scheduleModeOptions}</select>`
    + '</div>'
    + renderField({
      id: 'interval-hours',
      path: 'schedule.intervalHours',
      label: t('settings.watcherScoutEditorIntervalHours'),
      value: draft.schedule.intervalHours,
      type: 'number',
      min: 1,
      fieldErrors,
    })
    + '</div>'
    + `<label class="cr-check"><input type="checkbox" data-scout-editor-toggle="enabled"${draft.enabled === true ? ' checked' : ''}> `
    + `${escapeWatcherHtml(t('settings.watcherScoutAutoScansLabel'))}</label>`
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutAutoScansHint'))}</p>`
    + '</section>'
    + `<details class="watcher-scout-editor-advanced"${advancedOpenAttr}>`
    + `<summary>${escapeWatcherHtml(t('settings.watcherScoutEditorAdvanced'))}</summary>`
    + renderCheckboxGroup({
      legend: t('settings.watcherScoutEditorSources'),
      toggle: 'sources',
      options: sourceOptions,
      selected: draft.sources,
      fieldErrors,
    })
    + renderCheckboxGroup({
      legend: t('settings.watcherScoutEditorCategories'),
      toggle: 'categories',
      options: categoryOptions,
      selected: draft.categories,
      errorField: 'categories',
      fieldErrors,
    })
    + '<div class="cr-field">'
    + `<span class="cr-field-label">${escapeWatcherHtml(t('settings.watcherScoutEditorExecutor'))}</span>`
    + `<label class="cr-check"><input type="checkbox" data-scout-editor-toggle="executor.auto"${draft.executor.auto !== false ? ' checked' : ''}> `
    + `${escapeWatcherHtml(t('settings.watcherScoutEditorExecutorAuto'))}</label>`
    + '</div>'
    + '<div class="watcher-scout-editor-grid">'
    + renderField({ id: 'executor-harness', path: 'executor.harness', label: t('settings.watcherScoutEditorHarness'), value: draft.executor.harness, fieldErrors, disabled: executorAuto })
    + renderField({ id: 'executor-model', path: 'executor.model', label: t('settings.watcherScoutEditorModel'), value: draft.executor.model, fieldErrors, disabled: executorAuto })
    + '</div>'
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutEditorExecutorHint'))}</p>`
    + renderCheckboxGroup({
      legend: t('settings.watcherScoutEditorAllowedHarnesses'),
      toggle: 'executor.allowedHarnesses',
      options: allowedHarnessOptions(draft.executor.allowedHarnesses),
      selected: draft.executor.allowedHarnesses,
      fieldErrors,
    })
    + '<div class="watcher-scout-editor-grid">'
    + renderField({ id: 'limit-max-per-day', path: 'limits.maxPerDay', label: t('settings.watcherScoutEditorMaxPerDay'), value: draft.limits.maxPerDay, type: 'number', min: 0, fieldErrors })
    + renderField({ id: 'limit-max-findings', path: 'limits.maxFindingsPerScan', label: t('settings.watcherScoutEditorMaxFindings'), value: draft.limits.maxFindingsPerScan, type: 'number', min: 0, fieldErrors })
    + renderField({ id: 'limit-timeout', path: 'limits.timeoutMs', label: t('settings.watcherScoutEditorTimeoutMs'), value: draft.limits.timeoutMs, type: 'number', min: 0, fieldErrors })
    + '</div>'
    + '</details>'
    + '</div>';
}

/**
 * Harness checkbox rows. A profile starts with an empty allow-list (no extra
 * restriction); any already-typed harness is kept even when it is not in the
 * catalog, so a save never silently drops it.
 *
 * @param {unknown[]} [allowed]
 * @returns {Array<{ value: string, label: string }>}
 */
function allowedHarnessOptions(allowed = []) {
  const seen = new Set();
  /** @type {Array<{ value: string, label: string }>} */
  const rows = [];
  for (const harness of SCOUT_EDITOR_HARNESSES) {
    seen.add(harness);
    rows.push({ value: harness, label: harness });
  }
  for (const raw of Array.isArray(allowed) ? allowed : []) {
    const value = asText(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    rows.push({ value, label: value });
  }
  return rows;
}

/**
 * The editor card: a picker when no draft is open, otherwise the form. Never
 * renders the full catalog defaults for a draft — every control reads the
 * explicit draft value.
 *
 * @param {{
 *   loading?: boolean, error?: string, draft?: object | null, profiles?: object[],
 *   templates?: object[], preview?: object | null, mode?: string,
 *   busy?: boolean, dirty?: boolean, fieldErrors?: Record<string, string>,
 *   casConflict?: boolean, selectedId?: string, originalProfile?: object | null,
 * }} [view]
 * @returns {string}
 */
export function renderScoutEditorHtml(view = {}) {
  if (view.loading === true) {
    return `<div class="cr-card watcher-form watcher-scout-editor-card" data-scout-editor data-scout-editor-loading>`
      + `<p class="cr-hint" role="status">${escapeWatcherHtml(t('settings.watcherScoutEditorLoading'))}</p></div>`;
  }
  if (view.draft) return renderEditorForm(view);
  const toolbar = renderEditorToolbar(view);
  if (asText(view.error)) {
    const block = `<div class="message watcher-scout-error" data-tone="error" role="alert">${escapeWatcherHtml(view.error)}</div>`;
    return toolbar.replace(/<\/div>$/, `${block}</div>`);
  }
  return toolbar;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatPreviewValue(value) {
  if (Array.isArray(value)) return value.map((entry) => asText(entry)).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return asText(value);
}

/**
 * Effective-config preview of a draft or saved profile. Explicitly separates the
 * technical `agent` transport from the host read-only policy: Scout is never
 * presented as running in Plan mode.
 *
 * @param {{ preview?: object | null, error?: string }} [view]
 * @returns {string}
 */
export function renderScoutPreviewHtml(view = {}) {
  const error = asText(view.error);
  if (error) {
    return '<div class="cr-card watcher-form watcher-scout-preview-card" data-scout-preview>'
      + `<div class="message watcher-scout-error" data-tone="error" role="alert">${escapeWatcherHtml(error)}</div></div>`;
  }
  const preview = view.preview;
  if (!preview || typeof preview !== 'object') return '';
  const config = preview.config && typeof preview.config === 'object' ? preview.config : {};
  const rows = PREVIEW_CONFIG_FIELDS.map((field) => {
    const entry = config[field];
    if (!entry || typeof entry !== 'object') return '';
    const provenance = asText(entry.source) || 'default';
    return '<li class="watcher-scout-preview-field"'
      + ` data-scout-config-field="${escapeWatcherAttr(field)}">`
      + `<span class="watcher-scout-preview-field-name">${escapeWatcherHtml(t(`settings.watcherScoutPreviewField_${field}`))}</span>`
      + `<span class="watcher-scout-provenance" data-scout-provenance="${escapeWatcherAttr(provenance)}">`
      + `${escapeWatcherHtml(scoutProvenanceText(provenance))}</span>`
      + `<span class="watcher-scout-preview-value">${escapeWatcherHtml(formatPreviewValue(entry.value))}</span>`
      + '</li>';
  }).join('');

  const matched = Array.isArray(preview.matchedFiles) ? preview.matchedFiles : [];
  const matchedFiles = matched.length
    ? '<ul class="watcher-scout-preview-files">'
      + matched.slice(0, PREVIEW_MAX_FILES).map((file) => `<li><code>${escapeWatcherHtml(asText(file))}</code></li>`).join('')
      + '</ul>'
    : (preview.signals?.scopeStatus === 'error' ? '' : `<p class="cr-hint" data-scout-preview-no-files>${escapeWatcherHtml(t('settings.watcherScoutPreviewNoFiles'))}</p>`);
  const resolution = preview.signals || {};
  const gitDiagnostics = (Array.isArray(resolution.diagnostics) ? resolution.diagnostics : []);
  const scopeDetails = '<div data-scout-scope-resolution>'
    + (resolution.resolvedBase ? `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutResolvedBase'))}: <code>${escapeWatcherHtml(resolution.resolvedBase)} (${escapeWatcherHtml(resolution.baseCommit)})</code></p>` : '')
    + gitDiagnostics.map((entry) => `<p class="cr-hint" data-scout-git-diagnostic="${escapeWatcherAttr(entry.code)}">${escapeWatcherHtml(entry.message)}</p>`).join('')
    + '</div>';

  const blockers = Array.isArray(preview.blockers) ? preview.blockers.filter(Boolean) : [];
  const unsupportedHarness = blockers.some((blocker) => asText(blocker?.code) === 'read_only_unsupported_harness');
  const readOnlyState = unsupportedHarness ? 'unsupported' : 'supported';
  const readOnlyText = unsupportedHarness
    ? t('settings.watcherScoutReadOnlyUnsupported')
    : t('settings.watcherScoutReadOnlySupported');
  const blockerRows = blockers.length
    ? '<ul class="watcher-scout-preview-blockers">'
      + blockers.map((blocker) => (
        `<li data-scout-blocker="${escapeWatcherAttr(asText(blocker?.code))}">`
        + `${escapeWatcherHtml(asText(blocker?.code).startsWith('git_') ? asText(blocker?.message) : scoutBlockerText(blocker?.code))}</li>`
      )).join('')
      + '</ul>'
    : `<p class="cr-hint" data-scout-preview-no-blockers>${escapeWatcherHtml(t('settings.watcherScoutPreviewNoBlockers'))}</p>`;

  const prompt = asText(preview.prompt);
  const promptBlock = prompt
    ? '<details class="watcher-scout-preview-prompt"><summary>'
      + `${escapeWatcherHtml(t('settings.watcherScoutPreviewPrompt'))}</summary>`
      + `<pre><code>${escapeWatcherHtml(prompt)}</code></pre></details>`
    : '';

  return '<div class="cr-card watcher-form watcher-scout-preview-card" data-scout-preview>'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutPreviewTitle'))}</h4>`
    + '<p class="cr-hint watcher-scout-transport" data-scout-transport="agent">'
    + `${escapeWatcherHtml(t('settings.watcherScoutTransportAgent'))}</p>`
    + `<p class="cr-hint watcher-scout-readonly" data-scout-readonly="${escapeWatcherAttr(readOnlyState)}">`
    + `${escapeWatcherHtml(readOnlyText)}</p>`
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutPreviewModelStarted'))}</p>`
    + '<ul class="watcher-scout-preview-fields">' + rows + '</ul>'
    + scopeDetails
    + '<div class="watcher-scout-preview-section">'
    + `<h5 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutPreviewFiles'))}</h5>`
    + matchedFiles + '</div>'
    + '<div class="watcher-scout-preview-section">'
    + `<h5 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutPreviewBlockers'))}</h5>`
    + blockerRows + '</div>'
    + promptBlock
    + '</div>';
}

/**
 * "From template" grid. An empty catalog renders an honest empty state, never an
 * empty grid.
 *
 * @param {{ templates?: object[], busy?: boolean }} [view]
 * @returns {string}
 */
export function renderScoutTemplatesHtml(view = {}) {
  const templates = Array.isArray(view.templates) ? view.templates.filter(Boolean) : [];
  const busy = view.busy === true;
  const body = templates.length
    ? '<div class="watcher-scout-templates">'
      + templates.map((template) => {
        const id = asText(template?.id);
        return '<div class="watcher-scout-template"'
          + ` data-scout-template-id="${escapeWatcherAttr(id)}">`
          + '<div class="watcher-scout-template-head">'
          + `<span class="watcher-scout-template-name">${escapeWatcherHtml(asText(template?.name) || id)}</span>`
          + `<span class="cr-hint">v${escapeWatcherHtml(String(template?.version == null ? '1' : template.version))}</span>`
          + '</div>'
          + `<p class="cr-hint">${escapeWatcherHtml(asText(template?.description))}</p>`
          + `<p class="cr-hint watcher-scout-template-objective">${escapeWatcherHtml(asText(template?.objective))}</p>`
          + renderScoutEditorButton('template-pick', t('settings.watcherScoutTemplatesUse'), {
            scoutId: id,
            icon: 'mdi-file-document-outline',
            disabled: busy,
          })
          + '</div>';
      }).join('')
      + '</div>'
    : `<p class="cr-hint" data-scout-templates-empty>${escapeWatcherHtml(t('settings.watcherScoutTemplatesEmpty'))}</p>`;
  return '<div class="cr-card watcher-form watcher-scout-templates-card" data-scout-templates>'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutTemplatesTitle'))}</h4>`
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutTemplatesHint'))}</p>`
    + body
    + '</div>';
}

/**
 * Restore diff confirmation. An empty diff renders a "nothing to restore"
 * message instead of an empty `0 rows` table.
 *
 * @param {{
 *   diff?: object[] | null, templateId?: string, templateVersion?: string,
 *   templateName?: string, error?: string, busy?: boolean, scoutId?: string,
 * }} [view]
 * @returns {string}
 */
export function renderScoutRestoreHtml(view = {}) {
  const error = asText(view.error);
  if (error) {
    return '<div class="cr-card watcher-form watcher-scout-restore-card" data-scout-restore>'
      + `<div class="message watcher-scout-error" data-tone="error" role="alert">${escapeWatcherHtml(error)}</div></div>`;
  }
  if (!Array.isArray(view.diff)) return '';
  const busy = view.busy === true;
  const scoutId = asText(view.scoutId);
  const diff = view.diff.filter(Boolean);
  const templateName = asText(view.templateName) || asText(view.templateId) || '';
  const header = '<h4 class="watcher-section-title">'
    + escapeWatcherHtml(t('settings.watcherScoutRestoreTitle')) + '</h4>';
  const question = `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutRestoreQuestion', {
    name: templateName || t('settings.watcherScoutRestoreTemplateFallback'),
  }))}</p>`;
  if (diff.length === 0) {
    return '<div class="cr-card watcher-form watcher-scout-restore-card" data-scout-restore>'
      + header
      + `<p class="cr-hint" data-scout-restore-empty>${escapeWatcherHtml(t('settings.watcherScoutRestoreEmpty'))}</p>`
      + '<div class="cr-row watcher-scout-profile-actions">'
      + renderScoutEditorButton('restore-cancel', t('settings.watcherScoutRestoreCancel'), { icon: 'mdi-close' })
      + '</div></div>';
  }
  const rows = diff.map((entry) => (
    '<tr>'
    + `<td class="watcher-scout-restore-field">${escapeWatcherHtml(asText(entry.field))}</td>`
    + `<td class="watcher-scout-restore-before"><code>${escapeWatcherHtml(asText(entry.before))}</code></td>`
    + `<td class="watcher-scout-restore-after"><code>${escapeWatcherHtml(asText(entry.after))}</code></td>`
    + '</tr>'
  )).join('');
  return '<div class="cr-card watcher-form watcher-scout-restore-card" data-scout-restore>'
    + header
    + question
    + '<table class="watcher-scout-restore-diff">'
    + '<thead><tr>'
    + `<th>${escapeWatcherHtml(t('settings.watcherScoutRestoreField'))}</th>`
    + `<th>${escapeWatcherHtml(t('settings.watcherScoutRestoreBefore'))}</th>`
    + `<th>${escapeWatcherHtml(t('settings.watcherScoutRestoreAfter'))}</th>`
    + '</tr></thead>'
    + `<tbody>${rows}</tbody></table>`
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutRestoreConfirmHint'))}</p>`
    + '<div class="cr-row watcher-scout-profile-actions">'
    + renderScoutEditorButton('restore-confirm', t('settings.watcherScoutRestoreConfirm'), { scoutId, icon: 'mdi-check', disabled: busy })
    + renderScoutEditorButton('restore-cancel', t('settings.watcherScoutRestoreCancel'), { icon: 'mdi-close', disabled: busy })
    + '</div></div>';
}
