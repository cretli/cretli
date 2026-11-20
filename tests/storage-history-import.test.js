import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  SYNTHETIC_IDS, copyFullSyntheticDataset, makeTempDir, padText, userRec, writeHandmadeLegacyDocs,
} from './fixtures/storage-history-synthetic.js';
import { applyLegacyImport, planLegacyImport, verifyImportStaging } from '../lib/storage/history-import.js';
import { digestLegacyDocument, normalizeLegacyHistory, readLegacyHistoryFile } from '../lib/storage/history-legacy-format.js';
import { openImmutableDatabase } from '../lib/storage/history-migration-fs.js';
import { readChatAsLegacy } from '../lib/storage/history-sidecar.js';
import { HISTORY_MAX_LARGE_RECORD_BYTES, HISTORY_MAX_RECORD_BYTES } from '../lib/storage/chat-history-store.js';

const GENERATION = 'generation-import-1';
const CRASH_CHILD = fileURLToPath(new URL('./fixtures/storage-history-crash-child.js', import.meta.url));
const dataRoot = makeTempDir('cretli-hist-data-');
let seedDir;
let work;
let legacyDir;
let out;

before(async () => {
  seedDir = await copyFullSyntheticDataset(dataRoot, path.join(makeTempDir('cretli-hist-seed-'), 'chat-history'));
});

after(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(path.dirname(seedDir), { recursive: true, force: true });
});

beforeEach(() => {
  work = makeTempDir('cretli-hist-work-');
  legacyDir = path.join(work, 'legacy');
  fs.mkdirSync(legacyDir);
  for (const name of fs.readdirSync(seedDir)) fs.copyFileSync(path.join(seedDir, name), path.join(legacyDir, name));
  out = path.join(work, 'staging');
});

/** @param {string} dir @returns {Record<string, string>} name -> sha256 of every file (for "source untouched" checks) */
function snapshotDir(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const stat = fs.lstatSync(path.join(dir, name));
    result[name] = stat.isFile() ? `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(path.join(dir, name)).toString('base64').length}` : 'not-file';
  }
  return result;
}

/** @param {string} name @param {string} content */
function putFile(name, content) {
  fs.writeFileSync(path.join(legacyDir, name), content);
}

/** @param {ReturnType<typeof planLegacyImport>} plan */
function apply(plan, extra = {}) {
  return applyLegacyImport({ legacyDir, stagingOut: out, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash, ...extra });
}

