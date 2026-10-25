/**
 * Synthetic legacy chat-history datasets for the history migration tests. No user
 * data: every record is generated here. Part of the dataset is written by the REAL
 * legacy persist code (appendChatHistoryEvents), so the migration is exercised
 * against the format the server really produces (coalescing, trimming, clientSeq
 * stamping); the rest is hand-written to cover shapes that code never emits
 * (unknown fields, sequence gaps, near-limit records).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir as makeTempDirShared } from '../helpers/temp-dir.js';

export const SYNTHETIC_IDS = Object.freeze({
  live: 'aaaaaaaa-0000-4000-8000-000000000001',
  trimmed: 'aaaaaaaa-0000-4000-8000-000000000002',
  large: 'aaaaaaaa-0000-4000-8000-000000000003',
  extras: 'aaaaaaaa-0000-4000-8000-000000000004',
  empty: 'aaaaaaaa-0000-4000-8000-000000000005',
  gaps: 'aaaaaaaa-0000-4000-8000-000000000006',
});

/** @param {number} bytes @returns {string} text whose JSON-encoded record stays at or below the target */
export function padText(bytes) {
  return 'x'.repeat(bytes);
}

/** @param {string} text @param {'delta'|'snapshot'} [mode] */
export function assistantRec(text, mode = 'delta') {
  return { kind: 'sdk', harness: 'synthetic', event: { type: 'assistant', streamTextMode: mode, message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}

/** @param {string} text */
export function userRec(text) {
  return { kind: 'localUser', text, createdAt: '2026-10-01T10:00:00.000Z' };
}

/**
 * Create a temp directory below the real OS temp dir (no symlinked ancestors).
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  return makeTempDirShared(prefix);
}

/**
 * Write the dataset into `<dataRoot>/chat-history` using the real persist module.
 * CRETLI_DATA_DIR must point at `dataRoot` before the module is first imported.
 *
 * @param {string} dataRoot
 * @returns {Promise<string>} the legacy history directory
 */
export async function buildRealLegacyDataset(dataRoot) {
  process.env.CRETLI_DATA_DIR = dataRoot;
  const persist = await import('../../lib/persist/chat-history-persist.js');
  const dir = path.join(dataRoot, 'chat-history');
  const { live, trimmed, large, empty } = SYNTHETIC_IDS;
  // live: client-keyed user turns, a coalesced stream (3 deltas -> 1 event), a retry that dedupes, a tail merge.
  persist.appendChatHistoryEvents(live, 'session-live-1', [
    { rec: userRec('first question'), clientSeq: 1 },
    { rec: { kind: 'meta', variant: 'notice', payload: 'plain payload' } },
    { rec: assistantRec('Hel') }, { rec: assistantRec('lo, '), clientSeq: 9 }, { rec: assistantRec('world') },
  ]);
  persist.appendChatHistoryEvents(live, 'session-live-1', [{ rec: userRec('first question'), clientSeq: 1 }]);
  persist.appendChatHistoryEvents(live, 'session-live-2', [{ rec: assistantRec('!') }, { rec: userRec('second'), clientSeq: 2 }]);
  // trimmed: more than 2000 events, so the oldest are dropped and headSeq keeps counting.
  for (let batch = 0; batch < 22; batch += 1) {
    persist.appendChatHistoryEvents(trimmed, 's-trim', Array.from({ length: 100 }, (_, i) => ({ rec: userRec(`t-${batch * 100 + i}`) })));
  }
  // large: 70 KiB, 200 KiB and a record right at the 256 KiB cap.
  persist.appendChatHistoryEvents(large, 's-large', [
    { rec: userRec(padText(70 * 1024)), clientSeq: 1 },
    { rec: userRec(padText(200 * 1024)), clientSeq: 2 },
  ]);
  persist.appendChatHistoryEvents(empty, '', []);
  return dir;
}

/**
 * Hand-written documents in the exact legacy writer format (JSON.stringify(doc, null, 2)).
 *
 * @param {string} dir legacy history directory (created when missing)
 * @returns {Record<string, Record<string, unknown>>} the documents by name
 */
export function writeHandmadeLegacyDocs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const exactCap = (() => {
    // Largest text that keeps JSON.stringify(rec) at exactly 256 KiB.
    const overhead = Buffer.byteLength(JSON.stringify({ ...userRec(''), clientSeq: 1 }));
    return userRec(padText(256 * 1024 - overhead));
  })();
  const docs = {
    extras: {
      v: 1, chatId: SYNTHETIC_IDS.extras, cursorSessionId: 'session-extras', headSeq: 12, updatedAt: '2026-10-02T11:22:33.444Z',
      events: [
        { seq: 3, rec: { ...userRec('with unknown record fields'), clientSeq: 5, futureField: { nested: [1, 2, { deep: true }] }, '日本語': 'ünïcode ✓' }, origin: 'legacy-tool', weight: 0.5 },
        { seq: 4, rec: assistantRec('tail') },
        { seq: 9, rec: { kind: 'meta', variant: 'banner', payload: null } },
      ],
      futureDocField: { keep: 'me' }, schemaNote: 'unknown-top-level',
    },
    gaps: {
      v: 1, chatId: SYNTHETIC_IDS.gaps, cursorSessionId: '', headSeq: 40, updatedAt: '2026-10-03T00:00:00.000Z',
      events: [4, 5, 9, 10, 31, 40].map((seq) => ({ seq, rec: userRec(`gap ${seq}`) })),
    },
    cap: {
      v: 1, chatId: 'bbbbbbbb-0000-4000-8000-000000000001', cursorSessionId: 's', headSeq: 2, updatedAt: '2026-10-03T01:00:00.000Z',
      events: [{ seq: 1, rec: { ...exactCap, clientSeq: 1 } }, { seq: 2, rec: userRec(padText(130 * 1024)) }],
    },
    empty: { v: 1, chatId: 'bbbbbbbb-0000-4000-8000-000000000002', cursorSessionId: '', headSeq: 7, updatedAt: '2026-10-03T02:00:00.000Z', events: [] },
  };
  for (const doc of Object.values(docs)) {
    fs.writeFileSync(path.join(dir, `${doc.chatId}.json`), JSON.stringify(doc, null, 2));
  }
  return docs;
}

/**
 * A directory holding the real-writer dataset plus the hand-made documents.
 *
 * @param {string} dataRoot
 * @param {string} target
 * @returns {Promise<string>} populated legacy directory (a copy under `target`)
 */
export async function copyFullSyntheticDataset(dataRoot, target) {
  const source = await buildRealLegacyDataset(dataRoot);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(target, name));
  writeHandmadeLegacyDocs(target);
  return target;
}
