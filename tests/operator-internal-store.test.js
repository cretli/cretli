import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordOperatorEvent } from '../lib/persist/operator-journal-persist.js';
import { OPERATOR_EVENT_KINDS, OPERATOR_RUN_PICK_PURPOSE, OPERATOR_TEST_KIND } from '../lib/operator/operator-constants.js';
import { buildDedupeKey, ingestOperatorEvents, listOperatorEventsGlobalSince } from '../lib/operator/operator-event-ingest.js';
import {
  ackEvents, claimPendingEvents, claimRunSlot, getMeta, heartbeatRunSlot, openOperatorStore, pruneOperatorAudit,
  pruneOperatorEvents, recoverInterruptedWork, releaseRunSlot,
} from '../lib/operator/operator-internal-store.js';
import { operatorRunChatRow } from './helpers/operator-run-chat-fixture.js';

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const WS = path.resolve('/tmp/operator-ws-a');
const quiet = { warn() {} };

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-store-'));
  return { dataDir, options: { dataDir, now: T0, logger: quiet }, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}
const emit = (f, kind, summary, at = 0, ws = WS) => recordOperatorEvent(ws, kind, summary, { dataDir: f.dataDir, now: T0 + at });
function queue(f) {
  const db = openOperatorStore(f.options);
  try { return db.prepare('SELECT * FROM operator_internal_queue ORDER BY event_rowid').all(); } finally { db.close(); }
}
function meta(f, key) {
  const db = openOperatorStore(f.options);
  try { return getMeta(db, key); } finally { db.close(); }
}

test('constants and fixture', () => {
  assert.equal(OPERATOR_RUN_PICK_PURPOSE, 'operator_run');
  assert.ok(OPERATOR_EVENT_KINDS.includes(OPERATOR_TEST_KIND));
  assert.equal(operatorRunChatRow().pickPurpose, 'operator_run');
});

test('global read returns UUID ids, leaf ids and a cursor', () => {
  const f = fixture();
  try {
    emit(f, 'review_failed', 'review_failed: leaf L1, code review failed');
    emit(f, 'blocked', 'blocked: x', 1000, path.resolve('/tmp/operator-ws-b'));
    const page = listOperatorEventsGlobalSince(0, { kinds: ['review_failed'] }, f.options);
    assert.equal(page.events.length, 1);
    assert.match(page.events[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(page.events[0].leafId, 'L1');
    assert.equal(page.cursor, 2);
    assert.equal(listOperatorEventsGlobalSince(0, {}, f.options).events.length, 2);
  } finally { f.cleanup(); }
});

test('ingest is atomic: injected failure leaves cursor and queue unchanged', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a');
    assert.throws(() => ingestOperatorEvents({ ...f.options, afterInsert() { throw new Error('boom'); } }), /boom/);
    assert.equal(meta(f, 'internal_operator_cursor'), '');
    assert.equal(queue(f).length, 0);
    const ok = ingestOperatorEvents(f.options);
    assert.equal(ok.ingested, 1);
    assert.equal(meta(f, 'internal_operator_cursor'), '1');
    assert.equal(ingestOperatorEvents(f.options).ingested, 0);
  } finally { f.cleanup(); }
});

test('journal reset with repeated rowids loses no events', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: one'); emit(f, 'needs_human', 'needs_human: two'); emit(f, 'restart', 'restart: three');
    ingestOperatorEvents(f.options);
    const db = openOperatorStore(f.options);
    db.exec('DELETE FROM operator_events'); db.close();
    emit(f, 'blocked', 'blocked: new1', 100000); emit(f, 'blocked', 'blocked: new2', 200000);
    emit(f, 'blocked', 'blocked: new3', 300000); emit(f, 'blocked', 'blocked: new4', 400000);
    const result = ingestOperatorEvents(f.options);
    assert.equal(result.reset, 'cursor_uuid_mismatch');
    assert.equal(result.epoch, 1);
    assert.equal(result.ingested, 4);
    assert.equal(queue(f).length, 7);
  } finally { f.cleanup(); }
});

test('cursor beyond head resets; swapped journal id resets', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: one'); emit(f, 'blocked', 'blocked: two', 100000);
    const first = ingestOperatorEvents(f.options);
    const db = openOperatorStore(f.options);
    db.exec('DELETE FROM operator_events'); db.close();
    assert.equal(ingestOperatorEvents(f.options).reset, 'cursor_beyond_head');
    // File swapped for a journal with a different journal_id and a head past the cursor.
    const other = fixture();
    try {
      for (let i = 0; i < 4; i += 1) emit(other, 'blocked', `blocked: other${i}`, i * 100000);
      const swapped = new DatabaseSync(path.join(other.dataDir, 'operator-journal.sqlite'));
      swapped.close();
      const result = ingestOperatorEvents({ ...other.options, knownJournalId: first.journalId });
      assert.equal(result.reset, 'journal_id_changed');
      assert.equal(result.ingested, 4);
    } finally { other.cleanup(); }
  } finally { f.cleanup(); }
});

