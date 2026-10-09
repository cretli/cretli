/**
 * Workspace Watcher settings UI contract.
 *
 * The panel is real DOM (this suite has no jsdom), so the wiring is asserted
 * from source the same way the other settings UI tests do: the one-click global
 * pause must toggle the `paused` flag (and keep the state), and every guardrail
 * field must stay bound to the policy it writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(
  path.join(root, 'app_front/features/settings/workspaceWatcherSettings.js'),
  'utf8',
);

test('the watcher panel exposes a one-click global pause and clear-stop control', () => {
  assert.match(source, /id="watcher-pause"/);
  assert.match(source, /saveWatcher\(root, \{ paused: watcher\.paused !== true \}\)/);
  assert.match(source, /id="watcher-clear-stop"/);
  assert.match(source, /watcherAction\(root, 'clear_stop'\)/, 'clear-stop routes to the dedicated clear-stop endpoint, not a plain PATCH');
  assert.doesNotMatch(source, /#watcher-resume/, 'the old stop-only resume button is gone');
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    assert.ok(dict.settings?.watcherPause, `${lang}.settings.watcherPause is missing`);
    assert.ok(dict.settings?.watcherPausedBadge, `${lang}.settings.watcherPausedBadge is missing`);
    assert.ok(dict.settings?.watcherClearStop, `${lang}.settings.watcherClearStop is missing`);
    assert.ok(dict.settings?.watcherResume, `${lang}.settings.watcherResume is missing`);
  }
});

test('the watcher settings panel splits status, monitoring, policy, scout and actions into tabs', () => {
  assert.match(source, /const WATCHER_TABS = \['status', 'monitor', 'settings', 'scout', 'actions'\]/);
  for (const id of ['status', 'monitor', 'settings', 'scout', 'actions']) {
    assert.match(source, new RegExp(`watcherPanelAttrs\\('${id}'\\)`));
  }
  assert.match(source, /data-watcher-panel="\$\{id\}"/);
  assert.match(source, /function syncWorkspaceWatcherSettingsTab\(\)/);
  assert.match(source, /function applyWatcherTab\(root\)/);
  assert.doesNotMatch(source, /watcher-tabs/, 'the sub-tab bar lives in the settings nav, not inside the panel');
  assert.match(source, /id="watcher-savebar"/);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="settings-watcher-tabs"/);
  for (const id of ['watcher', 'watcher-monitor', 'watcher-settings', 'watcher-scout', 'watcher-actions']) {
    assert.match(html, new RegExp(`data-settings-tab="${id}"`));
  }
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of ['watcherTabsAria', 'watcherTab_status', 'watcherTab_monitor', 'watcherTab_settings', 'watcherTab_scout', 'watcherTab_actions']) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});

test('the watcher settings panel refreshes on workspace-watcher-changed', () => {
  assert.match(source, /cretli:workspace-watcher-changed/);
  assert.match(source, /refreshWorkspaceWatcherSettingsPanel/);
});

test('the watcher panel keeps every guardrail field wired to the policy', () => {
  const fields = [
    'watcher-max-parallel',
    'watcher-max-cycles',
    'watcher-max-failures',
    'watcher-max-findings',
    'watcher-cooldown',
    'watcher-backoff-base',
    'watcher-backoff-cap',
    'watcher-quiet-start',
    'watcher-quiet-end',
  ];
  for (const id of fields) {
    assert.ok(source.includes(`id="${id}"`), `missing ${id}`);
  }
});

test('the settings panel renders the monitoring dashboard from the stats endpoint', () => {
  // The dashboard pulls aggregated stats and delegates to the pure renderers.
  assert.match(source, /\/api\/workspace-watcher\/stats/);
  assert.match(source, /import[\s\S]*watcherDashboard\.js/);
  assert.match(source, /import[\s\S]*watcherTimeline\.js/);
  assert.ok(source.includes('id="watcher-dashboard"'), 'the dashboard container is present');
  assert.match(source, /renderWatcherTimelineHtml\(/);
  assert.match(source, /renderWatcherStatsHtml\(/);
  assert.match(source, /renderWatcherLiveHtml\(/);
  assert.match(source, /renderWatcherAlertsHtml\(/);
  assert.match(source, /renderWatcherDecisionsHtml\(/);
  // Interactive wiring: range switch, click-to-detail, decisions filter, clear-stop, open-chat.
  assert.match(source, /data-watcher-range/);
  assert.match(source, /data-watcher-tl-select/);
  assert.match(source, /data-watcher-decisions-filter/);
  assert.match(source, /clear-stop/);
  assert.match(source, /clear-backoff/);
  assert.match(source, /data-watcher-open-chat/);
  // A per-second ticker repaints only the time-driven fields (no refetch).
  assert.match(source, /setInterval\(/);
  assert.match(source, /data-watcher-countdown/);
  assert.match(source, /data-watcher-duration/);
  // Active cycle rows resolve a human title (falling back to the short id).
  assert.match(source, /\/api\/todos/);
  assert.match(source, /function getTodoTitle\(/);
});

test('a live watcher change repaints only the dashboard, preserving the form', () => {
  // The websocket/change event must NOT rebuild the root (which would erase
  // unsaved policy edits); it refreshes in dashboard-only mode.
  assert.match(
    source,
    /cretli:workspace-watcher-changed[\s\S]*?refreshWorkspaceWatcherSettingsPanel\(\{ full: false \}\)/,
    'the change listener must request a non-full (form-preserving) refresh',
  );
  // Full renders are gated on the `full` flag so the live path skips the form.
  assert.match(source, /if \(full\) \{[\s\S]*?renderWatcherPanel\(root, lastView\);/, 'renderWatcherPanel only runs on the full path');
  // The live path stays dashboard-only, but a change that races the first load
  // still renders the form once (dataset.rendered guard), and a workspace switch
  // forces the form because the previous workspace's policy must not stay editable.
  assert.match(
    source,
    /const full = options\.full !== false\s*\|\| root\.dataset\.rendered !== 'true'\s*\|\| watcherWorkspaceScopeChanged\(renderedWorkspaceFolder\);/,
  );
  assert.match(source, /root\.dataset\.rendered = 'true';/, 'the panel records that the form has rendered');
});

test('overlapping refreshes cannot let a stale fetch overwrite newer state', () => {
  assert.match(source, /let refreshSeq = 0;/, 'a monotonic generation counter exists');
  assert.match(source, /const seq = \+\+refreshSeq;/, 'each refresh claims a fresh generation');
  assert.match(source, /if \(seq !== refreshSeq\) return;/, 'a superseded refresh aborts before painting');
  assert.match(source, /if \(seq != null && seq !== refreshSeq\) return;/, 'stats/todos loads drop stale responses');
});

test('the dashboard ticker stops when the panel is hidden or detached', () => {
  assert.match(source, /function stopWatcherTicker\(\)/, 'an explicit ticker teardown helper exists');
  assert.match(source, /clearInterval\(dashTimer\)/, 'the interval is actually cleared');
  assert.match(source, /container\.offsetParent !== null/, 'visibility is detected via offsetParent');
  // The monitoring dashboard, the Scout schedule card and the cycle schedule
  // card all mount a live countdown, so the tick self-cleans only once none is
  // on screen.
  assert.match(
    source,
    /function tickWatcherTimes\(root\) \{[\s\S]*?if \(!dashboardIsVisible\(container\) && !dashboardIsVisible\(scoutSchedule\)[\s\S]*?!dashboardIsVisible\(statusCard\)[\s\S]*?!dashboardIsVisible\(scheduleInfo\)\) \{[\s\S]*?stopWatcherTicker\(\);/,
    'the tick self-cleans only once every countdown surface is hidden',
  );
  assert.match(source, /visibilitychange/, 'backgrounding the browser tab stops the ticker');
});

test('the Scout editor mounts its containers and never overwrites a dirty draft', () => {
  // The pure editor module is imported and mounted next to the profile list.
  assert.match(source, /from '\.\.\/watcher\/scoutProfileEditorView\.js'/);
  for (const id of ['watcher-scout-editor', 'watcher-scout-templates', 'watcher-scout-preview', 'watcher-scout-restore']) {
    assert.ok(source.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(source, /let scoutEditorState = \{/);
  assert.match(source, /dirty: false/);
  assert.match(source, /function paintScoutEditor\(root\)/);
  assert.match(source, /renderScoutEditorHtml\(/);
  assert.match(source, /renderScoutTemplatesHtml\(/);
  assert.match(source, /renderScoutPreviewHtml\(/);
  assert.match(source, /renderScoutRestoreHtml\(/);
  // A dirty draft repaints only the list; the editor form is left untouched.
  assert.match(
    source,
    /function paintScoutEditorLive\(root\) \{[\s\S]*?if \(scoutEditorState\.dirty === true\) \{[\s\S]*?paintScoutProfiles\(root\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?paintScoutEditor\(root\);/,
    'a dirty draft must only repaint the list card',
  );
  // The editor actions are declared and dispatched through the shared dispatcher.
  assert.match(source, /SCOUT_EDITOR_ACTIONS\.includes\(action\)/);
  assert.match(source, /function bindScoutEditor\(root\)/);
  assert.match(source, /scoutEditorFieldErrors\(draft\)/);
  assert.match(source, /\/profiles\/preview-draft/);
  assert.match(source, /\/restore-diff/);
  assert.match(source, /\/restore`/);
  assert.match(source, /watcherScoutEditorCasConflict/);
  assert.match(source, /watcherScoutEditorSaved/);
});

test('the Scout tab shows the next scan and a manual run trigger', () => {
  // The schedule card is rendered from the server-computed `scout` view field.
  assert.match(source, /id="watcher-scout-schedule-info"/);
  assert.match(source, /renderScoutScheduleHtml\(data\.scout \|\| \{\}, Date\.now\(\)\)/);
  assert.match(source, /function renderScoutScheduleHtml\(/);
  assert.match(source, /settings\.watcherScoutNextScan/);
  assert.match(source, /data-watcher-countdown="\$\{nextScanAt\}"/);
  // Manual trigger posts `action: run` and preserves the form via a live refresh.
  assert.match(source, /id="watcher-scout-run"/);
  assert.match(source, /\/api\/workspace-watcher\/scout', \{ method: 'POST', body: \{ action: 'run' \} \}/);
  assert.match(source, /async function runScoutNow\(root\)/);
  assert.match(source, /refreshWorkspaceWatcherSettingsPanel\(\{ full: false \}\)/);
  assert.match(source, /function paintScoutSchedule\(root\)/);
  // The Scout tab also drives the per-second countdown ticker.
  assert.match(source, /tab === 'monitor' \|\| tab === 'scout'/);
  // A blocked answer is surfaced as a translated reason, not a generic error.
  // The helper is shared with the profile list (scoutProfilesView) so the row
  // and the run message cannot drift.
  assert.match(source, /import \{[\s\S]*?scoutReasonText,[\s\S]*?\} from '\.\.\/watcher\/scoutProfilesView\.js'/);
  assert.match(source, /scoutRunResultText\(/);
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of [
      'watcherScoutScheduleTitle',
      'watcherScoutNextScan',
      'watcherScoutLastScan',
      'watcherScoutScansToday',
      'watcherScoutRemaining',
      'watcherScoutRunning',
      'watcherScoutPending',
      'watcherScoutNotScheduled',
      'watcherScoutDueNow',
      'watcherScoutBlocked',
      'watcherScoutRunNow',
      'watcherScoutRunHint',
      'watcherScoutRunStarted',
      'watcherScoutRunError',
      'watcherScoutReason_scan_interval',
      'watcherScoutReason_daily_budget',
      'watcherScoutReason_scout_parallel',
    ]) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});

test('the watcher settings panel exposes the worktree layout', () => {
  for (const id of [
    'watcher-worktree-root',
    'watcher-worktree-namespace',
    'watcher-worktree-branch-prefix',
    'watcher-worktree-directory-prefix',
    'watcher-worktree-prepare',
  ]) {
    assert.ok(source.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.match(source, /name="watcher-execution-mode"/);
  // The form reads and writes both the default mode and the layout block.
  assert.match(source, /executionMode: root\.querySelector\('input\[name="watcher-execution-mode"\]:checked'\)/);
  assert.match(source, /worktree: \{[\s\S]*?prepareCommand: readPrepareCommandLines\(root\),/);
  // A shell string is never built: one argv argument per textarea line.
  assert.match(source, /function prepareCommandLines\(value\)/);
  assert.match(source, /\.split\('\\n'\)/);
  // The server suggestion prefills empty fields; the form asks for it only on
  // the form-building (full) fetch.
  assert.match(source, /executionSuggest/);
  assert.match(source, /\/api\/workspace-watcher\?suggest=1/);
  assert.match(source, /settings\.watcherWorktreeSuggestedHint/);
  // Fail-closed validation mirrors the server refusal.
  assert.match(source, /watcherValidationWorktree/);
  assert.match(source, /watcherValidationWorktreeRoot/);
  assert.match(source, /watcherValidationWorktreeNamespace/);
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of [
      'watcherWorktree',
      'watcherWorktreeHint',
      'watcherWorktreeSuggestedHint',
      'watcherExecutionMode',
      'watcherExecutionModeProject',
      'watcherExecutionModeWorktree',
      'watcherWorktreeRoot',
      'watcherWorktreeNamespace',
      'watcherWorktreeBranchPrefix',
      'watcherWorktreeDirectoryPrefix',
      'watcherWorktreePrepare',
      'watcherWorktreePrepareHint',
      'watcherValidationWorktree',
      'watcherValidationWorktreeRoot',
      'watcherValidationWorktreeNamespace',
    ]) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});

test('the watcher settings panel shows the cycle schedule like Scout', () => {
  // The schedule card is rendered from the server-computed `schedule` view field,
  // with the pure renderer reused from the dashboard module.
  assert.match(source, /id="watcher-schedule-info"/);
  assert.match(source, /renderWatcherScheduleHtml\(data\.schedule \|\| \{\}, Date\.now\(\)\)/);
  assert.match(source, /scheduleNextValueHtml\(data\.schedule, Date\.now\(\)\)/);
  assert.match(source, /renderWatcherScheduleHtml,/);
  assert.match(source, /scheduleNextValueHtml,/);
  assert.match(source, /function paintWatcherSchedule\(root\)/);
  // The card repaints from the cached view on the live path and on language change.
  assert.match(source, /paintWatcherSchedule\(root\)/);
  assert.match(source, /paintWatcherSchedule\(panel\)/);
  // The status tab keeps the per-second countdown ticker alive.
  assert.match(source, /tab === 'monitor' \|\| tab === 'scout' \|\| tab === 'status'/);
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of [
      'watcherScheduleTitle',
      'watcherScheduleHint',
      'watcherScheduleNext',
      'watcherScheduleLast',
      'watcherScheduleCyclesToday',
      'watcherScheduleRemaining',
      'watcherScheduleUnlimited',
      'watcherScheduleRunning',
      'watcherScheduleNotScheduled',
      'watcherScheduleDueNow',
      'watcherScheduleBlocked',
      'watcherScheduleReason_mode_not_active',
      'watcherScheduleReason_paused',
      'watcherScheduleReason_stop_reason',
      'watcherScheduleReason_max_parallel',
      'watcherScheduleReason_quiet_hours',
      'watcherScheduleReason_daily_budget',
      'watcherScheduleReason_cooldown',
      'watcherScheduleReason_failure_backoff',
      'watcherScheduleReason_harness_usage_limited',
    ]) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});
