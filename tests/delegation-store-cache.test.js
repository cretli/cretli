/**
 * JSON delegation store: a write re-seeds the document cache (no re-parse on
 * the next read), reads see the write through every accessor, and callers
 * cannot mutate cached rows through returned records.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDelegationRecord,
  getDelegationById,
  listDelegationsForChat,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';

test.after(() => removeIsolatedDataDir());

test('write-then-read does not re-parse the store and stays isolated', () => {
  assert.ok(ISOLATED_DATA_DIR);
  const created = createDelegationRecord({
    id: 'cache-a',
    parentChatId: 'chat-cache',
    harness: 'claude',
    model: 'm',
    task: 't',
  });
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    // Single-row parses by id are expected; only a whole-document parse counts.
    if (String(args[0]).includes('"items"')) parses += 1;
    return realParse(...args);
  };
  try {
    assert.equal(getDelegationById('cache-a')?.id, 'cache-a');
    assert.equal(listDelegationsForChat('chat-cache').length, 1);
    created.status = 'tampered';
    created.attempts?.push({ id: 'x' });
    assert.notEqual(getDelegationById('cache-a')?.status, 'tampered');
    const next = updateDelegationRecord('cache-a', { status: 'running' });
    next.status = 'tampered';
    assert.equal(getDelegationById('cache-a')?.status, 'running');
    assert.equal(listDelegationsForChat('chat-cache')[0].status, 'running');
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(parses, 0);
});

test('batch update rewrites the store once and applies every patch', async () => {
  const { default: fs } = await import('node:fs');
  const { updateDelegationRecordsBatch } = await import('../lib/persist/delegations-persist.js');
  for (const id of ['batch-a', 'batch-b', 'batch-c']) {
    createDelegationRecord({ id, parentChatId: 'chat-batch', harness: 'claude', model: 'm', task: 't' });
  }
  const realWrite = fs.writeFileSync;
  let storeWrites = 0;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file).includes('delegations.json')) storeWrites += 1;
    return realWrite(file, ...rest);
  };
  let updated;
  try {
    updated = updateDelegationRecordsBatch([
      { id: 'batch-a', patch: { sourceText: 'a' } },
      { id: 'batch-b', patch: { sourceText: 'b' } },
      { id: 'missing', patch: { sourceText: 'x' } },
    ]);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(updated, 2);
  assert.equal(storeWrites, 1);
  assert.equal(getDelegationById('batch-a')?.sourceText, 'a');
  assert.equal(getDelegationById('batch-b')?.sourceText, 'b');
  assert.notEqual(getDelegationById('batch-c')?.sourceText, 'a');
});

test('delivered outbox snapshots shrink to ids; pending ones stay whole', () => {
  createDelegationRecord({
    id: 'slim-a',
    parentChatId: 'chat-slim',
    harness: 'claude',
    model: 'm',
    task: 't',
    outbox: [
      { id: 'o-done', type: 'mailbox', attemptId: 'a1', deliveredAt: '2026-01-01T00:00:00.000Z', snapshot: { attemptId: 'a1', eventId: 'e1', report: 'x'.repeat(5000) } },
      { id: 'o-pending', type: 'mailbox', attemptId: 'a1', deliveredAt: '', snapshot: { attemptId: 'a1', eventId: 'e1', report: 'keep me' } },
    ],
  });
  const row = getDelegationById('slim-a');
  const done = row.outbox.find((item) => item.id === 'o-done');
  const pending = row.outbox.find((item) => item.id === 'o-pending');
  assert.deepEqual(done.snapshot, { attemptId: 'a1', eventId: 'e1' });
  assert.equal(done.deliveredAt, '2026-01-01T00:00:00.000Z');
  assert.equal(pending.snapshot.report, 'keep me');
});

test('verifyResult keeps output tails only for failing checks', () => {
  createDelegationRecord({ id: 'verify-a', parentChatId: 'chat-verify', harness: 'claude', model: 'm', task: 't' });
  updateDelegationRecord('verify-a', {
    verifyResult: {
      status: 'failed',
      exitCode: 1,
      baseline: { source: 'none' },
      results: [
        { id: 'pass', ok: true, durationMs: 1, outputTail: 'noise' },
        { id: 'fail', ok: false, durationMs: 1, outputTail: 'boom' },
      ],
    },
  });
  const { results } = getDelegationById('verify-a').verifyResult;
  assert.deepEqual(results.map((r) => [r.id, r.outputTail]), [['pass', ''], ['fail', 'boom']]);
});
