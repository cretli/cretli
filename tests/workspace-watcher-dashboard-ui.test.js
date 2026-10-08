/**
 * Workspace Watcher monitoring dashboard render contract.
 *
 * `watcherDashboard.js` and `watcherTimeline.js` are pure string builders (no
 * DOM, no SCSS) so they are exercised directly in Node with injected `now`, like
 * `watcherStatus.js`. The settings wiring itself is covered by
 * `workspace-watcher-settings-ui.test.js`. This suite also guards that every
 * new dashboard label exists in both English and Polish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  renderWatcherLiveHtml,
  renderWatcherStatsHtml,
  renderWatcherDecisionsHtml,
  renderWatcherAlertsHtml,
  renderWatcherScheduleHtml,
  scheduleNextValueHtml,
  scheduleReasonText,
  quietHoursStatus,
  formatDuration,
  formatPercent,
  formatCountdown,
  watcherOutcomeTone,
} from '../app_front/features/watcher/watcherDashboard.js';
import {
  renderWatcherTimelineHtml,
  assignTimelineLanes,
  filterTimelineBars,
  normalizeTimelineBar,
  WATCHER_TIMELINE_RANGES,
} from '../app_front/features/watcher/watcherTimeline.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsScss = fs.readFileSync(
  path.join(projectRoot, 'app_front/features/settings/workspace-watcher-settings.scss'),
  'utf8',
);

test('live section renders active cycles with duration + chat link and delegations', () => {
  const view = {
    watcher: {
      mode: 'autopilot',
      activeCycles: [
        { cycleId: 'cy1', chatId: 'chat-abcdef123456', todoIds: ['todo-00001111'], startedAt: iso(NOW - 5000), phase: 'running', runId: 'r1' },
      ],
      decisions: [{ at: iso(NOW), kind: 'cycle_failed', reason: 'boom' }],
    },
  };
  const stats = { activeDelegations: [{ id: 'd1', harness: 'deepseek', status: 'running', assignment: 'implement', startedAt: iso(NOW - 1000) }] };
  const html = renderWatcherLiveHtml(view, { stats, now: NOW, getTodoTitle: (id) => (id === 'todo-00001111' ? 'Fix login' : '') });
  assert.match(html, /Fix login/);
  assert.match(html, /watcher-dash-link/);
  assert.match(html, /data-watcher-open-chat="chat-abcdef123456"/);
  assert.match(html, /data-watcher-duration="\d+"/);
  assert.match(html, /deepseek/);
  assert.match(html, /boom/, 'latest decision reason is shown');
});

test('live section falls back to empty rows when nothing is running', () => {
  const html = renderWatcherLiveHtml({ watcher: { mode: 'observe', decisions: [] } }, { stats: {}, now: NOW });
  assert.match(html, /watcher-dash-empty/);
});

test('stats section renders KPIs, daily bars, harness rows and stop reasons', () => {
  const stats = {
    cycleCount: 9,
    cycles: { successRate: 0.5, avgDurationMs: 30000, windowCycles: 2, recent: [] },
    throughput: {
      daily: [
        { day: '2026-10-03', total: 1, success: 1, failure: 0, blocked: 0 },
        { day: '2026-10-04', total: 2, success: 1, failure: 1, blocked: 0 },
      ],
      weekly: [{ week: '2026-09-28', total: 3, success: 2 }],
    },
    harnesses: [{ harness: 'opencode', count: 3, verified: 2, passed: 2, passRate: 0.5 }],
    stopReasons: [{ kind: 'wait_budget', count: 4, lastReason: 'daily_budget' }],
  };
  const html = renderWatcherStatsHtml(stats);
  assert.match(html, /50%/, 'success rate percent');
  assert.match(html, /30s/, 'avg cycle duration formatted');
  assert.ok((html.match(/watcher-dash-bar-group/g) || []).length >= 2, 'daily bar per day');
  assert.match(html, /opencode/);
  assert.match(html, /watcher-dash-pass/);
  assert.match(html, /wait_budget/);
});

test('decisions filter renders all types plus a per-kind dropdown and filters rows', () => {
  const decisions = [
    { at: iso(NOW - 2000), kind: 'cycle_failed', reason: 'a' },
    { at: iso(NOW), kind: 'start_cycle', reason: 'b' },
  ];
  const kinds = [{ kind: 'cycle_failed', count: 1 }, { kind: 'start_cycle', count: 1 }];
  const all = renderWatcherDecisionsHtml(decisions, { kinds, filterKind: 'all' });
  assert.match(all, /data-watcher-decisions-filter/);
  assert.match(all, /<option value="cycle_failed"/);
  assert.match(all, /start_cycle/);
  const filtered = renderWatcherDecisionsHtml(decisions, { kinds, filterKind: 'cycle_failed' });
  assert.match(filtered, /cycle_failed/);
  assert.doesNotMatch(filtered.split('<tbody>')[1] || '', /start_cycle/, 'only the selected kind remains in the table body');
});

test('decisions table names blocking chats when unknownChats is persisted', () => {
  const html = renderWatcherDecisionsHtml([
    {
      at: iso(NOW),
      kind: 'wait_active',
      reason: 'unknown_liveness',
      unknownChats: [{ chatId: 'blocker-chat', reason: 'adapter_error' }],
    },
  ], { kinds: [], filterKind: 'all' });
  assert.match(html, /blocker-chat/);
  assert.match(html, /adapter_error/);
});

test('alerts show stop reason with clear action, a backoff countdown, and quiet hours', () => {
  const stopped = renderWatcherAlertsHtml({ watcher: { stopReason: 'operator stop', policy: {}, activeCycles: [] } }, { now: NOW });
  assert.match(stopped, /operator stop/);
  assert.match(stopped, /data-watcher-action="clear-stop"/);
  const backoff = renderWatcherAlertsHtml({ watcher: { backoffUntil: iso(NOW + 90_000), policy: {} } }, { now: NOW });
  assert.match(backoff, /data-watcher-countdown="[\d.]+"/);
  assert.match(backoff, /data-watcher-action="clear-backoff"/, 'the backoff alert offers a one-click release');
  // 23:00 UTC sits inside a 22:00–06:00 wrap window → active quiet alert with a countdown.
  const quietNow = Date.parse('2026-10-04T23:00:00.000Z');
  const quiet = renderWatcherAlertsHtml({ watcher: { policy: { quietHours: { start: '22:00', end: '06:00' } } } }, { now: quietNow });
  assert.match(quiet, /data-tone="quiet"/);
  assert.match(quiet, /data-watcher-countdown="[\d.]+"/);
  const none = renderWatcherAlertsHtml({ watcher: { policy: {} } }, { now: NOW });
  assert.match(none, /watcher-dash-empty/);
});

test('cycle schedule renders the next countdown, last run, budget and blocker', () => {
  const schedule = {
    enabled: true,
    paused: false,
    stopped: false,
    nextCycleAt: NOW + 90_000,
    lastCycleAt: iso(NOW - 600_000),
    cyclesToday: 2,
    maxCyclesPerDay: 4,
    remainingToday: 2,
    running: 0,
    maxParallel: 2,
    allowed: false,
    blockedReason: 'cooldown',
  };
  const html = renderWatcherScheduleHtml(schedule, NOW);
  assert.match(html, /data-watcher-countdown="\d+"/, 'the next cycle is a live countdown');
  assert.match(html, /2 \/ 4/, 'today budget numerator/denominator');
  assert.match(html, /0 \/ 2/, 'running slots');
  assert.match(html, new RegExp(iso(NOW - 600_000)), 'the last cycle instant is shown');
  assert.match(html, /watcher-badge/, 'the blocker carries the blocked badge');
  assert.ok(html.includes(scheduleReasonText('cooldown')), 'the blocker is translated, not the raw key');
  // Only the failure backoff has a one-click release; a cooldown/budget blocker
  // resolves on its own and must not offer a misleading reset.
  assert.doesNotMatch(html, /data-watcher-action="clear-backoff"/);
  const backedOff = renderWatcherScheduleHtml({ ...schedule, blockedReason: 'failure_backoff' }, NOW);
  assert.match(backedOff, /data-watcher-action="clear-backoff"/, 'the backoff blocker offers a one-click release');

  // The reason helper translates known keys and degrades to the raw value.
  assert.notEqual(scheduleReasonText('cooldown'), 'cooldown');
  assert.equal(scheduleReasonText('not_a_real_reason'), 'not_a_real_reason');
  assert.equal(scheduleReasonText(''), '');

  // "Next cycle" value: not scheduled / halted / due now / future.
  assert.doesNotMatch(scheduleNextValueHtml({ enabled: false }, NOW), /data-watcher-countdown/);
  assert.equal(scheduleNextValueHtml({ enabled: true, paused: true }, NOW), '—');
  assert.doesNotMatch(scheduleNextValueHtml({ enabled: true, nextCycleAt: NOW - 1 }, NOW), /data-watcher-countdown/);
  assert.match(scheduleNextValueHtml({ enabled: true, nextCycleAt: NOW + 5000 }, NOW), /data-watcher-countdown="\d+"/);

  // An unlimited budget (0) reads as "no limit", not a spent 0/0.
  const unlimited = renderWatcherScheduleHtml({ enabled: true, maxCyclesPerDay: 0, cyclesToday: 3, nextCycleAt: NOW }, NOW);
  assert.match(unlimited, /3/);
  assert.doesNotMatch(unlimited, /0 \/ 0/);
});

test('quietHoursStatus reports active window and next UTC end across midnight', () => {
  const inside = quietHoursStatus({ start: '22:00', end: '06:00' }, Date.parse('2026-10-04T23:30:00.000Z'));
  assert.equal(inside.active, true);
  assert.ok(inside.endsAtMs > Date.parse('2026-10-04T23:30:00.000Z'));
  assert.equal(inside.endsAtMs, Date.parse('2026-10-05T06:00:00.000Z'));
  const outside = quietHoursStatus({ start: '22:00', end: '06:00' }, NOW);
  assert.equal(outside.active, false);
  assert.equal(quietHoursStatus({ start: '', end: '' }, NOW).configured, false);
  assert.equal(quietHoursStatus({ start: '06:00', end: '06:00' }, NOW).configured, false, 'identical bounds are not a window');
});

test('timeline renders concurrent lanes, tone colors, range filter, selection and legacy point', () => {
  const recent = [
    { chatId: 'cA', cycleId: 'cyA', todoIds: ['todoAAAA'], outcome: 'success', startedAt: iso(NOW - 60_000), at: iso(NOW - 30_000), startMs: NOW - 60_000, endMs: NOW - 30_000, durationMs: 30_000 },
    { chatId: 'cB', cycleId: 'cyB', todoIds: ['todoBBBB'], outcome: 'failure', startedAt: iso(NOW - 50_000), at: iso(NOW - 20_000), startMs: NOW - 50_000, endMs: NOW - 20_000, durationMs: 30_000 },
    { chatId: 'cOLD', cycleId: 'cyOLD', todoIds: [], outcome: 'blocked', startedAt: iso(NOW - 10 * 86_400_000), at: iso(NOW - 10 * 86_400_000), startMs: NOW - 10 * 86_400_000, endMs: NOW - 10 * 86_400_000, durationMs: null },
  ];
  const stats = { cycles: { recent } };
  const html = renderWatcherTimelineHtml(stats, { watcher: {} }, { now: NOW, rangeKey: '1h', selectedId: 'cyB', getTodoTitle: (id) => (id === 'todoBBBB' ? 'Ship api' : id) });
  // Two overlapping cycles must occupy separate lanes; the 10-day-old one is filtered out of the 1h window.
  assert.match(html, /data-lane="0"/);
  assert.match(html, /data-lane="1"/);
  assert.match(html, /2 concurrent lanes|data-lane-count="2"/);
  assert.doesNotMatch(html, /cOLD/, 'the far-past cycle is outside the last-hour window');
  assert.match(html, /data-outcome-tone="success"/);
  assert.match(html, /data-outcome-tone="failed"/);
  assert.match(html, /data-selected="true"/, 'the selected cycle bar is highlighted');
  assert.match(html, /watcher-tl-detail/);
  assert.match(html, /Ship api/);
});

test('timeline lane assignment, filtering and normalization are correct in isolation', () => {
  const a = { startMs: NOW - 1000, endMs: NOW };
  const b = { startMs: NOW - 500, endMs: NOW + 500 };
  assert.equal(assignTimelineLanes([a, b]).laneCount, 2, 'overlap needs two lanes');
  const sequential = { startMs: NOW - 2000, endMs: NOW - 1000 };
  assert.equal(assignTimelineLanes([sequential, a]).laneCount, 1, 'non-overlap shares one lane');
  assert.equal(filterTimelineBars([a, { startMs: NOW - 10_000_000, endMs: NOW - 9_000_000 }], NOW, 3_600_000).length, 1);
  // A live cycle (no close time) is normalized to run until `now`.
  const live = normalizeTimelineBar({ id: 'cX', startedAt: iso(NOW - 4000), at: '', live: true }, NOW);
  assert.equal(live.outcome, 'running');
  assert.equal(live.endMs, NOW);
  assert.equal(live.durationMs, 4000);
});

test('watcher range options expose 1h / 24h / 7d', () => {
  assert.deepEqual(WATCHER_TIMELINE_RANGES.map((r) => r.key), ['1h', '24h', '7d']);
});

test('format helpers degrade to placeholders, not fabricated zeros', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(undefined), '—');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(0), '0%');
  assert.equal(watcherOutcomeTone('success'), 'success');
  assert.equal(watcherOutcomeTone('failure'), 'failed');
  assert.equal(watcherOutcomeTone('bogus'), 'unknown');
  assert.equal(formatCountdown(NOW + 5000, NOW), '5s');
});

test('every dashboard label exists in English and Polish', () => {
  const keys = [
    'watcherDashboardTitle', 'watcherDashboardHint', 'watcherDashLive', 'watcherDashTimeline',
    'watcherDashStats', 'watcherDashAlerts', 'watcherDashRange', 'watcherDashRange_1h',
    'watcherDashRange_24h', 'watcherDashRange_7d', 'watcherDashNow', 'watcherDashClickCycle',
    'watcherDashNoCycles', 'watcherDashLanes', 'watcherDashActiveDelegations',
    'watcherDashNoActiveDelegations', 'watcherDashNoActiveCycles', 'watcherDashLatestDecision',
    'watcherDashPhaseRunning', 'watcherDashPhaseStarting', 'watcherDashTodo', 'watcherDashOutcome',
    'watcherDashChat', 'watcherDashDuration', 'watcherDashSuccessRate', 'watcherDashAvgCycle',
    'watcherDashRecentWindow', 'watcherDashDailyThroughput', 'watcherDashWeeklyThroughput',
    'watcherDashThroughput', 'watcherDashStopReasons', 'watcherDashTopHarnesses',
    'watcherDashPassRate', 'watcherDashVerifiedCount', 'watcherDashSuccess', 'watcherDashFailure',
    'watcherDashBlocked', 'watcherDashNoStats', 'watcherDashFilterType', 'watcherDashAllTypes',
    'watcherDashQuietActive', 'watcherDashQuietEnds', 'watcherDashQuietNext', 'watcherDashExpired',
    'watcherDashNoAlerts', 'watcherDashHarness', 'watcherDashWindowCycles',
  ];
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) {
      assert.ok(typeof dict.settings?.[key] === 'string' && dict.settings[key].length > 0, `${lang}.settings.${key} is missing`);
    }
  }
});

test('success tones are green (--cr-success), not the blue --cr-accent', () => {
  const successBar = /watcher-tl-bar\[data-outcome-tone='success'\]\s*\{[^}]*--cr-success[^}]*\}/.exec(settingsScss);
  assert.ok(successBar, 'the timeline success bar must use --cr-success');
  assert.doesNotMatch(
    settingsScss,
    /watcher-tl-bar\[data-outcome-tone='success'\][^}]*--cr-accent/,
    'the timeline success bar must not fall back to --cr-accent',
  );
  assert.match(settingsScss, /watcher-dash-bar\[data-success\]\s*\{[^}]*--cr-success/, 'the daily throughput success bar uses --cr-success');
});

test('normalizeTimelineBar keeps a legacy closed cycle at unknown duration (positioned only)', () => {
  const atMs = NOW - 1000;
  const bar = normalizeTimelineBar({ id: 'c', cycleId: 'cy', outcome: 'success', startedAt: '', at: iso(atMs) }, NOW);
  assert.equal(bar.durationMs, null, 'an unknown start reads as no duration, never a fabricated 0ms');
  assert.equal(bar.startMs, atMs, 'positioning still falls back to the close instant');
  assert.equal(bar.endMs, atMs);
  assert.equal(bar.live, false);
});

test('timeline detail shows an unknown duration as a dash and the harness', () => {
  const recent = [
    { chatId: 'cLeg', cycleId: 'cyLeg', todoIds: ['t9'], outcome: 'blocked', startedAt: '', at: iso(NOW - 5000), startMs: NOW - 5000, endMs: NOW - 5000, durationMs: null, harness: 'deepseek' },
  ];
  const html = renderWatcherTimelineHtml({ cycles: { recent } }, { watcher: {} }, { now: NOW, rangeKey: '24h', selectedId: 'cyLeg' });
  assert.match(html, /watcher-tl-detail/);
  assert.match(html, /deepseek/, 'the selected-cycle detail surfaces the harness');
  // The duration line renders the dash placeholder, never "0ms".
  const durationLine = /Duration<\/strong>:\s*([^<]+)</.exec(html) || /Czas trwania<\/strong>:\s*([^<]+)</.exec(html);
  assert.ok(durationLine, 'a duration line is present');
  assert.equal(durationLine[1].trim(), '—', 'unknown duration shows as an em dash');
  assert.doesNotMatch(html, /0ms/, 'no fabricated zero-millisecond duration');
});

test('timeline window count matches the selected range', () => {
  const recent = [
    { chatId: 'a', cycleId: 'ca', todoIds: ['t1'], outcome: 'success', startedAt: iso(NOW - 60_000), at: iso(NOW - 50_000), startMs: NOW - 60_000, endMs: NOW - 50_000, durationMs: 10_000 },
    { chatId: 'b', cycleId: 'cb', todoIds: ['t2'], outcome: 'success', startedAt: iso(NOW - 2 * 86_400_000), at: iso(NOW - 2 * 86_400_000 + 1000), startMs: NOW - 2 * 86_400_000, endMs: NOW - 2 * 86_400_000 + 1000, durationMs: 1000 },
  ];
  const oneHour = renderWatcherTimelineHtml({ cycles: { recent } }, { watcher: {} }, { now: NOW, rangeKey: '1h' });
  assert.match(oneHour, /data-window-count="1"/, 'only the recent cycle is in the last-hour window');
  const sevenDay = renderWatcherTimelineHtml({ cycles: { recent } }, { watcher: {} }, { now: NOW, rangeKey: '7d' });
  assert.match(sevenDay, /data-window-count="2"/, 'both cycles fall inside the seven-day window');
});
