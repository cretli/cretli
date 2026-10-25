import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsageTop, explainUsage } from '../lib/usage/usage-top.ts';
import { attributeLimitBurn } from '../lib/usage/usage-limit-burn.ts';

const ev = (over) => ({
  eventType: 'delta',
  harness: 'claude',
  model: 'm1',
  role: 'chat',
  at: '2026-10-10T10:00:00.000Z',
  tokens: { textInput: 10, textOutput: 5, cachedInput: 1000, cacheWrite: 20, reasoning: 0 },
  ...over,
});

test('ranks by fresh tokens, not by cache-heavy totals', () => {
  const events = [
    ev({ chatId: 'a', tokens: { textInput: 1, textOutput: 1, cachedInput: 9_000_000, cacheWrite: 0 } }),
    ev({ chatId: 'b', tokens: { textInput: 5000, textOutput: 100, cachedInput: 10, cacheWrite: 0 } }),
  ];
  const top = buildUsageTop({ events, groupBy: 'chat' });
  assert.equal(top.rows[0].key, 'b');
  assert.equal(top.rows[1].key, 'a');
  assert.ok(top.rows[1].cacheShare > 0.99);
  const byTotal = buildUsageTop({ events, groupBy: 'chat', metric: 'total' });
  assert.equal(byTotal.rows[0].key, 'a');
});

test('counts limit hits from run events and groups by day', () => {
  const events = [
    ev({ chatId: 'a' }),
    { eventType: 'run', outcome: 'limit', harness: 'claude', model: 'm1', chatId: 'a', at: '2026-10-11T01:00:00.000Z' },
  ];
  const top = buildUsageTop({ events, groupBy: 'chat' });
  assert.equal(top.rows[0].limitHits, 1);
  const days = buildUsageTop({ events, groupBy: 'day', tz: 'UTC' });
  assert.deepEqual(days.rows.map((r) => r.key).sort(), ['2026-10-10', '2026-10-11']);
});

test('leaf grouping joins through delegations and keeps unattributed apart', () => {
  const delegations = [{ id: 'd1', leafId: 'leaf1', attempts: [{ attemptId: 'at1', runId: 'r1', leafId: 'leaf1' }] }];
  const events = [
    ev({ delegationId: 'd1', attemptId: 'at1', runId: 'r1' }),
    ev({ chatId: 'x' }),
  ];
  const top = buildUsageTop({ events, delegations, groupBy: 'leaf' });
  const keys = top.rows.map((r) => r.key).sort();
  assert.deepEqual(keys, ['(not delegated)', 'leaf1']);
});

test('leaf axis separates a delegation that cannot be joined from plain chats', () => {
  const events = [ev({ delegationId: 'ghost', attemptId: 'x', runId: 'y' }), ev({ chatId: 'c' })];
  const keys = buildUsageTop({ events, delegations: [], groupBy: 'leaf' }).rows.map((r) => r.key).sort();
  assert.deepEqual(keys, ['(delegation not joined)', '(not delegated)']);
});

test('limit truncates and reports it; explain finds the heaviest run', () => {
  const events = [
    ev({ chatId: 'a', runId: 'r1' }),
    ev({ chatId: 'a', runId: 'r2', tokens: { textInput: 9999, textOutput: 1, cachedInput: 0, cacheWrite: 0 } }),
    ev({ chatId: 'b', runId: 'r3' }),
  ];
  const top = buildUsageTop({ events, groupBy: 'chat', limit: 1 });
  assert.equal(top.rows.length, 1);
  assert.equal(top.truncated, true);
  const explained = explainUsage({ events, subject: { type: 'chat', id: 'a' } });
  assert.equal(explained.found, true);
  assert.equal(explained.topRuns[0].key, 'r2');
  assert.equal(explainUsage({ events, subject: { type: 'chat', id: 'zzz' } }).found, false);
});

