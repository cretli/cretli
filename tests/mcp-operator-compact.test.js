/** Compact operator answers: handoff grouping/limits, todo_list fields and size cursor, watcher summary. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CRETLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-operator-compact-'));
const { compactOperatorHandoff, HANDOFF_DEFAULT_EVENTS_LIMIT, HANDOFF_DEFAULT_NOTES_LIMIT } = await import('../lib/mcp/mcp-external-operator-tools.js');
const { clampTodoListMaxChars, resolveTodoListFields, TODO_LIST_DEFAULT_MAX_CHARS, TODO_LIST_MAX_CHARS } = await import('../lib/mcp/builtin/todo-tools.js');
const { summarizeWatcherViewForMcp } = await import('../lib/mcp/builtin/watcher-tools.js');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const big = 'n'.repeat(3000);

function handoffFixture() {
  return {
    ok: true,
    since: hoursAgo(10),
    lease: { session_id: 's' },
    notes: [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `new${i}`, text: big, createdAt: hoursAgo(1 + i * 0.5) })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, text: big, createdAt: hoursAgo(100 + i) })),
    ],
    events: [
      ...Array.from({ length: 17 }, (_, i) => ({ kind: 'integration', summary: `${big} ${i}`, createdAt: hoursAgo(9 - i * 0.1) })),
      ...Array.from({ length: 3 }, (_, i) => ({ kind: 'restart', summary: 'restarted', createdAt: hoursAgo(2 - i * 0.1) })),
    ],
    sessions: Array.from({ length: 25 }, (_, i) => ({ sessionId: `s${i}` })),
  };
}

test('handoff default keeps recent notes only, counts the rest and groups events', () => {
  const full = handoffFixture();
  const out = compactOperatorHandoff(full, {}, NOW);
  assert.equal(out.notes.length, HANDOFF_DEFAULT_NOTES_LIMIT);
  assert.ok(out.notes.every((note) => note.id.startsWith('new')));
  assert.equal(out.notes_older_count, 30);
  assert.equal(out.notes_total, 70);
  assert.equal(out.notes_omitted, 20);
  assert.equal(out.events.length, HANDOFF_DEFAULT_EVENTS_LIMIT);
  assert.equal(out.events_total, 20);
  assert.equal(out.events.at(-1).kind, 'restart', 'newest events are kept');
  const groups = Object.fromEntries(out.event_groups.map((g) => [g.kind, g.label]));
  assert.equal(groups.integration, '17× integration');
  assert.equal(groups.restart, '3× restart');
  assert.equal(out.sessions.length, 10);
  assert.equal(out.sessions_total, 25);
  assert.ok(JSON.stringify(out).length < 20_000, `default handoff is small (${JSON.stringify(out).length})`);
  assert.ok(JSON.stringify(full).length > 100_000);
  assert.equal(full.notes.length, 70, 'input is not mutated');
});

test('handoff notes_limit and events_limit are honoured, 0 hides the raw rows', () => {
  const out = compactOperatorHandoff(handoffFixture(), { notes_limit: 3, events_limit: 0 }, NOW);
  assert.equal(out.notes.length, 3);
  assert.equal(out.events.length, 0);
  assert.equal(out.events_omitted, 20);
  assert.equal(out.event_groups.length, 2, 'groups still cover every event');
  const more = compactOperatorHandoff(handoffFixture(), { notes_limit: 40, events_limit: 5 }, NOW);
  assert.equal(more.notes.length, 40);
  assert.equal(more.events.length, 5);
  assert.equal(compactOperatorHandoff(handoffFixture(), { notes_limit: 'junk' }, NOW).notes.length, HANDOFF_DEFAULT_NOTES_LIMIT);
});

test('handoff include_all restores the legacy fields untouched', () => {
  const full = handoffFixture();
  const out = compactOperatorHandoff(full, { include_all: true }, NOW);
  assert.equal(out.notes.length, 70);
  assert.equal(out.events.length, 20);
  assert.equal(out.sessions.length, 25);
  assert.equal(out.notes[0].text.length, 3000);
  assert.equal(out.compact, false);
});

test('todo_list field and size helpers', () => {
  assert.equal(resolveTodoListFields({}), null);
  assert.deepEqual(resolveTodoListFields({ compact: true }), ['id', 'status', 'title']);
  assert.deepEqual(resolveTodoListFields({ fields: ['status', 'parent_id'] }), ['id', 'status', 'parent_id']);
  assert.deepEqual(resolveTodoListFields({ fields: 'title,status' }), ['id', 'title', 'status']);
  assert.equal(clampTodoListMaxChars(undefined), TODO_LIST_DEFAULT_MAX_CHARS);
  assert.equal(clampTodoListMaxChars(10 ** 9), TODO_LIST_MAX_CHARS);
  assert.equal(clampTodoListMaxChars(10), 500);
});

test('watcher summary is bounded, keeps cycles, 10 decisions and active backoff only', () => {
  const nowMs = NOW;
  const view = {
    workspaceFolder: '/w',
    watcher: {
      mode: 'autopilot',
      policy: { maxParallel: 2 },
      activeCycles: [{ cycleId: 'c1', chatId: 'x', todoIds: ['t1'] }],
      failures: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, 1])),
      planRequests: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, { at: big }])),
      blockedBackoff: {
        live: { count: 2, until: new Date(NOW + 60_000).toISOString() },
        expired: { count: 1, until: new Date(NOW - 60_000).toISOString() },
      },
      decisions: Array.from({ length: 50 }, (_, i) => ({ at: String(i), kind: 'tick', reason: big })),
      reports: Array.from({ length: 20 }, () => ({ message: big })),
    },
    snapshot: {
      readyTodoCount: 40,
      readyLeaves: Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, title: 'L', body: big })),
      doingStates: [],
      doingTodoIds: [],
    },
    guardrails: { kind: 'ok' },
  };
  const out = summarizeWatcherViewForMcp(view, nowMs);
  assert.equal(out.summary, true);
  assert.equal(out.watcher.decisions.length, 10);
  assert.equal(out.watcher.decisions.at(-1).at, '49');
  assert.deepEqual(out.watcher.blocked_backoff.map((row) => row.todoId), ['live']);
  assert.equal(out.watcher.failuresCount, 200);
  assert.equal(out.watcher.failures, undefined);
  assert.deepEqual(out.watcher.activeCycles, view.watcher.activeCycles);
  assert.equal(out.snapshot.readyLeavesCount, 40);
  assert.equal(out.snapshot.readyLeaves.length, 25);
  assert.equal(out.snapshot.readyLeaves[0].body, undefined);
  assert.ok(JSON.stringify(out).length < 20_000, `summary is small (${JSON.stringify(out).length})`);
  assert.equal(summarizeWatcherViewForMcp(null), null);
});
