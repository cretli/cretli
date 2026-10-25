/**
 * The live regions of the Watcher settings panel. Each one is a Lit element that
 * reads the store and renders a single card; none of them touches the policy
 * form, so a live update can never drop unsaved edits.
 */

import { getTodoTitle } from '../api.js';
import { escapeHtml } from '../format.js';
import { t } from '../../../../i18n/index.js';
import { renderWatcherAlertsHtml, renderWatcherDecisionsHtml, renderWatcherLiveHtml, renderWatcherScheduleHtml, renderWatcherStatsHtml } from '../../../watcher/watcherDashboard.js';
import { renderScoutInboxHtml } from '../../../watcher/scoutFindingsInboxView.js';
import { renderScoutHistoryHtml } from '../../../watcher/scoutHistoryView.js';
import { renderScoutEditorHtml, renderScoutPreviewHtml, renderScoutRestoreHtml, renderScoutTemplatesHtml } from '../../../watcher/scoutProfileEditorView.js';
import { renderScoutProfilesHtml } from '../../../watcher/scoutProfilesView.js';
import { renderWatcherTimelineHtml } from '../../../watcher/watcherTimeline.js';
import { bindRuntimeToggle, tickWatcherTimes } from '../runtime.js';
import { ws } from '../store.js';
import { renderScoutScheduleHtml, renderWatcherLoadHtml, renderWatcherRuntimeControlHtml, renderWatcherStatusCardHtml, restoreView } from '../views.js';
import { defineWatcherRegion } from './watcherRegion.js';

/** Refresh the per-second countdown nodes a region just rendered. */
const tickAfterRender = (region) => tickWatcherTimes(region.panelRoot);

export const CrWatcherStatusCard = defineWatcherRegion(
  'cr-watcher-status-card',
  () => (ws.lastView ? renderWatcherStatusCardHtml(ws.lastView) : ''),
  { afterRender: tickAfterRender },
);

export const CrWatcherRuntimeControl = defineWatcherRegion(
  'cr-watcher-runtime-control',
  () => `<h4 class="watcher-section-title">${escapeHtml(t('settings.watcherRuntimeTitle'))} <span class="watcher-section-hint">${escapeHtml(t('settings.watcherRuntimeScopeHint'))}</span></h4>${renderWatcherRuntimeControlHtml(ws.runtimeControl || {})}`,
  { afterRender: (region) => bindRuntimeToggle(region) },
);

export const CrWatcherLoadMetrics = defineWatcherRegion(
  'cr-watcher-load-metrics',
  () => (ws.loadMetrics.loaded
    ? `<h4 class="watcher-section-title">${escapeHtml(t('settings.watcherLoadTitle'))}</h4>${renderWatcherLoadHtml(ws.loadMetrics.load)}`
    : ''),
);

export const CrWatcherSchedule = defineWatcherRegion(
  'cr-watcher-schedule',
  () => renderWatcherScheduleHtml(ws.lastView?.schedule || {}, Date.now()),
  { afterRender: tickAfterRender },
);

export const CrWatcherScoutSchedule = defineWatcherRegion(
  'cr-watcher-scout-schedule',
  () => renderScoutScheduleHtml(ws.lastView?.scout || {}, Date.now()),
  { afterRender: tickAfterRender },
);

export const CrWatcherDashboard = defineWatcherRegion(
  'cr-watcher-dashboard',
  () => {
    const view = ws.lastView || { watcher: {} };
    const stats = ws.lastStats || {};
    const dash = ws.dash;
    void ws.todoTitles;
    const now = Date.now();
    return ''
      + '<h3 class="watcher-dashboard-title">' + escapeHtml(t('settings.watcherDashboardTitle')) + '</h3>'
      + '<p class="cr-hint">' + escapeHtml(t('settings.watcherDashboardHint')) + '</p>'
      + renderWatcherAlertsHtml(view, { now })
      + renderWatcherLiveHtml(view, { stats, getTodoTitle, now })
      + renderWatcherTimelineHtml(stats, view, {
        now,
        rangeKey: dash.range,
        selectedId: dash.selectedCycleId,
        getTodoTitle,
      })
      + renderWatcherStatsHtml(stats)
      + renderWatcherDecisionsHtml(view.watcher?.decisions || [], {
        kinds: stats.decisionKinds,
        filterKind: dash.decisionsFilter,
      });
  },
  { afterRender: tickAfterRender },
);

export const CrWatcherScoutProfiles = defineWatcherRegion(
  'cr-watcher-scout-profiles',
  () => renderScoutProfilesHtml(/** @type {any} */ ({ ...ws.scoutProfilesState, now: Date.now() })),
  { afterRender: tickAfterRender },
);

export const CrWatcherScoutHistory = defineWatcherRegion(
  'cr-watcher-scout-history',
  () => renderScoutHistoryHtml(/** @type {any} */ ({ ...ws.scoutHistoryState, profiles: ws.scoutProfilesState.profiles })),
);

export const CrWatcherScoutInbox = defineWatcherRegion(
  'cr-watcher-scout-inbox',
  () => renderScoutInboxHtml(/** @type {any} */ ({
    ...ws.scoutInboxState,
    profiles: ws.scoutProfilesState.profiles,
    autoCreate: (ws.lastView?.watcher?.policy ?? ws.lastView?.policy)?.scoutAutoCreate === true,
    getTodoTitle,
  })),
);

/**
 * The editor regions read only the editor state. The profile list is read with
 * `peek` and the language is not tracked: a reload of the list or a language
 * change must never rebuild a draft the operator is typing into.
 */
export const CrWatcherScoutEditor = defineWatcherRegion(
  'cr-watcher-scout-editor',
  () => renderScoutEditorHtml(/** @type {any} */ ({
    ...ws.scoutEditorState,
    profiles: ws.peek('scoutProfilesState').profiles,
    now: Date.now(),
  })),
  { trackLanguage: false },
);

export const CrWatcherScoutTemplates = defineWatcherRegion(
  'cr-watcher-scout-templates',
  () => renderScoutTemplatesHtml({ templates: ws.scoutEditorState.templates, busy: ws.scoutEditorState.busy }),
  { trackLanguage: false },
);

export const CrWatcherScoutPreview = defineWatcherRegion(
  'cr-watcher-scout-preview',
  () => renderScoutPreviewHtml({ preview: ws.scoutEditorState.preview, error: ws.scoutEditorState.previewError }),
  { trackLanguage: false },
);

export const CrWatcherScoutRestore = defineWatcherRegion(
  'cr-watcher-scout-restore',
  () => renderScoutRestoreHtml(restoreView()),
  { trackLanguage: false },
);