test('flags a chat whose prompt volume dwarfs its harness peers', () => {
  const mk = (chatId, cached) => Array.from({ length: 6 }, () => ev({
    chatId,
    harness: 'codex',
    tokens: { textInput: 300_000, textOutput: 1000, cachedInput: cached, cacheWrite: 0 },
  }));
  const events = [...mk('a', 100_000), ...mk('b', 120_000), ...mk('c', 110_000), ...mk('big', 9_000_000)];
  const rows = buildUsageTop({ events, groupBy: 'chat' }).rows;
  assert.deepEqual(rows.find((r) => r.key === 'big').flags, ['heavy_context']);
  assert.deepEqual(rows.find((r) => r.key === 'a').flags, []);
});

test('limit burn blames same-harness chats in the look-back and collapses retries', () => {
  const hit = (at) => ({ eventType: 'run', outcome: 'limit', harness: 'claude', model: 'm1', at });
  const events = [
    ev({ chatId: 'hog', at: '2026-10-10T08:00:00.000Z', tokens: { textInput: 5000, textOutput: 10, cachedInput: 0, cacheWrite: 0 } }),
    ev({ chatId: 'small', at: '2026-10-10T09:00:00.000Z', tokens: { textInput: 100, textOutput: 10, cachedInput: 0, cacheWrite: 0 } }),
    ev({ chatId: 'other', harness: 'codex', at: '2026-10-10T09:00:00.000Z', tokens: { textInput: 99999, textOutput: 1, cachedInput: 0, cacheWrite: 0 } }),
    ev({ chatId: 'old', at: '2026-10-09T01:00:00.000Z', tokens: { textInput: 99999, textOutput: 1, cachedInput: 0, cacheWrite: 0 } }),
    hit('2026-10-10T10:00:00.000Z'),
    hit('2026-10-10T10:02:00.000Z'),
  ];
  const burn = attributeLimitBurn({ events });
  assert.equal(burn.clusters, 1);
  assert.equal(burn.rawHits, 2);
  assert.deepEqual(burn.recent[0].topChats.map((c) => c.chatId), ['hog', 'small']);
  assert.equal(burn.culprits[0].chatId, 'hog');
});