describe('legacy history plan (read-only, strict)', () => {
  it('plans the synthetic dataset without writing anything', () => {
    const before = snapshotDir(legacyDir);
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
    assert.equal(plan.totals.chats, 8);
    assert.deepEqual(snapshotDir(legacyDir), before);
    assert.deepEqual(fs.readdirSync(work).sort(), ['legacy']);
    assert.equal(plan.planHash, planLegacyImport({ legacyDir, datasetGeneration: GENERATION }).planHash, 'deterministic');
    assert.notEqual(plan.planHash, planLegacyImport({ legacyDir, datasetGeneration: 'generation-other' }).planHash);
    const trimmed = plan.files.find((file) => file.chatId === SYNTHETIC_IDS.trimmed);
    assert.equal(trimmed.events, 2000);
    assert.equal(trimmed.headSeq, 2200);
    assert.equal(trimmed.firstSeq, 201);
  });

  const corrupt = [
    ['truncated JSON', '{"v":1,"chatId":"cccccccc-0000-4000-8000-000000000001","events":[', 'legacy_invalid_json'],
    ['byte order mark', '﻿{}', 'legacy_invalid_json'],
    ['duplicate key', '{"v":1,"v":1,"chatId":"cccccccc-0000-4000-8000-000000000001","cursorSessionId":"","headSeq":0,"updatedAt":"","events":[]}', 'legacy_duplicate_key'],
    ['duplicate key via escape', '{"v":1,"chatId":"cccccccc-0000-4000-8000-000000000001","cursorSessionId":"","headSeq":0,"updatedAt":"","events":[],"a":1,"\\u0061":2}', 'legacy_duplicate_key'],
    ['not an object', '[]', 'legacy_not_object'],
    ['wrong version', JSON.stringify({ v: 2, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 0, updatedAt: '', events: [] }), 'legacy_unsupported_version'],
    ['missing field', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', headSeq: 0, updatedAt: '', events: [] }), 'legacy_doc_field_missing'],
    ['wrong field type', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: 5, headSeq: 0, updatedAt: '', events: [] }), 'legacy_doc_field_type'],
    ['headSeq as string', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: '3', updatedAt: '', events: [] }), 'legacy_doc_field_type'],
    ['file name mismatch', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000999', cursorSessionId: '', headSeq: 0, updatedAt: '', events: [] }), 'legacy_chat_id_mismatch'],
    ['descending seq', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 5, updatedAt: '', events: [{ seq: 3, rec: userRec('a') }, { seq: 2, rec: userRec('b') }] }), 'legacy_seq_not_ascending'],
    ['invalid record the legacy loader would silently drop', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 2, updatedAt: '', events: [{ seq: 1, rec: userRec('ok') }, { seq: 2, rec: { kind: 'bogus' } }] }), 'legacy_invalid_record'],
    ['headSeq behind last seq', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 1, updatedAt: '', events: [{ seq: 2, rec: userRec('a') }] }), 'legacy_head_seq_behind'],
    ['record over the large-record cap', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 1, updatedAt: '', events: [{ seq: 1, rec: userRec(padText(HISTORY_MAX_LARGE_RECORD_BYTES)) }] }), 'legacy_record_too_large'],
    ['duplicate clientSeq', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 2, updatedAt: '', events: [{ seq: 1, rec: { ...userRec('a'), clientSeq: 4 } }, { seq: 2, rec: { ...userRec('b'), clientSeq: 4 } }] }), 'legacy_duplicate_client_seq'],
    ['non-integer clientSeq', JSON.stringify({ v: 1, chatId: 'cccccccc-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 1, updatedAt: '', events: [{ seq: 1, rec: { ...userRec('a'), clientSeq: 1.5 } }] }), 'legacy_client_seq_invalid'],
  ];
  for (const [label, content, code] of corrupt) {
    it(`refuses (${label}) with ${code} and never repairs`, () => {
      putFile('cccccccc-0000-4000-8000-000000000001.json', content);
      const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
      assert.equal(plan.ok, false);
      assert.deepEqual(plan.refusals.map((r) => [r.file, r.code]), [['cccccccc-0000-4000-8000-000000000001.json', code]]);
      assert.throws(() => apply(plan), (error) => error.code === 'plan_refused');
      assert.equal(fs.existsSync(out), false);
      assert.equal(fs.existsSync(`${out}.partial`), false);
    });
  }

  it('refuses invalid UTF-8, a symlinked file, unexpected entries and an oversized file', () => {
    putFile('dddddddd-0000-4000-8000-000000000001.json', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    fs.symlinkSync(path.join(legacyDir, SYNTHETIC_IDS.live + '.json'), path.join(legacyDir, 'dddddddd-0000-4000-8000-000000000002.json'));
    fs.mkdirSync(path.join(legacyDir, 'subdir'));
    putFile('notes.txt', 'x');
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION, maxFileBytes: 100 * 1024 });
    const byFile = Object.fromEntries(plan.refusals.map((r) => [r.file, r.code]));
    assert.equal(byFile['dddddddd-0000-4000-8000-000000000001.json'], 'legacy_invalid_utf8');
    assert.equal(byFile['dddddddd-0000-4000-8000-000000000002.json'], 'legacy_not_regular_file');
    assert.equal(byFile.subdir, 'legacy_unexpected_entry');
    assert.equal(byFile['notes.txt'], 'legacy_unexpected_entry');
    assert.equal(byFile[`${SYNTHETIC_IDS.trimmed}.json`], 'legacy_file_too_large');
  });

  it('reports interrupted-write temp files instead of importing them, and refuses a recently modified source', () => {
    putFile(`${SYNTHETIC_IDS.live}.json.4242.1767225600000.tmp`, '{"half":');
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.ignored.map((item) => item.file), [`${SYNTHETIC_IDS.live}.json.4242.1767225600000.tmp`]);
    const quiet = planLegacyImport({ legacyDir, datasetGeneration: GENERATION, minQuietMs: 3_600_000 });
    assert.equal(quiet.ok, false);
    assert.ok(quiet.refusals.every((r) => r.code === 'legacy_recently_modified'));
  });

  it('requires a valid dataset generation', () => {
    assert.throws(() => planLegacyImport({ legacyDir, datasetGeneration: 'has space' }), (e) => e.code === 'dataset_generation_invalid');
  });
});

