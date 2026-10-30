import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { addTodo, getTodoById } from '../lib/persist/todos-legacy-adapter.js';
import {
  getWorkspaceWatcher,
  nextLastBlocked,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { startWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import { decideWorkspaceWatcherAction } from '../lib/workspace-watcher.js';
import {
  parseWorkspaceWatcherPreflightTargets,
  runWorkspaceWatcherPreflight,
} from '../lib/workspace-watcher-preflight.js';
import { createTempRepo, tempDir } from './helpers/temp-git-repo.js';

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const body = (line) => `## Goal\nx\n\n## Acceptance\n- ${line}\n\n## Notes\nok\n`;

test('marker grammar: section scoped, max 3, prose ignored', () => {
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets(body('Requires: http://127.0.0.1:3011')), ['http://127.0.0.1:3011']);
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets('## Akceptacja\n* wymaga: http://localhost:1/x\n'), ['http://localhost:1/x']);
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets('## Goal\nRequires: http://localhost:1\n'), []);
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets('## Acceptance\nrun curl http://localhost:1 here\n'), []);
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets('## Acceptance\nRequires: http://a.test\n## Other\nRequires: http://b.test\n'), ['http://a.test']);
  const many = '## Acceptance\n' + [1, 2, 3, 4, 5].map((n) => `Requires: http://h${n}.test`).join('\n');
  assert.equal(parseWorkspaceWatcherPreflightTargets(many).length, 3);
  assert.deepEqual(parseWorkspaceWatcherPreflightTargets(''), []);
});

test('probe: any HTTP response is reachable, errors unreachable, non-http and public only warn', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes(':1/')) throw new Error('ECONNREFUSED');
    return { status: url.includes('404') ? 404 : 302, body: null };
  };
  const text = '## Acceptance\nRequires: http://127.0.0.1:1/\nRequires: https://example.org/\nRequires: npm-start\n';
  const result = await runWorkspaceWatcherPreflight(text, { fetchImpl });
  assert.deepEqual(result.unreachable, ['http://127.0.0.1:1/']);
  assert.equal(result.warnings.length, 2);
  assert.equal(calls.length, 1, 'public and non-http targets are never fetched');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.method, 'GET');
  const redirected = await runWorkspaceWatcherPreflight('## Acceptance\nRequires: http://127.0.0.1:2/404\n', { fetchImpl });
  assert.deepEqual(redirected.unreachable, []);
  const none = await runWorkspaceWatcherPreflight('plain body', { fetchImpl });
  assert.deepEqual(none, { unreachable: [], warnings: [], probed: [] });
});

