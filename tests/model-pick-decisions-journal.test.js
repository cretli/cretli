import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-dir.js';
import {
  MODEL_PICK_JOURNAL_COMPACT_LINES,
  getModelPickRecord,
  loadModelPickRecords,
  modelPickDocumentStats,
  modelPickStoreSignature,
  purgeStaleModelPickRecords,
  releaseModelPickSlotsForDelegation,
  reserveModelPickSlot,
  resetModelPickDocumentCache,
  saveModelPickRecord,
} from '../lib/persist/model-pick-decisions-persist.js';
import { MODEL_PICK_RETENTION_MS } from '../lib/model-pick-policy.js';

const tempFile = () => path.join(makeTempDir('pick-journal-'), 'model-pick-decisions.json');
const rec = (n, extra = {}) => ({
  id: `p${n}`,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  chatId: 'c',
  picks: [{ harness: 'codex', model: 'm' }],
  ...extra,
});

test('repeated mutations append to the journal and never rewrite the snapshot', async () => {
  const file = tempFile();
  // Large legacy snapshot: must stay byte-identical across journaled mutations.
  const picks = {};
  for (let n = 0; n < 300; n += 1) picks[`old${n}`] = { id: `old${n}`, createdAt: new Date().toISOString(), picks: [{ harness: 'codex', model: 'm' }] };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, picks }));
  const snapshot = fs.readFileSync(file);
  const before = { ...modelPickDocumentStats };
  for (let n = 0; n < 50; n += 1) saveModelPickRecord(rec(n), { file });
  assert.equal((await reserveModelPickSlot({ pickId: 'p1', selectionSlot: 0, delegationId: 'd1', idempotencyKey: 'k1', file })).ok, true);
  assert.equal(releaseModelPickSlotsForDelegation({ pickId: 'p1', delegationId: 'd1', file }), true);
  assert.equal(modelPickDocumentStats.snapshotWrites - before.snapshotWrites, 0);
  assert.equal(modelPickDocumentStats.journalAppends - before.journalAppends, 52);
  assert.ok(fs.readFileSync(file).equals(snapshot), 'legacy snapshot untouched');
  assert.equal(modelPickDocumentStats.parses - before.parses, 1, 'one cold parse, then incremental');
  // Cold reload (new process view) sees snapshot + journal.
  resetModelPickDocumentCache(file);
  assert.equal(Object.keys(loadModelPickRecords({ file })).length, 350);
  assert.deepEqual(getModelPickRecord('p1', { file }).slots, {});
});

test('journal is compacted into the snapshot after the line threshold', () => {
  const file = tempFile();
  const before = modelPickDocumentStats.snapshotWrites;
  for (let n = 0; n < MODEL_PICK_JOURNAL_COMPACT_LINES + 5; n += 1) saveModelPickRecord(rec(n), { file });
  assert.equal(modelPickDocumentStats.snapshotWrites - before, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes('"p0"'));
  resetModelPickDocumentCache(file);
  assert.equal(Object.keys(loadModelPickRecords({ file })).length, MODEL_PICK_JOURNAL_COMPACT_LINES + 5);
});

test('replay ignores a torn tail and corrupt lines; the next append is not swallowed', () => {
  const file = tempFile();
  saveModelPickRecord(rec(1), { file });
  saveModelPickRecord(rec(2), { file });
  const journal = `${file}.journal`;
  fs.appendFileSync(journal, 'not json\n{"op":"put","id":"zz","row":{"id":"zz"'); // corrupt line + torn tail
  resetModelPickDocumentCache(file);
  assert.deepEqual(Object.keys(loadModelPickRecords({ file })).sort(), ['p1', 'p2']);
  saveModelPickRecord(rec(3), { file });
  resetModelPickDocumentCache(file);
  assert.deepEqual(Object.keys(loadModelPickRecords({ file })).sort(), ['p1', 'p2', 'p3']);
});

test('purge journals a removal; legacy rows stay on disk and a cold reload agrees', () => {
  const file = tempFile();
  const old = new Date(Date.now() - MODEL_PICK_RETENTION_MS - 60_000).toISOString();
  saveModelPickRecord(rec(1, { createdAt: old }), { file });
  saveModelPickRecord(rec(2), { file });
  const before = modelPickDocumentStats.snapshotWrites;
  purgeStaleModelPickRecords({ file });
  assert.equal(modelPickDocumentStats.snapshotWrites, before);
  assert.equal(getModelPickRecord('p1', { file }), null);
  resetModelPickDocumentCache(file);
  assert.deepEqual(Object.keys(loadModelPickRecords({ file })), ['p2']);
});

test('another process appending to the journal is picked up; signature covers the journal', () => {
  const file = tempFile();
  saveModelPickRecord(rec(1), { file });
  const sig = modelPickStoreSignature(file);
  fs.appendFileSync(`${file}.journal`, `${JSON.stringify({ op: 'put', id: 'ext', row: rec('ext', { id: 'ext' }) })}\n`);
  assert.notEqual(modelPickStoreSignature(file), sig);
  assert.ok(getModelPickRecord('ext', { file }), 'incremental replay of the foreign append');
  fs.appendFileSync(`${file}.journal`, `${JSON.stringify({ op: 'del', ids: ['ext'] })}\n`);
  assert.equal(getModelPickRecord('ext', { file }), null);
});

test('journal-only store (no snapshot yet) reads and survives a stale journal after compaction crash', () => {
  const file = tempFile();
  for (let n = 0; n < 3; n += 1) saveModelPickRecord(rec(n), { file });
  assert.equal(fs.existsSync(file), false);
  // Simulate crash after the snapshot write but before the journal removal.
  const journal = fs.readFileSync(`${file}.journal`);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, picks: Object.fromEntries(Object.entries(loadModelPickRecords({ file }))) }));
  fs.writeFileSync(`${file}.journal`, journal);
  resetModelPickDocumentCache(file);
  assert.equal(Object.keys(loadModelPickRecords({ file })).length, 3);
});
