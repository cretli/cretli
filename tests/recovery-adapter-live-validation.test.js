/**
 * R7/R20: persisted live adapter validation, version invalidation, and the
 * automatic-resume enable gate.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './helpers/temp-dir.js';

import {
  getRecoveryAdapterValidationMatrix,
  isRecoveryAdapterEnabled,
  listAutomaticResumeAdapters,
  resolveRecoveryAdapterValidation,
} from '../lib/recovery/adapter-validation.ts';
import { runLiveAdapterValidation } from '../lib/recovery/adapter-live-validation.ts';
import {
  getStoredAdapterValidation,
  readAdapterValidationResults,
  recordAdapterValidationResult,
} from '../lib/recovery/adapter-validation-results.ts';
import { evaluateAutomaticResume } from '../lib/recovery/recovery-policy.ts';
import { isRecoveryAdapterValidated } from '../lib/delegation-runtime-boot.js';

/** Fake repo root with installed SDK package.json files for claude and codex. */
function fakeRepo(root, versions) {
  const files = {
    claude: 'optional-packages/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    codex: 'node_modules/@openai/codex-sdk/package.json',
  };
  for (const [harness, version] of Object.entries(versions)) {
    const file = path.join(root, files[harness]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version }));
  }
}

/** Driver that mimics a healthy SDK: tool runs once, resume recalls the secret. */
function healthyDriver(overrides = {}) {
  let secret = '';
  return {
    async startAndKill({ markerFile, secret: s }) {
      secret = s;
      appendFileSync(markerFile, 'run1\n');
      return { sessionId: 'sess-1', killed: true };
    },
    async resume({ sessionId }) {
      return { sessionId, replyText: secret, toolCalls: 0 };
    },
    ...overrides,
  };
}

test('live validation PASS is persisted and lifts the gate for the exact version only', async () => {
  const dir = makeTempDir('recovery-live-');
  fakeRepo(dir, { claude: '1.0.0', codex: '2.0.0' });
  const resultsPath = path.join(dir, 'results.json');
  const entry = await runLiveAdapterValidation({
    harness: 'claude', driver: healthyDriver(), repoRoot: dir, resultsPath,
  });
  assert.equal(entry.status, 'passed');
  assert.equal(entry.versionKey, 'claude@1.0.0');
  assert.equal(readAdapterValidationResults(resultsPath)['claude@1.0.0'].status, 'passed');

  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), true);
  const record = resolveRecoveryAdapterValidation('claude', { repoRoot: dir, resultsPath });
  assert.equal(record.overallStatus, 'validated');
  assert.equal(record.enableGateValidation, 'validated');
  // Other harnesses stay blocked (fail closed).
  assert.equal(isRecoveryAdapterEnabled('codex', { repoRoot: dir, resultsPath }), false);
  assert.equal(isRecoveryAdapterEnabled('qwen', { repoRoot: dir, resultsPath }), false);
  assert.equal(isRecoveryAdapterEnabled('opencode', { repoRoot: dir, resultsPath }), false);
  assert.deepEqual(
    listAutomaticResumeAdapters({ repoRoot: dir, resultsPath }).filter((row) => row.validated).map((row) => row.harness),
    ['claude'],
  );

  // Declared-only views never read the results file.
  assert.equal(getRecoveryAdapterValidationMatrix({ repoRoot: dir }).claude.overallStatus, 'pending');

  // An SDK upgrade invalidates the stored PASS (back to pending).
  fakeRepo(dir, { claude: '1.0.1' });
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), false);
  const upgraded = resolveRecoveryAdapterValidation('claude', { repoRoot: dir, resultsPath });
  assert.equal(upgraded.overallStatus, 'pending');
  assert.equal(upgraded.versionKey, 'claude@1.0.1');
});

test('live validation failures are stored but never lift the gate', async () => {
  const dir = makeTempDir('recovery-live-');
  fakeRepo(dir, { codex: '2.0.0' });
  const resultsPath = path.join(dir, 'results.json');
  const cases = {
    'context lost': { resume: async ({ sessionId }) => ({ sessionId, replyText: 'no idea', toolCalls: 0 }) },
    'tool executed again': {
      resume: async ({ sessionId, cwd }) => {
        appendFileSync(path.join(cwd, 'marker.txt'), 'run2\n');
        return { sessionId, replyText: 'x', toolCalls: 1 };
      },
    },
    'other session': { resume: async () => ({ sessionId: 'sess-2', replyText: '', toolCalls: 0 }) },
    'executor not killed': { startAndKill: async ({ markerFile }) => { appendFileSync(markerFile, 'a\n'); return { sessionId: 's', killed: false }; } },
    'driver throws': { startAndKill: async () => { throw new Error('boom'); } },
  };
  for (const [name, override] of Object.entries(cases)) {
    const entry = await runLiveAdapterValidation({
      harness: 'codex', driver: healthyDriver(override), repoRoot: dir, resultsPath,
    });
    assert.equal(entry.status, 'failed', name);
    assert.equal(isRecoveryAdapterEnabled('codex', { repoRoot: dir, resultsPath }), false, name);
  }
});

test('stored entries that are malformed, mismatched or hand-edited stay blocked', () => {
  const dir = makeTempDir('recovery-live-');
  fakeRepo(dir, { claude: '1.0.0' });
  const resultsPath = path.join(dir, 'results.json');
  const good = {
    harness: 'claude', sdkVersion: '1.0.0', packageName: 'x', versionKey: 'claude@1.0.0',
    status: 'passed', validatedAt: '2026-11-03T00:00:00.000Z',
    steps: {
      crash_resume: { status: 'validated' }, store_states: { status: 'validated' },
      waiting: { status: 'validated' }, cancel: { status: 'validated' }, missing_transcript: { status: 'validated' },
    },
  };
  recordAdapterValidationResult(good, resultsPath);
  assert.ok(getStoredAdapterValidation('claude', '1.0.0', resultsPath));
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), true);

  // Missing live step, wrong key contents, unknown version, corrupt file.
  recordAdapterValidationResult({ ...good, steps: { ...good.steps, crash_resume: { status: 'failed' } } }, resultsPath);
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), false);
  recordAdapterValidationResult({ ...good, sdkVersion: '9.9.9' }, resultsPath);
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), false);
  recordAdapterValidationResult({ ...good, steps: { ...good.steps, waiting: { status: 'pending' } } }, resultsPath);
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), false);
  assert.equal(getStoredAdapterValidation('claude', 'unknown', resultsPath), null);
  writeFileSync(resultsPath, '{not json');
  assert.deepEqual(readAdapterValidationResults(resultsPath), {});
  assert.equal(isRecoveryAdapterEnabled('claude', { repoRoot: dir, resultsPath }), false);
});

test('R20 gate: evaluateAutomaticResume passes only the validated adapter', () => {
  const run = { state: 'interrupted', reason: 'server_restart', acceptance: { state: 'accepted' }, sessionId: 's1' };
  const base = { mode: 'automatic', run, liveness: 'dead', capabilities: { canResumeSession: true } };
  assert.equal(evaluateAutomaticResume({ ...base, adapterValidated: true }).allowed, true);
  assert.equal(evaluateAutomaticResume({ ...base, adapterValidated: false }).reason, 'adapter_not_validated');
  // The production predicate has no stored PASS in a clean data dir.
  assert.equal(typeof isRecoveryAdapterValidated('claude'), 'boolean');
  assert.equal(isRecoveryAdapterValidated('not-a-harness'), false);
});
