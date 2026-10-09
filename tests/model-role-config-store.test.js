/**
 * Store contract for the audited model-role operator config.
 *
 * Covers the legacy full-list -> delta migration, order independence, unknown
 * key/matcher preservation, the invalid-file guard, ETag conflicts and the
 * explicit reset backup. Every case uses a temporary file path; the real
 * `data/model-role-profiles.json` is never read or written.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  ModelRoleConfigError,
  applyModelRoleDelta,
  buildEditableRoleView,
  computeModelRoleConfigDiff,
  computeModelRoleConfigEtag,
  normalizeModelRoleConfigDelta,
  previewModelRoleConfig,
  readModelRoleConfig,
  resetModelRoleConfig,
  writeModelRoleConfig,
} from '../lib/model-role-config-store.js';
import {
  DEFAULT_MODEL_ROLE_PROFILES,
  loadModelRoleProfiles,
  normalizeModelRoleProfiles,
} from '../lib/model-role-profiles.js';

test.after(() => {
  removeIsolatedDataDir();
});

/**
 * @returns {{ dir: string, filePath: string }}
 */
function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-role-store-'));
  return { dir, filePath: path.join(dir, 'model-role-profiles.json') };
}

/**
 * @param {string} filePath
 * @param {unknown} document
 * @returns {void}
 */
function writeConfig(filePath, document) {
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
}

test('a missing file reads as the built-in defaults with a stable ETag', () => {
  const { filePath } = tempConfig();
  const snapshot = readModelRoleConfig({ filePath });
  assert.equal(snapshot.state, 'missing');
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.etag, computeModelRoleConfigEtag(null));
  assert.deepEqual(snapshot.roles.plan, DEFAULT_MODEL_ROLE_PROFILES.plan);
  assert.equal(snapshot.editable.plan.locked, false);
});

test('a legacy full-list override still replaces the policy list (behavior unchanged)', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, { roles: { plan: [{ pattern: 'luna', priority: 0 }, { pattern: 'sol', priority: 1 }] } });
  const profiles = loadModelRoleProfiles({ filePath });
  assert.deepEqual(profiles.plan.map((row) => row.pattern), ['luna', 'sol']);
  assert.ok(profiles.plan.every((row) => row.operator === true));
  // Other roles keep the built-in policy.
  assert.deepEqual(profiles.review.map((row) => row.pattern), DEFAULT_MODEL_ROLE_PROFILES.review.map((row) => row.pattern));
});

test('a rolesDelta applies on top of the policy list and legacy wins per role', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, {
    roles: { plan: [{ pattern: 'sol', priority: 0 }] },
    rolesDelta: { implement: { set: { grok: { priority: 7 } }, remove: ['flash'] } },
  });
  const profiles = normalizeModelRoleProfiles(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  // plan is a legacy override: only sol.
  assert.deepEqual(profiles.plan.map((row) => row.pattern), ['sol']);
  // implement is policy minus flash plus grok.
  assert.ok(profiles.implement.some((row) => row.pattern === 'grok' && row.operator === true));
  assert.ok(!profiles.implement.some((row) => row.pattern === 'flash'));
});

test('write migrates a legacy override to a delta with the same effective list', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, {
    roles: { plan: [{ pattern: 'luna', priority: 0 }, { pattern: 'sol', priority: 1 }] },
    custom: { keep: true },
  });
  const before = readModelRoleConfig({ filePath });
  // A no-op write (empty delta) still converges the file to the delta form.
  const result = writeModelRoleConfig({ filePath, delta: {}, ifMatch: before.etag });
  assert.equal(result.ok, true);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal('roles' in doc, false);
  assert.ok(doc.rolesDelta?.plan);
  assert.deepEqual(doc.custom, { keep: true });
  const after = readModelRoleConfig({ filePath });
  assert.deepEqual(
    after.roles.plan.map((row) => [row.pattern, row.priority]),
    before.roles.plan.map((row) => [row.pattern, row.priority]),
  );
});

test('two deltas that differ only in array order produce identical bytes', () => {
  const first = tempConfig();
  const second = tempConfig();
  const base = { custom: true };
  writeConfig(first.filePath, base);
  writeConfig(second.filePath, base);
  const deltaA = { roles: { plan: { remove: ['opus', 'astra', 'sonnet'] } } };
  const deltaB = { roles: { plan: { remove: ['sonnet', 'astra', 'opus'] } } };
  assert.equal(writeModelRoleConfig({ filePath: first.filePath, delta: deltaA }).ok, true);
  assert.equal(writeModelRoleConfig({ filePath: second.filePath, delta: deltaB }).ok, true);
  assert.equal(
    fs.readFileSync(first.filePath, 'utf8'),
    fs.readFileSync(second.filePath, 'utf8'),
  );
});

