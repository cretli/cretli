/**
 * TODO usage aggregation (lib/usage/todo-usage.ts).
 *
 * Pure read model over the existing ledger: join by delegationId + attemptId +
 * runId, retry safety, no tree duplication, own/consolidated kept apart,
 * "no data" as null with coverage, cost from the ledger only, elapsed separate
 * from the sum of attempt durations, workspace scope and filters.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateTodoUsageRows,
  buildDelegationJoinIndex,
  buildTodoUsageModel,
  buildTodoUsageStats,
  buildWorkspaceTodoUsage,
  decodeTodoUsageCursor,
  encodeTodoUsageCursor,
  joinTodoUsageEvents,
  resolveTodoUsageLimit,
  resolveTodoUsageQuery,
  sumAttemptDurationsMs,
  TODO_USAGE_MAX_LIMIT,
  todoElapsedMs,
  todoUsageJoinKey,
} from '../lib/usage/todo-usage.ts';

/**
 * @param {object} [over]
 * @returns {object}
 */
function usageEvent(over = {}) {
  return {
    id: `e-${Math.random().toString(16).slice(2)}`,
    at: '2026-09-01T10:00:00.000Z',
    provider: 'openrouter',
    feature: 'chat',
    harness: 'openrouter',
    model: 'm',
    role: 'implement',
    eventType: 'delta',
    tokens: {
      textInput: 100,
      textOutput: 10,
      audioInput: 0,
      audioOutput: 0,
      cachedInput: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    usd: 0.5,
    estimated: false,
    ...over,
  };
}

/**
 * @param {object} [over]
 * @returns {object}
 */
function delegation(over = {}) {
  const base = {
    id: 'd1',
    leafId: 'todo-1',
    workspaceFolder: '/ws',
    attemptId: 'a1',
    runId: 'r1',
    status: 'completed',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:01:00.000Z',
    queuedAt: '2026-09-01T09:59:00.000Z',
    attempts: [],
  };
  return { ...base, ...over };
}

/**
 * @param {string} id
 * @param {string} [parentId]
 * @param {object} [over]
 * @returns {object}
 */
function todo(id, parentId = '', over = {}) {
  return {
    id,
    parentId,
    title: id,
    status: 'ready',
    body: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...over,
  };
}

test('join key is delegationId + attemptId + runId', () => {
  assert.equal(todoUsageJoinKey('d1', 'a1', 'r1'), 'd1|a1|r1');
  assert.equal(todoUsageJoinKey('d1', '', 'r1'), 'd1||r1');
  assert.notEqual(todoUsageJoinKey('d1', 'a1', 'r1'), todoUsageJoinKey('d1', 'a2', 'r1'));
});

test('usage events are joined to the TODO of their delegation', () => {
  const index = buildDelegationJoinIndex([delegation()]);
  const { matched, unmatched } = joinTodoUsageEvents(
    [
      usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1' }),
      usageEvent({ delegationId: 'unknown', attemptId: 'a1', runId: 'r1' }),
      usageEvent({ delegationId: '', attemptId: 'a1', runId: 'r1' }),
    ],
    index,
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].todoId, 'todo-1');
  assert.equal(matched[0].join, 'exact');
  assert.equal(unmatched.length, 2);
});

test('archived attempts use their historical leaf and mismatched identities never fall back', () => {
  const index = buildDelegationJoinIndex([delegation({ leafId: 'current', attempts: [{ attemptId: 'old-a', runId: 'old-r', leafId: 'archived' }] })]);
  const result = joinTodoUsageEvents([
    usageEvent({ delegationId: 'd1', attemptId: 'old-a', runId: 'old-r' }),
    usageEvent({ delegationId: 'd1', attemptId: 'wrong-a', runId: 'wrong-r' }),
  ], index);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].todoId, 'archived');
  assert.equal(result.unmatched.length, 1);
});

