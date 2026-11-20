/**
 * Scout profile editor: draft edits, actions and delegated input handling.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { applyDraftEdit, draftFromProfile, draftFromTemplate, scoutEditorFieldErrors, scoutEditorTabForField } from '../../watcher/scoutProfileEditorView.js';
import { nextScoutProfileName } from '../../watcher/scoutProfilesView.js';
import { watcherApi } from './api.js';
import { reloadScoutProfiles, setScoutProfilesMessage } from './scoutProfiles.js';
import { EMPTY_SCOUT_EDITOR_STATE } from './constants.js';
import { queryFields } from './format.js';
import { getGitBranches } from '../../../core/api/git.js';

/* -------------------------------------------------------------------------- */
/* Scout profile editor (stage 5.2)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Strip server-owned fields and the additive `state` before an editor save.
 *
 * @param {any | null | undefined} draft
 * @returns {any}
 */
export function stripScoutEditorDraft(draft) {
  const body = { ...(draft && typeof draft === 'object' ? draft : {}) };
  for (const field of ['state', 'id', 'revision', 'createdAt', 'updatedAt']) delete body[field];
  return body;
}

/**
 * Overrides sent with `from-template`: everything the user edited except the
 * server-owned identity, the template link and the automation invariant
 * (`enabled`/`schedule` are forced by the control layer).
 *
 * @param {any} draft
 * @returns {any}
 */
export function templateOverridesFromDraft(draft) {
  const body = stripScoutEditorDraft(draft);
  delete body.templateId;
  delete body.templateVersion;
  delete body.enabled;
  delete body.schedule;
  return body;
}

/**
 * @param {any | null | undefined} profile
 * @param {string} scoutId
 * @returns {any | null}
 */
export function findScoutProfile(profile, scoutId) {
  if (profile && String(profile.id ?? '') === scoutId) return profile;
  return ws.scoutProfilesState.profiles.find((row) => String(row?.id ?? '') === scoutId) || null;
}

/**
 * @param {string} templateId
 * @returns {string}
 */
export function scoutTemplateName(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return '';
  const template = ws.scoutEditorState.templates.find((row) => String(row?.id ?? '') === id);
  return String(template?.name ?? '').trim();
}

/**
 * Read one editor input back into the draft. The draft is replaced immutably so
 * the original profile (and any template) is never mutated.
 *
 * @param {HTMLElement} root
 * @param {string} path
 * @param {unknown} rawValue
 */
export function applyScoutEditorField(root, path, rawValue) {
  if (!ws.scoutEditorState.draft) return;
  const numeric = path === 'schedule.intervalHours' || path.startsWith('limits.');
  const value = numeric ? (rawValue === '' ? '' : Number(rawValue)) : rawValue;
  let draft = applyDraftEdit(ws.scoutEditorState.draft, path, value);
  // Typing an explicit harness/model is a mode switch: an explicit executor and
  // automatic selection are mutually exclusive, so a non-empty value leaves auto.
  if ((path === 'executor.harness' || path === 'executor.model') && String(value ?? '').trim() !== '') {
    draft = applyDraftEdit(draft, 'executor.auto', false);
    // Reflect the switch in the DOM without rebuilding the form, so focus and
    // caret stay where the operator is typing.
    const autoToggle = root.querySelector('#watcher-scout-editor [data-scout-editor-toggle="executor.auto"]');
    if (autoToggle instanceof HTMLInputElement) autoToggle.checked = false;
  }
  const fieldErrors = { ...ws.scoutEditorState.fieldErrors };
  delete fieldErrors[path];
  // Silent: the input already shows the value, and a re-render would rebuild it.
  ws.setSilent('scoutEditorState', {
    ...ws.scoutEditorState,
    draft,
    fieldErrors,
    dirty: true,
    error: '',
  });
  const node = root.querySelector(`#watcher-scout-editor [data-scout-field-error="${path}"]`);
  if (node) node.remove();
}