test('unknown top-level keys survive a delta write', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, { custom: { a: 1 }, notes: ['x'], rolesDelta: { plan: { set: { grok: { priority: 1 } } } } });
  const snapshot = readModelRoleConfig({ filePath });
  assert.deepEqual(snapshot.unknownTopLevelKeys, ['custom', 'notes']);
  const result = writeModelRoleConfig({
    filePath,
    delta: { roles: { plan: { set: { astra: { priority: 3 } } } } },
    ifMatch: snapshot.etag,
  });
  assert.equal(result.ok, true);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(doc.custom, { a: 1 });
  assert.deepEqual(doc.notes, ['x']);
});

test('a matcher with unknown fields is preserved and its role is read-only', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, {
    roles: { plan: [{ pattern: 'grok', priority: 1, note: 'operator note' }] },
  });
  const snapshot = readModelRoleConfig({ filePath });
  assert.equal(snapshot.editable.plan.locked, true);
  assert.equal(snapshot.editable.plan.rules.length, 0);
  assert.equal(snapshot.editable.plan.preserved[0].reason, 'extra-fields');
  // Editing another role must not touch the preserved row.
  const result = writeModelRoleConfig({
    filePath,
    delta: { roles: { implement: { remove: ['flash'] } } },
    ifMatch: snapshot.etag,
  });
  assert.equal(result.ok, true);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(doc.roles.plan, [{ pattern: 'grok', priority: 1, note: 'operator note' }]);
  // The locked role is refused explicitly.
  assert.throws(
    () => writeModelRoleConfig({ filePath, delta: { roles: { plan: { remove: ['grok'] } } } }),
    (err) => err instanceof ModelRoleConfigError && err.code === 'role-locked',
  );
});

test('advanced matchers (sub/re/deny/variant/effort) are preserved and read-only', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, {
    roles: {
      review: [
        { pattern: 'sub:sol', priority: 0 },
        { pattern: 're:^gpt-', priority: 1 },
        { pattern: '!astra', priority: 2 },
        { pattern: 'sol', priority: 3, effort: ['high'] },
      ],
    },
  });
  const snapshot = readModelRoleConfig({ filePath });
  assert.equal(snapshot.editable.review.locked, true);
  assert.equal(snapshot.editable.review.rules.length, 0);
  assert.deepEqual(
    snapshot.editable.review.preserved.map((row) => row.reason).sort(),
    ['advanced', 'deny', 're', 'sub'],
  );
});

test('an invalid config is reported and never overwritten by a delta write', () => {
  const { filePath } = tempConfig();
  fs.writeFileSync(filePath, '{ not json');
  const result = writeModelRoleConfig({ filePath, delta: { roles: { plan: { set: { grok: { priority: 1 } } } } } });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'invalid');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ not json');
  // A dry run reports the blocked state too.
  const preview = previewModelRoleConfig({ filePath, delta: {} });
  assert.equal(preview.blocked, true);
  assert.equal(preview.state, 'invalid');
});