test('limit burn window edges and a large ledger stay linear', () => {
  const hit = (at, harness = 'claude') => ({ eventType: 'run', outcome: 'limit', harness, model: 'm1', at });
  const one = { textInput: 1, textOutput: 0, cachedInput: 0, cacheWrite: 0 };
  const edges = attributeLimitBurn({
    lookbackMs: 60 * 60 * 1000,
    events: [
      ev({ chatId: 'at-hit', at: '2026-10-10T10:00:00.000Z', tokens: one }),
      ev({ chatId: 'at-start', at: '2026-10-10T09:00:00.000Z', tokens: one }),
      ev({ chatId: 'after', at: '2026-10-10T10:00:00.001Z', tokens: one }),
      hit('2026-10-10T10:00:00.000Z'),
    ],
  });
  assert.deepEqual(edges.recent[0].topChats.map((c) => c.chatId), ['at-hit'], 'window is (hit - lookback, hit]');

  // 2 000 limit clusters over 200 000 usage events: the old per-cluster rescan
  // parsed 400 M timestamps and blocked the server for seconds.
  const events = [];
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  for (let i = 0; i < 200_000; i += 1) events.push(ev({ chatId: `c${i % 50}`, at: new Date(base + i * 6000).toISOString(), tokens: one }));
  for (let i = 0; i < 2000; i += 1) events.push(hit(new Date(base + i * 11 * 60 * 1000).toISOString()));
  const started = Date.now();
  const burn = attributeLimitBurn({ events });
  assert.equal(burn.clusters, 2000);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('advice reports uncached heavy models, costly leaves, heavy chats and limit hotspots with evidence', async () => {
  const { buildUsageAdvice } = await import('../lib/usage/usage-advice.ts');
  const advice = buildUsageAdvice({
    models: { rows: [{ key: 'codebuddy|hy3', fresh: 30e6, events: 900, cacheShare: 0, shareOfFresh: 0.2, roles: ['review'] }, { key: 'claude|x', fresh: 30e6, events: 900, cacheShare: 0.9, shareOfFresh: 0.2 }] },
    leaves: { rows: [{ key: 'leaf1', attempts: 8, freshPerAttempt: 2_500_000, fresh: 20e6 }, { key: '(not delegated)', attempts: 9, freshPerAttempt: 9e6 }] },
    chats: { rows: [{ key: 'c1', flags: ['heavy_context'], fresh: 5e6 }, { key: 'c2', flags: [] }] },
    burn: { culprits: [{ chatId: 'c3', harness: 'claude', hitsBlamed: 3, fresh: 1 }, { chatId: 'c4', hitsBlamed: 1 }] },
  });
  assert.deepEqual(advice.map((f) => `${f.kind}:${f.subject}`), ['uncached_model:codebuddy|hy3', 'costly_leaf:leaf1', 'heavy_context_chat:c1', 'limit_hotspot:c3']);
  assert.equal(advice[0].severity, 'high');
});

test('resume axis splits delegated usage by sessionResume and advice flags harnesses where it costs more', async () => {
  const { buildUsageAdvice } = await import('../lib/usage/usage-advice.ts');
  const mk = (n, delegationId, input) => ev({ role: 'review', harness: 'codex', delegationId, tokens: { textInput: input, textOutput: 0, cachedInput: 0, cacheWrite: 0 } });
  const delegations = [];
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    delegations.push({ id: `r${i}`, sessionResume: { reasonCode: 'resumed' } }, { id: `f${i}`, sessionResume: { reasonCode: 'reuse_first_session' } });
    events.push(mk(i, `r${i}`, 3000), mk(i, `f${i}`, 1000));
  }
  events.push(ev({ chatId: 'plain' }));
  const top = buildUsageTop({ events, delegations, groupBy: 'resume' });
  const byKey = Object.fromEntries(top.rows.map((r) => [r.key, r]));
  assert.equal(byKey['codex|review|resumed'].freshPerDelegation, 3000);
  assert.equal(byKey['codex|review|fresh'].delegations, 10);
  assert.ok(byKey['(not delegated)']);
  const advice = buildUsageAdvice({ resume: top });
  assert.deepEqual(advice.map((f) => `${f.kind}:${f.subject}`), ['resume_hurts:codex|review']);
  assert.equal(advice[0].evidence.ratio, 3);
  // A harness that is mostly unmeasured must not be judged on the few events it has.
  const sparse = buildUsageTop({ events: events.filter((e, i) => i % 5 === 0).concat(events.map((e) => ({ ...e, eventType: 'run', tokens: undefined }))), delegations, groupBy: 'resume' });
  assert.deepEqual(buildUsageAdvice({ resume: sparse }).map((f) => f.kind), ['low_measurement_coverage']);
});

test('resume axis reports resume_context_cap fallbacks as their own bucket', () => {
  const mk = (delegationId) => ev({ role: 'implement', harness: 'codex', delegationId, tokens: { textInput: 100, textOutput: 0, cachedInput: 0, cacheWrite: 0 } });
  const delegations = [
    { id: 'cap1', sessionResume: { status: 'fallback', reasonCode: 'resume_context_cap' } },
    { id: 'fresh1', sessionResume: { status: 'fallback', reasonCode: 'resume_locked_out' } },
  ];
  const top = buildUsageTop({ events: [mk('cap1'), mk('fresh1')], delegations, groupBy: 'resume' });
  const byKey = Object.fromEntries(top.rows.map((r) => [r.key, r]));
  assert.equal(byKey['codex|implement|resume_context_cap'].delegations, 1);
  assert.equal(byKey['codex|implement|fresh'].delegations, 1);
});

test('advice flags harness/role pairs whose delegations mostly lack usage measurements', async () => {
  const { buildUsageAdvice } = await import('../lib/usage/usage-advice.ts');
  const advice = buildUsageAdvice({ resume: { rows: [
    { key: 'codex|review|fresh', delegations: 41, delegationsSeen: 173 },
    { key: 'codex|review|resumed', delegations: 16, delegationsSeen: 48 },
    { key: 'claude|review|fresh', delegations: 570, delegationsSeen: 579 },
  ] } });
  assert.deepEqual(advice.map((f) => `${f.kind}:${f.subject}`), ['low_measurement_coverage:codex|review']);
  assert.equal(advice[0].evidence.delegationsMeasured, 57);
});