test('a retry of the same delegation does not double the numbers', () => {
  // One delegation, two attempts (the first archived). Each attempt is a
  // distinct run, and a repeated delivery of one logical event is dropped.
  const delegations = [
    delegation({
      attemptId: 'a2',
      runId: 'r2',
      attempts: [{ attemptId: 'a1', runId: 'r1', startedAt: '', finishedAt: '' }],
    }),
  ];
  const index = buildDelegationJoinIndex(delegations);
  assert.equal(index.byKey.size, 2, 'one entry per attempt, never per retry record');

  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', logicalEventKey: 'k1' }),
    // Same logical event delivered again (snapshot re-flush).
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', logicalEventKey: 'k1' }),
    usageEvent({ delegationId: 'd1', attemptId: 'a2', runId: 'r2', logicalEventKey: 'k2' }),
  ];
  const { matched, duplicates } = joinTodoUsageEvents(events, index);
  assert.equal(duplicates, 1);
  assert.equal(matched.length, 2);

  const stats = aggregateTodoUsageRows(matched, []);
  assert.equal(stats.attempts, 2, 'two distinct attempts');
  assert.equal(stats.delegations, 1, 'one delegation');
  assert.equal(stats.events, 2, 'the repeated delivery is not counted');
  assert.equal(stats.usd, 1, 'two priced events, not three');
});

test('a duplicated attempt row on one delegation is collapsed', () => {
  const delegations = [
    delegation({
      attempts: [{ attemptId: 'a1', runId: 'r1' }],
      // The archived attempt equals the live one (a replayed status write).
      ...{},
    }),
  ];
  delegations[0].attempts = [
    { attemptId: 'a1', runId: 'r1' },
    { attemptId: 'a1', runId: 'r1' },
  ];
  const index = buildDelegationJoinIndex(delegations);
  assert.equal(index.byKey.size, 1);
  const { matched } = joinTodoUsageEvents(
    [usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1' })],
    index,
  );
  assert.equal(aggregateTodoUsageRows(matched, []).attempts, 1);
});

test('a tree roll-up never duplicates a delegation between parent and child', () => {
  const items = [todo('root'), todo('child', 'root')];
  const delegations = [
    delegation({ id: 'd1', leafId: 'root', attemptId: 'a1', runId: 'r1' }),
    delegation({ id: 'd2', leafId: 'child', attemptId: 'a2', runId: 'r2' }),
  ];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 1 }),
    usageEvent({ delegationId: 'd2', attemptId: 'a2', runId: 'r2', usd: 2 }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const root = buildTodoUsageStats(model, items, 'root');
  const child = buildTodoUsageStats(model, items, 'child');

  assert.equal(root.own.usd, 1);
  assert.equal(root.consolidated.usd, 2);
  assert.equal(child.own.usd, 2);
  assert.equal(child.consolidated.usd, null);
  assert.equal(root.own.events + root.consolidated.events, 2);
  assert.equal(root.mixed, true);

  const report = buildWorkspaceTodoUsage({ items, delegations, events });
  // The workspace roll-up counts every event once, never the sum of the
  // overlapping `consolidated` columns (1 + 2 + 2 would be 5).
  assert.equal(report.workspace.usd, 3);
  assert.equal(report.workspace.attempts, 2);
  assert.equal(report.workspace.events, 2);
});

test('own and consolidated are reported separately and are not pre-added', () => {
  const items = [todo('root'), todo('child', 'root')];
  const delegations = [
    delegation({ id: 'd1', leafId: 'root', attemptId: 'a1', runId: 'r1' }),
    delegation({ id: 'd2', leafId: 'child', attemptId: 'a2', runId: 'r2' }),
  ];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 1 }),
    usageEvent({ delegationId: 'd2', attemptId: 'a2', runId: 'r2', usd: 2 }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.ok(stats.own);
  assert.ok(stats.consolidated);
  assert.equal(stats.usd, undefined, 'there is no combined total on purpose');
  assert.equal(stats.totalUsd, undefined);
  assert.equal(stats.mixed, true);

  const ownOnly = buildTodoUsageStats(model, items, 'root', { scope: 'own' });
  assert.equal(ownOnly.consolidated, undefined);
  assert.equal(ownOnly.own.usd, 1);
});

