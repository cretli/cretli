/**
 * Unit tests for the Harness health card pure helpers.
 *
 * No DOM: the model/formatters/SVG builders are imported directly under Node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../app_front/features/usage/usageCharts.js';
import {
  buildHealthCardModel,
  formatErrorTime,
  formatResetTime,
  formatStaleHours,
  normalizeUtilization,
  renderDailyTableHtml,
  renderHealthCardHtml,
  renderSparklineSvg,
} from '../app_front/features/harness-health/harnessHealthModel.js';

const NOW = new Date('2026-01-15T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;
const FUTURE = new Date(NOW + 3 * HOUR).toISOString();
const PAST = new Date(NOW - 3 * HOUR).toISOString();

/** Simple stub: keeps the key so assertions can match translation calls. */
function stubT(key, vars) {
  return vars ? `${key}:${JSON.stringify(vars)}` : key;
}

// --- formatResetTime -------------------------------------------------------

test('formatResetTime prints local HH:MM for the same day', () => {
  const out = formatResetTime(FUTURE, { lang: 'en', now: NOW });
  assert.match(out, /^\d{2}:\d{2}$/);
  const expected = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(FUTURE));
  assert.equal(out, expected);
});

test('formatResetTime prefixes the date when the reset is on another day', () => {
  const out = formatResetTime(FUTURE, { lang: 'en', now: NOW + 5 * 24 * HOUR });
  assert.match(out, /^\d{2}\/\d{2} \d{2}:\d{2}$/);
});

test('formatResetTime returns empty for missing or invalid input', () => {
  assert.equal(formatResetTime(''), '');
  assert.equal(formatResetTime(null), '');
  assert.equal(formatResetTime('not-a-date'), '');
});

test('formatErrorTime includes the local day and time', () => {
  const out = formatErrorTime('2026-01-14T09:05:00.000Z', { lang: 'en' });
  assert.match(out, /\d{2}\/\d{2},? \d{2}:\d{2}/);
  assert.equal(formatErrorTime('nope', { lang: 'en' }), '');
});

// --- formatStaleHours / normalizeUtilization -------------------------------

test('formatStaleHours floors whole hours and rejects invalid input', () => {
  assert.equal(formatStaleHours(new Date(NOW - 7 * HOUR).toISOString(), NOW), 7);
  assert.equal(formatStaleHours(new Date(NOW - 30 * 60 * 1000).toISOString(), NOW), 0);
  assert.equal(formatStaleHours('nope', NOW), null);
});

test('normalizeUtilization reads the stored 0..100 percentage without guessing', () => {
  // The backend stores percent verbatim: 1 is 1%, 0.8 is 0.8%, not 100%/80%.
  assert.equal(normalizeUtilization(1), 0.01);
  assert.equal(normalizeUtilization(0.8), 0.008);
  assert.equal(normalizeUtilization(12), 0.12);
  assert.equal(normalizeUtilization(82.5), 0.825);
  assert.equal(normalizeUtilization(100), 1);
  assert.equal(normalizeUtilization(150), 1);
  assert.equal(normalizeUtilization(-3), 0);
  assert.equal(normalizeUtilization(undefined), null);
  assert.equal(normalizeUtilization(''), null);
});

// --- buildHealthCardModel --------------------------------------------------

test('stored percentages keep their scale (1, 0.8, 12, 82.5)', () => {
  const observedAt = new Date(NOW).toISOString();
  const model = buildHealthCardModel({
    runs: 1,
    okRuns: 1,
    planLimits: [1, 0.8, 12, 82.5].map((utilization) => ({
      rateLimitType: `w${utilization}`,
      utilization,
      resetsAt: FUTURE,
      observedAt,
    })),
  }, { now: NOW, lang: 'en' });
  assert.deepEqual(model.planLimits.map((row) => row.utilization), [0.01, 0.008, 0.12, 0.825]);
  assert.deepEqual(model.planLimits.map((row) => row.utilizationText), ['1%', '0.8%', '12%', '82.5%']);
});

