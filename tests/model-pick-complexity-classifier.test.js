import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SHADOW_CACHE_MAX_ENTRIES,
  SHADOW_CACHE_NULL_TTL_MS,
  SHADOW_CACHE_TTL_MS,
  createComplexityShadowClassifier,
  loadComplexityClassifierConfig,
  mapAnswersToComplexityShadow,
  normalizeComplexityClassifierConfig,
  normalizeComplexityShadow,
  parseBasalResponse,
  resolveComplexityShadowForPick,
} from '../lib/model-pick-complexity-classifier.js';
import { pickAndPersistModelForPurpose } from '../lib/model-pick-service.js';
import { getModelPickRecord, normalizeModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';
import { buildEvaluationReport, labelLeaf } from '../scripts/eval-complexity-classifier.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(projectRoot, 'tests', 'fixtures', 'complexity-classifier');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cxc-'));
const SECRET_BODY = 'Rotate the SECRET-LEAF-TEXT credential in lib/a.js';

const VALID = Object.freeze({
  backendId: 'basal',
  backendVersion: 'basal-1.5',
  level: 'standard',
  levelProbs: { trivial: 0.1, standard: 0.7, demanding: 0.2 },
  risk: 'none',
  domain: 'backend',
  needsTests: true,
  confidenceBucket: 'medium',
});

const ANSWERS = Object.freeze({
  level: { trivial: 0.05, standard: 0.15, demanding: 0.8 },
  risk: { none: 0.1, contract: 0.1, security: 0.6, data_migration: 0.1, concurrency: 0.1 },
  domain: { frontend: 0, backend: 0.9, docs: 0, tests: 0.1, mixed: 0 },
  needsTests: 0.7,
});

const basalConfig = () => normalizeComplexityClassifierConfig({ backend: 'basal', timeoutMs: 200 });

/**
 * @param {string} file
 * @returns {object}
 */
function pickInput(file) {
  return {
    role: 'implement',
    leafId: 'leaf-1',
    leafBody: SECRET_BODY,
    workspaceFolder: '/tmp/ws',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    delegations: [],
    file,
  };
}

/**
 * @param {object} [extra]
 */
function instantClassifier(extra = {}) {
  let calls = 0;
  const classifier = createComplexityShadowClassifier({
    config: basalConfig(),
    adapter: async () => {
      calls += 1;
      return { answers: ANSWERS, version: 'basal-1.5' };
    },
    log: () => {},
    ...extra,
  });
  return { classifier, calls: () => calls };
}

test('normalizeComplexityShadow keeps a valid record and rejects anything off-list', () => {
  assert.deepEqual(normalizeComplexityShadow({ ...VALID }), VALID);
  for (const patch of [
    { backendId: 'other' },
    { backendVersion: 'bad version!' },
    { level: 'huge' },
    { risk: 'unknown' },
    { domain: 'infra' },
    { needsTests: 'yes' },
    { confidenceBucket: 'certain' },
    { levelProbs: { trivial: 0.3, standard: 0.7 } },
    { levelProbs: { trivial: 0.5, standard: 0.7, demanding: 0.2 } },
    { levelProbs: { trivial: 0.1, standard: 0.7, demanding: 0.2, extra: 0 } },
    { level: 'demanding' },
  ]) {
    assert.equal(normalizeComplexityShadow({ ...VALID, ...patch }), null, JSON.stringify(patch));
  }
});

test('normalizeComplexityShadow renormalizes probabilities within tolerance', () => {
  const out = normalizeComplexityShadow({ ...VALID, levelProbs: { trivial: 0.1, standard: 0.71, demanding: 0.2 } });
  assert.ok(out);
  assert.ok(Math.abs(out.levelProbs.trivial + out.levelProbs.standard + out.levelProbs.demanding - 1) <= 0.011);
});