/**
 * Rebuild one include/exclude list from all of its visible inputs.
 *
 * @param {HTMLElement} root
 * @param {string} listPath
 */
export function applyScoutEditorListField(root, listPath) {
  if (!ws.scoutEditorState.draft) return;
  const inputs = queryFields(root, `#watcher-scout-editor [data-scout-editor-list-field="${listPath}"]`);
  if (inputs.length === 0) return;
  const values = inputs.map((node) => String(node.value ?? ''));
  ws.setSilent('scoutEditorState', {
    ...ws.scoutEditorState,
    draft: applyDraftEdit(ws.scoutEditorState.draft, listPath, values),
    dirty: true,
    error: '',
  });
}

/**
 * Toggle one checkbox group or boolean flag in the draft. Categories are forced
 * non-empty: unchecking the last one keeps it and shows the inline error.
 *
 * @param {string} toggle
 * @param {string} value
 * @param {boolean} checked
 */
export function applyScoutEditorToggle(toggle, value, checked) {
  const draft = ws.scoutEditorState.draft;
  if (!draft) return;
  if (toggle === 'enabled' || toggle === 'executor.auto') {
    let nextDraft = applyDraftEdit(draft, toggle, checked);
    // Re-checking automatic selection clears the explicit executor the runner
    // would ignore, so a stored profile can never carry a stale value.
    if (toggle === 'executor.auto' && checked) {
      nextDraft = applyDraftEdit(nextDraft, 'executor.harness', '');
      nextDraft = applyDraftEdit(nextDraft, 'executor.model', '');
    }
    ws.setSilent('scoutEditorState', {
      ...ws.scoutEditorState,
      draft: nextDraft,
      dirty: true,
      error: '',
    });
    // The explicit inputs enable or disable with the mode, so the region
    // re-renders for that toggle only; a plain flag keeps the DOM untouched.
    if (toggle === 'executor.auto') ws.touch('scoutEditorState');
    return;
  }
  const path = toggle === 'executor.allowedHarnesses' ? 'executor.allowedHarnesses' : toggle;
  const current = toggle === 'executor.allowedHarnesses'
    ? [...(draft.executor?.allowedHarnesses || [])]
    : [...(toggle === 'sources' ? draft.sources : draft.categories)];
  const next = checked
    ? [...new Set([...current, value])]
    : current.filter((entry) => String(entry) !== String(value));
  if (toggle === 'categories' && next.length === 0) {
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      fieldErrors: {
        ...ws.scoutEditorState.fieldErrors,
        categories: t('settings.watcherScoutFieldErrors_categoriesRequired'),
      },
      // The inline error lives inside the Advanced tab; keep it visible.
      activeTab: 'advanced',
    };
    return;
  }
  /** @type {Record<string, string>} */
  const fieldErrors = { ...ws.scoutEditorState.fieldErrors };
  if (toggle === 'categories') delete fieldErrors.categories;
  ws.scoutEditorState = {
    ...ws.scoutEditorState,
    draft: applyDraftEdit(draft, path, next),
    fieldErrors,
    dirty: true,
    error: '',
  };
}

/**
 * One editor action. Every branch keeps the draft on screen on a validation
 * error, and only clears it after the server confirmed a save.
 *
 * @param {string} action
 * @param {string} scoutId
 */