test('empty harness yields the empty state instead of zeros', () => {
  const model = buildHealthCardModel(
    { harness: 'sdk', runs: 0, okRuns: 0, errorRuns: 0, limitHits: 0, daily: [], lastErrors: [] },
    { now: NOW, lang: 'en' }
  );
  assert.equal(model.status, 'empty');
  assert.equal(model.hasData, false);
  assert.equal(model.successRate, null);
  assert.equal(model.p50LatencyMs, null);
  assert.equal(model.p95LatencyMs, null);
  assert.equal(model.activeLimit, null);
  assert.deepEqual(model.planLimits, []);
});

test('missing payload also yields the empty state', () => {
  const model = buildHealthCardModel(null, { now: NOW, lang: 'en' });
  assert.equal(model.status, 'empty');
  assert.equal(model.hasData, false);
});

test('healthy harness exposes runs, success and latency', () => {
  const model = buildHealthCardModel({
    harness: 'claude',
    runs: 10,
    okRuns: 9,
    errorRuns: 1,
    limitHits: 2,
    p50LatencyMs: 1200,
    p95LatencyMs: 5000,
    daily: [{ day: '2026-01-14', runs: 4, errors: 1 }],
    lastErrors: [{ ts: '2026-01-14T09:05:00.000Z', errorCode: 'rate_limit', model: 'opus' }],
  }, { now: NOW, lang: 'en' });
  assert.equal(model.status, 'ok');
  assert.equal(model.hasData, true);
  assert.equal(model.successRate, 0.9);
  assert.equal(model.p50LatencyMs, 1200);
  assert.equal(model.p95LatencyMs, 5000);
  assert.equal(model.lastErrors.length, 1);
  assert.equal(model.lastErrors[0].errorCode, 'rate_limit');
  assert.match(model.lastErrors[0].time, /\d{2}:\d{2}/);
});

test('an active lockout flips the status and formats the reset', () => {
  const model = buildHealthCardModel({
    runs: 3,
    okRuns: 3,
    activeLimit: { harness: 'claude', model: 'opus', code: 'usage_limit', resetAt: FUTURE },
  }, { now: NOW, lang: 'en' });
  assert.equal(model.status, 'limit');
  assert.ok(model.activeLimit);
  assert.equal(model.activeLimit.model, 'opus');
  assert.equal(model.activeLimit.code, 'usage_limit');
  assert.match(model.activeLimit.resetTime, /^\d{2}:\d{2}$/);
});

test('an expired lockout is ignored', () => {
  const model = buildHealthCardModel({
    runs: 1,
    okRuns: 1,
    activeLimit: { model: 'opus', resetAt: PAST },
  }, { now: NOW, lang: 'en' });
  assert.equal(model.activeLimit, null);
  assert.equal(model.status, 'ok');
});

test('stale plan limits keep the stale flag and hour count', () => {
  const observedAt = new Date(NOW - 7 * HOUR).toISOString();
  const model = buildHealthCardModel({
    runs: 5,
    okRuns: 5,
    planLimits: [{
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 42,
      resetsAt: FUTURE,
      observedAt,
      stale: true,
    }],
  }, { now: NOW, lang: 'en' });
  assert.equal(model.planLimits.length, 1);
  assert.equal(model.planLimits[0].stale, true);
  assert.equal(model.planLimits[0].staleHours, 7);
  assert.equal(model.planLimits[0].utilizationPercent, 42);
  assert.equal(model.planLimits[0].utilization, 0.42);
});

test('a plan limit without utilization keeps the bar hidden', () => {
  const model = buildHealthCardModel({
    runs: 2,
    okRuns: 2,
    planLimits: [{ rateLimitType: 'weekly', status: 'allowed', resetsAt: FUTURE, observedAt: new Date(NOW).toISOString() }],
  }, { now: NOW, lang: 'en' });
  assert.equal(model.planLimits[0].utilization, null);
  assert.equal(model.planLimits[0].utilizationText, '');
});