describe('staging import (apply)', () => {
  it('stages every chat losslessly, keeps seq/headSeq/retention/unknown fields and leaves the source untouched', () => {
    const sourceBefore = snapshotDir(legacyDir);
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    const result = apply(plan);
    assert.deepEqual(snapshotDir(legacyDir), sourceBefore, 'sources are read-only');
    assert.deepEqual(fs.readdirSync(work).sort(), ['legacy', 'staging'], 'no partial left behind');
    assert.deepEqual(fs.readdirSync(out).sort(), ['cretli-store.sqlite', 'manifest.json']);
    assert.equal(result.manifest.validation.logicalCompare, 'ok');
    const verified = verifyImportStaging({ stagingDir: out, legacyDir });
    assert.equal(verified.chats, plan.files.length);
    assert.equal(verified.sourceChecked, plan.files.length);

    const db = openImmutableDatabase(path.join(out, 'cretli-store.sqlite'));
    try {
      for (const file of plan.files) {
        const source = readLegacyHistoryFile(path.join(legacyDir, file.file));
        const stored = readChatAsLegacy(db, file.chatId);
        assert.equal(digestLegacyDocument(stored.doc), digestLegacyDocument(source.doc), file.chatId);
        assert.deepEqual(stored.doc.events.map((e) => e.seq), source.doc.events.map((e) => e.seq));
        assert.equal(stored.doc.headSeq, source.doc.headSeq);
        assert.equal(stored.doc.updatedAt, source.doc.updatedAt);
        assert.equal(stored.doc.cursorSessionId, source.doc.cursorSessionId);
      }
      const trimmed = db.prepare('SELECT * FROM chat_history_state WHERE chat_id = ?').get(SYNTHETIC_IDS.trimmed);
      assert.equal(trimmed.next_seq, 2201);
      assert.equal(trimmed.trimmed_through_seq, 200);
      assert.equal(trimmed.retention_limit, 2000);
      assert.equal(trimmed.revision, 2000);
      assert.equal(trimmed.dataset_generation, GENERATION);
      const gaps = db.prepare('SELECT seq FROM chat_history_events WHERE chat_id = ? ORDER BY seq').all(SYNTHETIC_IDS.gaps).map((r) => r.seq);
      assert.deepEqual(gaps, [4, 5, 9, 10, 31, 40]);
      const empty = db.prepare('SELECT * FROM chat_history_state WHERE chat_id = ?').get('bbbbbbbb-0000-4000-8000-000000000002');
      assert.deepEqual([empty.next_seq, empty.trimmed_through_seq, empty.revision], [8, 7, 0]);
      const producer = db.prepare('SELECT status FROM chat_history_producers WHERE chat_id = ?').get(SYNTHETIC_IDS.live);
      assert.equal(producer.status, 'retired', 'the import producer cannot be forged');
      const dedupe = db.prepare('SELECT client_seq, event_seq FROM chat_history_dedupe WHERE chat_id = ? ORDER BY client_seq').all(SYNTHETIC_IDS.live);
      // clientSeq 9 was coalesced into an earlier stream event by the legacy writer and never stored: the ledger mirrors what the file holds.
      assert.deepEqual(dedupe.map((r) => r.client_seq), [1, 2]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n, 0);
    } finally {
      db.close();
    }
  });

  it('keeps near-limit records (64-256 KiB) byte-exact', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    apply(plan);
    const db = openImmutableDatabase(path.join(out, 'cretli-store.sqlite'));
    try {
      const sizes = db.prepare('SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM chat_history_events WHERE chat_id IN (?, ?) ORDER BY bytes DESC')
        .all(SYNTHETIC_IDS.large, 'bbbbbbbb-0000-4000-8000-000000000001').map((r) => r.bytes);
      assert.equal(sizes[0], HISTORY_MAX_RECORD_BYTES, 'the record exactly at the cap is stored without truncation');
      assert.ok(sizes.some((b) => b > 200 * 1024) && sizes.some((b) => b > 64 * 1024 && b < 130 * 1024 + 512));
    } finally {
      db.close();
    }
  });

  it('refuses a wrong plan hash, an existing output, an output inside the source and a symlinked output parent', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.throws(() => apply({ planHash: 'sha256-wrong' }), (e) => e.code === 'plan_hash_mismatch');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep.txt'), 'precious');
    assert.throws(() => apply(plan), (e) => e.code === 'output_exists');
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'precious', 'existing targets are never overwritten');
    assert.throws(() => applyLegacyImport({ legacyDir, stagingOut: path.join(legacyDir, 'inside'), datasetGeneration: GENERATION, confirmPlanHash: plan.planHash }),
      (e) => e.code === 'path_overlaps_source');
    assert.throws(() => applyLegacyImport({ legacyDir, stagingOut: legacyDir, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash }),
      (e) => e.code === 'path_overlaps_source');
    const link = path.join(work, 'link');
    fs.mkdirSync(path.join(work, 'real'));
    fs.symlinkSync(path.join(work, 'real'), link);
    assert.throws(() => applyLegacyImport({ legacyDir, stagingOut: path.join(link, 'staging'), datasetGeneration: GENERATION, confirmPlanHash: plan.planHash }),
      (e) => e.code === 'path_symlink');
    assert.throws(() => planLegacyImport({ legacyDir: link, datasetGeneration: GENERATION }), (e) => e.code === 'path_symlink');
    assert.throws(() => planLegacyImport({ legacyDir: path.join(work, 'missing'), datasetGeneration: GENERATION }), (e) => e.code === 'path_missing');
  });

  it('refuses when the source changed after the plan, before anything is written', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    const file = path.join(legacyDir, `${SYNTHETIC_IDS.live}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.events.push({ seq: doc.headSeq + 1, rec: userRec('written after the plan') });
    doc.headSeq += 1;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    assert.throws(() => apply(plan), (e) => e.code === 'plan_hash_mismatch');
    assert.equal(fs.existsSync(`${out}.partial`), false);
  });

  it('detects a source that changes DURING the import and keeps nothing published', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    const victim = path.join(legacyDir, `${SYNTHETIC_IDS.trimmed}.json`);
    assert.throws(() => apply(plan, {
      faultHook(point, info) {
        if (point === 'chat-committed' && info.index === 0) fs.appendFileSync(victim, '\n');
      },
    }), (e) => e.code === 'source_changed_since_plan');
    assert.equal(fs.existsSync(out), false, 'nothing is published from a drifting source');
  });
});

describe('crash safety and resume', () => {
  it('a throw inside a chat transaction leaves no half-imported chat; resume completes to the same result', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    const clean = apply(plan, { stagingOut: path.join(work, 'clean') });
    out = path.join(work, 'resumed');
    let committed = 0;
    assert.throws(() => apply(plan, {
      faultHook(point) {
        if (point === 'chat-committed') committed += 1;
        if (point === 'chat-before-commit' && committed === 3) throw new Error('simulated crash before COMMIT');
      },
    }), /simulated crash/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(`${out}.partial`), true);
    const partialDb = new DatabaseSync(path.join(`${out}.partial`, 'cretli-store.sqlite'), { readOnly: true });
    assert.equal(partialDb.prepare('SELECT count(*) AS n FROM chat_history_state').get().n, 3, 'the chat that crashed was rolled back');
    partialDb.close();
    assert.throws(() => apply(plan), (e) => e.code === 'staging_partial_exists');
    const resumed = apply(plan, { resume: true });
    assert.equal(resumed.resumedChats, 3);
    assert.deepEqual(resumed.manifest.chats, clean.manifest.chats);
    assert.equal(verifyImportStaging({ stagingDir: out, legacyDir }).ok, true);
  });

  it('survives a real SIGKILL of the importing process and resumes', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    const args = JSON.stringify({ legacyDir, stagingOut: out, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash, killAfterChats: 4 });
    const child = spawnSync(process.execPath, [CRASH_CHILD, args], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(path.join(`${out}.partial`, 'MIGRATION-INCOMPLETE.json')), true);
    const resumed = apply(plan, { resume: true });
    assert.equal(resumed.resumedChats >= 4, true);
    const verified = verifyImportStaging({ stagingDir: out, legacyDir });
    assert.equal(verified.chats, plan.files.length);
    const clean = apply(plan, { stagingOut: path.join(work, 'clean') });
    assert.deepEqual(resumed.manifest.chats, clean.manifest.chats, 'crash + resume is logically identical to an uninterrupted run');
  });

  it('refuses to resume a partial of another plan or generation, and to resume nothing', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.throws(() => apply(plan, { resume: true }), (e) => e.code === 'staging_partial_missing');
    assert.throws(() => apply(plan, { faultHook(point) { if (point === 'after-marker') throw new Error('stop'); } }), /stop/);
    const other = planLegacyImport({ legacyDir, datasetGeneration: 'generation-different' });
    assert.throws(() => applyLegacyImport({ legacyDir, stagingOut: out, datasetGeneration: 'generation-different', confirmPlanHash: other.planHash, resume: true }),
      (e) => e.code === 'staging_partial_mismatch');
    assert.equal(apply(plan, { resume: true }).manifest.totals.chats, plan.files.length);
  });

  it('verify-import detects tampering with the staged database and with the manifest', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    apply(plan);
    const manifestPath = path.join(out, 'manifest.json');
    const original = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(manifestPath, original.replace(`"${GENERATION}"`, '"generation-forged"'));
    assert.throws(() => verifyImportStaging({ stagingDir: out }), (e) => e.code === 'manifest_hash_mismatch');
    fs.writeFileSync(manifestPath, original);
    const db = new DatabaseSync(path.join(out, 'cretli-store.sqlite'));
    db.exec(`UPDATE chat_history_events SET payload_json = json_set(payload_json, '$.text', 'tampered') WHERE chat_id = '${SYNTHETIC_IDS.gaps}' AND seq = 4`);
    db.close();
    assert.throws(() => verifyImportStaging({ stagingDir: out }), (e) => e.code === 'db_hash_mismatch');
  });
});

describe('strict reader details', () => {
  it('keeps lone surrogates and numeric edge values logically intact', () => {
    const doc = { v: 1, chatId: 'eeeeeeee-0000-4000-8000-000000000001', cursorSessionId: '', headSeq: 1, updatedAt: '',
      events: [{ seq: 1, rec: { ...userRec('\ud800 lone'), n: 1e21, z: 0 } }] };
    const normalized = normalizeLegacyHistory(JSON.parse(JSON.stringify(doc)), { expectedChatId: doc.chatId });
    assert.equal(normalized.events[0].rec.text, '\ud800 lone');
  });

  it('writeHandmadeLegacyDocs fixture matches the legacy writer format', () => {
    const docs = writeHandmadeLegacyDocs(path.join(work, 'hand'));
    const raw = fs.readFileSync(path.join(work, 'hand', `${docs.extras.chatId}.json`), 'utf8');
    assert.equal(raw, JSON.stringify(docs.extras, null, 2));
  });
});

describe('F14 import hardening', () => {
  const ID = 'cccccccc-0000-4000-8000-000000000001';
  const doc = (chatId, headSeq, seqs) => JSON.stringify({
    v: 1, chatId, cursorSessionId: '', headSeq, updatedAt: '', events: seqs.map((seq) => ({ seq, rec: userRec(`m${seq}`) })),
  });

  it('quarantines a chat id claimed twice instead of importing both', () => {
    putFile(`${ID}.json`, doc(ID, 1, [1]));
    const upper = ID.replace('cccccccc', 'CCCCCCCC');
    putFile(`${upper}.json`, doc(upper, 1, [1]));
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.equal(plan.ok, true);
    assert.equal(plan.quarantined.length, 1);
    assert.equal(plan.quarantined[0].file, `${ID}.json`);
    assert.equal(plan.files.filter((f) => f.chatId.toLowerCase() === ID).length, 1);
  });

  it('rejects a seq above the upper limit', () => {
    putFile(`${ID}.json`, doc(ID, 100, [1, 100]));
    const refusalFor = (plan) => plan.refusals.find((r) => r.file === `${ID}.json`)?.code;
    assert.equal(refusalFor(planLegacyImport({ legacyDir, datasetGeneration: GENERATION, maxSeq: 50 })), 'legacy_seq_over_limit');
    assert.equal(refusalFor(planLegacyImport({ legacyDir, datasetGeneration: GENERATION })), undefined);
    putFile(`${ID}.json`, doc(ID, 3_000_000_000, [1]));
    assert.equal(refusalFor(planLegacyImport({ legacyDir, datasetGeneration: GENERATION })), 'legacy_seq_over_limit');
  });

  it('detects a last_seq mismatch between the store and the source during apply', () => {
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.throws(() => apply(plan, {
      faultHook(point) {
        if (point !== 'before-verify') return;
        const db = new DatabaseSync(path.join(`${out}.partial`, 'cretli-store.sqlite'));
        try {
          db.exec('PRAGMA foreign_keys = OFF');
          db.prepare('UPDATE chat_history_events SET seq = seq + 1 WHERE chat_id = ? AND seq = (SELECT max(seq) FROM chat_history_events WHERE chat_id = ?)').run(SYNTHETIC_IDS.live, SYNTHETIC_IDS.live);
        } finally {
          db.close();
        }
      },
    }), (error) => ['verify_last_seq_mismatch', 'verify_chat_missing'].includes(error.code));
    assert.equal(fs.existsSync(out), false);
  });
});
