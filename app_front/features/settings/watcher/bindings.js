/**
 * Delegated listeners bound once per rendered panel.
 */

import { ws } from './store.js';
import { SCOUT_INBOX_ACTIONS } from '../../watcher/scoutFindingsInboxView.js';
import { SCOUT_HISTORY_ACTIONS } from '../../watcher/scoutHistoryView.js';
import { SCOUT_EDITOR_ACTIONS } from '../../watcher/scoutProfileEditorView.js';
import { SCOUT_PROFILE_ACTIONS } from '../../watcher/scoutProfilesView.js';
import { WATCHER_TIMELINE_RANGES } from '../../watcher/watcherTimeline.js';
import { openWatcherChat } from './api.js';
import { watcherApi } from './api.js';
import { saveWatcher, watcherAction } from './policyForm.js';
import { dashboardIsVisible, ensureWatcherTicker } from './runtime.js';
import { bindScoutEditor } from './scoutEditor.js';
import { bindScoutHistoryInboxFilters, runScoutHistoryAction, runScoutInboxAction } from './scoutFeed.js';
import { runScoutProfileAction } from './scoutProfiles.js';
import { resetWatcherForm, runScoutNow } from './policyForm.js';
import { applyWatcherTab, loadWatcherLoad } from './runtime.js';
import { t } from '../../../i18n/index.js';
import { queryField, queryFields, formatCooldownLabel, readDurationMs } from './format.js';

/**
 * Bind one delegated click handler onto each Scout region element. The elements
 * are replaced on every full render, so listeners never accumulate.
 * Every rendered action (see `SCOUT_PROFILE_ACTIONS`) is dispatched here, so a
 * button in the list is never a dead action.
 *
 * @param {HTMLElement} root
 */
export function bindScoutProfiles(root) {
  // One delegated click listener per swapped container: the main profile list
  // (SCOUT_PROFILE_ACTIONS) plus the stage-5.2 editor surfaces
  // (SCOUT_EDITOR_ACTIONS). Every rendered action is declared in one of the two
  // sets, so a button can never be a dead action.
  const containers = [
    queryField(root, '#watcher-scout-profiles'),
    queryField(root, '#watcher-scout-history'),
    queryField(root, '#watcher-scout-inbox'),
    queryField(root, '#watcher-scout-editor'),
    queryField(root, '#watcher-scout-templates'),
    queryField(root, '#watcher-scout-restore'),
  ].filter(Boolean);
  for (const container of containers) {
    container.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-scout-action],[data-scout-editor-action],[data-scout-history-action],[data-scout-inbox-action]')
        : null;
      if (!target || target.disabled === true) return;
      const historyAction = String(target.getAttribute('data-scout-history-action') || '').trim();
      if (historyAction) {
        if (!SCOUT_HISTORY_ACTIONS.includes(historyAction)) return;
        void runScoutHistoryAction(historyAction);
        return;
      }
      const inboxAction = String(target.getAttribute('data-scout-inbox-action') || '').trim();
      if (inboxAction) {
        if (!SCOUT_INBOX_ACTIONS.includes(inboxAction)) return;
        void runScoutInboxAction(
          inboxAction,
          String(target.getAttribute('data-scout-finding-id') || '').trim(),
          String(target.getAttribute('data-scout-todo-id') || '').trim(),
        );
        return;
      }
      const editorAction = String(target.getAttribute('data-scout-editor-action') || '').trim();
      if (editorAction) {
        if (!SCOUT_EDITOR_ACTIONS.includes(editorAction)) return;
        ws.scoutEditorRemoveIndex = Number(target.getAttribute('data-scout-editor-index'));
        void runScoutProfileAction(editorAction, String(target.getAttribute('data-scout-id') || '').trim());
        return;
      }
      const action = String(target.getAttribute('data-scout-action') || '').trim();
      if (!SCOUT_PROFILE_ACTIONS.includes(action)) return;
      const scoutId = String(target.getAttribute('data-scout-id') || '').trim();
      void runScoutProfileAction(action, scoutId);
    });
  }
  bindScoutHistoryInboxFilters(root);
  bindScoutEditor(root);
}

/**
 * Bind delegated handlers onto the dashboard region and start the countdown
 * ticker. Called once per rendered panel (the region element is fresh each
 * time, so listeners never accumulate); the region re-renders its own content.
 *
 * @param {HTMLElement} root
 */
export function bindWatcherDashboard(root) {
  const container = queryField(root, '#watcher-dashboard');
  if (!container) return;
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-range],[data-watcher-tl-select],[data-watcher-open-chat],[data-watcher-action]') : null;
    if (!target) return;
    if (target.hasAttribute('data-watcher-range')) {
      const key = String(target.getAttribute('data-watcher-range') || '24h');
      if (WATCHER_TIMELINE_RANGES.some((r) => r.key === key)) {
        ws.dash = { ...ws.dash, range: key };
      }
      return;
    }
    if (target.matches('[data-watcher-tl-select]')) {
      const id = String(target.getAttribute('data-cycle-id') || target.getAttribute('data-chat-id') || '').trim();
      ws.dash = { ...ws.dash, selectedCycleId: ws.dash.selectedCycleId === id ? '' : id };
      return;
    }
    if (target.hasAttribute('data-watcher-open-chat')) {
      void openWatcherChat(String(target.getAttribute('data-watcher-open-chat') || ''));
      return;
    }
    if (String(target.getAttribute('data-watcher-action') || '') === 'clear-stop') {
      void watcherAction(root, 'clear_stop');
      return;
    }
    if (String(target.getAttribute('data-watcher-action') || '') === 'clear-backoff') {
      // Same reset the Actions tab button performs: drop the failure counts and
      // release the backoff timer in one PATCH.
      void saveWatcher(root, { failures: {}, backoffUntil: '' });
    }
  });
  // The cycle-schedule card (Settings tab) sits outside the dashboard container,
  // so its inline clear-backoff button needs its own delegated listener.
  queryField(root, '#watcher-schedule-info')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-action="clear-backoff"]') : null;
    if (target) void saveWatcher(root, { failures: {}, backoffUntil: '' });
  });
  container.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-decisions-filter]') : null;
    if (!target) return;
    ws.dash = { ...ws.dash, decisionsFilter: String(target.value || 'all') };
  });
  if (dashboardIsVisible(container)) ensureWatcherTicker(root);
}


