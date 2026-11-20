import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARCHIVE_CONTRACT_REVISION,
  ARCHIVE_LIMITS_V1,
  ARCHIVE_PROFILES,
  ARCHIVE_STORE_IDS,
  REGISTRY_CAPABILITY_FIELDS,
  validateArchiveTotals,
  validatePreMigrationRestorePreview,
  validateStoreRegistryEntry,
} from '../lib/backup/archive-contract.js';
import {
  validateArchiveDocument,
  validateArchiveDocumentAuto,
} from '../lib/backup/validate-archive-document.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'backup');

/**
 * @param {string} name
 * @returns {unknown}
 */
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

test('ARCHIVE_PROFILES and store IDs are frozen contract surfaces', () => {
  assert.deepEqual(ARCHIVE_PROFILES, [
    'portable-settings-v1',
    'conversations-v1',
    'data-backup-v1',
  ]);
  assert.ok(ARCHIVE_STORE_IDS.includes('recovery'));
  assert.ok(ARCHIVE_STORE_IDS.includes('chat-history'));
  assert.equal(ARCHIVE_CONTRACT_REVISION, '2026-10-13.1');
  assert.ok(ARCHIVE_LIMITS_V1.maxMemberBytes > 0);
  assert.equal(REGISTRY_CAPABILITY_FIELDS.length, 14);
});

test('validateStoreRegistryEntry requires full capability checklist', () => {
  const complete = {
    storeId: 'chat-history',
    domainOwner: 'persist',
    backend: 'json-documents',
    schemaVersion: 2,
    managedPaths: ['chat-history/'],
    writers: [{ id: 'http-history', kind: 'http' }],
    lockOrderRank: 30,
    flushStrategy: 'atomic-rename',
    secretClassification: { paths: [] },
    dependsOn: ['chats-metadata'],
    rawValidatorId: 'chat-history-strict-v2',
    exportAdapterId: 'chat-history-export',
    restoreAdapterId: 'chat-history-restore',
    cacheInvalidationHooks: ['chat-list-cache'],
  };
  assert.deepEqual(validateStoreRegistryEntry(complete), { ok: true });
  const incomplete = { ...complete, flushStrategy: '', writers: null };
  const result = validateStoreRegistryEntry(incomplete);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('flushStrategy'));
  assert.ok(result.missing.includes('writers'));
});

test('portable-settings-v1 fixture passes schema validation', () => {
  const doc = loadFixture('portable-settings-v1.sample.json');
  const result = validateArchiveDocument(doc, 'portable-settings-v1');
  assert.equal(result.ok, true);
});

test('conversations-v1 fixture passes schema and totals validation', () => {
  const doc = loadFixture('conversations-manifest-v1.sample.json');
  const result = validateArchiveDocument(doc, 'conversations-v1');
  assert.equal(result.ok, true);
});

test('data-backup-v1 current and legacy fixtures pass validation', () => {
  for (const file of ['data-backup-manifest-v1.current.json', 'data-backup-manifest-v1.legacy-json-history.json']) {
    const doc = loadFixture(file);
    const result = validateArchiveDocumentAuto(doc);
    assert.equal(result.ok, true, file);
  }
});

test('wrong archiveContractRevision fails after schema pass', () => {
  const doc = loadFixture('invalid-manifest-wrong-revision.json');
  const result = validateArchiveDocument(doc, 'data-backup-v1');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('archiveContractRevision')));
});

test('validateArchiveTotals rejects member over limit', () => {
  const oversize = {
    categories: [{ byteSize: ARCHIVE_LIMITS_V1.maxMemberBytes + 1 }],
  };
  assert.deepEqual(validateArchiveTotals(oversize), { ok: false, code: 'member_size_exceeded' });
});

test('validateArchiveTotals rejects totals mismatch', () => {
  const manifest = {
    categories: [{ byteSize: 100 }, { byteSize: 200 }],
    totals: { uncompressedBytes: 500 },
  };
  assert.deepEqual(validateArchiveTotals(manifest), { ok: false, code: 'totals_mismatch' });
});

test('pre-migration preview fails without legacy reader', () => {
  const legacy = loadFixture('data-backup-manifest-v1.legacy-json-history.json');
  const preview = validatePreMigrationRestorePreview(legacy, {
    installedBackend: 'sqlite-unified',
    hasLegacyReader: () => false,
    hasForwardMigration: () => true,
  });
  assert.deepEqual(preview, { ok: false, code: 'unsupported_legacy_reader' });
});

test('pre-migration preview passes when reader and migration exist', () => {
  const legacy = loadFixture('data-backup-manifest-v1.legacy-json-history.json');
  const preview = validatePreMigrationRestorePreview(legacy, {
    installedBackend: 'sqlite-unified',
    forwardMigrationPaused: true,
    hasLegacyReader: (id) => id === 'chat-history-json-v1',
    hasForwardMigration: (id) => id === 'chat-history-to-sqlite-v2',
    acceptsBootstrapMarker: (marker) => marker === 'data/chat-history/.backend',
  });
  assert.deepEqual(preview, { ok: true });
});

test('pre-migration preview fails when forward migration is not paused', () => {
  const legacy = loadFixture('data-backup-manifest-v1.legacy-json-history.json');
  const preview = validatePreMigrationRestorePreview(legacy, {
    installedBackend: 'sqlite-unified',
    forwardMigrationPaused: false,
    hasLegacyReader: (id) => id === 'chat-history-json-v1',
    hasForwardMigration: (id) => id === 'chat-history-to-sqlite-v2',
  });
  assert.deepEqual(preview, { ok: false, code: 'forward_migration_not_paused' });
});

test('corrupt_source omission without rawSha256 fails schema validation', () => {
  const doc = loadFixture('data-backup-manifest-v1.current.json');
  doc.omissions = [{ path: 'stores/chat-history/broken.json', reason: 'corrupt_source' }];
  const result = validateArchiveDocument(doc, 'data-backup-v1');
  assert.equal(result.ok, false);
});

test('corrupt_source omission with rawSha256 passes validation', () => {
  const doc = loadFixture('data-backup-corrupt-omission-valid.json');
  const result = validateArchiveDocument(doc, 'data-backup-v1');
  assert.equal(result.ok, true);
});

test('same backend skips legacy reader requirement', () => {
  const current = loadFixture('data-backup-manifest-v1.current.json');
  const preview = validatePreMigrationRestorePreview(current, {
    installedBackend: 'mixed-json-sqlite',
    hasLegacyReader: () => false,
    hasForwardMigration: () => false,
  });
  assert.deepEqual(preview, { ok: true });
});