// --- renderSparklineSvg / renderDailyTableHtml -----------------------------

test('sparkline is an accessible image with escaped aria-label', () => {
  const svg = renderSparklineSvg(
    [{ day: '2026-01-14', runs: 2, errors: 1 }, { day: '2026-01-15', runs: 0, errors: 0 }],
    { ariaLabel: 'runs <7> & errors' }
  );
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="runs &lt;7&gt; &amp; errors"/);
  assert.match(svg, /class="harness-health-spark-runs"/);
  assert.match(svg, /class="harness-health-spark-errors"/);
  assert.match(svg, /<title>/);
});

test('sparkline returns nothing for an empty series', () => {
  assert.equal(renderSparklineSvg([], { ariaLabel: 'x' }), '');
});

test('daily table is a details fallback with escaped days', () => {
  const html = renderDailyTableHtml([{ day: '<b>', runs: 1, errors: 2 }], {
    caption: 'cap',
    day: 'Day',
    runs: 'Runs',
    errors: 'Errors',
  });
  assert.match(html, /<details class="harness-health-daily">/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /<td>2<\/td>/);
  assert.equal(renderDailyTableHtml([]), '');
});

// --- renderHealthCardHtml --------------------------------------------------

test('empty card renders the empty note and no metric grid', () => {
  const model = buildHealthCardModel({ runs: 0 }, { now: NOW, lang: 'en' });
  const html = renderHealthCardHtml(model, { t: stubT, lang: 'en' });
  assert.match(html, /harnessHealth\.statusNoData/);
  assert.match(html, /harnessHealth\.emptyRuns/);
  assert.doesNotMatch(html, /harness-health-metrics/);
});

test('card renders a lockout with an unlock button and notice slot', () => {
  const model = buildHealthCardModel({
    runs: 1,
    okRuns: 1,
    activeLimit: { model: 'opus', code: 'usage_limit', resetAt: FUTURE },
  }, { now: NOW, lang: 'en' });
  const html = renderHealthCardHtml(model, { t: stubT, lang: 'en' });
  assert.match(html, /data-action="unlock"/);
  assert.match(html, /data-role="notice"/);
  assert.match(html, /harnessHealth\.activeLimitTitle/);
});

test('card escapes error codes and model names from the ledger', () => {
  const model = buildHealthCardModel({
    runs: 1,
    okRuns: 0,
    errorRuns: 1,
    lastErrors: [{
      ts: '2026-01-14T09:05:00.000Z',
      errorCode: '<img src=x onerror=alert(1)>',
      model: 'a&b',
    }],
  }, { now: NOW, lang: 'en' });
  const html = renderHealthCardHtml(model, { t: stubT, lang: 'en' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /a&amp;b/);
});

test('card renders stale plan-limit text with the hour count', () => {
  const observedAt = new Date(NOW - 7 * HOUR).toISOString();
  const model = buildHealthCardModel({
    runs: 4,
    okRuns: 4,
    planLimits: [{
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 50,
      resetsAt: FUTURE,
      observedAt,
      stale: true,
    }],
  }, { now: NOW, lang: 'en' });
  const html = renderHealthCardHtml(model, { t: stubT, lang: 'en' });
  assert.match(html, /harnessHealth\.planLimitStale/);
  assert.match(html, /&quot;hours&quot;:7/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /style="width:50%"/);
});

test('card exposes the details link', () => {
  const model = buildHealthCardModel({ runs: 1, okRuns: 1 }, { now: NOW, lang: 'en' });
  const html = renderHealthCardHtml(model, { t: stubT, lang: 'en' });
  assert.match(html, /data-action="details"/);
  assert.match(html, /harnessHealth\.details/);
});

// --- escapeHtml (shared helper used by every renderer) ---------------------

test('escapeHtml neutralizes the five HTML metacharacters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});