test('persist round trip keeps the shadow block and drops unknown keys', () => {
  const record = normalizeModelPickRecord({
    id: 'pick-1',
    complexityShadow: { ...VALID, leafBody: SECRET_BODY, hash: 'abc' },
  });
  assert.deepEqual(record.complexityShadow, VALID);
  assert.equal(JSON.stringify(record).includes('SECRET-LEAF-TEXT'), false);
  const broken = normalizeModelPickRecord({ id: 'pick-2', complexityShadow: { ...VALID, risk: 'x' } });
  assert.equal('complexityShadow' in broken, false);
});

test('mapAnswersToComplexityShadow maps argmax fields and applies minConfidence', () => {
  const shadow = mapAnswersToComplexityShadow({ backendId: 'basal', backendVersion: 'basal-1.5', answers: ANSWERS });
  assert.deepEqual(shadow, {
    backendId: 'basal',
    backendVersion: 'basal-1.5',
    level: 'demanding',
    levelProbs: { trivial: 0.05, standard: 0.15, demanding: 0.8 },
    risk: 'security',
    domain: 'backend',
    needsTests: true,
    confidenceBucket: 'medium',
  });
  assert.equal(mapAnswersToComplexityShadow({ backendId: 'basal', backendVersion: 'b', answers: ANSWERS, minConfidence: 0.9 }), null);
});

test('parseBasalResponse reads per-question probabilities', () => {
  const parsed = parseBasalResponse({
    model: 'basal-1.5',
    answers: {
      level: { type: 'choice', probabilities: ANSWERS.level },
      risk: { type: 'choice', probabilities: ANSWERS.risk },
      domain: { type: 'choice', probabilities: ANSWERS.domain },
      needsTests: { type: 'noul', noul: 0.7 },
    },
  });
  assert.equal(parsed.version, 'basal-1.5');
  assert.equal(mapAnswersToComplexityShadow({ backendId: 'basal', backendVersion: parsed.version, answers: parsed.answers })?.level, 'demanding');
});

test('backend off or no config leaves the pick and the record unchanged', () => {
  const dir = tempDir();
  const baseline = pickAndPersistModelForPurpose({ ...pickInput(path.join(dir, 'a.json')), complexityClassifier: false });
  const missing = pickAndPersistModelForPurpose({ ...pickInput(path.join(dir, 'b.json')), complexityClassifierFile: path.join(dir, 'none.json') });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.pick, baseline.pick);
  assert.equal('complexityShadow' in missing, false);
  assert.equal('complexityShadow' in getModelPickRecord(missing.pickId, { file: path.join(dir, 'b.json') }), false);
});

test('cache miss schedules once (single-flight); a hit lands in the record', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'picks.json');
  const { classifier, calls } = instantClassifier();
  const results = Array.from({ length: 5 }, () => pickAndPersistModelForPurpose({ ...pickInput(file), complexityClassifier: classifier }));
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.equal('complexityShadow' in getModelPickRecord(r.pickId, { file }), false);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls(), 1, 'one backend request for five concurrent picks');
  const hit = pickAndPersistModelForPurpose({ ...pickInput(file), complexityClassifier: classifier });
  assert.equal(hit.complexityShadow.level, 'demanding');
  assert.deepEqual(getModelPickRecord(hit.pickId, { file }).complexityShadow, hit.complexityShadow);
  assert.deepEqual(hit.pick, results[0].pick, 'the shadow never changes the selection');
  assert.equal(classifier.stats().hits, 1);
});

test('TTL and LRU eviction on a fake clock', async () => {
  let clock = 1_000;
  const { classifier } = instantClassifier({ now: () => clock });
  const key = classifier.keyFor({ leafBody: 'x', role: 'implement' });
  await classifier.scheduleShadow(key, { leafBody: 'x' });
  assert.ok(classifier.getCachedShadow(key));
  clock += SHADOW_CACHE_TTL_MS + 1;
  assert.equal(classifier.getCachedShadow(key), undefined, 'expired after 24 h');
  for (let i = 0; i <= SHADOW_CACHE_MAX_ENTRIES; i += 1) {
    await classifier.scheduleShadow(`k${i}`, { leafBody: `b${i}` });
  }
  assert.equal(classifier.stats().cacheSize, SHADOW_CACHE_MAX_ENTRIES);
  assert.equal(classifier.getCachedShadow('k0'), undefined, 'oldest entry evicted');
  assert.ok(classifier.getCachedShadow(`k${SHADOW_CACHE_MAX_ENTRIES}`));
});

