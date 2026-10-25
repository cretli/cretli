/**
 * Durable store contract for audited model-selection overrides.
 *
 * Every case uses a temporary file, so the real `data/model-pick-overrides.json`
 * is never read or written. The store must preserve unknown fields, refuse to
 * overwrite an invalid file except through the explicit backup reset, and treat
 * a stale `If-Match` as a conflict.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  computeModelPickOverridesEtag,
  createModelPickOverride,
  readModelPickOverrides,
  recordModelPickOverrideAudit,
  resetModelPickOverrides,
  revokeModelPickOverride,
} from '../lib/persist/model-pick-overrides-persist.js';

test.after(() => {
  removeIsolatedDataDir();
});

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

/**
 * @returns {{ dir: string, filePath: string }}
 */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-overrides-'));
  return { dir, filePath: path.join(dir, 'model-pick-overrides.json') };
}

/**
 * @param {object} [overrides]
 * @param {number} [ttlMs]
 * @returns {object}
 */
function body(overrides = {}, ttlMs = 60 * 60 * 1000) {
  return {
    action: 'exclude',
    targetHarness: 'codex',
    reason: 'maintenance',
    expiresAt: new Date(NOW + ttlMs).toISOString(),
    ...overrides,
  };
}

test('a missing file reads as valid-but-empty with a stable ETag', () => {
  const { filePath } = tempStore();
  const snapshot = readModelPickOverrides({ filePath });
  assert.equal(snapshot.state, 'missing');
  assert.deepEqual(snapshot.overrides, []);
  assert.equal(snapshot.etag, computeModelPickOverridesEtag(null));
});

test('create preserves unknown top-level keys and unknown record fields', () => {
  const { filePath } = tempStore();
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, futureSection: { a: 1 }, overrides: [], audit: [] }));
  const result = createModelPickOverride({
    filePath,
    override: { ...body({ customField: 'keep-me' }), spoofed: true },
    createdBy: 'operator',
    source: 'test',
    ifMatch: '*',
    now: NOW,
    generateId: () => 'ov-1',
  });
  assert.equal(result.ok, true);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(stored.futureSection, { a: 1 });
  assert.equal(stored.overrides[0].customField, 'keep-me');
  assert.equal(stored.overrides[0].spoofed, true);
  assert.equal(stored.overrides[0].createdBy, 'operator');
  assert.equal(stored.overrides[0].id, 'ov-1');
  // An audit row was appended for the create.
  assert.ok(stored.audit.some((row) => row.type === 'create' && row.id === 'ov-1'));
});

test('a normal write refuses an invalid file; reset repairs it with a backup', () => {
  const { filePath } = tempStore();
  fs.writeFileSync(filePath, '{ this is not json');
  const blocked = createModelPickOverride({
    filePath,
    override: body(),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'ov-1',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.state, 'invalid');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ this is not json');

  const repaired = resetModelPickOverrides({ filePath, now: NOW, by: 'operator' });
  assert.equal(repaired.ok, true);
  assert.ok(repaired.backupPath);
  assert.equal(fs.readFileSync(repaired.backupPath, 'utf8'), '{ this is not json');
  const cleared = readModelPickOverrides({ filePath });
  assert.equal(cleared.state, 'valid');
  assert.deepEqual(cleared.overrides, []);
});

test('a stale If-Match is a conflict and writes nothing', () => {
  const { filePath } = tempStore();
  const first = createModelPickOverride({
    filePath,
    override: body(),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'ov-1',
  });
  assert.equal(first.ok, true);
  const stale = createModelPickOverride({
    filePath,
    override: body({ targetHarness: 'qwen' }),
    ifMatch: 'not-the-current-etag',
    now: NOW,
    generateId: () => 'ov-2',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(readModelPickOverrides({ filePath }).overrides.length, 1);
});

test('revoke keeps the row for audit and never reactivates it', () => {
  const { filePath } = tempStore();
  const created = createModelPickOverride({
    filePath,
    override: body(),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'ov-1',
  });
  const revoked = revokeModelPickOverride({
    filePath,
    id: 'ov-1',
    ifMatch: created.etag,
    now: NOW + 1000,
    by: 'operator',
    reason: 'done',
  });
  assert.equal(revoked.ok, true);
  assert.ok(revoked.record.revokedAt);
  const snapshot = readModelPickOverrides({ filePath });
  assert.equal(snapshot.overrides.length, 1);
  assert.ok(snapshot.overrides[0].revokedAt);
  assert.ok(snapshot.audit.some((row) => row.type === 'revoke'));

  const missing = revokeModelPickOverride({ filePath, id: 'nope', now: NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'override_not_found');
});

test('a scope-limited reset keeps the other scope', () => {
  const { filePath } = tempStore();
  createModelPickOverride({
    filePath,
    override: body({ targetHarness: 'codex' }),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'g1',
  });
  createModelPickOverride({
    filePath,
    override: body({ scope: 'workspace', workspaceFolder: '/w/app', targetHarness: 'qwen' }),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'w1',
  });
  const reset = resetModelPickOverrides({ filePath, scope: 'workspace', workspaceFolder: '/w/app', now: NOW });
  assert.equal(reset.ok, true);
  assert.equal(reset.removed, 1);
  const rows = readModelPickOverrides({ filePath }).overrides;
  assert.deepEqual(rows.map((row) => row.id), ['g1']);
});

test('the TTL is validated by the store (client cannot persist an unbounded row)', () => {
  const { filePath } = tempStore();
  const result = createModelPickOverride({
    filePath,
    override: body({}, 365 * 24 * 60 * 60 * 1000),
    ifMatch: '*',
    now: NOW,
    generateId: () => 'ov-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'override_invalid_ttl');
});

test('recordModelPickOverrideAudit appends an observed refusal/expiry', () => {
  const { filePath } = tempStore();
  const result = recordModelPickOverrideAudit({
    filePath,
    event: { type: 'refuse', id: 'ov-x', detail: 'conflict' },
  });
  assert.equal(result.ok, true);
  const snapshot = readModelPickOverrides({ filePath });
  assert.equal(snapshot.audit.length, 1);
  assert.equal(snapshot.audit[0].type, 'refuse');
});
