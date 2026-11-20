import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { getWriteStats, resetWriteStats } from '../lib/persist/atomic-write.js';
import {
  appendContextSendManifest,
  getContextManifestSnapshotWrites,
  getContextPreviewMarker,
  listContextSendManifests,
  setContextPreviewMarker,
  JOURNAL_COMPACT_LINES,
} from '../lib/persist/context-send-manifests-persist.js';

test.after(() => removeIsolatedDataDir());

test('N sends do not trigger N snapshot rewrites and survive a cold reload', () => {
  resetWriteStats();
  const chatId = 'chat-journal';
  listContextSendManifests(chatId); // warm the cache
  const before = getContextManifestSnapshotWrites();
  const n = 15; // stays under MAX_MANIFESTS_PER_CHAT
  for (let i = 0; i < n; i += 1) appendContextSendManifest(chatId, { sendId: `s${i}` });
  assert.ok(getContextManifestSnapshotWrites() - before < 2);
  assert.ok(n < JOURNAL_COMPACT_LINES);
  // Journal exists, snapshot not rewritten per send.
  assert.ok(fs.existsSync(resolveDataPath('context-send-manifests.json.journal')));
  const journalStats = getWriteStats().rows.find((row) => row.key === 'context-send-manifests.json.journal');
  assert.equal(journalStats?.writes, n);
  assert.equal(journalStats?.bytes, fs.statSync(resolveDataPath('context-send-manifests.json.journal')).size);
  assert.equal(listContextSendManifests(chatId).length, n);
  assert.equal(appendContextSendManifest(chatId, { sendId: 's0' }), false);
});

test('identical preview markers are no-ops; a changed marker still journals and survives reload', async () => {
  const chatId = `chat-preview-${Date.now()}`;
  // A recent timestamp: previews older than MANIFEST_MAX_AGE_MS (7 days) are pruned on reload.
  const marker = { revision: 'rev-1', adapter: 'a', previewedAt: new Date(Date.now() - 60_000).toISOString() };
  const journal = resolveDataPath('context-send-manifests.json.journal');
  const size = () => (fs.existsSync(journal) ? fs.statSync(journal).size : 0);
  const writes = getContextManifestSnapshotWrites();
  const start = size();
  setContextPreviewMarker(chatId, marker);
  const afterFirst = size();
  assert.ok(afterFirst > start, 'first marker is journaled');
  setContextPreviewMarker(chatId, { ...marker });
  setContextPreviewMarker(chatId, { ...marker });
  assert.equal(size(), afterFirst, 'identical markers append nothing');
  const changed = { ...marker, revision: 'rev-2' };
  setContextPreviewMarker(chatId, changed);
  assert.ok(size() > afterFirst, 'changed marker is journaled');
  assert.equal(getContextManifestSnapshotWrites(), writes, 'no snapshot rewrite for markers');
  const cold = await import(`../lib/persist/context-send-manifests-persist.js?cold=${Date.now()}`);
  assert.deepEqual(cold.getContextPreviewMarker(chatId), changed, 'changed marker replays after a cold module reload');
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