test('ledger accountingScope is own or consolidated and is never summed', () => {
  const rows = [
    { event: usageEvent({ accountingScope: 'own', usd: 1 }), joinKey: 'a', delegationId: 'd1' },
    { event: usageEvent({ accountingScope: 'consolidated', usd: 5 }), joinKey: 'b', delegationId: 'd2' },
  ];
  const ownDefault = aggregateTodoUsageRows(rows);
  assert.equal(ownDefault.usd, 1, 'the default scope is own only');
  assert.equal(ownDefault.events, 1);
  assert.equal(ownDefault.summary.totalUsd, 1);
  // Both subtotals are reported side by side and must never be added.
  assert.equal(ownDefault.accountingScopes.own.totalUsd, 1);
  assert.equal(ownDefault.accountingScopes.consolidated.usdByScope.consolidated, 5);

  const consolidated = aggregateTodoUsageRows(rows, [], { accountingScope: 'consolidated' });
  assert.equal(consolidated.usd, 5);
  assert.equal(consolidated.events, 1);

  // `both` is not a scope: summing own + consolidated would double count.
  const both = resolveTodoUsageQuery({ accountingScope: 'both' });
  assert.equal(both.ok, false);
  assert.equal(both.code, 'VALIDATION');
});

test('missing data is null with coverage and is never zero', () => {
  const items = [todo('root')];
  const model = buildTodoUsageModel({ items, delegations: [], events: [] });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.usd, null);
  assert.equal(stats.own.tokens, null);
  assert.equal(stats.own.billedTokens, null);
  assert.equal(stats.own.attemptsDurationMs, null);
  assert.equal(stats.own.elapsedMs, null);
  assert.equal(stats.own.coverage.state, 'no_data');
  assert.equal(stats.own.coverage.costCoverage, 'none');
  assert.equal(stats.own.coverage.costSource, 'none');
  assert.ok(stats.own.coverage.notes.includes('no_usage_events'));
  assert.equal(stats.own.attempts, 0, 'the attempt count is known and stays 0');
});

test('a measured zero is 0, not null', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 0 })];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.usd, 0);
  assert.notEqual(stats.own.usd, null);
  assert.deepEqual(stats.own.tokens, {
    textInput: 100,
    textOutput: 10,
    cachedInput: 0,
    cacheWrite: 0,
    reasoning: 0,
    audioInput: 0,
    audioOutput: 0,
  });
  assert.equal(stats.own.coverage.state, 'complete');
  assert.equal(stats.own.coverage.costCoverage, 'complete');
  assert.equal(stats.own.coverage.pricedEvents, 1);
});

test('cost comes from the ledger only and unpriced history is flagged', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    // Legacy event written before pricing: tokens present, no usd.
    usageEvent({
      delegationId: 'd1',
      attemptId: 'a1',
      runId: 'r1',
      usd: null,
      tokens: { textInput: 1000, textOutput: 100 },
    }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.usd, null, 'no cost is invented from the rate table');
  assert.equal(stats.own.coverage.unpricedEvents, 1);
  assert.equal(stats.own.coverage.costCoverage, 'none');
  assert.equal(stats.own.coverage.state, 'partial');
  assert.ok(stats.own.coverage.notes.includes('cost_missing_for_1_events'));
  assert.ok(
    stats.own.coverage.notes.includes('cost_is_not_recomputed_from_the_rate_table'),
  );
  // Tokens are still a real measurement.
  assert.equal(stats.own.tokens.textInput, 1000);
});

test('subscription usage is not reported as zero cost', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    usageEvent({
      delegationId: 'd1',
      attemptId: 'a1',
      runId: 'r1',
      usd: null,
      billingMode: 'subscription',
    }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.usd, null);
  assert.equal(stats.own.coverage.subscriptionEvents, 1);
  assert.ok(stats.own.coverage.notes.includes('subscription_usage_is_not_zero_cost'));
});

test('estimated and reported USD are kept apart', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 1, estimated: true }),
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 2, reportedUsd: 2, logicalEventKey: 'estimated-reported-second' }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.usd, 2);
  assert.equal(stats.own.estimatedUsd, 1);
  assert.equal(stats.own.reportedUsd, 2);
  assert.equal(stats.own.coverage.estimatedEvents, 1);
  assert.equal(stats.own.coverage.reportedUsdEvents, 1);
});

