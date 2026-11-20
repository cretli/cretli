/**
 * Fetching the watcher view and publishing it to the store.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { SCOUT_INBOX_PAGE_SIZE } from '../../watcher/scoutFindingsInboxView.js';
import { SCOUT_HISTORY_PAGE_SIZE } from '../../watcher/scoutHistoryView.js';
import { watcherWorkspaceScopeChanged } from '../../watcher/watcherWorkspaceScope.js';
import { watcherApi } from './api.js';
import { applyWorkspaceOverridesResponse } from './overrides.js';
import { mountWatcherPanel } from './components/watcherPanel.js';
import { renderWatcherPanel } from './panelView.js';
import { applyScoutHistoryResponse, applyScoutInboxResponse } from './scoutFeed.js';
import { applyScoutProfilesResponse } from './scoutProfiles.js';
import { EMPTY_SCOUT_EDITOR_STATE, EMPTY_SCOUT_HISTORY_STATE, EMPTY_SCOUT_INBOX_STATE, EMPTY_SCOUT_PROFILES_STATE } from './constants.js';

export async function refreshWorkspaceWatcherSettingsPanel(options = {}) {
  const root = document.getElementById('settings-watcher-root');
  if (!root) return;
  // Until the panel has rendered its form once, force a full render even for a
  // "live" call, so a change event that races the initial load can't leave the
  // form unmounted (the superseded full render would otherwise be dropped). A
  // workspace switch also forces the full path: the live path must never leave
  // the previous workspace's policy editable.
  const full = options.full !== false
    || root.dataset.rendered !== 'true'
    || watcherWorkspaceScopeChanged(ws.renderedWorkspaceFolder);
  const seq = ++ws.refreshSeq;
  if (full) {
    mountWatcherPanel(root);
    ws.panelModel = { kind: 'loading' };
    // A full render is a fresh start for the list: drop a stale confirmation and
    // show the loading state until the fetch resolves.
    ws.scoutProfilesState = { ...EMPTY_SCOUT_PROFILES_STATE };
    ws.scoutHistoryState = { ...EMPTY_SCOUT_HISTORY_STATE };
    ws.scoutInboxState = { ...EMPTY_SCOUT_INBOX_STATE };
    // A workspace switch must not leave the previous workspace's profile draft
    // on screen; within one workspace the draft survives a full render.
    if (watcherWorkspaceScopeChanged(ws.renderedWorkspaceFolder)) {
      ws.scoutEditorState = { ...EMPTY_SCOUT_EDITOR_STATE };
    }
  }
  const scoutHistoryPath = full
    ? `/api/workspace-watcher/scout/history?max=${SCOUT_HISTORY_PAGE_SIZE}`
    : null;
  const scoutInboxPath = full
    ? `/api/workspace-watcher/scout?max=${SCOUT_INBOX_PAGE_SIZE}`
    : null;
  // The harness catalog is only needed to build the form (full path); fetch it
  // alongside the watcher view so the checkbox list renders synchronously. The
  // profile list is additive: a failure degrades to an error card, it must never
  // reject the whole refresh and blank the rest of the panel.
  /** @type {{ status: number, json: any } | null} */
  let res = null;
  let catalog = null;
  let runtime = null;
  let profilesRes = null;
  let historyRes = null;
  let inboxRes = null;
  let overridesRes = null;
  try {
    [res, catalog, runtime, profilesRes, historyRes, inboxRes, overridesRes] = await Promise.all([
      watcherApi('/api/workspace-watcher'),
      full ? watcherApi('/api/harness-catalog/harnesses') : Promise.resolve(null),
      watcherApi('/api/workspace-watcher/runtime-control'),
      full ? watcherApi('/api/workspace-watcher/scout/profiles').catch(() => null) : Promise.resolve(null),
      full && scoutHistoryPath ? watcherApi(scoutHistoryPath).catch(() => null) : Promise.resolve(null),
      full && scoutInboxPath ? watcherApi(scoutInboxPath).catch(() => null) : Promise.resolve(null),
      full ? watcherApi('/api/workspace-watcher/overrides').catch(() => null) : Promise.resolve(null),
    ]);
  } catch {
    if (seq !== ws.refreshSeq) return;
    if (full) {
      ws.panelModel = { kind: 'error', message: t('settings.watcherLoadError') };
    }
    return;
  }
  // A newer refresh (a save, or another live event) already owns the paint.
  if (seq !== ws.refreshSeq) return;
  if (catalog?.json?.ok && Array.isArray(catalog.json.items)) {
    ws.harnessOptions = catalog.json.items
      .map((row) => ({ id: String(row?.id ?? '').trim(), label: String(row?.label ?? row?.id ?? '').trim() }))
      .filter((row) => row.id);
  }
  if (full) {
    applyScoutProfilesResponse(profilesRes);
    applyScoutHistoryResponse(historyRes);
    applyScoutInboxResponse(inboxRes, res.json?.scout);
    applyWorkspaceOverridesResponse(overridesRes);
  }
  if (!res?.json?.ok) {
    if (full) ws.panelModel = { kind: 'error', message: res?.json?.error || t('settings.watcherLoadError') };
    return;
  }
  ws.runtimeControl = runtime?.json?.runtimeControl || { statusUnavailable: true };
  ws.lastView = res.json;
  ws.viewSeq += 1;
  // Only the full path rebuilds the form. The live path just updates the store:
  // the regions that read the view re-render themselves and the operator's
  // unsaved form edits stay untouched.
  if (full) {
    ws.panelModel = {
      kind: 'ready',
      rev: ++ws.panelRev,
      data: ws.lastView,
      html: renderWatcherPanel(ws.lastView),
    };
    root.dataset.rendered = 'true';
    ws.renderedWorkspaceFolder = String(res.json.workspaceFolder || res.json.cwd || '').trim();
  }
  // The dashboard is additive: a stats/todos failure degrades to "no data" /
  // short ids, it must never blank out the already-rendered status/form.
  try {
    await Promise.all([loadWatcherStats(seq), loadTodoTitles(seq)]);
  } catch {
    // loadWatcherStats / loadTodoTitles swallow errors; guard against future throws.
  }
}

/**
 * Fetch the workspace todo titles once per refresh so active cycles render a
 * human title next to the id. A failure keeps the previous map.
 */
export async function loadTodoTitles(seq) {
  try {
    const res = await watcherApi('/api/todos');
    if (seq != null && seq !== ws.refreshSeq) return;
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    const next = new Map();
    for (const item of items) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      next.set(id, String(item?.title || '').trim());
    }
    ws.todoTitles = next;
  } catch {
    // Keep whatever we had.
  }
}

/**
 * Fetch the aggregated monitoring stats into `ws.lastStats`. Errors leave the
 * previous value so a transient failure does not empty the dashboard. A stale
 * (superseded) response is dropped so it cannot overwrite fresher state.
 */
export async function loadWatcherStats(seq) {
  try {
    const res = await watcherApi('/api/workspace-watcher/stats');
    if (seq != null && seq !== ws.refreshSeq) return;
    if (res.json?.ok) {
      ws.lastStats = res.json;
    }
  } catch {
    // Keep whatever we had.
  }
}