export async function runScoutEditorAction(action, scoutId) {
  const selectedId = String(scoutId || ws.scoutEditorState.selectedId || '').trim();
  const profile = findScoutProfile(ws.scoutEditorState.originalProfile, selectedId);
  const removeIndex = ws.scoutEditorRemoveIndex;
  ws.scoutEditorRemoveIndex = -1;

  if (action === 'new-profile') {
    ws.scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: ws.scoutEditorState.templates,
      selectedId,
      mode: 'create',
      draft: applyDraftEdit(
        applyDraftEdit(draftFromProfile(null), 'name',
          nextScoutProfileName(ws.scoutProfilesState.profiles.map((row) => row?.name))),
        'objective',
        t('settings.watcherScoutNewDefaultObjective'),
      ),
      dirty: false,
    };
    return;
  }
  if (action === 'edit') {
    if (!profile) return;
    ws.scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: ws.scoutEditorState.templates,
      selectedId,
      mode: 'edit',
      draft: draftFromProfile(profile),
      originalProfile: profile,
    };
    return;
  }
  if (action === 'from-template') {
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, error: '' };
    let templates = ws.scoutEditorState.templates;
    if (templates.length === 0) {
      const res = await watcherApi('/api/workspace-watcher/scout/templates').catch(() => null);
      if (res?.json?.ok && Array.isArray(res.json.templates)) {
        templates = res.json.templates;
        ws.scoutEditorState = { ...ws.scoutEditorState, templates, busy: false, error: '' };
      } else {
        ws.scoutEditorState = {
          ...ws.scoutEditorState,
          busy: false,
          error: res?.json?.error || t('settings.watcherScoutEditorFromTemplateError'),
        };
      }
    } else {
      ws.scoutEditorState = { ...ws.scoutEditorState, busy: false };
    }
    return;
  }
  if (action === 'template-pick') {
    const template = ws.scoutEditorState.templates.find((row) => String(row?.id ?? '') === selectedId) || null;
    if (!template) return;
    ws.scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: ws.scoutEditorState.templates,
      selectedId,
      mode: 'from-template',
      draft: draftFromTemplate(template),
    };
    return;
  }
  if (action === 'cancel' || action === 'close') {
    ws.scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: ws.scoutEditorState.templates,
      selectedId,
    };
    return;
  }
  if (action === 'add-include' || action === 'add-exclude') {
    const listPath = action === 'add-include' ? 'scope.include' : 'scope.exclude';
    const current = action === 'add-include'
      ? [...(ws.scoutEditorState.draft?.scope?.include || [])]
      : [...(ws.scoutEditorState.draft?.scope?.exclude || [])];
    current.push('');
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      draft: applyDraftEdit(ws.scoutEditorState.draft, listPath, current),
      dirty: true,
      error: '',
    };
    return;
  }
  if (action === 'remove-include' || action === 'remove-exclude') {
    const listPath = action === 'remove-include' ? 'scope.include' : 'scope.exclude';
    const index = Math.max(0, Math.floor(Number(removeIndex) || 0));
    const current = action === 'remove-include'
      ? [...(ws.scoutEditorState.draft?.scope?.include || [])]
      : [...(ws.scoutEditorState.draft?.scope?.exclude || [])];
    current.splice(index, 1);
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      draft: applyDraftEdit(ws.scoutEditorState.draft, listPath, current),
      dirty: true,
      error: '',
    };
    return;
  }
  if (action === 'preview') {
    const draft = ws.scoutEditorState.draft;
    let res;
    if (draft) {
      res = await watcherApi('/api/workspace-watcher/scout/profiles/preview-draft', {
        method: 'POST',
        body: { profile: stripScoutEditorDraft(draft) },
      }).catch(() => null);
    } else {
      if (!selectedId) return;
      res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/preview`)
        .catch(() => null);
    }
    if (res?.json?.ok) {
      ws.scoutEditorState = { ...ws.scoutEditorState, preview: res.json, previewError: '' };
    } else {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        preview: null,
        previewError: res?.json?.error || t('settings.watcherScoutEditorPreviewError'),
      };
    }
    return;
  }
  if (action === 'restore-diff') {
    if (!selectedId) {
      ws.scoutEditorState = { ...ws.scoutEditorState, restoreError: t('settings.watcherScoutEditorNoRestoreTemplate') };
      return;
    }
    const target = findScoutProfile(ws.scoutEditorState.originalProfile, selectedId);
    if (!target || !String(target.templateId || '').trim()) {
      ws.scoutEditorState = { ...ws.scoutEditorState, restoreError: t('settings.watcherScoutEditorNoRestoreTemplate') };
      return;
    }
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, restoreError: '' };
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/restore-diff`,
    ).catch(() => null);
    if (res?.json?.ok) {
      const templateId = String(res.json.templateId || target.templateId || '').trim();
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        restoreError: '',
        restoreDiff: Array.isArray(res.json.diff) ? res.json.diff : [],
        restoreMeta: {
          templateId,
          templateVersion: String(res.json.templateVersion || ''),
          templateName: scoutTemplateName(templateId) || templateId,
          scoutId: selectedId,
        },
      };
    } else {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        restoreDiff: null,
        restoreMeta: null,
        restoreError: res?.json?.error || t('settings.watcherScoutEditorRestoreDiffError'),
      };
    }
    return;
  }
  if (action === 'restore-cancel') {
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      restoreDiff: null,
      restoreMeta: null,
      restoreError: '',
    };
    return;
  }
  if (action === 'restore-confirm') {
    if (!profile) return;
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, restoreError: '' };
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/restore`,
      {
        method: 'POST',
        body: {
          expectedRevision: Math.max(1, Math.floor(Number(profile.revision) || 1)),
          confirm: true,
        },
      },
    ).catch(() => null);
    if (res?.json?.ok) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorRestoreApplied'), 'ok');
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        restoreDiff: null,
        restoreMeta: null,
        restoreError: '',
        casConflict: false,
        dirty: false,
        draft: ws.scoutEditorState.draft ? draftFromProfile(res.json.profile) : ws.scoutEditorState.draft,
        originalProfile: res.json.profile || ws.scoutEditorState.originalProfile,
      };
      await reloadScoutProfiles();
    } else if (res?.status === 409) {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        restoreError: t('settings.watcherScoutEditorCasConflict'),
      };
    } else {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        restoreError: res?.json?.error || t('settings.watcherScoutEditorRestoreError'),
      };
    }
    return;
  }
  if (action === 'reload-profile') {
    if (!selectedId) return;
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, error: '' };
    const res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`)
      .catch(() => null);
    if (res?.json?.ok && res.json.profile) {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        casConflict: false,
        error: '',
        dirty: false,
        fieldErrors: {},
        mode: 'edit',
        originalProfile: res.json.profile,
        draft: draftFromProfile(res.json.profile),
      };
    } else {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        casConflict: false,
        error: res?.json?.error || t('settings.watcherScoutEditorProfileError'),
      };
    }
    return;
  }
  if (action === 'overwrite') {
    const draft = ws.scoutEditorState.draft;
    if (!draft || !selectedId) return;
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, error: '' };
    const fresh = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`)
      .catch(() => null);
    if (!(fresh?.json?.ok && fresh.json.profile)) {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        error: fresh?.json?.error || t('settings.watcherScoutEditorProfileError'),
      };
      return;
    }
    const revision = Math.max(1, Math.floor(Number(fresh.json.profile.revision) || 1));
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`,
      {
        method: 'PATCH',
        body: { expectedRevision: revision, profile: stripScoutEditorDraft({ ...draft, revision }) },
      },
    ).catch(() => null);
    if (res?.json?.ok) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorSaved'), 'ok');
      ws.scoutEditorState = {
        ...EMPTY_SCOUT_EDITOR_STATE,
        templates: ws.scoutEditorState.templates,
        selectedId,
      };
      await reloadScoutProfiles();
      if (res.json.profile) {
        ws.scoutEditorState = {
          ...ws.scoutEditorState,
          mode: 'edit',
          originalProfile: res.json.profile,
          draft: draftFromProfile(res.json.profile),
        };
      }
    } else if (res?.status === 409) {
      ws.scoutEditorState = { ...ws.scoutEditorState, busy: false, casConflict: true, error: '' };
    } else {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        busy: false,
        error: res?.json?.error || t('settings.watcherScoutEditorOverwriteError'),
      };
    }
    return;
  }
  if (action === 'save') {
    const draft = ws.scoutEditorState.draft;
    if (!draft) return;
    const fieldErrors = scoutEditorFieldErrors(draft);
    if (Object.keys(fieldErrors).length > 0) {
      ws.scoutEditorState = {
        ...ws.scoutEditorState,
        fieldErrors,
        error: '',
        casConflict: false,
        dirty: true,
        // A rejected Advanced field must reveal the section that owns it.
        activeTab: scoutEditorFieldErrorTab(fieldErrors),
      };
      return;
    }
    const mode = ws.scoutEditorState.mode;
    ws.scoutEditorState = { ...ws.scoutEditorState, busy: true, error: '', fieldErrors: {}, casConflict: false };
    let res;
    if (mode === 'from-template') {
      res = await watcherApi('/api/workspace-watcher/scout/profiles/from-template', {
        method: 'POST',
        body: { templateId: draft.templateId, overrides: templateOverridesFromDraft(draft) },
      }).catch(() => null);
    } else if (mode === 'create') {
      res = await watcherApi('/api/workspace-watcher/scout/profiles', {
        method: 'POST',
        body: { profile: stripScoutEditorDraft(draft) },
      }).catch(() => null);
    } else {
      const id = String(draft.id || ws.scoutEditorState.originalProfile?.id || '').trim();
      res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          expectedRevision: Math.max(1, Math.floor(Number(draft.revision) || 1)),
          profile: stripScoutEditorDraft(draft),
        },
      }).catch(() => null);
    }
    if (res?.status === 409) {
      ws.scoutEditorState = { ...ws.scoutEditorState, busy: false, casConflict: true, error: '' };
      return;
    }
    if (res?.json?.ok === true) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorSaved'), 'ok');
      ws.scoutEditorState = {
        ...EMPTY_SCOUT_EDITOR_STATE,
        templates: ws.scoutEditorState.templates,
        selectedId,
      };
      await reloadScoutProfiles();
      return;
    }
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      busy: false,
      error: res?.json?.error || t('settings.watcherActionError'),
    };
  }
}

