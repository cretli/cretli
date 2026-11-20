import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import {
  canonicalJson,
  computeRequestDigest,
  executeCommand,
  RECEIPT_LOOKUP_QUERY,
  resolveUnknown,
  withReceipt,
} from '../lib/storage/command-receipts.js';
import { scanHandlerSql } from '../lib/storage/handler-sql-guard.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-receipt-handlers.js', import.meta.url));
const GEN = 'gen-1';

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-receipts-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>} [extra]
 */
async function startHost(extra = {}) {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    restartBackoffMs: { initial: 10, max: 100 },
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    ...extra,
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

/**
 * @param {ReturnType<typeof createStorageWorkerHost>} host
 * @param {string} k
 */
async function state(host, k) {
  return {
    value: await host.query('get', { k }),
    applied: await host.query('applyCount', { k }),
    receipts: await host.query('receiptCount', {}),
  };
}

describe('request digest', () => {
  it('does not depend on object key order at any depth', () => {
    const a = computeRequestDigest('put', { k: 'a', v: 'b', nested: { x: 1, y: [1, { p: 1, q: 2 }] } });
    const b = computeRequestDigest('put', { nested: { y: [1, { q: 2, p: 1 }], x: 1 }, v: 'b', k: 'a' });
    assert.equal(a, b);
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
  });

  it('changes with values, array order and the command name', () => {
    const base = computeRequestDigest('put', { k: 'a', list: [1, 2] });
    assert.notEqual(computeRequestDigest('put', { k: 'b', list: [1, 2] }), base);
    assert.notEqual(computeRequestDigest('put', { k: 'a', list: [2, 1] }), base);
    assert.notEqual(computeRequestDigest('put2', { k: 'a', list: [1, 2] }), base);
    assert.notEqual(computeRequestDigest('put', { k: 'a', list: [1, 2], extra: null }), base);
  });

  it('normalizes like the wire (undefined members, -0) and refuses non-JSON', () => {
    assert.equal(canonicalJson({ b: undefined, a: -0 }), '{"a":0}');
    assert.equal(computeRequestDigest('put', { a: 1, b: undefined }), computeRequestDigest('put', { a: 1 }));
    assert.equal(computeRequestDigest('put', undefined), computeRequestDigest('put', null));
    assert.throws(() => computeRequestDigest('put', { m: new Map() }), TypeError);
    assert.throws(() => computeRequestDigest('put', { n: 1n }), TypeError);
    assert.throws(() => computeRequestDigest('bad name', {}), TypeError);
  });

  it('is stable across a JSON round trip (host vs worker view)', () => {
    const payload = { z: 'ż\u2028', a: [1.5, true, null, 'x'], m: { '': 1, __proto__x: 2 } };
    assert.equal(computeRequestDigest('put', JSON.parse(JSON.stringify(payload))), computeRequestDigest('put', payload));
  });

  it('pins golden digests of scheme cretli-storage-receipt-v1', () => {
    // Any change of canonicalization or DIGEST_SCHEME must break this test:
    // it needs a new scheme version and dual-read of old receipts.
    const expectedCanonical = '{"k":"a","v":"1"}';
    assert.equal(canonicalJson({ v: '1', k: 'a' }), expectedCanonical);
    const independent = createHash('sha256').update(`cretli-storage-receipt-v1\0put\0${expectedCanonical}`, 'utf8').digest('hex');
    assert.equal(computeRequestDigest('put', { v: '1', k: 'a' }), `sha256:${independent}`);
    assert.equal(computeRequestDigest('put', { k: 'a', v: '1' }), 'sha256:835e0211d51b01ef6f86b594eb759ef7b4f0da7aef7be27ef0e1f522a325b485');
    assert.equal(computeRequestDigest('put', null), 'sha256:de7f6932dcb930b9acf797562d545e081965dc3277fe3a66743014719f70e149');
    // A real own `__proto__` key (JSON.parse creates one), unicode keys and
    // values, -0, nested empty key.
    const inputJson = '{"__proto__":{"x":1},"b":[1,2.5,-0,true,null],"ż":"zażółć","Z":"😀","a":{"":0}}';
    const parsed = JSON.parse(inputJson);
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'));
    assert.equal(canonicalJson(parsed), '{"Z":"😀","__proto__":{"x":1},"a":{"":0},"b":[1,2.5,0,true,null],"ż":"zażółć"}');
    assert.equal(computeRequestDigest('chat.append', parsed), 'sha256:85ac7ce5aee803c71e23643f30dbf4717f6d123cabd236d6de27127780a54e51');
  });

  it('withReceipt refuses async and generator handlers and invalid caps', () => {
    assert.throws(() => withReceipt(async () => 1), TypeError);
    assert.throws(() => withReceipt(function* gen() { yield 1; }), TypeError);
    assert.throws(() => withReceipt(async function* agen() { yield 1; }), TypeError);
    assert.throws(() => withReceipt(() => 1, { maxResultBytes: 0 }), TypeError);
    assert.throws(() => withReceipt(null), TypeError);
  });
});

describe('handler SQL guard', () => {
  it('refuses transaction control outside literals, comments and parameters', () => {
    for (const sql of [
      'COMMIT',
      'commit transaction',
      'BEGIN IMMEDIATE',
      'ROLLBACK',
      'END',
      '  end transaction',
      'SAVEPOINT s',
      'RELEASE s',
      'INSERT INTO t VALUES (1); COMMIT',
      'INSERT OR ROLLBACK INTO t VALUES (1)',
      'SELECT 1; /* c */ END',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END',
    ]) {
      assert.throws(() => scanHandlerSql(sql), (err) => err.code === 'io' && err.details.operation === 'transaction_control', sql);
    }
  });

  it('accepts ordinary SQL, including CASE ... END and keyword-like literals', () => {
    assert.equal(scanHandlerSql("SELECT CASE WHEN x THEN 'COMMIT' ELSE \"end\" END FROM t -- ROLLBACK\n"), 1);
    assert.equal(scanHandlerSql('INSERT INTO t (a) VALUES (:release) /* BEGIN */'), 1);
    assert.equal(scanHandlerSql("UPDATE t SET v = 'it''s; COMMIT' WHERE [end] = @commit"), 1);
    assert.equal(scanHandlerSql('CREATE TABLE a (x); CREATE TABLE b (y);'), 2);
    assert.equal(scanHandlerSql(''), 0);
  });
});

describe('command receipts (worker host)', () => {
  it('replays the stored result and applies the mutation exactly once', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-1', name: 'put', payload: { k: 'a', v: '1' } };
    const first = await executeCommand(host, args);
    assert.deepEqual(first, { result: { k: 'a', v: '1', applySeq: 1 }, replayed: false });
    // Same logical payload with another key order: same digest, replay.
    const again = await executeCommand(host, { ...args, payload: { v: '1', k: 'a' } });
    assert.deepEqual(again, { result: first.result, replayed: true });
    assert.deepEqual(await state(host, 'a'), { value: '1', applied: 1, receipts: 1 });
    assert.deepEqual(await resolveUnknown(host, args), { outcome: 'committed', result: first.result });
  });

  it('scopes receipts by dataset generation', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-gen', name: 'put', payload: { k: 'g', v: '1' } };
    await executeCommand(host, args);
    const other = await executeCommand(host, { ...args, datasetGeneration: 'gen-2' });
    assert.equal(other.replayed, false);
    assert.equal((await state(host, 'g')).applied, 2);
  });

  it('rejects the same commandId with another payload as conflict without mutating', async () => {
    const host = await startHost();
    await executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-c', name: 'put', payload: { k: 'c', v: '1' } });
    const changed = { datasetGeneration: GEN, commandId: 'cmd-c', name: 'put', payload: { k: 'c', v: '2' } };
    const err = await rejection(executeCommand(host, changed));
    assert.equal(err.code, 'conflict');
    assert.equal(err.retryable, false);
    assert.equal(err.details.conflictKind, 'receipt_digest_mismatch');
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(err.details.commandId, 'cmd-c');
    assert.equal(err.details.sqliteCode, undefined, 'decided by digest comparison, not a constraint error');
    assert.deepEqual(err.toJSON().details.conflictKind, 'receipt_digest_mismatch');
    // Another handler name with the same commandId is another request too.
    const renamed = await rejection(executeCommand(host, { ...changed, name: 'spinPut', payload: { k: 'c', v: '1', ms: 0 } }));
    assert.equal(renamed.code, 'conflict');
    const resolveErr = await rejection(resolveUnknown(host, changed));
    assert.equal(resolveErr.code, 'conflict');
    assert.equal(resolveErr.details.conflictKind, 'receipt_digest_mismatch');
    assert.deepEqual(await state(host, 'c'), { value: '1', applied: 1, receipts: 1 });
  });

  it('rolls back a failing handler and writes no receipt', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-throw', name: 'putThenThrow', payload: { k: 't', v: '1' } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(err.details.commandId, 'cmd-throw');
    assert.deepEqual(await state(host, 't'), { value: null, applied: 0, receipts: 0 });
    assert.deepEqual(await resolveUnknown(host, args), { outcome: 'not_committed' });
  });

  it('rolls back a result above the receipt cap (result_too_large)', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-big', name: 'putBigResult', payload: { k: 'big', v: '1', bytes: 4096 } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.code, 'io');
    assert.equal(err.details.operation, 'result_too_large');
    assert.equal(err.details.commitState, 'not_committed');
    assert.deepEqual(await state(host, 'big'), { value: null, applied: 0, receipts: 0 });
    const small = await executeCommand(host, { ...args, commandId: 'cmd-small', payload: { k: 'big', v: '1', bytes: 10 } });
    assert.equal(small.result, 'x'.repeat(10));
  });

  it('crash after COMMIT: unknown_commit, resolveUnknown finds the receipt, retry replays', async () => {
    const host = await startHost({ faultInjection: true });
    const args = { datasetGeneration: GEN, commandId: 'cmd-ac', name: 'putCommitThenExit', payload: { k: 'ac', v: '1' } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.code, 'unknown_commit');
    assert.equal(err.details.commitState, 'unknown');
    assert.equal(err.details.commandId, 'cmd-ac');
    const resolved = await resolveUnknown(host, args);
    assert.deepEqual(resolved, { outcome: 'committed', result: { k: 'ac', v: '1', applySeq: 1 } });
    assert.equal(host.getMetrics().restarts, 1);
    const retry = await executeCommand(host, args);
    assert.deepEqual(retry, { result: resolved.result, replayed: true });
    assert.deepEqual(await state(host, 'ac'), { value: '1', applied: 1, receipts: 1 });
    assert.equal(host.getMetrics().restarts, 1, 'a replay does not run the handler, so no second crash');
  });

  it('crash before COMMIT: unknown_commit, resolveUnknown says not_committed, retry applies once', async () => {
    const host = await startHost();
    const crashMarker = path.join(root, 'crash-once');
    const args = { datasetGeneration: GEN, commandId: 'cmd-bc', name: 'putThenExit', payload: { k: 'bc', v: '1', crashMarker } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.code, 'unknown_commit');
    assert.equal(err.details.commitState, 'unknown');
    assert.ok(fs.existsSync(crashMarker), 'the handler really ran and crashed');
    assert.deepEqual(await resolveUnknown(host, args), { outcome: 'not_committed' });
    assert.deepEqual(await state(host, 'bc'), { value: null, applied: 0, receipts: 0 });
    // Same commandId, same payload (same digest): the retry applies once.
    const retry = await executeCommand(host, args);
    assert.deepEqual(retry, { result: { k: 'bc', v: '1', applySeq: 1 }, replayed: false });
    assert.equal((await executeCommand(host, args)).replayed, true);
    assert.deepEqual(await state(host, 'bc'), { value: '1', applied: 1, receipts: 1 });
    assert.equal(host.getMetrics().restarts, 1);
  });

  it('full disk: full_disk not_committed, no receipt, existing data intact', async () => {
    const host = await startHost();
    await executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-keep', name: 'put', payload: { k: 'keep', v: '1' } });
    await host.command('limitPages', {});
    const args = { datasetGeneration: GEN, commandId: 'cmd-full', name: 'fillBlob', payload: { bytes: 256 * 1024 } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.code, 'full_disk');
    assert.equal(err.retryable, false);
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(err.details.commandId, 'cmd-full');
    assert.equal(await host.query('blobCount', {}), 0);
    assert.deepEqual(await state(host, 'keep'), { value: '1', applied: 1, receipts: 1 });
    assert.deepEqual(await resolveUnknown(host, args), { outcome: 'not_committed' });
    assert.equal(host.getMetrics().restarts, 0);
  });

  it('write-lock contention: busy, no ACK, no receipt; a later retry applies once', async () => {
    const host = await startHost({ busyTimeoutMs: 50 });
    const args = { datasetGeneration: GEN, commandId: 'cmd-busy', name: 'put', payload: { k: 'busy', v: '1' } };
    const other = new DatabaseSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME), { timeout: 0 });
    try {
      other.exec('BEGIN IMMEDIATE');
      const err = await rejection(executeCommand(host, args));
      assert.equal(err.code, 'busy');
      assert.equal(err.retryable, true);
      assert.equal(err.details.commitState, 'not_committed');
      assert.equal(err.details.commandId, 'cmd-busy');
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    assert.deepEqual(await state(host, 'busy'), { value: null, applied: 0, receipts: 0 });
    assert.equal((await executeCommand(host, args)).replayed, false);
    assert.equal((await state(host, 'busy')).applied, 1);
  });

  it('concurrent callers with the same commandId and digest run the handler once', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-race', name: 'spinPut', payload: { k: 'race', v: '1', ms: 20 } };
    const results = await Promise.all(Array.from({ length: 8 }, () => executeCommand(host, args)));
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    for (const r of results) assert.deepEqual(r.result, results[0].result);
    assert.deepEqual(await state(host, 'race'), { value: '1', applied: 1, receipts: 1 });
  });

  it('concurrent callers with different commandIds all apply', async () => {
    const host = await startHost();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => executeCommand(host, {
      datasetGeneration: GEN,
      commandId: `cmd-many-${i}`,
      name: 'put',
      payload: { k: `many-${i}`, v: String(i) },
    })));
    assert.ok(results.every((r) => r.replayed === false));
    assert.equal(await host.query('receiptCount', {}), 10);
  });

  it('validates arguments before anything is sent', async () => {
    const host = await startHost();
    const good = { datasetGeneration: GEN, commandId: 'cmd-v', name: 'put', payload: { k: 'v', v: '1' } };
    for (const bad of [
      { ...good, commandId: undefined },
      { ...good, commandId: 'has/slash' },
      { ...good, datasetGeneration: '' },
      { ...good, name: 'not a name' },
      { ...good, payload: { f: () => 1 } },
    ]) {
      const err = await rejection(executeCommand(host, bad));
      assert.equal(err.code, 'io');
      assert.equal(err.retryable, false);
      assert.equal(err.details.commitState, 'not_committed');
    }
    assert.equal(await host.query('receiptCount', {}), 0);
  });

  it('refuses a raw envelope with a forged digest and a non-wrapped handler reply', async () => {
    const host = await startHost();
    const forged = await rejection(host.command('put', {
      receipt: { v: 1, datasetGeneration: GEN, requestDigest: computeRequestDigest('put', { k: 'f', v: 'other' }) },
      payload: { k: 'f', v: '1' },
    }, { commandId: 'cmd-forged' }));
    assert.equal(forged.details.operation, 'receipt_digest_invalid');
    const noId = await rejection(host.command('put', { receipt: { v: 1, datasetGeneration: GEN, requestDigest: 'x' }, payload: {} }));
    assert.equal(noId.details.operation, 'receipt_command_id');
    const noEnvelope = await rejection(host.command('put', { k: 'f', v: '1' }, { commandId: 'cmd-noenv' }));
    assert.equal(noEnvelope.details.operation, 'receipt_envelope');
    // F30: the worker refuses a receipt request to an unwrapped handler
    // before BEGIN, so nothing commits and the outcome is known.
    const plain = await rejection(executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-plain', name: 'plainPut', payload: { k: 'p', v: '1' } }));
    assert.equal(plain.code, 'io');
    assert.equal(plain.details.operation, 'receipt_required');
    assert.equal(plain.details.commitState, 'not_committed');
    assert.equal(plain.details.commandId, 'cmd-plain');
    assert.equal(plain.retryable, false);
    assert.equal(await host.query('get', { k: 'p' }), null, 'handler never ran');
    assert.equal(await host.query(RECEIPT_LOOKUP_QUERY, { datasetGeneration: GEN }, { commandId: 'cmd-plain' }), null);
    assert.equal(await host.query('receiptCount', {}), 0);
    // Without requireReceipt the plain handler still works as a raw command.
    assert.ok(await host.command('plainPut', { payload: { k: 'raw', v: '1' } }, { commandId: 'cmd-raw' }));
  });

  it('marks receipt_missing non-reconcilable: resolveUnknown and retry refuse', async () => {
    const host = await startHost();
    // Only reachable with a forged receipt marker since F30.
    const args = { datasetGeneration: GEN, commandId: 'cmd-plain2', name: 'forgedMarkPut', payload: { k: 'p2', v: '1' } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.details.operation, 'receipt_missing');
    assert.equal(err.details.reconcilable, false);
    assert.equal(err.toJSON().details.reconcilable, false);
    // The mutation did commit, without a receipt: not_committed would be a lie.
    assert.equal(await host.query('get', { k: 'p2' }), '1');
    const resolveErr = await rejection(resolveUnknown(host, args));
    assert.equal(resolveErr.code, 'unknown_commit');
    assert.equal(resolveErr.details.operation, 'not_reconcilable');
    assert.equal(resolveErr.details.reconcilable, false);
    const retryErr = await rejection(executeCommand(host, args));
    assert.equal(retryErr.details.operation, 'not_reconcilable');
    assert.equal((await state(host, 'p2')).applied, 1, 'never re-run');
    // A fresh host object has no memory; passing the rejection still refuses.
    const other = await startHost();
    const passed = await rejection(resolveUnknown(other, { ...args, error: err }));
    assert.equal(passed.details.operation, 'not_reconcilable');
  });

  it('refuses a handler COMMIT through the context: rolled back, no receipt', async () => {
    const host = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-selfc', name: 'selfCommitPut', payload: { k: 'sc', v: '1' } };
    const err = await rejection(executeCommand(host, args));
    assert.equal(err.code, 'io');
    assert.equal(err.retryable, false);
    assert.equal(err.details.operation, 'transaction_control');
    assert.equal(err.details.commitState, 'not_committed');
    assert.deepEqual(await state(host, 'sc'), { value: null, applied: 0, receipts: 0 });
    assert.deepEqual(await resolveUnknown(host, args), { outcome: 'not_committed' });
  });

  it('a swallowed auto-rollback cannot write in autocommit: handler_transaction, not reconcilable', async () => {
    const host = await startHost();
    await host.command('limitPages', {});
    for (const name of ['swallowFullThenPut', 'swallowAllThenReturn']) {
      const args = { datasetGeneration: GEN, commandId: `cmd-${name}`, name, payload: { k: name, v: '1', bytes: 256 * 1024 } };
      const err = await rejection(executeCommand(host, args));
      assert.equal(err.code, 'unknown_commit', name);
      assert.equal(err.details.operation, 'handler_transaction', name);
      assert.equal(err.details.reconcilable, false, name);
      assert.equal(err.details.commandId, args.commandId);
      // The guard refused the autocommit write: nothing is durable.
      assert.deepEqual(await state(host, name), { value: null, applied: 0, receipts: 0 });
      const resolveErr = await rejection(resolveUnknown(host, args));
      assert.equal(resolveErr.details.operation, 'not_reconcilable', name);
    }
    assert.equal(await host.query('blobCount', {}), 0);
  });

  for (const [name, expected] of [['putCommitFault', 'committed'], ['putRollbackFault', 'not_committed']]) {
    it(`COMMIT-time unknown_commit (${name}, simulated) recycles the worker before resolveUnknown`, async () => {
      const host = await startHost({ faultInjection: true });
      const faultMarker = path.join(root, `fault-${name}`);
      const args = { datasetGeneration: GEN, commandId: `cmd-${name}`, name, payload: { k: name, v: '1', faultMarker } };
      const generationBefore = host.getMetrics().generation;
      const err = await rejection(executeCommand(host, args));
      assert.ok(fs.existsSync(faultMarker), 'the simulated fault really fired');
      assert.equal(err.code, 'unknown_commit');
      assert.equal(err.details.operation, 'commit');
      assert.equal(err.details.commitState, 'unknown');
      assert.equal(err.details.reconcilable, undefined, 'a COMMIT failure is reconcilable after the recycle');
      // The worker is already being replaced when the rejection arrives.
      assert.notEqual(host.getMetrics().state, 'ready');
      const resolved = await resolveUnknown(host, args);
      const metrics = host.getMetrics();
      assert.equal(metrics.restarts, 1);
      assert.equal(metrics.generation, generationBefore + 1, 'served by a fresh worker/connection');
      assert.equal(metrics.counters.workerLost, 1);
      if (expected === 'committed') {
        assert.deepEqual(resolved, { outcome: 'committed', result: { k: name, v: '1', applySeq: 1 } });
        assert.deepEqual(await executeCommand(host, args), { result: resolved.result, replayed: true });
      } else {
        assert.deepEqual(resolved, { outcome: 'not_committed' });
        assert.equal((await executeCommand(host, args)).replayed, false);
      }
      assert.deepEqual(await state(host, name), { value: '1', applied: 1, receipts: 1 });
      assert.equal(host.getMetrics().restarts, 1);
    });
  }

  it('two hosts (two connections) racing on one commandId apply it once', async () => {
    const first = await startHost();
    const second = await startHost();
    const args = { datasetGeneration: GEN, commandId: 'cmd-xconn', name: 'spinPut', payload: { k: 'xc', v: '1', ms: 50 } };
    const results = await Promise.all([
      executeCommand(first, args),
      executeCommand(second, args),
      executeCommand(first, args),
      executeCommand(second, args),
    ]);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    for (const r of results) assert.deepEqual(r.result, results[0].result);
    assert.deepEqual(await state(first, 'xc'), { value: '1', applied: 1, receipts: 1 });
  });

  it('refuses a new host on the same db while a timed-out close left a thread alive', async () => {
    const host = await startHost();
    const stuck = rejection(host.command('sleepNative', { seconds: 0.8 }, { commandId: 'cmd-stuck' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.close({ timeoutMs: 100 });
    const stuckErr = await stuck;
    assert.equal(stuckErr.code, 'unknown_commit');
    const next = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
    hosts.push(next);
    const refused = await rejection(next.start());
    assert.equal(refused.code, 'busy');
    assert.equal(refused.retryable, true);
    assert.equal(refused.details.operation, 'previous_worker_alive');
    assert.equal(next.getMetrics().state, 'idle', 'a refused start changes nothing');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await next.start();
        break;
      } catch (err) {
        if (err.details?.operation !== 'previous_worker_alive' || Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(next.getMetrics().state, 'ready');
  });
});
