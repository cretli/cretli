/**
 * Regression tests for usage view state machine and KPI formatting.
 *
 * Does NOT require a DOM — tests pure logic extracted from usageSettings.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sumDayWindow } from '../app_front/features/usage/usageCharts.js';

// ---------------------------------------------------------------------------
// View state machine — pure logic re-implemented to match usageSettings.js
// ---------------------------------------------------------------------------

/**
 * Mirrors the setView state transitions from usageSettings.js.
 * Returns the resulting visibility map for the three panes.
 *
 * @param {'loading'|'ready'|'error'} view
 * @returns {{ loading: boolean, error: boolean, content: boolean }}
 */
function applySetView(view) {
  return {
    loading: view === 'loading',
    error: view === 'error',
    content: view === 'ready',
  };
}

test('setView(loading) shows only loading, hides error and content', () => {
  const { loading, error, content } = applySetView('loading');
  assert.equal(loading, true, 'loading should be visible');
  assert.equal(error, false, 'error must be hidden during loading');
  assert.equal(content, false, 'content must be hidden during loading');
});

test('setView(ready) shows only content, hides loading and error', () => {
  const { loading, error, content } = applySetView('ready');
  assert.equal(loading, false, 'loading must be hidden when ready');
  assert.equal(error, false, 'error must be hidden when content is ready');
  assert.equal(content, true, 'content should be visible');
});

test('setView(error) shows only error, hides loading and content', () => {
  const { loading, error, content } = applySetView('error');
  assert.equal(loading, false, 'loading must be hidden on error');
  assert.equal(error, true, 'error must be visible');
  assert.equal(content, false, 'content must be hidden when error is shown');
});

test('error and content are never both visible across all valid transitions', () => {
  for (const view of ['loading', 'ready', 'error']) {
    const { error, content } = applySetView(view);
    assert.ok(!(error && content), `view="${view}": error and content must not be visible together`);
  }
});

// ---------------------------------------------------------------------------
// allSettled partial-failure routing
// ---------------------------------------------------------------------------

/**
 * Mirrors the allFailed check from refreshUsageSettings.
 *
 * @param {PromiseSettledResult<unknown>[]} results
 * @returns {boolean}
 */
function isAllFailed(results) {
  return results.every((r) => r.status === 'rejected' || !r.value?.ok);
}

test('isAllFailed returns true only when every result is a rejection or ok:false', () => {
  assert.equal(isAllFailed([
    { status: 'rejected', reason: new Error('x') },
    { status: 'rejected', reason: new Error('y') },
    { status: 'rejected', reason: new Error('z') },
  ]), true);

  assert.equal(isAllFailed([
    { status: 'rejected', reason: new Error('x') },
    { status: 'fulfilled', value: { ok: false } },
    { status: 'rejected', reason: new Error('z') },
  ]), true);
});

test('isAllFailed returns false when at least one result is ok', () => {
  assert.equal(isAllFailed([
    { status: 'rejected', reason: new Error('x') },
    { status: 'fulfilled', value: { ok: true, buckets: [] } },
    { status: 'rejected', reason: new Error('z') },
  ]), false);

  assert.equal(isAllFailed([
    { status: 'fulfilled', value: { ok: true, summary: {} } },
    { status: 'fulfilled', value: { ok: true } },
    { status: 'fulfilled', value: { ok: true, models: [] } },
  ]), false);
});

// ---------------------------------------------------------------------------
// KPI "0 runs" formatting
// ---------------------------------------------------------------------------

/**
 * Mirrors paintKpi's runs-branch logic.
 *
 * @param {{ runs?: number, successRate?: number|null }} data
 * @returns {'runs_shown'|'no_run_data'}
 */
function kpiRunsBranch(data) {
  const runs = Number(data.runs) || 0;
  return runs > 0 ? 'runs_shown' : 'no_run_data';
}

test('kpiRunsBranch returns no_run_data for zero runs', () => {
  assert.equal(kpiRunsBranch({ runs: 0, successRate: null }), 'no_run_data');
  assert.equal(kpiRunsBranch({ runs: undefined }), 'no_run_data');
  assert.equal(kpiRunsBranch({}), 'no_run_data');
});

test('kpiRunsBranch returns runs_shown for positive runs', () => {
  assert.equal(kpiRunsBranch({ runs: 1, successRate: 1 }), 'runs_shown');
  assert.equal(kpiRunsBranch({ runs: 42, successRate: 0.9 }), 'runs_shown');
});

// ---------------------------------------------------------------------------
// sumDayWindow — runs accumulation
// ---------------------------------------------------------------------------

test('sumDayWindow sums runs and okRuns across days', () => {
  const byDay = {
    '2026-09-24': { usd: 0, tokens: { input: 100 }, runs: 3, okRuns: 2 },
    '2026-09-25': { usd: 0, tokens: { input: 200 }, runs: 1, okRuns: 1 },
  };
  const result = sumDayWindow(byDay, '2026-09-24', '2026-09-25');
  assert.equal(result.runs, 4);
  assert.equal(result.okRuns, 3);
  assert.ok(Math.abs(result.successRate - 0.75) < 0.001);
});

test('sumDayWindow returns runs=0 and successRate=null when no run events present', () => {
  const byDay = {
    '2026-09-24': { usd: 1.5, tokens: { input: 500 }, runs: 0, okRuns: 0 },
  };
  const result = sumDayWindow(byDay, '2026-09-24', '2026-09-24');
  assert.equal(result.runs, 0);
  assert.equal(result.successRate, null);
});