test('estimated-only usage leaves usd null and keeps estimatedUsd', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 1, estimated: true })];
  const stats = buildTodoUsageStats(buildTodoUsageModel({ items, delegations, events }), items, 'root');
  assert.equal(stats.own.usd, null);
  assert.equal(stats.own.estimatedUsd, 1);
  assert.equal(stats.own.coverage.costCoverage, 'none');
  assert.equal(stats.own.coverage.costSource, 'none');
});

test('no estimated cost keeps estimatedUsd null', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', usd: 2 })];
  const stats = buildTodoUsageStats(buildTodoUsageModel({ items, delegations, events }), items, 'root');
  assert.equal(stats.own.usd, 2);
  assert.equal(stats.own.estimatedUsd, null);
});

test('model filter scopes tokens, cost and coverage to the same events', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', model: 'm1', usd: 1, reportedUsd: 1 }),
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', model: 'm2', usd: 4, reportedUsd: 4, logicalEventKey: 'k2' }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root', { model: 'm1' });
  assert.equal(stats.own.usd, 1);
  assert.equal(stats.own.reportedUsd, 1);
  assert.equal(stats.own.tokens.textInput, 100);
  assert.equal(stats.own.coverage.events, 1);
});

test('ledger diagnostics and expected attempts reach coverage', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1' })];
  const model = buildTodoUsageModel({ items, delegations, events });
  const ok = buildTodoUsageStats(model, items, 'root', { diagnostics: { corrupt: 0, retainedOut: 0 } });
  assert.equal(ok.own.coverage.ledger.corrupt, 0);
  assert.equal(ok.own.coverage.contractual.missing, 0);
  assert.equal(ok.own.coverage.contractual.complete, true);
  const dirty = buildTodoUsageStats(model, items, 'root', { diagnostics: { corrupt: 2, retainedOut: 0 } });
  assert.equal(dirty.own.coverage.contractual.complete, false);
  const noDiag = buildTodoUsageStats(model, items, 'root');
  assert.equal(noDiag.own.coverage.contractual.complete, false, 'unproven without ledger diagnostics');
  const missing = buildTodoUsageStats(
    buildTodoUsageModel({ items, delegations, events: [] }), items, 'root', { diagnostics: { corrupt: 0, retainedOut: 0 } });
  assert.equal(missing.own.coverage.contractual.missing, 1);
  const report = buildWorkspaceTodoUsage({ items, delegations, events, diagnostics: { corrupt: 0, retainedOut: 0 } });
  assert.equal(report.workspace.coverage.ledger.corrupt, 0);
  assert.equal(report.workspace.coverage.contractual.complete, true);
});

test('run events carry no tokens and no cost', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    usageEvent({
      delegationId: 'd1',
      attemptId: 'a1',
      runId: 'r1',
      eventType: 'run',
      outcome: 'ok',
      latencyMs: 1200,
      tokens: undefined,
      usd: null,
    }),
  ];
  const model = buildTodoUsageModel({ items, delegations, events });
  const stats = buildTodoUsageStats(model, items, 'root');
  assert.equal(stats.own.events, 1);
  assert.equal(stats.own.runEvents, 1);
  assert.equal(stats.own.measurementEvents, 0);
  assert.equal(stats.own.coverage.unpricedEvents, 0, 'a run event is not an unpriced measurement');
  assert.equal(stats.own.usd, null);
  assert.equal(stats.own.summary.runs, 1);
});