/** Start one cycle against a ready todo whose body carries `line`. */
async function startWith(t, line, preflightFetch) {
  const dataDir = tempDir('cretli-preflight-data-');
  const repo = createTempRepo().dir;
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  const todo = addTodo(dataDir, repo, { title: 'needs server', status: 'ready', body: line }).item;
  upsertWorkspaceWatcher(repo, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, executionMode: 'project' },
  }, { dataDir });
  let chatCreated = false;
  const deps = {
    addChat: (_s, title, _w, _f, _m, extras) => { chatCreated = true; return { id: extras.id, title }; },
    startChatRun: async () => ({ runId: 'r', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    notify: () => false,
    preflightFetch,
  };
  const tick = {
    watcher: getWorkspaceWatcher(repo, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, repo, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: repo, dataDir, now: T0, tick, token: 'lease', deps });
  return { started, row: getWorkspaceWatcher(repo, { dataDir }), todo, dataDir, repo, chatCreated: () => chatCreated };
}

test('unreachable marked local URL blocks, backs off and is not re-picked', async (t) => {
  const r = await startWith(t, body('Requires: http://127.0.0.1:1'), async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(r.started, { started: false, reason: 'preflight_env_infra' });
  assert.equal(r.chatCreated(), false);
  assert.equal(r.row.activeCycles.length, 0);
  assert.deepEqual(r.row.failures, {});
  assert.deepEqual(r.row.blockedReasonStreak, {});
  assert.equal(r.row.blockedBackoff[r.todo.id].count, 1);
  assert.equal(r.row.lastBlocked.reasonCode, 'env_infra');
  assert.equal(r.row.lastBlocked.count, 1);
  assert.ok(r.row.decisions.some((d) => d.kind === 'preflight_env_infra'));
  assert.equal(getTodoById(r.dataDir, r.repo, r.todo.id).status, 'ready');
  const leaf = { id: r.todo.id, status: 'ready', updatedAt: 'x' };
  const next = decideWorkspaceWatcherAction({
    watcher: { ...r.row, mode: 'autopilot', enabled: true },
    snapshot: { readyTodoCount: 1, readyLeaves: [leaf], items: [leaf], activeAgentCount: 0, errors: [] },
    now: T0 + 1000,
  });
  assert.equal(next.kind, 'idle_no_work');
  assert.equal(next.reason, 'blocked_backoff');
});

test('reachable (also 404) passes the preflight; non-http and public hosts only warn', async (t) => {
  for (const [line, fetchImpl] of [
    ['Requires: http://127.0.0.1:2/missing', async () => ({ status: 404, body: null })],
    ['Requires: npm-run-dev', async () => { throw new Error('must not fetch'); }],
    ['Requires: https://example.org/', async () => { throw new Error('must not fetch'); }],
    ['run http://127.0.0.1:1 manually', async () => { throw new Error('must not fetch'); }],
  ]) {
    const r = await startWith(t, body(line), fetchImpl);
    assert.notEqual(r.started.reason, 'preflight_env_infra', line);
    assert.equal(r.row.lastBlocked, null, line);
  }
});

test('lastBlocked counter increments on repeat, resets on a different cause or success', () => {
  const a = nextLastBlocked(null, { todoId: 't1', reasonCode: 'env_infra', at: 'a' });
  const b = nextLastBlocked(a, { todoId: 't1', reasonCode: 'env_infra', at: 'b' });
  assert.equal(b.count, 2);
  assert.equal(nextLastBlocked(b, { todoId: 't1', reasonCode: 'needs_human', at: 'c' }).count, 1);
  assert.equal(nextLastBlocked(b, { todoId: 't2', reasonCode: 'env_infra', at: 'c' }).count, 1);
  assert.equal(nextLastBlocked(b, { todoId: 't1', at: 'c' }).reasonCode, 'unspecified');

  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', mode: 'autopilot', lastBlocked: b, policy: {} });
  assert.equal(row.lastBlocked.count, 2);
  const cycle = { cycleId: 'c1', todoIds: ['t1'] };
  const blocked = buildWorkspaceWatcherCycleClosePatch({ row, cycle, outcome: 'blocked', now: T0 });
  assert.equal(blocked.lastBlocked.count, 1, 'unspecified differs from env_infra');
  assert.equal(blocked.lastBlocked.reasonCode, 'unspecified');
  const stored = normalizeWorkspaceWatcherRow({ ...row, ...blocked });
  const again = buildWorkspaceWatcherCycleClosePatch({ row: stored, cycle, outcome: 'blocked', now: T0 });
  assert.equal(again.lastBlocked.count, 2);
  const ok = buildWorkspaceWatcherCycleClosePatch({ row: stored, cycle, outcome: 'success', now: T0 });
  assert.equal(ok.lastBlocked, null);
});

test('infra-failure and interrupted closes clear a stale lastBlocked of the same todo only', () => {
  const stale = { todoId: 't1', reasonCode: 'env_infra', count: 2, at: 'a' };
  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', mode: 'autopilot', lastBlocked: stale, policy: {} });
  const close = (todoId, outcome, decisionReason) => buildWorkspaceWatcherCycleClosePatch({
    row, cycle: { cycleId: 'c1', todoIds: [todoId] }, outcome, decisionReason, now: T0,
  });
  const infra = close('t1', 'failure', 'mcp_not_ready');
  assert.equal(infra.failures, undefined, 'failure accounting stays skipped');
  assert.equal(infra.lastBlocked, null);
  assert.equal(close('t1', 'interrupted').lastBlocked, null);
  assert.equal(close('t2', 'failure', 'mcp_not_ready').lastBlocked, undefined, 'a different todo keeps it');
  assert.equal(close('t2', 'interrupted').lastBlocked, undefined);
});
