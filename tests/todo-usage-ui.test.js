import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  buildTodoUsageQuery,
  collectUsageModels,
  formatTodoUsageCost,
  formatTodoUsageDuration,
  formatTodoUsageTokens,
  normalizeModelRoleRows,
  normalizeTodoUsage,
  normalizeWorkspaceUsage,
  resolveUsageViewState,
  TODO_USAGE_NO_DATA,
} from '../app_front/features/todo/todoUsageView.js';
import { createTodoUsageController } from '../app_front/features/todo/todoUsageController.js';

const aggregate = (over = {}) => ({
  attempts: 2, delegations: 1, events: 2, usd: 0.5, estimatedUsd: null, reportedUsd: null,
  billedTokens: 1200, attemptsDurationMs: 90000, elapsedMs: 60000,
  coverage: { state: 'complete', costCoverage: 'complete', unpricedEvents: 0, ledger: { corrupt: 0, retainedOut: 0 }, contractual: { missing: 0, complete: true }, notes: [] },
  byModelRole: {},
  ...over,
});

test('null is rendered as "no data", a measured zero as 0', () => {
  assert.equal(formatTodoUsageCost(null, null).text, TODO_USAGE_NO_DATA);
  assert.equal(formatTodoUsageCost(null, null).missing, true);
  const zero = formatTodoUsageCost(0, null);
  assert.equal(zero.missing, false);
  assert.notEqual(zero.text, TODO_USAGE_NO_DATA);
  assert.equal(formatTodoUsageTokens(null).missing, true);
  assert.equal(formatTodoUsageTokens(0).text, '0');
  assert.equal(formatTodoUsageDuration(null).missing, true);
  assert.equal(formatTodoUsageDuration(0).text, '0 ms');
  assert.equal(formatTodoUsageDuration(183000).text, '3 min 3 s');
});

test('estimate-only cost is marked as an estimate, never as measured', () => {
  const cost = formatTodoUsageCost(null, 0.12);
  assert.equal(cost.estimated, true);
  assert.ok(cost.text.startsWith('~'));
});

test('query builder is workspace scoped by filters and drops invalid values', () => {
  const q = new URLSearchParams(buildTodoUsageQuery(
    { range: 'bogus', status: ['done', 'nope', 'done'], model: 'm1', onlyWithUsage: true },
    { workspace: true, cursor: 'abc' },
  ));
  assert.equal(q.get('range'), '30d');
  assert.equal(q.get('status'), 'done');
  assert.equal(q.get('model'), 'm1');
  assert.equal(q.get('include'), 'usage');
  assert.equal(q.get('cursor'), 'abc');
  const single = new URLSearchParams(buildTodoUsageQuery({ range: '7d', status: ['done'] }));
  assert.equal(single.get('status'), null);
  assert.equal(single.get('range'), '7d');
});

test('model x role rows keep unpriced groups at null instead of 0', () => {
  const rows = normalizeModelRoleRows({
    'a|implement': { model: 'a', role: 'implement', totalUsd: 0, estimatedUsd: 0, unpricedEvents: 2, eventsByScope: { own: 2, consolidated: 0 }, tokensByScope: { own: { textInput: 10 } } },
    'b|review': { model: 'b', role: 'review', totalUsd: 0, estimatedUsd: 0, unpricedEvents: 0, eventsByScope: { own: 1, consolidated: 0 }, tokensByScope: { own: { textInput: 5 } } },
    'c|plan': { model: 'c', role: 'plan', totalUsd: 0, estimatedUsd: 0.3, unpricedEvents: 0, eventsByScope: { own: 1, consolidated: 0 }, tokensByScope: { own: {} } },
  });
  const byModel = Object.fromEntries(rows.map((row) => [row.model, row]));
  assert.equal(byModel.a.usd, null);
  assert.equal(byModel.b.usd, 0);
  assert.equal(byModel.c.usd, null);
  assert.equal(byModel.c.estimatedUsd, 0.3);
  assert.equal(byModel.a.tokens, 10);
});

test('view state: loading, unavailable, error, empty, partial, ready', () => {
  const ready = normalizeWorkspaceUsage({ workspace: aggregate(), todos: [] }).summary;
  const partial = normalizeWorkspaceUsage({ workspace: aggregate({ coverage: { state: 'partial', unpricedEvents: 1, contractual: { complete: false } } }) }).summary;
  const empty = normalizeWorkspaceUsage({ workspace: aggregate({ attempts: 0, events: 0, usd: null, billedTokens: null }) }).summary;
  assert.equal(resolveUsageViewState({ loading: true }), 'loading');
  assert.equal(resolveUsageViewState({ error: { status: 503, code: 'USAGE_UNAVAILABLE' } }), 'unavailable');
  assert.equal(resolveUsageViewState({ error: { status: 500 } }), 'error');
  assert.equal(resolveUsageViewState({ aggregates: [empty] }), 'empty');
  assert.equal(resolveUsageViewState({ aggregates: [partial] }), 'partial');
  assert.equal(resolveUsageViewState({ aggregates: [ready] }), 'ready');
  // Attempts without any usage event are partial data, not "empty".
  const noEvents = normalizeWorkspaceUsage({ workspace: aggregate({ events: 0, usd: null, billedTokens: null }) }).summary;
  assert.equal(resolveUsageViewState({ aggregates: [noEvents] }), 'partial');
});

