import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  appendContextSendManifest,
  getContextManifestSnapshotWrites,
  listContextSendManifests,
  JOURNAL_COMPACT_LINES,
} from '../lib/persist/context-send-manifests-persist.js';

test.after(() => removeIsolatedDataDir());

test('N sends do not trigger N snapshot rewrites and survive a cold reload', () => {
  const chatId = 'chat-journal';
  listContextSendManifests(chatId); // warm the cache
  const before = getContextManifestSnapshotWrites();
  const n = 50;
  for (let i = 0; i < n; i += 1) appendContextSendManifest(chatId, { sendId: `s${i}` });
  assert.ok(getContextManifestSnapshotWrites() - before < 2);
  assert.ok(n < JOURNAL_COMPACT_LINES);
  // Journal exists, snapshot not rewritten per send.
  assert.ok(fs.existsSync(resolveDataPath('context-send-manifests.json.journal')));
  assert.equal(listContextSendManifests(chatId).length, n);
  assert.equal(appendContextSendManifest(chatId, { sendId: 's0' }), false);
});

test('journal replay restores entries when only the journal exists (torn tail ignored)', () => {
  const snap = resolveDataPath('context-send-manifests.json');
  const journal = `${snap}.journal`;
  fs.rmSync(snap, { force: true });
  const row = { sendId: 'r1', recordedAt: new Date().toISOString() };
  fs.writeFileSync(journal, `${JSON.stringify({ op: 'append', chatId: 'c2', row })}\n{"op":"app`);
  const list = listContextSendManifests('c2');
  assert.deepEqual(list.map((r) => r.sendId), ['r1']);
  // Load folded the journal into the snapshot.
  assert.ok(fs.existsSync(snap));
  assert.ok(!fs.existsSync(journal));
});

test('compaction bounds the journal and applies retention to old legacy rows', () => {
  const snap = resolveDataPath('context-send-manifests.json');
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  fs.writeFileSync(snap, JSON.stringify({ v: 1, chats: { stale: [{ sendId: 'x', recordedAt: old }] }, previews: {} }));
  assert.deepEqual(listContextSendManifests('stale'), []);
  for (let i = 0; i < JOURNAL_COMPACT_LINES + 5; i += 1) appendContextSendManifest('c3', { sendId: `k${i}` });
  const data = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.ok(!('stale' in data.chats));
  assert.ok(data.chats.c3.length > 0);
});