test('a slow backend never delays the pick; timeout caches null for 10 minutes', async () => {
  let clock = 5_000;
  const lines = [];
  const classifier = createComplexityShadowClassifier({
    config: basalConfig(),
    now: () => clock,
    log: (line) => lines.push(line),
    adapter: () => new Promise((resolve) => {
      setTimeout(() => resolve({ answers: ANSWERS, version: 'basal-1.5' }), 5_000).unref();
    }),
  });
  const file = path.join(tempDir(), 'picks.json');
  const started = Date.now();
  const picked = pickAndPersistModelForPurpose({ ...pickInput(file), complexityClassifier: classifier });
  assert.ok(Date.now() - started < 500, 'pick returned without waiting');
  assert.equal(picked.ok, true);
  const key = classifier.keyFor({ workspaceFolder: '/tmp/ws', role: 'implement', leafBody: SECRET_BODY });
  const value = await classifier.scheduleShadow(key, { leafBody: SECRET_BODY });
  assert.equal(value, null);
  assert.equal(classifier.getCachedShadow(key), null, 'failure is cached');
  assert.equal(classifier.stats().errors.timeout, 1);
  clock += SHADOW_CACHE_NULL_TTL_MS + 1;
  assert.equal(classifier.getCachedShadow(key), undefined);
  assert.ok(lines.some((line) => line.endsWith('timeout')));
  assert.equal(lines.join('\n').includes('SECRET-LEAF-TEXT'), false);
});

test('adapter errors are logged by code only', async () => {
  const lines = [];
  const classifier = createComplexityShadowClassifier({
    config: basalConfig(),
    log: (line) => lines.push(line),
    adapter: async () => {
      throw Object.assign(new Error(`upstream echoed ${SECRET_BODY}`), { code: 'http_error', status: 500 });
    },
  });
  assert.equal(await classifier.scheduleShadow('k', { leafBody: SECRET_BODY }), null);
  assert.deepEqual(lines, ['complexityClassifier basal failed: http_500']);
});

test('config is fail-closed and remote backends need allowRemote', () => {
  const withKey = { resolveApiKey: () => 'sk-or-v1-testtesttest' };
  assert.equal(normalizeComplexityClassifierConfig(undefined).backend, 'off');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'jev' }, withKey).offReason, 'remote_not_allowed');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'jev', allowRemote: true }, withKey).backend, 'jev');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'jev', allowRemote: true }, { resolveApiKey: () => '' }).offReason, 'missing_api_key');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'openai-decisions', allowRemote: true }, withKey).offReason, 'backend_unavailable');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal' }).backend, 'basal');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', url: 'http://gpu.example.com:8000' }).offReason, 'remote_not_allowed');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', url: 'http://gpu.example.com:8000', allowRemote: true }).backend, 'basal');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', url: 'file:///etc/passwd' }).backend, 'off');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'BASAL' }).backend, 'off');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', timeoutMs: '2000' }).backend, 'off');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', allowRemote: 'yes' }).backend, 'off');
  assert.equal(normalizeComplexityClassifierConfig({ backend: 'basal', timeoutMs: 50 }).timeoutMs, 200);
});

