import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCacheCountdown } from '../lib/usage/cache-countdown.ts';
import { formatCacheCountdown, renderChatContextCacheCountdownHtml, resolveCountdownLevel, resolveCountdownPercent } from '../app_front/features/chat/chatContextCacheCountdownView.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ttl = { ttlMs: 300000, refreshOnHit: true };

test('uses the tracker while it is warm', () => {
  const freshness = { cache: { state: 'warm', ttlKnown: true, ttlMs: 300000, expiresAt: NOW + 120000, lastCachedTurnAt: NOW - 180000, refreshOnHit: true } };
  const result = buildCacheCountdown(freshness, [], ttl, NOW);
  assert.equal(result.state, 'warm');
  assert.equal(result.expiresInMs, 120000);
  assert.equal(result.source, 'tracker');
});

test('falls back to the newest sample with cache activity after a restart', () => {
  const samples = [
    { observedAt: new Date(NOW - 600000).toISOString(), cacheReadTokens: 100 },
    { observedAt: new Date(NOW - 60000).toISOString(), cacheReadTokens: 0, cacheWriteTokens: 5000 },
    { observedAt: new Date(NOW - 10000).toISOString(), cacheReadTokens: null, cacheWriteTokens: null },
  ];
  const warm = buildCacheCountdown({ cache: { state: 'unknown' } }, samples, ttl, NOW);
  assert.equal(warm.state, 'warm');
  assert.equal(warm.source, 'samples');
  assert.equal(warm.expiresInMs, 240000);
  const cold = buildCacheCountdown({ cache: { state: 'unknown' } }, samples, ttl, NOW + 400000);
  assert.equal(cold.state, 'cold');
});

test('unknown ttl never produces a countdown', () => {
  const result = buildCacheCountdown({ cache: { state: 'unknown' } }, [{ observedAt: new Date(NOW).toISOString(), cacheReadTokens: 10 }], { ttlMs: null }, NOW);
  assert.equal(result.state, 'unknown');
  assert.equal(result.expiresAt, null);
});

test('a compaction reset is cold even though the ttl has not passed', () => {
  const result = buildCacheCountdown({ cache: { state: 'cold', reason: 'context_epoch_changed', lastCachedTurnAt: NOW - 1000, ttlKnown: true, ttlMs: 300000 } }, [], ttl, NOW);
  assert.equal(result.state, 'cold');
});

test('formats and renders the countdown', () => {
  assert.equal(formatCacheCountdown(222000), '3:42');
  assert.equal(formatCacheCountdown(3725000), '1:02:05');
  const t = (key) => key;
  const html = renderChatContextCacheCountdownHtml({ state: 'warm', expiresAt: NOW + 30000, ttlMs: 300000, refreshOnHit: true, source: 'tracker' }, t, NOW);
  assert.match(html, /data-cache-expires-at/);
  assert.match(html, /0:30/);
  assert.match(html, /data-cache-countdown-bar/);
  assert.match(html, /width:10\.0%/);
  assert.equal(resolveCountdownPercent(150000, 300000), 50);
  assert.equal(resolveCountdownLevel(150000, 300000), 'ok');
  assert.equal(resolveCountdownLevel(90000, 300000), 'warn');
  assert.equal(resolveCountdownLevel(30000, 300000), 'urgent');
  assert.match(renderChatContextCacheCountdownHtml({ state: 'cold', source: 'samples' }, t, NOW), /cacheCountdownExpired/);
  assert.equal(renderChatContextCacheCountdownHtml(null, t), '');
});

test('the lifetime reported on a write overrides the configured one', async () => {
  const { inferObservedCacheTtlMs } = await import('../lib/usage/cache-countdown.ts');
  const at = (minutes, over = {}) => ({ observedAt: new Date(NOW - minutes * 60000).toISOString(), contextEpoch: 0, ...over });
  assert.equal(inferObservedCacheTtlMs([at(3, { cacheWrite5mTokens: 100 })]), 300000);
  assert.equal(inferObservedCacheTtlMs([at(9, { cacheWrite5mTokens: 100 }), at(3, { cacheWrite1hTokens: 100 })]), 3600000);
  assert.equal(inferObservedCacheTtlMs([at(9, { cacheWrite1hTokens: 100, contextEpoch: 0 }), at(3, { contextEpoch: 1 })]), null);
  assert.equal(inferObservedCacheTtlMs([]), null);
  const samples = [at(2, { cacheReadTokens: 10, cacheWriteTokens: 50, cacheWrite1hTokens: 50 })];
  const result = buildCacheCountdown({ cache: { state: 'unknown' } }, samples, { ttlMs: 300000, refreshOnHit: true }, NOW);
  assert.equal(result.ttlMs, 3600000);
  assert.equal(result.ttlSource, 'observed');
  assert.equal(result.expiresInMs, 3600000 - 120000);
});

test('Codex hits do not imply a known expiry time', async () => {
  const { resolveCacheTtl } = await import('../lib/usage/cache-state.ts');
  const ttl = resolveCacheTtl({ harness: 'codex' });
  assert.equal(ttl.known, false);
  const samples = [{ observedAt: new Date(NOW - 60000).toISOString(), cacheReadTokens: 900, contextEpoch: 0 }];
  const result = buildCacheCountdown({ cache: { state: 'unknown' } }, samples, ttl, NOW);
  assert.equal(result.state, 'unknown');
  assert.equal(result.expiresAt, null);
  assert.equal(result.lastCachedTurnAt, NOW - 60000);
  assert.match(renderChatContextCacheCountdownHtml(result, (key) => key, NOW), /cacheCountdownUnknown/);
});

test('series fallback fills codex cache from the newest sample', async () => {
  const { mergeSeriesIntoContextSnapshot } = await import('../app_front/features/chat/chatContextCacheChartView.js');
  const merged = mergeSeriesIntoContextSnapshot({ transport: 'codex', cacheReadTokens: null, inputTokens: null }, { points: [{ cacheReadTokens: 800, inputTokens: 1000 }] });
  assert.equal(merged.cacheReadTokens, 800);
  assert.equal(merged.inputTokens, 1000);
});
