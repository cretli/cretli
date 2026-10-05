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
  assert.match(source, /saveWatcher\(root, \{ stopReason: '' \}\)/);
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
  // still renders the form once (dataset.rendered guard).
  assert.match(source, /const full = options\.full !== false \|\| root\.dataset\.rendered !== 'true';/);
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
  assert.match(source, /function tickWatcherTimes\(root\) \{[\s\S]*?if \(!dashboardIsVisible\(container\)\) \{[\s\S]*?stopWatcherTicker\(\);/, 'the tick self-cleans while hidden');
  assert.match(source, /visibilitychange/, 'backgrounding the browser tab stops the ticker');
});