test('config loader: broken JSON is off with a value-free warning', () => {
  const dir = tempDir();
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "complexityClassifier": { "backend": "jev", "url": "SECRET-LEAF-TEXT"');
  const lines = [];
  assert.equal(loadComplexityClassifierConfig({ filePath: broken, warn: (l) => lines.push(l) }).backend, 'off');
  const remote = path.join(dir, 'remote.json');
  fs.writeFileSync(remote, JSON.stringify({ complexityClassifier: { backend: 'basal', url: 'http://SECRET-LEAF-TEXT.example.com' } }));
  assert.equal(loadComplexityClassifierConfig({ filePath: remote, warn: (l) => lines.push(l) }).backend, 'off');
  assert.deepEqual(lines, ['complexityClassifier disabled: invalid_json', 'complexityClassifier disabled: remote_not_allowed']);
  assert.equal(loadComplexityClassifierConfig({ filePath: path.join(dir, 'missing.json'), warn: () => assert.fail('no warning') }).backend, 'off');
});

test('resolveComplexityShadowForPick ignores picks without a leaf body', () => {
  const { classifier, calls } = instantClassifier();
  assert.equal(resolveComplexityShadowForPick({ leafBody: '  ', complexityClassifier: classifier }), null);
  assert.equal(calls(), 0);
});

test('cost policy is identical with the backend on and off', async () => {
  const dir = tempDir();
  const { classifier } = instantClassifier();
  const key = classifier.keyFor({ workspaceFolder: '/tmp/ws', role: 'implement', leafBody: SECRET_BODY });
  await classifier.scheduleShadow(key, { leafBody: SECRET_BODY });
  const on = pickAndPersistModelForPurpose({ ...pickInput(path.join(dir, 'on.json')), complexityClassifier: classifier });
  const off = pickAndPersistModelForPurpose({ ...pickInput(path.join(dir, 'off.json')), complexityClassifier: false });
  assert.ok(on.complexityShadow);
  assert.deepEqual(on.cost_policy, off.cost_policy);
  assert.deepEqual(on.complexity, off.complexity);
  assert.deepEqual(on.pick, off.pick);
  assert.deepEqual(on.candidates, off.candidates);
});

test('evaluation report on fixtures matches hand-computed accuracy and Brier', () => {
  const proposals = Object.values(JSON.parse(fs.readFileSync(path.join(fixturesDir, 'proposals.json'), 'utf8')).picks);
  const delegations = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'delegations.json'), 'utf8')).items;
  assert.equal(labelLeaf(delegations.filter((r) => r.leafId === 'leaf-a')), 'trivial');
  assert.equal(labelLeaf(delegations.filter((r) => r.leafId === 'leaf-b')), 'standard');
  assert.equal(labelLeaf(delegations.filter((r) => r.leafId === 'leaf-c')), 'demanding');
  const report = buildEvaluationReport({ proposals, delegations });
  assert.equal(report.samples, 4, 'the unlabelled leaf is skipped');
  assert.equal(report.all.heuristic.accuracy, 0.5);
  // Brier: (0.04 + 0.04) + (0.01 + 0.09 + 0.04) + (0.01 + 0.36 + 0.49) = 1.08 over 3 predictions.
  assert.equal(report.all.backends.basal.brier, 0.36);
  assert.equal(report.all.backends.basal.accuracy, 0.6667);
  assert.equal(report.all.backends.basal.missingRate, 0.25);
  assert.deepEqual(report.all.backends.basal.calibration.medium, { n: 3, meanConfidence: 0.7, accuracy: 0.6667 });
  assert.equal(report.noPriorReviewFail.heuristic.n, 3, 'the pick after two FAILs is excluded');
  assert.equal(report.noPriorReviewFail.heuristic.accuracy, 0.3333);
});

test('eval script runs offline on the fixtures', () => {
  const out = execFileSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'eval-complexity-classifier.mjs'),
    '--dry-run', '--fixtures', fixturesDir,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /\| basal \| 4 \| 3 \| 0\.6667 \| 0\.25 \| 0\.36 \|/);
  assert.match(out, /\| heuristic \| 4 \| 4 \| 0\.5 \|/);
});