/**
 * Bind the editor's input/change delegation. The editor container is replaced on
 * every full render, so the listeners never accumulate; a draft edit never
 * rebuilds the form, so typing cannot lose focus.
 *
 * @param {HTMLElement} root
 */
export function bindScoutEditor(root) {
  const container = root.querySelector('#watcher-scout-editor');
  if (!container) return;
  const editorContainer = /** @type {HTMLElement} */ (container);
  // The region replaces the editor markup on every reactive repaint. Hydrate
  // the current picker before the one-time delegated listeners guard.
  hydrateScoutBranchSelect(container);
  if (editorContainer.dataset.scoutEditorBound === 'true') return;
  editorContainer.dataset.scoutEditorBound = 'true';
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-scout-editor-tab]') : null;
    if (!target) return;
    setScoutEditorTab(String(target.getAttribute('data-scout-editor-tab') || 'general'));
  });
  container.addEventListener('keydown', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-scout-editor-tab]') : null;
    if (!target) return;
    const tabs = [...container.querySelectorAll('[data-scout-editor-tab]')];
    const current = tabs.indexOf(target);
    if (current < 0) return;
    let next = current;
    if (/** @type {KeyboardEvent} */ (event).key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (/** @type {KeyboardEvent} */ (event).key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (/** @type {KeyboardEvent} */ (event).key === 'Home') next = 0;
    else if (/** @type {KeyboardEvent} */ (event).key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setScoutEditorTab(String(tabs[next].getAttribute('data-scout-editor-tab')));
  });
  container.addEventListener('input', (event) => {
    const target = event.target instanceof Element ? /** @type {any} */ (event.target) : null;
    if (!target) return;
    const path = target.getAttribute('data-scout-editor-field');
    if (path) {
      applyScoutEditorField(root, path, target.value);
      return;
    }
    const listPath = target.getAttribute('data-scout-editor-list-field');
    if (listPath) applyScoutEditorListField(root, listPath);
  });
  container.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? /** @type {any} */ (event.target) : null;
    if (!target) return;
    if (target.matches('[data-scout-editor-select]')) {
      ws.scoutEditorState = { ...ws.scoutEditorState, selectedId: String(target.value || '').trim() };
      return;
    }
    if (target.matches('[data-scout-editor-branch]')) {
      applyScoutEditorField(root, 'scope.base', target.value);
      return;
    }
    const path = target.getAttribute('data-scout-editor-field');
    if (path) {
      applyScoutEditorField(root, path, target.value);
      return;
    }
    const toggle = target.getAttribute('data-scout-editor-toggle');
    if (toggle) applyScoutEditorToggle(toggle, target.value, target.checked === true);
  });
}