test('a stale If-Match is a conflict and leaves the file untouched', () => {
  const { filePath } = tempConfig();
  const snapshot = readModelRoleConfig({ filePath });
  const first = writeModelRoleConfig({
    filePath,
    delta: { roles: { plan: { set: { grok: { priority: 1 } } } } },
    ifMatch: snapshot.etag,
  });
  assert.equal(first.ok, true);
  const bytes = fs.readFileSync(filePath, 'utf8');
  const stale = writeModelRoleConfig({
    filePath,
    delta: { roles: { plan: { set: { astra: { priority: 3 } } } } },
    ifMatch: snapshot.etag,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
  assert.equal(stale.etag, computeModelRoleConfigEtag(bytes));
});

test('reset backs up an invalid file and restores the defaults', () => {
  const { filePath } = tempConfig();
  fs.writeFileSync(filePath, '{ broken');
  const result = resetModelRoleConfig({ filePath, now: Date.parse('2026-01-02T03:04:05.000Z') });
  assert.equal(result.ok, true);
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '{ broken');
  const after = readModelRoleConfig({ filePath });
  assert.equal(after.state, 'valid');
  assert.deepEqual(after.roles.plan, DEFAULT_MODEL_ROLE_PROFILES.plan);
});

test('reset without a file writes defaults and reports no backup', () => {
  const { filePath } = tempConfig();
  const result = resetModelRoleConfig({ filePath });
  assert.equal(result.ok, true);
  assert.equal(result.backupPath, null);
  assert.equal(readModelRoleConfig({ filePath }).state, 'valid');
});

test('the delta validator rejects unverified patterns and unknown sections', () => {
  assert.throws(
    () => normalizeModelRoleConfigDelta({ roles: { plan: { set: { madeup: { priority: 1 } } } } }),
    (err) => err instanceof ModelRoleConfigError && err.code === 'invalid-delta',
  );
  assert.throws(
    () => normalizeModelRoleConfigDelta({ nope: true }),
    (err) => err instanceof ModelRoleConfigError && err.code === 'invalid-delta',
  );
  assert.throws(
    () => normalizeModelRoleConfigDelta({ roles: { plan: { set: { grok: { priority: 1 } }, remove: ['grok'] } } }),
    (err) => err instanceof ModelRoleConfigError && err.code === 'invalid-delta',
  );
});

test('a dry run computes a diff without writing', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, { custom: true });
  const before = fs.readFileSync(filePath, 'utf8');
  const preview = previewModelRoleConfig({
    filePath,
    delta: { roles: { plan: { remove: ['grok'], set: { flash: { priority: 1 } } } } },
  });
  assert.equal(preview.diff.changed, true);
  assert.deepEqual(preview.diff.roles.plan.removed.map((row) => row.pattern), ['grok']);
  assert.deepEqual(preview.diff.roles.plan.added.map((row) => row.pattern), ['flash']);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(preview.blocked, false);
});

test('weights/rotation/adaptive deltas round-trip and show in the diff', () => {
  const { filePath } = tempConfig();
  const snapshot = readModelRoleConfig({ filePath });
  const result = writeModelRoleConfig({
    filePath,
    delta: {
      weights: { plan: { cost: 0.1, quality: 0.8, speed: 0.1 } },
      rotation: { mode: 'off', band: 0.2 },
      adaptive: { enabled: false },
    },
    ifMatch: snapshot.etag,
  });
  assert.equal(result.ok, true);
  const after = readModelRoleConfig({ filePath });
  assert.deepEqual(after.weights.plan, { cost: 0.1, quality: 0.8, speed: 0.1 });
  assert.deepEqual(after.rotation, { band: 0.2, mode: 'off' });
  assert.deepEqual(after.adaptive, { enabled: false });
  assert.ok(result.diff.weights?.plan);
  assert.ok(result.diff.rotation);
  assert.ok(result.diff.adaptive);
});

test('the explore section is a known, preserved, read-only part of this file', () => {
  const { filePath } = tempConfig();
  writeConfig(filePath, { explore: { mode: 'off' }, custom: 1 });
  const snapshot = readModelRoleConfig({ filePath });
  assert.equal(snapshot.explore.mode, 'off');
  assert.deepEqual(snapshot.unknownTopLevelKeys, ['custom']);
  const result = writeModelRoleConfig({
    filePath,
    delta: { roles: { plan: { remove: ['grok'] } } },
    ifMatch: snapshot.etag,
  });
  assert.equal(result.ok, true);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(doc.explore, { mode: 'off' });
});

test('the editable view exposes the policy baseline and the applied delta', () => {
  const document = { rolesDelta: { plan: { set: { flash: { priority: 1 } }, remove: ['grok'] } } };
  const view = buildEditableRoleView(document, normalizeModelRoleProfiles(document));
  assert.ok(view.plan.policy.includes('grok'));
  assert.ok(view.plan.rules.some((row) => row.pattern === 'flash' && row.source === 'operator'));
  assert.ok(!view.plan.rules.some((row) => row.pattern === 'grok'));
  assert.equal(view.plan.locked, false);
});

test('computeModelRoleConfigDiff reports a no-op delta as unchanged', () => {
  const { filePath } = tempConfig();
  const current = readModelRoleConfig({ filePath });
  const delta = normalizeModelRoleConfigDelta({}, { editable: current.editable });
  const diff = computeModelRoleConfigDiff({ current, delta });
  assert.equal(diff.changed, false);
});

test('applyModelRoleDelta never mutates its input document', () => {
  const document = { custom: 1, roles: { plan: [{ pattern: 'sol', priority: 0 }] } };
  const snapshot = JSON.stringify(document);
  applyModelRoleDelta(document, { roles: { plan: { remove: ['sol'] } } });
  assert.equal(JSON.stringify(document), snapshot);
});
