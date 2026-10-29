/**
 * Required-test manifest: binding, evidence evaluation, reuse and the evidence
 * validator. Uses a synthetic temp project; never runs real suites.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildVerifyManifest,
  computeVerifyEnvKey,
  decideVerifyReuse,
  evaluateVerifyManifestEvidence,
  rebindVerifyEvidence,
} from '../lib/delegation-review-verify-plan.js';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { applyInheritedVerifyEvidence, recordDelegationVerifyResult } from '../lib/delegation-service.js';
import { renderEvidenceTable, validateEvidence } from '../scripts/validate-evidence.mjs';

const tempRoots = [];
test.after(() => { for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true }); });

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-manifest-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/alpha.test.js'), 'a');
  fs.writeFileSync(path.join(root, 'tests/beta.test.js'), 'b');
  return root;
}
const catalog = { alpha: 'tests/alpha.test.js', beta: 'tests/beta.test.js', evil: 'tests/../x.test.js', abs: '/etc/passwd' };

function build(root, ids, extra = {}) {
  return buildVerifyManifest({ ids, catalog, curated: { alpha: 'tests/alpha.test.js' }, projectRoot: root, attemptId: 'a1', materialRevision: 'r1', ...extra });
}
function passed(manifest, extra = {}) {
  return { status: 'passed', stale: false, manifest, results: manifest.entries.map((e) => ({ id: e.id, ok: true })), ...extra };
}

test('manifest binds ids, hashes, attempt and revision', () => {
  const root = makeProject();
  const built = build(root, ['alpha', 'beta']);
  assert.equal(built.ok, true);
  assert.equal(built.manifest.attemptId, 'a1');
  assert.equal(built.manifest.entries.find((e) => e.id === 'alpha').origin, 'curated');
  assert.equal(built.manifest.entries.find((e) => e.id === 'beta').origin, 'audited');
  assert.match(built.manifest.entries[0].sha256, /^[0-9a-f]{64}$/);
});

test('unknown id, traversal and absolute path are rejected', () => {
  const root = makeProject();
  assert.equal(build(root, ['nope']).error, 'unknown_id');
  assert.equal(build(root, ['evil']).error, 'path_rejected');
  assert.equal(build(root, ['abs']).error, 'path_rejected');
  assert.equal(build(root, ['__proto__']).error, 'unknown_id');
});

test('missing, stale, failed and wrong-attempt evidence is not usable', () => {
  const root = makeProject();
  const m = build(root, ['alpha']).manifest;
  const ctx = { attemptId: 'a1', materialRevision: 'r1', envKey: m.envKey, requiredIds: ['alpha'] };
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: null }).reason, 'missing');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: { status: 'passed' } }).reason, 'no_manifest');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: passed(m, { stale: true }) }).reason, 'stale');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: passed(m, { status: 'failed' }) }).reason, 'failed');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, attemptId: 'a2', verifyResult: passed(m) }).reason, 'attempt_mismatch');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: passed(m) }).usable, true);
});

test('a new test outside the manifest and a changed environment are not usable', () => {
  const root = makeProject();
  const m = build(root, ['alpha']).manifest;
  const ctx = { attemptId: 'a1', materialRevision: 'r1', envKey: m.envKey };
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, requiredIds: ['alpha', 'beta'], verifyResult: passed(m) }).reason, 'outside_manifest');
  const ranExtra = passed(m, { results: [{ id: 'alpha' }, { id: 'beta' }] });
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, verifyResult: ranExtra }).reason, 'outside_manifest');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, envKey: 'other', verifyResult: passed(m) }).reason, 'env_changed');
  assert.equal(evaluateVerifyManifestEvidence({ ...ctx, materialRevision: 'r2', verifyResult: passed(m) }).reason, 'revision_mismatch');
});

test('preexisting and flaky failures stay explicit', () => {
  const root = makeProject();
  const m = build(root, ['alpha']).manifest;
  const out = evaluateVerifyManifestEvidence({ verifyResult: passed(m, { preexistingFailures: ['beta'], flakyFailures: ['alpha'] }) });
  assert.deepEqual([out.preexisting, out.flaky], [['beta'], ['alpha']]);
});

test('reuse: valid, replay, new attempt, and each invalidation', () => {
  const root = makeProject();
  const m = build(root, ['alpha']).manifest;
  const prior = passed(m, { materialRevision: 'r1' });
  const next = { materialRevision: 'r1', envKey: m.envKey, testSetKey: m.testSetKey, ids: ['alpha'] };
  assert.deepEqual(decideVerifyReuse({ prior, next }), { reuse: true, reason: 'ok' });
  const rebound = rebindVerifyEvidence(prior, 'a2');
  assert.equal(rebound.attemptId, 'a2');
  assert.equal(rebound.manifest.attemptId, 'a2');
  assert.equal(rebound.source, 'reused_manifest');
  assert.equal(decideVerifyReuse({ prior, next: { ...next, materialRevision: 'r2' } }).reason, 'revision_mismatch');
  assert.equal(decideVerifyReuse({ prior, next: { ...next, envKey: 'x' } }).reason, 'env_changed');
  assert.equal(decideVerifyReuse({ prior, next: { ...next, testSetKey: 'x' } }).reason, 'tests_changed');
  assert.equal(decideVerifyReuse({ prior, next: { ...next, ids: ['alpha', 'beta'] } }).reason, 'outside_manifest');
  assert.equal(decideVerifyReuse({ prior: { ...prior, stale: true }, next }).reason, 'prior_not_passed');
  assert.equal(decideVerifyReuse({ prior: null, next }).reason, 'no_prior');
});

test('env key reacts to relevant env only', () => {
  assert.notEqual(computeVerifyEnvKey({ TZ: 'UTC' }), computeVerifyEnvKey({ TZ: 'Asia/Tokyo' }));
  assert.equal(computeVerifyEnvKey({ TZ: 'UTC', UNRELATED: '1' }), computeVerifyEnvKey({ TZ: 'UTC' }));
});

test('validator: a wrong hash or number in a brief never replaces the canonical artifact', () => {
  const root = makeProject();
  const m = build(root, ['alpha']).manifest;
  const canonical = { manifest: m, metrics: { tests: 3 } };
  const good = validateEvidence(canonical, { hashes: { alpha: m.entries[0].sha256 }, numbers: { tests: 3 } });
  assert.equal(good.ok, true);
  const bad = validateEvidence(canonical, { hashes: { alpha: 'deadbeef', ghost: 'x' }, numbers: { tests: 4, extra: 1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches.find((x) => x.key === 'alpha').canonical, m.entries[0].sha256);
  assert.equal(bad.mismatches.find((x) => x.key === 'tests').canonical, 3);
  assert.equal(bad.mismatches.length, 4);
  assert.match(renderEvidenceTable(canonical), /\| alpha \| tests\/alpha.test.js \|/);
});

// ---- Service-level regressions: production record + inheritance paths ----

const repo = createTempRepo();
test.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true });
const CURATED_FILE = path.join(repo.dir, 'tests/delegation-contract.test.js');
fs.writeFileSync(CURATED_FILE, 'v1');
fs.writeFileSync(path.join(repo.dir, 'tests/delegation-wait.test.js'), 'w1');

function makeRow(assignment = 'implement') {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: repo.dir,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment,
    status: 'completed',
    leafId: crypto.randomUUID(),
    finishedAt: new Date().toISOString(),
  });
  return { parent, row };
}
const okResult = (...ids) => ({ ok: true, output: 'ok', results: ids.map((id) => ({ id, ok: true, durationMs: 1, outputTail: '' })) });
async function record(row, extra = {}) {
  return await recordDelegationVerifyResult({
    delegationId: row.id, attemptId: row.attemptId, result: okResult('delegation-contract'), source: 'delegation_verify', ...extra,
  });
}

test('service: manual result without ids derives a manifest from executed results', async () => {
  const { row } = makeRow();
  const saved = (await record(row));
  assert.deepEqual(saved.verifyResult.manifest.entries.map((e) => e.id), ['delegation-contract']);
  assert.equal(saved.verifyResult.manifest.attemptId, row.attemptId);
  assert.deepEqual(saved.verifyResult.manifestEvidence, { usable: true, reason: 'ok' });
});

test('service: a manual re-run keeps the same manifest and replay is ignored', async () => {
  const { row } = makeRow();
  const first = (await record(row, { ids: ['delegation-contract'], source: 'auto_after_implement' }));
  const again = (await record(row, { ids: ['delegation-contract'], source: 'auto_after_implement' }));
  assert.equal(again.verifyResult.recordedAt, first.verifyResult.recordedAt, 'identical replay does not rewrite');
  const manual = (await record(row, { source: 'delegation_verify' }));
  assert.equal(manual.verifyResult.manifest.testSetKey, first.verifyResult.manifest.testSetKey, 'manual run does not drop the manifest');
});

test('service: test files changed during the run mark the result stale and unusable', async () => {
  const { row } = makeRow();
  const start = (await record(makeRow().row, {})).verifyResult.manifest;
  fs.writeFileSync(CURATED_FILE, 'v2');
  try {
    const saved = (await record(row, { manifest: start }));
    assert.equal(saved.verifyResult.stale, true);
    assert.deepEqual(saved.verifyResult.manifestEvidence, { usable: false, reason: 'stale' });
  } finally {
    fs.writeFileSync(CURATED_FILE, 'v1');
  }
});

test('service: a test outside the explicit manifest ids is not usable', async () => {
  const { row } = makeRow();
  const saved = (await record(row, { ids: ['delegation-contract'], result: okResult('delegation-contract', 'delegation-wait') }));
  assert.equal(saved.verifyResult.manifestEvidence.reason, 'outside_manifest');
});

test('service: unknown id and traversal never produce a manifest', async () => {
  const { row } = makeRow();
  const unknown = (await record(row, { result: okResult('no-such-id') }));
  assert.equal(unknown.verifyResult.manifest, undefined);
  assert.equal(unknown.verifyResult.manifestEvidence.reason, 'no_manifest');
  const { row: row2 } = makeRow();
  const evil = (await record(row2, { result: okResult('../../etc/passwd') }));
  assert.equal(evil.verifyResult.manifest, undefined);
});

test('service: failed run is not usable evidence', async () => {
  const { row } = makeRow();
  const saved = (await record(row, { result: { ok: false, output: 'x', results: [{ id: 'delegation-contract', ok: false }] } }));
  assert.equal(saved.verifyResult.manifestEvidence.reason, 'failed');
});

async function inheritFor(parent, implement) {
  const review = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: repo.dir,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    reviewSubject: 'code',
    leafId: implement.leafId,
  });
  return applyInheritedVerifyEvidence(review);
}

test('service: valid reuse rebinds the manifest to the new review attempt', async () => {
  const { parent, row } = makeRow();
  (await record(row));
  const review = await inheritFor(parent, row);
  const v = getDelegationById(review.id).verifyResult;
  assert.equal(v.source, 'inherited_from_implement');
  assert.equal(v.attemptId, review.attemptId);
  assert.equal(v.manifest.attemptId, review.attemptId, 'manifest rebound, not the implement attempt');
  assert.equal(v.implementDelegationId, row.id);
});

test('service: changed test file or environment blocks reuse', async () => {
  const { parent, row } = makeRow();
  (await record(row));
  fs.writeFileSync(CURATED_FILE, 'v3');
  try {
    assert.equal(getDelegationById((await inheritFor(parent, row)).id).verifyResult, null, 'tests changed => no reuse');
  } finally {
    fs.writeFileSync(CURATED_FILE, 'v1');
  }
  const prevTz = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    assert.equal(getDelegationById((await inheritFor(parent, row)).id).verifyResult, null, 'env changed => no reuse');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test('service: legacy implement evidence without a manifest is not reused', async () => {
  const { parent, row } = makeRow();
  const saved = (await record(row));
  const { manifest, manifestEvidence, ...legacy } = saved.verifyResult;
  updateDelegationRecord(row.id, { verifyResult: legacy });
  assert.equal(getDelegationById((await inheritFor(parent, row)).id).verifyResult, null);
});

test('service: a new attempt of the same implement records its own manifest', async () => {
  const { row } = makeRow();
  const first = (await record(row));
  updateDelegationRecord(row.id, { attemptId: 'attempt-2' });
  const second = await recordDelegationVerifyResult({ delegationId: row.id, attemptId: 'attempt-2', result: okResult('delegation-contract'), source: 'delegation_verify' });
  assert.equal(second.verifyResult.manifest.attemptId, 'attempt-2');
  assert.notEqual(second.verifyResult.manifest.attemptId, first.verifyResult.manifest.attemptId);
});