/**
 * Wire the freshly rendered form: input mirrors, the save bar and the manual
 * actions. Runs once per rendered panel (the nodes are new each time, so
 * listeners never accumulate) and then binds the region delegates.
 *
 * @param {HTMLElement} root
 * @param {any} data
 */
export function bindWatcherPanel(root, data) {
  const watcher = data?.watcher || {};
  const feedbackMode = queryField(root, '#watcher-feedback-triage');
  if (feedbackMode) feedbackMode.options = ['off', 'propose', 'auto'].map((value) => ({ value, label: t(`settings.watcherFeedbackMode_${value}`) }));
  queryField(root, '#watcher-feedback-proposals')?.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-feedback-decision]') : null;
    if (!target) return;
    const id = target.getAttribute('data-feedback-id');
    const decision = target.getAttribute('data-feedback-decision');
    if (!id || !['accept', 'reject'].includes(decision)) return;
    const response = await watcherApi(`/api/workspace-watcher/feedback-triage/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision } });
    if (response.status === 200) {
      const { refreshWorkspaceWatcherSettingsPanel } = await import('./refresh.js');
      await refreshWorkspaceWatcherSettingsPanel({ full: true });
    }
  });
  void loadWatcherLoad();

  queryFields(root, '[data-watcher-duration]').forEach((input) => {
    input.addEventListener('input', () => {
      const out = queryField(root, `[data-watcher-duration-out="${input.id}"]`);
      if (out) out.textContent = `≈ ${formatCooldownLabel(readDurationMs(root, input.id))}`;
    });
  });
  const cooldownInput = queryField(root, '#watcher-cooldown');
  cooldownInput?.addEventListener('input', () => {
    const out = queryField(root, '#watcher-cooldown-out');
    if (out) out.textContent = formatCooldownLabel(Number(cooldownInput.value) || 0);
  });
  const scoutIntervalInput = queryField(root, '#watcher-scout-interval');
  scoutIntervalInput?.addEventListener('input', () => {
    const out = queryField(root, '#watcher-scout-interval-out');
    if (out) out.textContent = `${scoutIntervalInput.value} ${t('settings.watcherHourUnit')}`;
  });
  // Quiet hours gate the time inputs: disabled and greyed unless the toggle is on.
  const quietToggle = queryField(root, '#watcher-quiet-enabled');
  const syncQuietFields = () => {
    const on = quietToggle?.checked === true;
    for (const id of ['#watcher-quiet-start', '#watcher-quiet-end']) {
      const field = queryField(root, id);
      if (field) field.disabled = !on;
    }
    queryFields(root, '.watcher-quiet-fields').forEach((wrap) => {
      wrap.classList.toggle('is-disabled', !on);
    });
  };
  quietToggle?.addEventListener('change', syncQuietFields);
  syncQuietFields();

  queryField(root, '#watcher-save')?.addEventListener('click', () => saveWatcher(root));
  queryField(root, '#watcher-reset')?.addEventListener('click', () => resetWatcherForm(root));
  queryField(root, '#watcher-tick')?.addEventListener('click', () => watcherAction(root, 'tick'));
  queryField(root, '#watcher-run-cycle')?.addEventListener('click', () => watcherAction(root, 'run_cycle'));
  // One-click global pause: keeps failures/backoff/findings and any active cycle, so resume continues.
  queryField(root, '#watcher-pause')?.addEventListener('click', () => saveWatcher(root, { paused: watcher.paused !== true }));
  queryField(root, '#watcher-stop')?.addEventListener('click', () => saveWatcher(root, { stopReason: t('settings.watcherStoppedReason') }));
  // Clear-stop is a real loop-stop reset (wipes failures/backoff/unblocks parked
  // todos) on the server, not a plain PATCH that only clears stopReason — route
  // it to the dedicated endpoint so a human resume does not immediately re-stop.
  queryField(root, '#watcher-clear-stop')?.addEventListener('click', () => watcherAction(root, 'clear_stop'));
  queryField(root, '#watcher-clear-backoff')?.addEventListener('click', () => saveWatcher(root, { failures: {}, backoffUntil: '' }));
  queryField(root, '#watcher-claim')?.addEventListener('click', () => watcherAction(root, 'claim_next'));
  queryField(root, '#watcher-reset-plan')?.addEventListener('click', () => watcherAction(root, 'reset_plan_requests'));
  queryField(root, '#watcher-record-findings')?.addEventListener('click', () => watcherAction(root, 'record_findings'));
  queryField(root, '#watcher-scout-run')?.addEventListener('click', () => runScoutNow(root));
  bindScoutProfiles(root);
  bindWatcherDashboard(root);
  applyWatcherTab(root);
}