test('elapsed time is separate from the sum of attempt durations', () => {
  const attempts = [
    { queuedAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', finishedAt: '2026-09-01T10:02:00.000Z' },
    { queuedAt: '2026-09-01T10:01:00.000Z', startedAt: '2026-09-01T10:01:00.000Z', finishedAt: '2026-09-01T10:03:00.000Z' },
  ];
  assert.equal(sumAttemptDurationsMs(attempts), 4 * 60_000, 'sum of the two attempt durations');
  assert.equal(todoElapsedMs(attempts), 3 * 60_000, 'wall-clock span, not the sum');
  assert.equal(sumAttemptDurationsMs([]), null);
  assert.equal(todoElapsedMs([{ startedAt: '2026-09-01T10:00:00.000Z' }]), null, 'open span is null');
  assert.equal(todoElapsedMs([{ startedAt: '2026-09-01T10:00:00.000Z', finishedAt: '2026-09-01T10:01:00.000Z' }, { startedAt: '2026-09-01T10:02:00.000Z' }]), null, 'any open attempt makes the total span unknown');
});

test('workspace view paginates with an opaque cursor', () => {
  const items = [];
  const delegations = [];
  const events = [];
  for (let i = 0; i < 5; i += 1) {
    const id = `t${i}`;
    items.push(todo(id, '', { updatedAt: `2026-09-0${i + 1}T00:00:00.000Z` }));
    delegations.push(delegation({ id: `d${i}`, leafId: id, attemptId: `a${i}`, runId: `r${i}` }));
    events.push(usageEvent({ delegationId: `d${i}`, attemptId: `a${i}`, runId: `r${i}`, usd: 1 }));
  }
  const first = buildWorkspaceTodoUsage({ items, delegations, events, limit: 2, offset: 0 });
  assert.equal(first.returned, 2);
  assert.equal(first.total, 5);
  assert.ok(first.nextCursor);
  const next = decodeTodoUsageCursor(first.nextCursor);
  assert.equal(next.ok, true);
  assert.equal(next.offset, 2);
  const second = buildWorkspaceTodoUsage({ items, delegations, events, limit: 2, offset: next.offset });
  assert.equal(second.returned, 2);
  const seen = [...first.todos, ...second.todos].map((row) => row.todoId);
  assert.equal(new Set(seen).size, 4, 'no row repeats across pages');
  const third = buildWorkspaceTodoUsage({ items, delegations, events, limit: 2, offset: 4 });
  assert.equal(third.returned, 1);
  assert.equal(third.nextCursor, null);
});

test('workspace view filters by status, root subtree and include', () => {
  const items = [
    todo('root'),
    todo('child', 'root'),
    todo('other', '', { status: 'done' }),
  ];
  const delegations = [
    delegation({ id: 'd1', leafId: 'root', attemptId: 'a1', runId: 'r1' }),
    delegation({ id: 'd2', leafId: 'child', attemptId: 'a2', runId: 'r2' }),
    delegation({ id: 'd3', leafId: 'other', attemptId: 'a3', runId: 'r3' }),
  ];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1' }),
    usageEvent({ delegationId: 'd2', attemptId: 'a2', runId: 'r2' }),
  ];
  const byStatus = buildWorkspaceTodoUsage({ items, delegations, events, status: ['done'] });
  assert.deepEqual(byStatus.todos.map((row) => row.todoId), ['other']);

  const byRoot = buildWorkspaceTodoUsage({ items, delegations, events, root: 'root' });
  assert.deepEqual(byRoot.todos.map((row) => row.todoId).sort(), ['child', 'root']);

  const withUsage = buildWorkspaceTodoUsage({ items, delegations, events, include: 'usage' });
  assert.deepEqual(withUsage.todos.map((row) => row.todoId).sort(), ['child', 'root']);
  assert.equal(withUsage.workspace.usd, 1, 'the roll-up ignores the include filter');

  const noUsage = buildWorkspaceTodoUsage({ items, delegations, events: [], include: 'usage' });
  assert.equal(noUsage.total, 0);
});

test('workspace filters constrain roll-up and cursor binds filters and revisions', () => {
  const items = [todo('a'), todo('b', '', { status: 'ready' }), todo('c', '', { status: 'done' })];
  const delegations = [delegation({ id: 'da', leafId: 'a' }), delegation({ id: 'db', leafId: 'b' }), delegation({ id: 'dc', leafId: 'c' })];
  const events = [usageEvent({ delegationId: 'da', attemptId: 'a1', runId: 'r1', model: 'm1', usd: 1 }), usageEvent({ delegationId: 'db', attemptId: 'a1', runId: 'r1', model: 'm1', usd: 3 }), usageEvent({ delegationId: 'dc', attemptId: 'a1', runId: 'r1', model: 'm2', usd: 2 })];
  const first = buildWorkspaceTodoUsage({ items, delegations, events, status: ['ready'], model: 'm1', limit: 0 });
  assert.equal(first.workspace.events, 2);
  assert.equal(first.workspace.usd, 4);
  assert.equal(first.appliedFilters.model, 'm1');
  const paged = buildWorkspaceTodoUsage({ items, delegations, events, status: ['ready'], model: 'm1', limit: 1 });
  const staleFilter = decodeTodoUsageCursor(paged.nextCursor, { f: 'different', r: 'different' });
  assert.equal(staleFilter.ok, false);
  assert.throws(() => buildWorkspaceTodoUsage({ items: [...items, todo('c')], delegations, events, status: ['ready'], model: 'm1', limit: 1, cursor: paged.nextCursor }), { code: 'CONFLICT' });
});

