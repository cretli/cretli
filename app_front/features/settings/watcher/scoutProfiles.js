/**
 * Scout profile list: load, mutate and the list-action dispatcher.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { SCOUT_EDITOR_ACTIONS } from '../../watcher/scoutProfileEditorView.js';
import { nextScoutProfileName, scoutRunResultText } from '../../watcher/scoutProfilesView.js';
import { watcherApi } from './api.js';
import { runScoutEditorAction } from './scoutEditor.js';
import { refreshScoutHistoryAndInbox } from './scoutFeed.js';
import { SCOUT_CATEGORIES } from './constants.js';

/**
 * Store one profiles response as the new server truth. Busy/confirmation state
 * is always cleared here: the list is authoritative again.
 *
 * @param {{ status?: number, json?: any | null } | null} res
 */
export function applyScoutProfilesResponse(res) {
  const next = { ...ws.scoutProfilesState, loading: false, busy: false, busyId: '', busyAction: '' };
  if (res?.json?.ok === true && Array.isArray(res.json.profiles)) {
    ws.scoutProfilesState = { ...next, error: '', profiles: res.json.profiles };
    return;
  }
  ws.scoutProfilesState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutProfilesError'),
    profiles: [],
  };
}

/**
 * Re-read the profile list into the store. Used after every mutation so the UI
 * reflects server truth (revision, counters, archived flag) instead of an
 * optimistic guess; only the list region re-renders, never the policy form.
 */
export async function reloadScoutProfiles() {
  ws.scoutProfilesState = {
    ...ws.scoutProfilesState,
    loading: true,
    error: '',
    busy: false,
    busyId: '',
    busyAction: '',
  };
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout/profiles');
  } catch {
    res = null;
  }
  applyScoutProfilesResponse(res);
}

/**
 * @param {string} text
 * @param {'ok' | 'error'} [tone]
 */
export function setScoutProfilesMessage(text, tone = 'ok') {
  ws.scoutProfilesState = {
    ...ws.scoutProfilesState,
    message: String(text ?? '').trim(),
    messageTone: tone === 'error' ? 'error' : 'ok',
  };
}

/**
 * Strip server-owned fields and the additive `state` before an update PATCH, so
 * the payload carries exactly the user-editable configuration.
 *
 * @param {any | null | undefined} profile
 * @returns {any}
 */
export function stripScoutProfileState(profile) {
  const body = { ...(profile && typeof profile === 'object' ? profile : {}) };
  for (const field of ['state', 'id', 'revision', 'createdAt', 'updatedAt']) delete body[field];
  return body;
}

/**
 * @param {string} action
 * @returns {string}
 */
export function scoutProfileSuccessMessage(action) {
  if (action === 'create') return t('settings.watcherScoutCreated');
  if (action === 'duplicate') return t('settings.watcherScoutDuplicated');
  if (action === 'archive-confirm') return t('settings.watcherScoutArchived');
  return t('settings.watcherScoutUpdated');
}

/**
 * Perform the API call behind one list action.
 *
 * @param {string} action
 * @param {any | null} profile
 * @param {string} scoutId
 * @returns {Promise<{ status?: number, json?: any | null }>}
 */
export async function scoutProfileMutation(action, profile, scoutId) {
  const encoded = encodeURIComponent(scoutId);
  if (action === 'create') {
    return watcherApi('/api/workspace-watcher/scout/profiles', {
      method: 'POST',
      body: {
        profile: {
          name: nextScoutProfileName(ws.scoutProfilesState.profiles.map((row) => row?.name)),
          objective: t('settings.watcherScoutNewDefaultObjective'),
          enabled: false,
          schedule: { mode: 'manual' },
          categories: [...SCOUT_CATEGORIES],
        },
      },
    });
  }
  if (action === 'duplicate') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/duplicate`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'archive-confirm') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/archive`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'run') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/run`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'toggle') {
    const nextProfile = stripScoutProfileState(profile);
    nextProfile.enabled = profile?.enabled !== true;
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}`, {
      method: 'PATCH',
      body: {
        expectedRevision: Math.max(1, Math.floor(Number(profile?.revision) || 1)),
        profile: nextProfile,
      },
    });
  }
  return { status: 400, json: { ok: false, error: t('settings.watcherActionError') } };
}

/**
 * Dispatch one management action from the profile list. A mutation marks the
 * row busy, calls the API, reports a readable message (including the 409 CAS
 * conflict) and then re-reads the list from the server. Every change goes through
 * the store, so only the Scout profile region re-renders.
 *
 * @param {string} action
 * @param {string} scoutId
 */
export async function runScoutProfileAction(action, scoutId) {
  // The editor surface has its own action namespace; route it to the editor
  // dispatcher so a rendered editor button is never treated as a list action.
  if (SCOUT_EDITOR_ACTIONS.includes(action)) {
    await runScoutEditorAction(action, scoutId);
    return;
  }
  if (action === 'archive') {
    ws.scoutProfilesState = { ...ws.scoutProfilesState, confirmArchiveId: scoutId, message: '', messageTone: 'ok' };
    return;
  }
  if (action === 'archive-cancel') {
    ws.scoutProfilesState = { ...ws.scoutProfilesState, confirmArchiveId: '' };
    return;
  }
  if (action === 'reload') {
    await reloadScoutProfiles();
    return;
  }
  const profile = ws.scoutProfilesState.profiles.find((row) => String(row?.id ?? '') === scoutId) || null;
  if (action !== 'create' && !profile) return;
  ws.scoutProfilesState = {
    ...ws.scoutProfilesState,
    busy: true,
    busyId: scoutId,
    busyAction: action,
    confirmArchiveId: '',
    message: '',
    messageTone: 'ok',
  };
  let res;
  try {
    res = await scoutProfileMutation(action, profile, scoutId);
  } catch {
    res = { status: 0, json: null };
  }
  const conflict = res?.status === 409;
  if (action === 'run') {
    // A blocked manual run answers HTTP 200 with ok:false and a reason.
    const started = res?.json?.ok === true && res?.json?.scanned !== false;
    if (started) {
      setScoutProfilesMessage(
        t('settings.watcherScoutRunStarted', { n: Number(res.json.added) || 0 }),
        'ok',
      );
    } else {
      setScoutProfilesMessage(
        scoutRunResultText(res?.json),
        res?.json?.reason === 'no_files_in_scope' ? 'ok' : 'error',
      );
    }
  } else if (res?.json?.ok === true) {
    setScoutProfilesMessage(scoutProfileSuccessMessage(action), 'ok');
  } else {
    setScoutProfilesMessage(
      conflict ? t('settings.watcherScoutCasConflict') : (res?.json?.error || t('settings.watcherActionError')),
      'error',
    );
  }
  // Always re-read: it resolves a stale revision (409) and reflects the real
  // counters after a manual run.
  await reloadScoutProfiles();
  if (action === 'run' && res?.json?.ok === true && res?.json?.scanned !== false) {
    await refreshScoutHistoryAndInbox(res.json?.scout);
  }
}
