/**
 * Settings → Usage delegation panel (model × role) contract + pure view tests.
 *
 * No DOM: the row normalization, view-state resolution and HTML builders are
 * pure functions in `delegationStatsView.js`. Static markup/i18n wiring is
 * asserted from the sources like `usage-ui-contract.test.js` does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  DELEGATION_STATS_ROLES,
  createDelegationStatsTokenGate,
  delegationStatsRows,
  delegationStatsRoleLabelKey,
  delegationStatsUnused,
  delegationStatsUnusedState,
  delegationStatsViewState,
  delegationStatsWindowDays,
  formatDelegationLastUsed,
  formatDelegationMinutes,
  formatDelegationQuality,
  formatDelegationRate,
  renderDelegationStatsCardsHtml,
  renderDelegationStatsHeadHtml,
  renderDelegationStatsMetaHtml,
  renderDelegationStatsRowsHtml,
  renderDelegationUnusedHtml,
} from '../app_front/features/usage/delegationStatsView.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const usageSettingsSource = fs.readFileSync(
  path.join(root, 'app_front/features/usage/usageSettings.js'),
  'utf8',
);
const apiSource = fs.readFileSync(path.join(root, 'app_front/api.js'), 'utf8');
const sdkRichViewSource = fs.readFileSync(path.join(root, 'app_front/lib/sdk-rich-view.js'), 'utf8');
const workspaceContextSource = fs.readFileSync(
  path.join(root, 'app_front/app/appShell/workspaceContext.js'),
  'utf8',
);

/** @returns {string} */
function usageSection() {
  const start = html.indexOf('<section class="settings-section" data-settings-tab="usage"');
  assert.ok(start > 0, 'usage settings section is missing');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

/**
 * Inner HTML of the first `<div>` carrying `openTagMarker`, found by balancing
 * nested `<div>`/`</div>` pairs. Good enough for the static settings markup.
 *
 * @param {string} source
 * @param {string} openTagMarker e.g. 'id="usage-content"'
 * @returns {string|null}
 */
function elementInnerHtml(source, openTagMarker) {
  const markerIdx = source.indexOf(openTagMarker);
  if (markerIdx < 0) return null;
  const start = source.indexOf('>', markerIdx) + 1;
  if (start <= 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 1;
  let match;
  while ((match = re.exec(source))) {
    if (match[0] === '</div>') {
      depth -= 1;
      if (depth === 0) return source.slice(start, match.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/**
 * Deterministic translation stub that echoes the key and its params.
 *
 * @param {string} key
 * @param {Record<string, string>} [params]
 * @returns {string}
 */
function tf(key, params = {}) {
  let text = String(key);
  for (const [name, value] of Object.entries(params)) text += `|${name}=${value}`;
  return text;
}

/**
 * @param {object} dict
 * @param {string} key dotted path
 * @returns {unknown}
 */
function lookup(dict, key) {
  return key
    .split('.')
    .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
}

const SAMPLE = {
  ok: true,
  window_ms: 30 * 24 * 60 * 60 * 1000,
  generated_at: '2026-10-01T08:00:00.000Z',
  min_jobs: 1,
  list: [
    { harness: 'claude', model: 'claude-sonnet-5', role: 'review', n: 3, pass_rate: 1, infra_fail_rate: 0, median_min: 4.2, quality: 5, last_used_at: '2026-09-30T10:00:00.000Z' },
    { harness: 'opencode', model: 'opencode/test', role: 'implement', n: 7, pass_rate: 0.8571, infra_fail_rate: 0.1429, median_min: 5, quality: 4.4284, last_used_at: '2026-10-01T07:00:00.000Z' },
    { harness: 'opencode', model: 'opencode/test', role: 'plan', n: 0, pass_rate: null, infra_fail_rate: 0, median_min: null, quality: null, last_used_at: '' },
    { harness: '', model: 'broken', role: 'review', n: 1 },
    { harness: 'x', model: 'y', role: 'unknown', n: 1 },
  ],
  unused_14d: ['codex', 'codebuddy', 'codebuddy', ''],
};

test('rows keep only valid identities, normalize numbers and sort by n desc', () => {
  const rows = delegationStatsRows(SAMPLE);
  assert.equal(rows.length, 3, 'invalid identities are dropped');
  assert.equal(rows[0].harness, 'opencode');
  assert.equal(rows[0].role, 'implement');
  assert.equal(rows[0].n, 7);
  assert.equal(rows[0].medianMin, 5);
  assert.equal(rows[0].lastUsedAt, '2026-10-01T07:00:00.000Z');
  const plan = rows.find((row) => row.role === 'plan');
  assert.equal(plan.passRate, null, 'a null rate survives as null');
  assert.equal(plan.medianMin, null);
  assert.equal(rows[rows.length - 1].role, 'plan', 'lower n sorts last');
  assert.deepEqual(DELEGATION_STATS_ROLES, ['plan', 'implement', 'review']);
});

test('role label keys are defined for known roles only', () => {
  assert.equal(delegationStatsRoleLabelKey('implement'), 'delegationStats.roleImplement');
  assert.equal(delegationStatsRoleLabelKey('review'), 'delegationStats.roleReview');
  assert.equal(delegationStatsRoleLabelKey('nope'), '');
});

test('viewState resolves error/empty/ready', () => {
  assert.equal(delegationStatsViewState(null), 'error');
  assert.equal(delegationStatsViewState({ ok: false }), 'error');
  assert.equal(delegationStatsViewState({ ok: true, list: [] }), 'empty');
  assert.equal(delegationStatsViewState({ ok: true, list: SAMPLE.list }), 'ready');
});

test('format helpers degrade to an em dash', () => {
  assert.equal(formatDelegationRate(0.8571, 'en'), '85.7%');
  assert.equal(formatDelegationRate(null, 'en'), '—');
  assert.equal(formatDelegationMinutes(5, 'en'), '5', 'the unit must come from i18n, never hardcoded');
  assert.equal(formatDelegationMinutes(5, 'en', tf), 'delegationStats.unitMinutes|n=5');
  assert.equal(formatDelegationMinutes(30, 'pl', tf), 'delegationStats.unitMinutes|n=30');
  assert.equal(formatDelegationMinutes(null, 'en', tf), '—');
  assert.equal(formatDelegationQuality(4.4284), '4.4');
  assert.equal(formatDelegationQuality(null), '—');
  assert.equal(formatDelegationLastUsed('2026-10-01T07:00:00.000Z'), '2026-10-01');
  assert.equal(formatDelegationLastUsed('not-a-date'), '—');
  assert.equal(delegationStatsWindowDays(30 * 24 * 60 * 60 * 1000), 30);
  assert.equal(delegationStatsWindowDays(0), null);
});

test('unused harnesses are de-duplicated, trimmed and sorted', () => {
  assert.deepEqual(delegationStatsUnused(SAMPLE), ['codebuddy', 'codex']);
  assert.deepEqual(delegationStatsUnused({}), []);
});

test('a failed harness catalog is a distinct error state, not an empty success', () => {
  assert.equal(delegationStatsUnusedState({ ok: true, unused_14d: [] }), 'ready');
  assert.equal(delegationStatsUnusedState({ ok: true, unused_14d: ['codex'] }), 'ready');
  assert.equal(
    delegationStatsUnusedState({ ok: true, unused_14d: [], unused_14d_error: true }),
    'error',
    'unused_14d_error wins over the empty list',
  );
  assert.equal(delegationStatsUnusedState(null), 'ready');

  const unavailable = renderDelegationUnusedHtml(delegationStatsUnused([]), tf, 'error');
  assert.match(unavailable, /delegationStats\.unusedUnavailable/);
  assert.doesNotMatch(unavailable, /delegationStats\.noUnused/);
  assert.match(renderDelegationUnusedHtml([], tf, 'ready'), /delegationStats\.noUnused/);
});

test('stats token gate rejects an older full-reload snapshot after a newer panel refresh', () => {
  const gate = createDelegationStatsTokenGate();
  const fullReload = gate.begin();
  const panelRefresh = gate.begin();
  assert.equal(gate.isCurrent(fullReload), false, 'the slow full-reload stats response is stale');
  assert.equal(gate.isCurrent(panelRefresh), true, 'the newest panel request owns the panel');

  const nextFullReload = gate.begin();
  assert.equal(gate.isCurrent(panelRefresh), false, 'starting a new request invalidates the previous winner');
  assert.equal(gate.isCurrent(nextFullReload), true);
  assert.ok(gate.invalidate() > nextFullReload);
  assert.equal(gate.isCurrent(nextFullReload), false, 'invalidate moves the current token forward');
});

test('table and card renderers expose every required API field', () => {
  const rows = delegationStatsRows(SAMPLE);
  const head = renderDelegationStatsHeadHtml(tf);
  for (const key of [
    'delegationStats.colHarness',
    'delegationStats.colModel',
    'delegationStats.colRole',
    'delegationStats.colN',
    'delegationStats.colPassRate',
    'delegationStats.colInfraFail',
    'delegationStats.colMedian',
    'delegationStats.colQuality',
    'delegationStats.colLastUsed',
  ]) {
    assert.match(head, new RegExp(key));
  }
  const body = renderDelegationStatsRowsHtml(rows, tf, 'en');
  assert.match(body, /opencode/);
  assert.match(body, /opencode\/test/);
  assert.match(body, /delegationStats\.roleImplement/);
  assert.match(body, /85\.7%/);
  assert.match(body, /14\.3%/);
  assert.match(body, /delegationStats\.unitMinutes\|n=5/);
  assert.match(body, /4\.4/);
  assert.match(body, /2026-10-01/);
  const cards = renderDelegationStatsCardsHtml(rows, tf, 'en');
  assert.match(cards, /settings-usage-card/);
  assert.match(cards, /delegationStats\.colLastUsed/);
  assert.match(cards, /delegationStats\.roleReview/);
  assert.match(cards, /delegationStats\.unitMinutes\|n=5/);
});

test('unused + meta renderers cover the empty state and the window fields', () => {
  const unused = renderDelegationUnusedHtml(delegationStatsUnused(SAMPLE), tf);
  assert.match(unused, /settings-usage-tag/);
  assert.match(unused, /codebuddy/);
  assert.match(unused, /codex/);
  assert.match(renderDelegationUnusedHtml([], tf), /delegationStats\.noUnused/);

  const meta = renderDelegationStatsMetaHtml(SAMPLE, tf);
  assert.match(meta, /delegationStats\.metaWindow\|days=30/);
  assert.match(meta, /delegationStats\.metaGenerated\|at=2026-10-01T08:00:00\.000Z/);
  assert.match(meta, /delegationStats\.metaMinJobs\|n=1/);
});

test('delegationStats i18n keys exist and match in en + pl', () => {
  const keys = [
    'title', 'hint', 'refresh', 'retry', 'loading', 'loadFailed', 'empty',
    'metaWindow', 'metaGenerated', 'metaMinJobs', 'unitMinutes',
    'unusedTitle', 'unusedHint', 'noUnused', 'unusedUnavailable',
    'colHarness', 'colModel', 'colRole', 'colN', 'colPassRate', 'colInfraFail',
    'colMedian', 'colQuality', 'colLastUsed',
    'rolePlan', 'roleImplement', 'roleReview',
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, `delegationStats.${key}`), 'string', `en missing ${key}`);
    assert.equal(typeof lookup(pl, `delegationStats.${key}`), 'string', `pl missing ${key}`);
  }
  assert.deepEqual(
    Object.keys(en.delegationStats).sort(),
    Object.keys(pl.delegationStats).sort(),
    'en/pl delegationStats key sets differ',
  );
});

test('usage section wires the delegation panel ids and states', () => {
  const section = usageSection();
  for (const id of [
    'delegation-stats-title',
    'delegation-stats-refresh',
    'delegation-stats-meta',
    'delegation-stats-loading',
    'delegation-stats-error',
    'delegation-stats-error-text',
    'delegation-stats-retry',
    'delegation-stats-content',
    'delegation-stats-table',
    'delegation-stats-head',
    'delegation-stats-body',
    'delegation-stats-cards',
    'delegation-stats-empty',
    'delegation-stats-unused-list',
  ]) {
    assert.match(section, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // Responsive: the table/cards reuse the KPI breakdown classes so the <600px
  // media query hides the table and shows the cards.
  assert.match(section, /id="delegation-stats-table"[^>]*settings-usage-breakdown/);
  assert.match(section, /id="delegation-stats-cards"[^>]*settings-usage-cards/);
});

test('the delegation panel is a sibling of #usage-content, not nested inside it', () => {
  const section = usageSection();
  const content = elementInnerHtml(section, 'id="usage-content"');
  assert.ok(content != null, '#usage-content must exist');
  assert.doesNotMatch(
    content,
    /delegation-stats-content/,
    'a ledger error must not be able to hide the delegation panel via #usage-content',
  );
  assert.match(section, /class="settings-usage-delegation-stats"/);
  assert.ok(
    section.indexOf('class="settings-usage-delegation-stats"') > section.indexOf('id="usage-content"'),
    'the panel is declared after the ledger content block',
  );
});

test('usage module + api client wire the stats endpoint and refresh/retry', () => {
  assert.match(apiSource, /export async function getDelegationStats\(/);
  assert.match(apiSource, /\/api\/delegations\/stats/);
  assert.match(usageSettingsSource, /getDelegationStats/);
  assert.match(usageSettingsSource, /refreshDelegationStatsSettings/);
  assert.match(usageSettingsSource, /delegation-stats-retry/);
  assert.match(usageSettingsSource, /delegation-stats-refresh/);
  assert.match(usageSettingsSource, /setDelegationStatsView\('loading'\)/);
  assert.match(usageSettingsSource, /setDelegationStatsView\('error'\)/);
  assert.match(usageSettingsSource, /delegationStatsViewState/);
});

test('stats client forwards the active workspace scope and the panel reloads on switch', () => {
  assert.match(apiSource, /if \(query\.workspaceFolder\) params\.set\('workspaceFolder'/);
  assert.match(apiSource, /if \(query\.workspaceFile\) params\.set\('workspaceFile'/);
  assert.match(usageSettingsSource, /function getActiveWorkspaceScope\(/);
  assert.match(usageSettingsSource, /getDelegationStats\(getActiveWorkspaceScope\(\)\)/);
  assert.match(usageSettingsSource, /cretli-workspace-updated/);
  assert.match(usageSettingsSource, /cretli-active-workspace-changed/);
  assert.match(
    workspaceContextSource,
    /dispatchEvent\(new CustomEvent\('cretli-active-workspace-changed'/,
    'the active workspace switch must emit the signal the panel listens to',
  );
});

test('refreshUsageSettings paints the panel before the all-failed early return', () => {
  const body = usageSettingsSource.slice(
    usageSettingsSource.indexOf('export async function refreshUsageSettings'),
    usageSettingsSource.indexOf('function exportCsv'),
  );
  const renderIdx = body.indexOf('renderDelegationStatsIfCurrent(statsToken, delegationStatsResult)');
  const allFailedIdx = body.indexOf('if (allFailed) {');
  assert.ok(renderIdx > 0, 'the panel render must use the guarded token renderer');
  assert.ok(allFailedIdx > renderIdx, 'the panel must be painted before the all-failed early return');
  assert.match(body, /delegationStatsGate\.begin\(\)/);
  assert.match(body, /renderDelegationStatsIfCurrent/);
});

test('delegation card renders the pick reason when the payload carries one', () => {
  assert.match(sdkRichViewSource, /model\.pickReason/);
  assert.match(sdkRichViewSource, /delegationPickReason/);
  assert.equal(typeof lookup(en, 'chat.delegationPickReason'), 'string');
  assert.equal(typeof lookup(pl, 'chat.delegationPickReason'), 'string');
});