test('workspace roll-up counts unattributed and duplicate events in coverage', () => {
  const items = [todo('root')];
  const delegations = [delegation({ leafId: 'root' })];
  const events = [
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', logicalEventKey: 'k1' }),
    usageEvent({ delegationId: 'd1', attemptId: 'a1', runId: 'r1', logicalEventKey: 'k1' }),
    usageEvent({ delegationId: '', attemptId: '', runId: '', workspaceFile: '/ws' }),
    usageEvent({ delegationId: '', attemptId: '', runId: '' }),
  ];
  const report = buildWorkspaceTodoUsage({ items, delegations, events, cwd: '/ws' });
  assert.equal(report.unattributed.events, 1);
  assert.equal(report.unattributed.unscopedEvents, 1, 'keyless events are a separate bucket');
  assert.equal(report.diagnostics.unscopedEvents, 1);
  assert.equal(report.unattributed.duplicateEvents, 1);
  assert.equal(report.workspace.events, 1);
});

test('the default window is 30 days and is capped at 92 days', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const fallback = resolveTodoUsageQuery({}, { now });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.window.range, '30d');
  assert.equal(fallback.window.days, 30);
  assert.equal(fallback.limit, 50);

  const tooWide = resolveTodoUsageQuery(
    { from: '2026-01-01', to: '2026-09-30' },
    { now },
  );
  assert.equal(tooWide.ok, false);
  assert.equal(tooWide.code, 'VALIDATION');
  assert.match(tooWide.error, /92 days/);

  const explicit = resolveTodoUsageQuery({ from: '2026-09-01', to: '2026-09-30' }, { now });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.window.from, '2026-09-01T00:00:00.000Z');
  assert.equal(explicit.window.to, '2026-10-01T00:00:00.000Z', 'a date-only to is exclusive');
  assert.equal(explicit.window.from, '2026-09-01T00:00:00.000Z');
});

test('limit and cursor are validated', () => {
  assert.equal(resolveTodoUsageLimit(undefined).limit, 50);
  assert.equal(resolveTodoUsageLimit('200').limit, 200);
  assert.equal(resolveTodoUsageLimit('201').ok, false);
  assert.equal(resolveTodoUsageLimit('0').ok, false);
  assert.equal(resolveTodoUsageLimit('1.5').ok, false);
  assert.equal(resolveTodoUsageLimit('abc').ok, false);
  assert.equal(TODO_USAGE_MAX_LIMIT, 200);

  assert.deepEqual(decodeTodoUsageCursor(''), { ok: true, offset: 0 });
  assert.equal(decodeTodoUsageCursor(encodeTodoUsageCursor(7)).offset, 7);
  assert.equal(decodeTodoUsageCursor('not-a-cursor').ok, false);
  assert.equal(decodeTodoUsageCursor(encodeTodoUsageCursor(-1)).ok, false);

  const badCursor = resolveTodoUsageQuery({ cursor: 'zzz' });
  assert.equal(badCursor.ok, false);
  assert.equal(badCursor.code, 'VALIDATION');
  const badLimit = resolveTodoUsageQuery({ limit: '999' });
  assert.equal(badLimit.ok, false);
  const badScope = resolveTodoUsageQuery({ scope: 'nope' });
  assert.equal(badScope.ok, false);
});

test('an unknown TODO id has no usage row', () => {
  const items = [todo('root')];
  const model = buildTodoUsageModel({ items, delegations: [], events: [] });
  assert.equal(buildTodoUsageStats(model, items, 'missing'), null);
});
