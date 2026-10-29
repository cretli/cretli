import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkspaceWatcherCycleClosePatch,
  evaluateWorkspaceWatcherBlockedReasonStreak,
  normalizeWorkspaceWatcherBlockedReportCode,
  normalizeWorkspaceWatcherBlockedReportDate,
} from '../lib/workspace-watcher-cycle-close.js';
import { normalizeWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';

const now = Date.parse('2026-10-24T00:00:00Z');
const policy = { backoffBaseMs: 60_000, backoffCapMs: 3_600_000 };

test('report codes are validated, not trusted', () => {
  assert.equal(normalizeWorkspaceWatcherBlockedReportCode(' Needs_Human '), 'needs_human');
  assert.equal(normalizeWorkspaceWatcherBlockedReportCode('please_defer'), '');
  assert.equal(normalizeWorkspaceWatcherBlockedReportCode(undefined), '');
});

test('waits_for_date needs a real future date', () => {
  assert.equal(normalizeWorkspaceWatcherBlockedReportDate('2026-11-01', now), '2026-11-01');
  assert.equal(normalizeWorkspaceWatcherBlockedReportDate('2026-10-01', now), '');
  assert.equal(normalizeWorkspaceWatcherBlockedReportDate('2026-02-31', now), '');
  assert.equal(normalizeWorkspaceWatcherBlockedReportDate('next week', now), '');
});

test('streak: state in, decision out', () => {
  const ev = (previous, code, date) => evaluateWorkspaceWatcherBlockedReasonStreak({ previous, outcome: 'blocked', code, date, now });
  assert.deepEqual(ev(null, 'needs_human'), { next: { code: 'needs_human', count: 1 }, escalation: null });
  assert.deepEqual(ev({ code: 'needs_human', count: 1 }, 'needs_human'), { next: null, escalation: { action: 'idea' } });
  assert.deepEqual(ev({ code: 'needs_rescope', count: 1 }, 'needs_rescope'), { next: null, escalation: { action: 'idea' } });
  // A different code restarts the streak.
  assert.deepEqual(ev({ code: 'needs_human', count: 1 }, 'needs_rescope'), { next: { code: 'needs_rescope', count: 1 }, escalation: null });
  assert.deepEqual(ev({ code: 'waits_for_date', count: 1 }, 'waits_for_date', '2026-12-01'), { next: null, escalation: { action: 'defer', until: '2026-12-01' } });
  // Missing/past date, env_infra, unknown code: no streak, no escalation.
  assert.deepEqual(ev({ code: 'waits_for_date', count: 1 }, 'waits_for_date', 'soon'), { next: null, escalation: null });
  assert.deepEqual(ev({ code: 'needs_human', count: 1 }, 'env_infra'), { next: null, escalation: null });
  assert.deepEqual(ev({ code: 'needs_human', count: 1 }, 'bogus'), { next: null, escalation: null });
  assert.deepEqual(evaluateWorkspaceWatcherBlockedReasonStreak({ previous: { code: 'needs_human', count: 1 }, outcome: 'success', code: 'needs_human', now }), { next: null, escalation: null });
});

function close(row, reasonCode, reasonDate, extra = {}) {
  const cycle = { cycleId: 'c1', chatId: 'chat1', reportId: 'r1', todoIds: ['t1'], ...extra };
  const reports = [{ reportId: 'r1', cycleId: 'c1', outcome: 'blocked', reasonCode, reasonDate }];
  const escalations = [];
  const patch = buildWorkspaceWatcherCycleClosePatch({
    row: { policy, activeCycles: [cycle], ...row }, cycle, outcome: 'blocked', reports, now, todoIds: ['t1'],
    onBlockedEscalation: (e) => escalations.push(e),
  });
  return { patch, escalations };
}

test('close patch keeps the streak next to blockedBackoff and escalates on the second block', () => {
  const first = close({}, 'needs_human');
  assert.equal(first.patch.blockedBackoff.t1.count, 1);
  assert.deepEqual(first.patch.blockedReasonStreak.t1, { code: 'needs_human', count: 1 });
  assert.equal(first.escalations.length, 0);
  const second = close({ blockedReasonStreak: first.patch.blockedReasonStreak, blockedBackoff: first.patch.blockedBackoff }, 'needs_human');
  assert.equal(second.escalations.length, 1);
  assert.equal(second.escalations[0].action, 'idea');
  assert.equal(second.patch.blockedReasonStreak.t1, undefined);
});

test('env_infra and unspecified blocks only back off', () => {
  const infra = close({ blockedReasonStreak: { t1: { code: 'needs_human', count: 1 } } }, 'env_infra');
  assert.equal(infra.escalations.length, 0);
  assert.equal(infra.patch.blockedReasonStreak.t1, undefined);
  assert.equal(infra.patch.blockedBackoff.t1.count, 1);
  assert.equal(close({}, undefined).patch.blockedReasonStreak.t1, undefined);
});

test('plan-only blocks never count toward the streak', () => {
  const planned = close({}, 'needs_human', undefined, { planOnly: true });
  assert.equal(planned.patch.blockedReasonStreak.t1, undefined);
});

test('streak and report codes survive row normalization', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/x',
    blockedReasonStreak: { t1: { code: 'needs_human', count: 1 }, t2: { code: '', count: 3 } },
    reports: [{ reportId: 'r', outcome: 'blocked', reasonCode: 'needs_human', reasonDate: '2026-12-01' }, { reportId: 'r2', outcome: 'blocked', reasonCode: 'x' }],
  });
  assert.deepEqual(row.blockedReasonStreak, { t1: { code: 'needs_human', count: 1 } });
  assert.equal(row.reports[0].reasonCode, 'needs_human');
  assert.equal(row.reports[1].reasonCode, undefined);
});

test('escalation only parks a released ready todo', async () => {
  const { addTodo, loadTodosData, updateTodo } = await import('../lib/persist/todos-persist.js');
  const { applyWorkspaceWatcherBlockedEscalation } = await import('../lib/workspace-watcher-cycle-close.js');
  const dataDir = process.env.CRETLI_TEST_DATA_DIR;
  const ws = '/tmp/blocked-reasons-ws';
  const mk = (title, patch = {}) => {
    const t = addTodo(dataDir, ws, { title, status: 'ready' }).item;
    if (Object.keys(patch).length) updateTodo(dataDir, ws, t.id, patch);
    return t;
  };
  const get = (id) => loadTodosData(dataDir, ws).items.find((i) => i.id === id);
  const run = async (id) => await applyWorkspaceWatcherBlockedEscalation({
    workspaceFolder: ws, dataDir, todoId: id, escalation: { action: 'idea' }, message: 'need a human', code: 'needs_human',
  });

  const ready = mk('ready');
  assert.equal(await run(ready.id), true);
  assert.equal(get(ready.id).status, 'idea');

  const doing = mk('doing', { status: 'doing', strictStatus: true });
  assert.equal(await run(doing.id), false);
  assert.equal(get(doing.id).status, 'doing');

  const claimed = mk('claimed', { claimedByChatId: 'other-chat', claimLeaseUntil: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(await run(claimed.id), false);
  assert.equal(get(claimed.id).status, 'ready');
  assert.equal(get(claimed.id).claimedByChatId, 'other-chat');
});
