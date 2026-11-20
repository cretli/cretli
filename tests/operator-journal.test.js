import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  acquireOperatorLease,
  addOperatorNote,
  assertOperatorLease,
  listOperatorNotes,
  operatorHandoff,
  recordOperatorEvent,
  resolveOperatorNote,
} from '../lib/persist/operator-journal-persist.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-journal-'));
  const a = path.join(root, 'a'); const b = path.join(root, 'b'); const dataDir = path.join(root, 'data');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(dataDir);
  return { root, a, b, options: { dataDir, now: Date.parse('2026-10-24T10:00:00.000Z') } };
}

test('journal entries are durable and isolated per workspace', () => {
  const f = fixture();
  try {
    const scope = { workspaceFolder: f.a, clientId: 'client-a', clientName: 'A', sessionId: 'session-a' };
    const note = addOperatorNote(scope, { kind: 'question', text: 'Ship now?', todoId: 'todo-1' }, f.options);
    addOperatorNote({ ...scope, workspaceFolder: f.b }, { kind: 'lesson', text: 'Other workspace' }, f.options);
    assert.deepEqual(listOperatorNotes(f.a, f.options).map((row) => row.text), ['Ship now?']);
    assert.equal(listOperatorNotes(f.b, f.options)[0].text, 'Other workspace');
    assert.throws(() => resolveOperatorNote(f.b, note.id, f.options), /not found/);
    assert.equal(resolveOperatorNote(f.a, note.id, f.options).resolvedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(listOperatorNotes(f.a, f.options).length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('lease conflicts, explicit takeover, heartbeat and expiry', () => {
  const f = fixture();
  try {
    const one = { workspaceFolder: f.a, clientId: 'one', clientName: 'One', sessionId: 's1' };
    const two = { workspaceFolder: f.a, clientId: 'two', clientName: 'Two', sessionId: 's2' };
    assert.equal(acquireOperatorLease(one, {}, f.options).ok, true);
    assert.equal(acquireOperatorLease(two, {}, f.options).conflict, true);
    assert.throws(() => assertOperatorLease(two, f.options), /operator_handoff/);
    assert.equal(acquireOperatorLease(two, { takeover: true }, f.options).takeover, true);
    assert.equal(assertOperatorLease(two, f.options).session_id, 's2');
    assert.equal(acquireOperatorLease(one, {}, { ...f.options, now: f.options.now + 91_000 }).ok, true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

function concurrentLeaseAttempt(scope, options, barrier) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { assertOperatorLease } = await import(workerData.moduleUrl);
        const gate = new Int32Array(workerData.barrier);
        Atomics.add(gate, 0, 1);
        Atomics.notify(gate, 0);
        Atomics.wait(gate, 1, 0);
        try {
          const lease = assertOperatorLease(workerData.scope, workerData.options);
          parentPort.postMessage({ ok: true, sessionId: lease.session_id });
        } catch (error) {
          parentPort.postMessage({ ok: false, code: error?.code, message: error?.message });
        }
      })().catch((error) => { throw error; });
    `, {
      eval: true,
      workerData: {
        moduleUrl: new URL('../lib/persist/operator-journal-persist.js', import.meta.url).href,
        scope,
        options,
        barrier,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`lease worker exited with ${code}`)); });
  });
}

test('two concurrent contenders after expiry produce exactly one lease winner', async () => {
  const f = fixture();
  try {
    const expired = { workspaceFolder: f.a, clientId: 'old', clientName: 'Old', sessionId: 'expired' };
    acquireOperatorLease(expired, {}, f.options);
    const afterExpiry = { ...f.options, now: f.options.now + 91_000 };
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const gate = new Int32Array(barrier);
    const attempts = [
      concurrentLeaseAttempt({ workspaceFolder: f.a, clientId: 'one', clientName: 'One', sessionId: 'one' }, afterExpiry, barrier),
      concurrentLeaseAttempt({ workspaceFolder: f.a, clientId: 'two', clientName: 'Two', sessionId: 'two' }, afterExpiry, barrier),
    ];
    while (Atomics.load(gate, 0) < 2) await Atomics.waitAsync(gate, 0, Atomics.load(gate, 0), 1_000).value;
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1, 2);
    const results = await Promise.all(attempts);
    const winners = results.filter((row) => row.ok);
    const refused = results.filter((row) => !row.ok && row.code === 'OPERATOR_LEASE_REQUIRED');
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(refused.length, 1, JSON.stringify(results));
    assert.equal(assertOperatorLease({ workspaceFolder: f.a, sessionId: winners[0].sessionId }, afterExpiry).session_id, winners[0].sessionId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('handoff returns open notes and only events since the previous visit', () => {
  const f = fixture();
  try {
    const scope = { workspaceFolder: f.a, clientId: 'one', clientName: 'One', sessionId: 's1' };
    addOperatorNote(scope, { kind: 'temporary_setting', text: 'Prefer model', expiresAt: '2026-10-31T00:00:00Z' }, f.options);
    assert.equal(operatorHandoff(scope, {}, f.options).notes.length, 1);
    recordOperatorEvent(f.a, 'restart', 'Server restarted', { ...f.options, now: f.options.now + 1_000 });
    const next = operatorHandoff(scope, {}, { ...f.options, now: f.options.now + 2_000 });
    assert.deepEqual(next.events.map((event) => event.summary), ['Server restarted']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('temporary settings require a valid expiry', () => {
  const f = fixture();
  try {
    const scope = { workspaceFolder: f.a, clientId: 'one', clientName: 'One', sessionId: 's1' };
    assert.throws(() => addOperatorNote(scope, { kind: 'temporary_setting', text: 'Temporary' }, f.options), /expires_at/);
    assert.throws(() => addOperatorNote(scope, { kind: 'decision', text: 'Bad date', expiresAt: 'never' }, f.options), /ISO date/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