test('swapped file whose rows pass the cursor is detected by row UUID', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a'); emit(f, 'blocked', 'blocked: b', 100000);
    ingestOperatorEvents(f.options);
    const db = openOperatorStore(f.options);
    db.exec('DELETE FROM operator_events'); db.close();
    for (let i = 0; i < 5; i += 1) emit(f, 'blocked', `blocked: swap${i}`, 200000 + i * 100000);
    const result = ingestOperatorEvents(f.options);
    assert.equal(result.reset, 'cursor_uuid_mismatch');
    assert.equal(result.ingested, 5);
  } finally { f.cleanup(); }
});

test('dedupe key without a leaf uses the reason; identical events coalesce in the window', () => {
  const f = fixture();
  try {
    assert.equal(buildDedupeKey({ workspace: WS, kind: 'watcher_stopped', summary: 'watcher_stopped: automatic, reason quota' }), `${WS}|watcher_stopped|quota`);
    assert.equal(buildDedupeKey({ workspace: WS, kind: 'review_failed', summary: 'review_failed: leaf L9, x' }), `${WS}|review_failed|L9`);
    emit(f, 'watcher_stopped', 'watcher_stopped: automatic, reason quota', 0);
    emit(f, 'watcher_stopped', 'watcher_stopped: automatic, reason quota', 10_000);
    emit(f, 'watcher_stopped', 'watcher_stopped: automatic, reason other', 20_000);
    emit(f, 'watcher_stopped', 'watcher_stopped: automatic, reason quota', 200_000);
    const result = ingestOperatorEvents(f.options);
    assert.equal(result.coalesced, 1);
    assert.equal(queue(f).filter((r) => r.state === 'pending').length, 3);
  } finally { f.cleanup(); }
});

test('overflow keeps the newest per (workspace, kind) and counts dropped', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 12; i += 1) emit(f, 'review_failed', `review_failed: leaf L${i}, x`, i);
    emit(f, 'blocked', 'blocked: y', 50);
    const result = ingestOperatorEvents({ ...f.options, maxPending: 5 });
    assert.equal(result.dropped, 8);
    const rows = queue(f);
    assert.equal(rows.length, 5);
    assert.ok(rows.some((r) => r.kind === 'blocked'));
    assert.ok(rows.some((r) => r.dedupe_key.endsWith('|L11')), 'newest of the group survives');
    assert.equal(meta(f, 'queue_dropped_total'), '8');
  } finally { f.cleanup(); }
});

test('run slot: live lease kept across handles, expired taken over, release frees at once', () => {
  const f = fixture();
  try {
    const a = claimRunSlot(f.options, { ownerInstanceId: 'A' });
    assert.equal(a.ok, true);
    const live = claimRunSlot({ ...f.options, now: T0 + 30_000 }, { ownerInstanceId: 'B' });
    assert.equal(live.ok, false); assert.equal(live.reason, 'slot_busy');
    assert.equal(heartbeatRunSlot({ ...f.options, now: T0 + 60_000 }, { runId: a.runId, ownerInstanceId: 'A' }), true);
    assert.equal(claimRunSlot({ ...f.options, now: T0 + 100_000 }, { ownerInstanceId: 'B' }).ok, false);
    const taken = claimRunSlot({ ...f.options, now: T0 + 200_000 }, { ownerInstanceId: 'B' });
    assert.equal(taken.ok, true); assert.equal(taken.tookOver, true);
    assert.equal(heartbeatRunSlot({ ...f.options, now: T0 + 200_001 }, { runId: a.runId, ownerInstanceId: 'A' }), false);
    const db = openOperatorStore(f.options);
    assert.equal(db.prepare('SELECT state FROM operator_runs WHERE id=?').get(a.runId).state, 'interrupted');
    db.close();
    assert.equal(releaseRunSlot({ ...f.options, now: T0 + 201_000 }, { runId: taken.runId, ownerInstanceId: 'B' }), true);
    assert.equal(claimRunSlot({ ...f.options, now: T0 + 201_001 }, { ownerInstanceId: 'C' }).ok, true);
  } finally { f.cleanup(); }
});

const A = { ownerInstanceId: 'A' };
const claimOne = (f, run, owner = 'A', at = 0) => claimPendingEvents({ ...f.options, now: T0 + at }, { runId: run.runId, ownerInstanceId: owner });

test('F1: recovery leaves a live run and its claims alone; expired ones are released', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a');
    ingestOperatorEvents(f.options);
    const run = claimRunSlot(f.options, A);
    assert.equal(claimOne(f, run).length, 1);
    assert.deepEqual(recoverInterruptedWork({ ...f.options, now: T0 + 1000 }), { requeued: 0, parked: 0, runsInterrupted: 0 });
    assert.equal(queue(f)[0].state, 'claimed');
    const db = openOperatorStore(f.options);
    assert.equal(db.prepare('SELECT state FROM operator_runs WHERE id=?').get(run.runId).state, 'running');
    db.close();
    assert.deepEqual(recoverInterruptedWork({ ...f.options, now: T0 + 200_000 }), { requeued: 1, parked: 0, runsInterrupted: 1 });
    assert.equal(queue(f)[0].state, 'pending');
  } finally { f.cleanup(); }
});

