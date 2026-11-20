import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  FULL_MANIFESTS_PER_CHAT,
  PROTECTED_MANIFESTS_PER_CHAT,
  STORE_MAX_BYTES,
  MAX_MANIFESTS_PER_CHAT,
  listContextSendManifests,
} from '../lib/persist/context-send-manifests-persist.js';
import {
  MODEL_PICK_MAX_RECORDS,
  applyModelPickRetention,
  createModelPickRecord,
  loadModelPickRecords,
  pruneModelPickDecisionsFile,
} from '../lib/persist/model-pick-decisions-persist.js';

test.after(() => removeIsolatedDataDir());

test('snapshot within the OLD window (100/chat, 30d) shrinks; newest manifests of active chats survive', () => {
  const snap = resolveDataPath('context-send-manifests.json');
  fs.rmSync(`${snap}.journal`, { force: true });
  fs.rmSync(`${snap}.pre-prune.bak`, { force: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const heavy = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, relPath: 'x'.repeat(200) }));
  const mk = (id, ageMs) => ({ sendId: id, kind: 'send', recordedAt: iso(now - ageMs), counts: { delivered: 1 }, entries: heavy, blocks: heavy });
  // Old policy kept all of this: 100 rows per chat, all within 30 days.
  const day = 86_400_000;
  const chats = {};
  for (let c = 0; c < 12; c += 1) {
    chats[`chat${c}`] = Array.from({ length: 100 }, (_, i) => mk(`c${c}-${i}`, (100 - i) * 0.2 * day));
  }
  chats.idle = [mk('idle-0', 20 * day)];
  fs.writeFileSync(snap, JSON.stringify({ v: 1, chats, previews: {} }));
  const oldBytes = fs.statSync(snap).size;
  assert.ok(oldBytes > STORE_MAX_BYTES);

  const list = listContextSendManifests('chat0');
  assert.ok(list.length >= PROTECTED_MANIFESTS_PER_CHAT && list.length <= MAX_MANIFESTS_PER_CHAT);
  const rewritten = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.ok(fs.statSync(snap).size < oldBytes / 5);
  assert.ok(fs.statSync(snap).size <= STORE_MAX_BYTES * 1.1);
  assert.ok(fs.existsSync(`${snap}.pre-prune.bak`));
  assert.equal(rewritten.chats.idle, undefined); // outside the 7-day window
  for (let c = 0; c < 12; c += 1) {
    const rows = rewritten.chats[`chat${c}`];
    assert.ok(rows.length >= PROTECTED_MANIFESTS_PER_CHAT && rows.length <= MAX_MANIFESTS_PER_CHAT);
    assert.equal(rows.at(-1).sendId, `c${c}-99`);
    assert.ok(rows.at(-1).entries, 'newest row keeps entries for the panel');
    const older = rows.slice(0, -FULL_MANIFESTS_PER_CHAT);
    assert.ok(older.every((r) => r.compacted && !r.entries && r.counts));
  }
});

test('model pick retention drops old rows, keeps recent/slotted, caps the count', () => {
  const now = Date.now();
  const day = 86_400_000;
  const row = (ageDays, slots = {}) => ({ createdAt: new Date(now - ageDays * day).toISOString(), slots });
  const out = applyModelPickRetention({
    fresh: row(1), openOld: row(40), slottedMid: row(40, { 0: { delegationId: 'd' } }), slottedAncient: row(200, { 0: { delegationId: 'd' } }),
  }, now);
  assert.deepEqual(Object.keys(out).sort(), ['fresh', 'slottedMid']);
  const many = {};
  for (let i = 0; i < MODEL_PICK_MAX_RECORDS + 10; i += 1) many[`p${i}`] = { createdAt: new Date(now - (MODEL_PICK_MAX_RECORDS + 10 - i) * 1000).toISOString(), slots: {} };
  const capped = applyModelPickRetention(many, now);
  assert.equal(Object.keys(capped).length, MODEL_PICK_MAX_RECORDS);
  assert.ok(capped[`p${MODEL_PICK_MAX_RECORDS + 9}`]);
  assert.ok(!capped.p0);
});

test('pruneModelPickDecisionsFile backs up before rewriting and keeps current picks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prune-'));
  const file = path.join(dir, 'model-pick-decisions.json');
  try {
    const now = Date.now();
    const keep = createModelPickRecord({ file, now, chatId: 'c', role: 'review', candidates: [{ harness: 'h', model: 'm' }], picks: [{ harness: 'h', model: 'm' }] });
    createModelPickRecord({ file, now: now - 40 * 86_400_000, chatId: 'c', role: 'review', candidates: [], picks: [] });
    const res = pruneModelPickDecisionsFile({ file, now });
    assert.equal(res.pruned, true);
    assert.ok(fs.existsSync(`${file}.pre-prune.bak`));
    assert.deepEqual(Object.keys(loadModelPickRecords({ file, now })), [keep.id]);
    assert.equal(pruneModelPickDecisionsFile({ file, now }).pruned, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