test('single TODO keeps own and consolidated apart (no combined total)', () => {
  const view = normalizeTodoUsage({ usage: { own: aggregate({ usd: 1 }), consolidated: aggregate({ usd: 2 }), descendantCount: 3, mixed: true } });
  assert.equal(view.own.usd, 1);
  assert.equal(view.consolidated.usd, 2);
  assert.equal('total' in view, false);
  assert.equal(view.descendantCount, 3);
});

test('collectUsageModels lists distinct known models', () => {
  const workspace = normalizeWorkspaceUsage({ workspace: aggregate({ byModelRole: {
    'z|a': { model: 'z', role: 'a', eventsByScope: { own: 1 }, tokensByScope: { own: {} } },
    'a|a': { model: 'a', role: 'a', eventsByScope: { own: 1 }, tokensByScope: { own: {} } },
    'unknown|a': { model: 'unknown', role: 'a', eventsByScope: { own: 1 }, tokensByScope: { own: {} } },
  } }) });
  assert.deepEqual(collectUsageModels(workspace), ['a', 'z']);
});

test('controller drops a stale response and aborts the superseded request', async () => {
  const resolvers = [];
  const signals = [];
  const fetcher = (path, query, signal) => new Promise((resolve) => {
    signals.push(signal);
    resolvers.push((todos) => resolve({ status: 200, body: { ok: true, todos, workspace: aggregate(), total: todos.length } }));
  });
  const states = [];
  const controller = createTodoUsageController({ fetcher, onChange: (s) => states.push(s) });
  const first = controller.load({ filters: { range: '7d' } });
  const second = controller.load({ filters: { range: '30d' } });
  assert.equal(signals[0].aborted, true);
  // The newer request answers first; the older (stale) answer arrives later.
  resolvers[1]([{ todoId: 'new', title: 'new' }]);
  await second;
  resolvers[0]([{ todoId: 'old', title: 'old' }]);
  await first;
  assert.equal(controller.getState().data.todos[0].todoId, 'new');
  assert.equal(controller.getState().loading, false);
});

test('controller maps 503 and network failures to error state and ignores aborts', async () => {
  const unavailable = createTodoUsageController({
    fetcher: async () => ({ status: 503, body: { ok: false, code: 'USAGE_UNAVAILABLE', error: 'x' } }),
  });
  await unavailable.load({ filters: {} });
  assert.equal(resolveUsageViewState({ error: unavailable.getState().error }), 'unavailable');
  const broken = createTodoUsageController({ fetcher: async () => { throw new Error('boom'); } });
  await broken.load({ filters: {} });
  assert.equal(resolveUsageViewState({ error: broken.getState().error }), 'error');
});

test('controller appends pages and keeps one summary', async () => {
  let call = 0;
  const controller = createTodoUsageController({
    fetcher: async (path, query) => {
      call += 1;
      const cursor = new URLSearchParams(query).get('cursor');
      return { status: 200, body: { ok: true, total: 2, workspace: aggregate(), todos: [{ todoId: cursor ? 'b' : 'a' }], nextCursor: cursor ? null : 'c1' } };
    },
  });
  await controller.load({ filters: {} });
  await controller.loadMore({ filters: {} });
  assert.equal(call, 2);
  assert.deepEqual(controller.getState().data.todos.map((row) => row.todoId), ['a', 'b']);
});

test('i18n has PL and EN for every key the usage section uses', async () => {
  const source = fs.readFileSync(new URL('../app_front/features/todo/crTodoUsage.js', import.meta.url), 'utf8');
  const cardSource = fs.readFileSync(new URL('../app_front/components/ui/cr-todo-card.js', import.meta.url), 'utf8');
  const panelSource = fs.readFileSync(new URL('../app_front/todoPanel.js', import.meta.url), 'utf8');
  const keys = new Set();
  for (const text of [source, cardSource, panelSource]) {
    for (const m of text.matchAll(/'todo\.((?:usage|tabUsage)[A-Za-z0-9]*)'/g)) keys.add(m[1]);
  }
  for (const m of source.matchAll(/'(todo\.usage[A-Za-z0-9]+)'/g)) keys.add(m[1].replace('todo.', ''));
  const { en } = await import('../app_front/i18n/en.js');
  const { pl } = await import('../app_front/i18n/pl.js');
  assert.ok(keys.size > 20);
  for (const key of keys) {
    assert.ok(en.todo[key], `en missing todo.${key}`);
    assert.ok(pl.todo[key], `pl missing todo.${key}`);
  }
});

test('usage styles use tokens only and have a mobile layout', () => {
  const block = fs.readFileSync(new URL('../app_front/css/features/todo/_todo-usage.scss', import.meta.url), 'utf8');
  assert.match(block, /TODO usage statistics/);
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(block), false);
  assert.match(block, /@media \(max-width: 768px\)/);
});