test('F2: takeover requeues the old run claims once, a second interruption parks', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a');
    ingestOperatorEvents(f.options);
    const a = claimRunSlot(f.options, A);
    claimOne(f, a);
    const b = claimRunSlot({ ...f.options, now: T0 + 200_000 }, { ownerInstanceId: 'B' });
    assert.equal(b.tookOver, true);
    assert.equal(queue(f)[0].state, 'pending');
    assert.equal(claimOne(f, b, 'B', 200_001)[0].attempts, 2);
    const c = claimRunSlot({ ...f.options, now: T0 + 500_000 }, { ownerInstanceId: 'C' });
    assert.equal(c.tookOver, true);
    assert.equal(queue(f)[0].state, 'parked');
  } finally { f.cleanup(); }
});

test('F3: a stale run cannot claim or ack after takeover', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a'); emit(f, 'needs_human', 'needs_human: b', 1000);
    ingestOperatorEvents(f.options);
    const a = claimRunSlot(f.options, A);
    const [first] = claimOne(f, a);
    const b = claimRunSlot({ ...f.options, now: T0 + 200_000 }, { ownerInstanceId: 'B' });
    const [again] = claimOne(f, b, 'B', 200_001);
    assert.equal(again.event_id, first.event_id);
    assert.deepEqual(claimOne(f, a, 'A', 200_002), []);
    assert.equal(ackEvents({ ...f.options, now: T0 + 200_002 }, { runId: a.runId, ownerInstanceId: 'A', eventIds: [first.event_id] }), 0);
    assert.equal(ackEvents({ ...f.options, now: T0 + 200_003 }, { runId: b.runId, ownerInstanceId: 'A', eventIds: [first.event_id] }), 0, 'wrong owner');
    assert.equal(queue(f).find((r) => r.event_id === first.event_id).state, 'claimed');
    assert.equal(ackEvents({ ...f.options, now: T0 + 200_004 }, { runId: b.runId, ownerInstanceId: 'B', eventIds: [first.event_id] }), 1);
  } finally { f.cleanup(); }
});

test('F4: cap holds with more than 200 distinct (workspace, kind) pairs', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 201; i += 1) emit(f, `kind_${i}`, `kind_${i}: x`, i, path.resolve(`/tmp/operator-ws-${i}`));
    const result = ingestOperatorEvents({ ...f.options, limit: 1000 });
    assert.equal(result.dropped, 1);
    const rows = queue(f);
    assert.equal(rows.length, 200);
    assert.equal(rows[0].event_rowid, 2, 'oldest dropped');
    assert.equal(meta(f, 'queue_dropped_total'), '1');
  } finally { f.cleanup(); }
});

test('F5: after a reset the new-epoch event outranks a leftover old-epoch row', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i += 1) emit(f, 'review_failed', `review_failed: leaf O${i}, x`, i * 100000);
    ingestOperatorEvents(f.options);
    const db = openOperatorStore(f.options);
    db.exec('DELETE FROM operator_events'); db.close();
    emit(f, 'review_failed', 'review_failed: leaf N0, x', 1_000_000);
    const result = ingestOperatorEvents({ ...f.options, maxPending: 4 });
    assert.equal(result.reset, 'cursor_beyond_head');
    const rows = queue(f);
    assert.equal(rows.length, 4);
    assert.ok(rows.some((r) => r.dedupe_key.endsWith('|N0') && r.journal_epoch === 1), 'new event survives');
    assert.ok(!rows.some((r) => r.dedupe_key.endsWith('|O0')), 'oldest old-epoch row dropped');
    const run = claimRunSlot(f.options, A);
    assert.ok(claimOne(f, run)[0].dedupe_key.endsWith('|O1'), 'claim order is epoch-first');
  } finally { f.cleanup(); }
});

test('retention keeps the newest event row and bounds the audit table', () => {
  const f = fixture();
  try {
    emit(f, 'blocked', 'blocked: a', 0); emit(f, 'blocked', 'blocked: b', 1000);
    assert.equal(pruneOperatorEvents({ ...f.options, now: T0 + 10 ** 9, olderThanMs: 1 }), 1);
    const page = listOperatorEventsGlobalSince(0, {}, f.options);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].summary, 'blocked: b');
    const db = openOperatorStore(f.options);
    const add = db.prepare('INSERT INTO operator_audit(tool, outcome, created_at) VALUES (?, ?, ?)');
    add.run('t', 'ok', new Date(T0 - 40 * 86_400_000).toISOString());
    for (let i = 0; i < 5; i += 1) add.run('t', 'ok', new Date(T0 - i).toISOString());
    db.close();
    assert.equal(pruneOperatorAudit({ ...f.options, maxRows: 3 }), 3);
    const db2 = openOperatorStore(f.options);
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM operator_audit').get().n, 3);
    db2.close();
  } finally { f.cleanup(); }
});