function scoutEditorFieldErrorTab(fieldErrors) {
  const fields = Object.keys(fieldErrors || {});
  const order = ['general', 'scope', 'schedule', 'advanced'];
  return order.find((tab) => fields.some((field) => scoutEditorTabForField(field) === tab)) || 'general';
}

function setScoutEditorTab(tab) {
  if (!['general', 'scope', 'schedule', 'advanced'].includes(tab)) return;
  ws.scoutEditorState = { ...ws.scoutEditorState, activeTab: tab };
}

/** Per-todo worktree branches (`<namespace>/todo/<uuid>`) are machine-made noise as a scout base. */
const SCOUT_TASK_BRANCH_PATTERN = /^[^/]+\/todo\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export function buildScoutBranchOptions(branches = [], selected = '') {
  const keep = String(selected || '').trim();
  return [
    { value: 'auto', label: t('settings.watcherScoutBranchAuto'), description: t('settings.watcherScoutBranchAutoDescription') },
    ...(Array.isArray(branches) ? branches : []).map((value) => String(value || '').trim()).filter(Boolean)
      .filter((value) => value === keep || !SCOUT_TASK_BRANCH_PATTERN.test(value))
      .filter((value, index, values) => values.indexOf(value) === index)
      .map((value) => ({ value, label: value })),
  ];
}

