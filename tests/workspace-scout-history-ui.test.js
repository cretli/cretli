/**
 * Scout scan history UI contract (stage 5.3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOUT_HISTORY_ACTIONS,
  SCOUT_HISTORY_DROP_REASONS,
  renderScoutHistoryHtml,
  renderScoutScanRow,
  scoutScanCapacityExceeded,
  scoutScanUsageParts,
  scoutScanUsageText,
  SCOUT_HISTORY_PAGE_SIZE,
} from '../app_front/features/watcher/scoutHistoryView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const settingsSource = readSource('app_front/features/settings/workspaceWatcherSettings.js');

test('history renders loading, error and empty states', () => {
  assert.match(renderScoutHistoryHtml({ loading: true }), /data-scout-history-loading/);
  assert.match(renderScoutHistoryHtml({ error: 'boom' }), /data-scout-history-error/);
  assert.match(renderScoutHistoryHtml({ history: [] }), /data-scout-history-empty/);
});

test('a scan row shows status, times, executor and counts; usage null is not zero cost', () => {
  const entry = {
    scanId: 'scan-1',
    status: 'completed',
    startedAt: '2026-02-01T10:00:00.000Z',
    finishedAt: '2026-02-01T10:05:00.000Z',
    executor: { harness: 'openrouter', model: 'cheap' },
    usage: null,
    added: 2,
    merged: 1,
    dropped: 0,
    scoutId: 'profile-a',
  };
  const html = renderScoutScanRow(entry);
  assert.match(html, /data-scout-scan-status="completed"/);
  assert.match(html, /2026-02-01T10:00:00.000Z/);
  assert.match(html, /openrouter · cheap/);
  assert.match(html, /data-scout-scan-usage="none"/);
  assert.equal(scoutScanUsageText(null), en.settings.watcherScoutScanNoUsage);
  assert.doesNotMatch(html, /\$0/);
  assert.doesNotMatch(html, /data-scout-scan-usage="measured"[^>]*>[^<]*\b0\b/);
  assert.match(html, /2 added · 1 merged · 0 dropped/);
});

test('usage with tokens but no usd renders tokens and never a zero-dollar cost', () => {
  const entry = {
    scanId: 'scan-tokens',
    status: 'completed',
    startedAt: '2026-02-01T10:00:00.000Z',
    finishedAt: '2026-02-01T10:05:00.000Z',
    usage: { tokens: 1500, eventCount: 1 },
    added: 0,
    merged: 0,
    dropped: 0,
  };
  const parts = scoutScanUsageParts(entry.usage);
  assert.equal(parts.measured, true);
  assert.match(scoutScanUsageText(entry.usage), /1[,.]?500|1500/);
  const html = renderScoutScanRow(entry);
  assert.match(html, /data-scout-scan-usage="measured"/);
  assert.doesNotMatch(html, /\$0/);
  assert.doesNotMatch(html, /0 USD/i);
});

test('history load-more label matches the step the panel applies', () => {
  const hidden = 35;
  const shown = 20;
  const html = renderScoutHistoryHtml({
    history: Array.from({ length: shown }, (_, i) => ({
      scanId: `s${i}`,
      status: 'completed',
      startedAt: '2026-01-01',
      finishedAt: '2026-01-02',
      usage: null,
      added: 0,
      merged: 0,
      dropped: 0,
    })),
    total: shown + hidden,
    max: shown,
  });
  const expectedStep = Math.min(hidden, SCOUT_HISTORY_PAGE_SIZE);
  const expectedLabel = en.settings.watcherScoutHistoryMore.replace('{n}', String(expectedStep));
  assert.match(html, new RegExp(escapeRegExp(expectedLabel)));
});

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('capacity_exceeded drop reason and overflow badge render', () => {
  const entry = {
    status: 'completed',
    reasons: ['capacity_exceeded'],
    usage: null,
    added: 0,
    merged: 0,
    dropped: 3,
  };
  assert.equal(scoutScanCapacityExceeded(entry), true);
  const html = renderScoutScanRow(entry);
  assert.match(html, /data-scout-scan-overflow="true"/);
  assert.match(html, /data-scout-scan-state="overflow"/);
  assert.match(html, /Mailbox full/);
  assert.match(html, /Mailbox capacity exceeded/);
  for (const reason of SCOUT_HISTORY_DROP_REASONS) {
    assert.ok(en.settings[`watcherScoutDropReason_${reason}`], `en drop reason ${reason}`);
    assert.ok(pl.settings[`watcherScoutDropReason_${reason}`], `pl drop reason ${reason}`);
  }
});

test('no rendered history action is a dead action', () => {
  const html = renderScoutHistoryHtml({
    history: [{
      scanId: 's1',
      status: 'completed',
      startedAt: '2026-01-01',
      finishedAt: '2026-01-02',
      usage: null,
      added: 0,
      merged: 0,
      dropped: 0,
    }],
    total: 50,
    max: 20,
  });
  const rendered = new Set([...html.matchAll(/data-scout-history-action="([^"]+)"/g)].map((m) => m[1]));
  for (const action of rendered) {
    assert.ok(SCOUT_HISTORY_ACTIONS.includes(action), `${action} must be in SCOUT_HISTORY_ACTIONS`);
    assert.ok(settingsSource.includes(`'${action}'`), `settings must reference ${action}`);
  }
  assert.match(settingsSource, /SCOUT_HISTORY_ACTIONS\.includes\(historyAction\)/);
  assert.match(settingsSource, /id="watcher-scout-history"/);
  assert.match(settingsSource, /\/api\/workspace-watcher\/scout\/history/);
  assert.doesNotMatch(settingsSource, /approve-plan|approvePlan/i);
});

test('PL and EN define every Scout history and scan status key', () => {
  const keys = [
    'watcherScoutHistoryTitle',
    'watcherScoutHistoryHint',
    'watcherScoutHistoryLoading',
    'watcherScoutHistoryEmpty',
    'watcherScoutHistoryError',
    'watcherScoutHistoryCount',
    'watcherScoutHistoryMore',
    'watcherScoutHistoryProfile',
    'watcherScoutHistoryAllProfiles',
    'watcherScoutHistoryReload',
    'watcherScoutScanProfile',
    'watcherScoutScanNoProfile',
    'watcherScoutScanStatus_unknown',
    'watcherScoutScanStatus_reserved',
    'watcherScoutScanStatus_running',
    'watcherScoutScanStatus_completed',
    'watcherScoutScanStatus_failed',
    'watcherScoutScanStatus_interrupted',
    'watcherScoutScanStatus_uncertain',
    'watcherScoutScanExecutor',
    'watcherScoutScanNoExecutor',
    'watcherScoutScanNoFinish',
    'watcherScoutScanUsage',
    'watcherScoutScanNoUsage',
    'watcherScoutScanUsageTokens',
    'watcherScoutScanUsageCost',
    'watcherScoutScanUsageEvents',
    'watcherScoutScanCounts',
    'watcherScoutScanCountsLabel',
    'watcherScoutScanReasons',
    'watcherScoutScanError',
    'watcherScoutScanRefs',
    'watcherScoutScanRevision',
    'watcherScoutScanOverflowBadge',
  ];
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});
