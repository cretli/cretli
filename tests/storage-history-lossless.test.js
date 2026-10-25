import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeTempDir } from './fixtures/storage-history-synthetic.js';
import { applyLegacyImport, planLegacyImport } from '../lib/storage/history-import.js';
import { applyRollbackExport, planRollbackExport } from '../lib/storage/history-rollback.js';
import {
  normalizeLegacyHistory, parseStrictJson, readLegacyHistoryFile, toLegacyDocumentObject,
} from '../lib/storage/history-legacy-format.js';
import { ensureSidecarTables, readChatAsLegacy } from '../lib/storage/history-sidecar.js';

const GENERATION = 'generation-lossless-1';
const CHAT = 'cccccccc-0000-4000-8000-000000000001';

// Hand-written text: an object literal with `__proto__` would set a prototype instead of an own key.
const TRICKY_TEXT = `{"events":[{"origin":"x","__proto__":{"evt":1},"rec":{"kind":"localUser","text":"hi","createdAt":"2026-10-04T00:00:00.000Z","__proto__":{"inRec":[1,{"__proto__":2}]},"constructor":{"prototype":{"p":1}},"prototype":null},"seq":2,"constructor":"evt-ctor"},{"seq":5,"rec":{"kind":"localUser","text":"b","createdAt":"2026-10-04T00:00:00.000Z"},"prototype":[1,2]}],"updatedAt":"2026-10-04T00:00:01.000Z","headSeq":6,"cursorSessionId":"s","chatId":"${CHAT}","v":1,"__proto__":{"doc":true},"constructor":{"a":1},"prototype":"doc-proto","nested":{"__proto__":{"deep":1}}}`;

let work;
before(() => { work = makeTempDir('cretli-lossless-'); });
after(() => { fs.rmSync(work, { recursive: true, force: true }); });

describe('strict losslessness against the raw parse tree', () => {
  it('keeps __proto__, constructor and prototype keys at document, event and record level', () => {
    const raw = parseStrictJson(TRICKY_TEXT);
    assert.ok(Object.hasOwn(raw, '__proto__'));
    const doc = normalizeLegacyHistory(raw);
    for (const key of ['__proto__', 'constructor', 'prototype', 'nested']) assert.ok(Object.hasOwn(doc.docExtra, key), key);
    assert.deepEqual(Object.keys(doc.events[0].extra).sort(), ['__proto__', 'constructor', 'origin']);
    assert.deepEqual(Object.keys(doc.events[1].extra), ['prototype']);
    assert.ok(Object.hasOwn(doc.events[0].rec, '__proto__'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(toLegacyDocumentObject(doc))), JSON.parse(TRICKY_TEXT));
    assert.equal(Object.getPrototypeOf(doc.docExtra), Object.prototype, 'no prototype pollution');
  });

  it('survives import -> store -> read and the rollback export, compared with the raw parse tree', () => {
    const legacyDir = path.join(work, 'legacy');
    fs.mkdirSync(legacyDir);
    // Compact, reordered, with a trailing newline: valid for the strict reader but not the legacy writer's layout.
    fs.writeFileSync(path.join(legacyDir, `${CHAT}.json`), `${TRICKY_TEXT}\n`);
    const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
    assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
    const staging = path.join(work, 'staging');
    applyLegacyImport({ legacyDir, stagingOut: staging, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash });
    const storeDir = path.join(work, 'store');
    fs.mkdirSync(storeDir);
    fs.copyFileSync(path.join(staging, 'cretli-store.sqlite'), path.join(storeDir, 'cretli-store.sqlite'));
    const db = new DatabaseSync(path.join(storeDir, 'cretli-store.sqlite'));
    const read = readChatAsLegacy(db, CHAT);
    db.close();
    const expected = JSON.parse(TRICKY_TEXT);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(toLegacyDocumentObject(read.doc))), expected);
    const exportPlan = planRollbackExport({ storeDir });
    const out = path.join(work, 'rollback');
    const result = applyRollbackExport({ storeDir, legacyOut: out, confirmPlanHash: exportPlan.planHash });
    const exportedText = fs.readFileSync(path.join(out, 'legacy-chat-history', `${CHAT}.json`), 'utf8');
    assert.deepStrictEqual(JSON.parse(exportedText), expected);
    assert.notEqual(exportedText, `${TRICKY_TEXT}\n`, 'formatting is not preserved; only logical content is');
    assert.equal(result.manifest.chats[0].matchesImportDigest, true);
    assert.equal(result.manifest.chats[0].unchangedSinceImport, true);
    assert.ok(Object.hasOwn(readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${CHAT}.json`)).doc.docExtra, '__proto__'));
  });
});

describe('unchangedSinceImport is a durable revision marker, not wall-clock time', () => {
  /** @returns {{ db: DatabaseSync, dbPath: string }} */
  function stagedCopy(name) {
    const dir = path.join(work, name);
    fs.mkdirSync(dir);
    const dbPath = path.join(dir, 'cretli-store.sqlite');
    fs.copyFileSync(path.join(work, 'staging', 'cretli-store.sqlite'), dbPath);
    return { db: new DatabaseSync(dbPath), dbPath };
  }

  it('a write in the same millisecond as the import is a modification', () => {
    const { db } = stagedCopy('same-ms');
    assert.equal(readChatAsLegacy(db, CHAT).unchangedSinceImport, true);
    // Same updated_at as the import, but a later revision/next_seq (an append or coalesce).
    db.prepare('UPDATE chat_history_state SET revision = revision + 1 WHERE chat_id = ?').run(CHAT);
    assert.equal(readChatAsLegacy(db, CHAT).unchangedSinceImport, false);
    db.prepare('UPDATE chat_history_state SET revision = revision - 1, next_seq = next_seq + 1 WHERE chat_id = ?').run(CHAT);
    assert.equal(readChatAsLegacy(db, CHAT).unchangedSinceImport, false);
    db.close();
  });

  it('a reset (new epoch, revision 0 -> same counters again) is a modification', () => {
    const { db } = stagedCopy('reset');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("UPDATE chat_history_state SET chat_epoch = 'epoch-after-reset' WHERE chat_id = ?").run(CHAT);
    assert.equal(readChatAsLegacy(db, CHAT).unchangedSinceImport, false);
    db.close();
  });

  it('a sidecar from another format version fails closed', () => {
    const dbPath = path.join(work, 'old-sidecar.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE legacy_import_chat (chat_id TEXT PRIMARY KEY, source_sha256 TEXT) STRICT;
      CREATE TABLE legacy_import_meta (id INTEGER PRIMARY KEY, format_version INTEGER) STRICT;
      CREATE TABLE legacy_import_event_extra (chat_id TEXT, seq INTEGER, extra_json TEXT) STRICT;`);
    assert.throws(() => ensureSidecarTables(db), (error) => error.code === 'sidecar_format_unsupported');
    db.close();
  });
});