export function hydrateScoutBranchSelect(container) {
  const picker = container.querySelector('[data-scout-editor-branch]');
  if (!picker) return;
  picker.options = buildScoutBranchOptions(ws.scoutEditorState.branchOptions, ws.scoutEditorState.draft?.scope?.base);
  picker.value = String(ws.scoutEditorState.draft?.scope?.base || '');
  if (picker.dataset.scoutEditorBranchBound !== 'true') {
    picker.dataset.scoutEditorBranchBound = 'true';
    picker.addEventListener('cr-change', (event) => applyScoutEditorField(container, 'scope.base', event.detail?.value || ''));
  }
  const folder = String(ws.renderedWorkspaceFolder || '').trim();
  if (!folder || ws.scoutEditorState.branchWorkspaceFolder === folder || ws.scoutEditorState.branchLoading) return;
  ws.scoutEditorState = { ...ws.scoutEditorState, branchLoading: true, branchWorkspaceFolder: folder };
  void getGitBranches({ workspaceFolder: folder }).then((result) => {
    const options = result?.ok && Array.isArray(result.branches) ? result.branches.map((row) => String(row?.name ?? row ?? '').trim()).filter(Boolean) : [];
    ws.scoutEditorState = {
      ...ws.scoutEditorState,
      branchOptions: options,
      branchOptionsLoaded: result?.ok === true,
      branchError: result?.ok ? '' : t('settings.watcherScoutBranchesError'),
      branchLoading: false,
    };
  }).catch(() => {
    ws.scoutEditorState = { ...ws.scoutEditorState, branchOptions: [], branchOptionsLoaded: false, branchError: t('settings.watcherScoutBranchesError'), branchLoading: false };
  });
}
