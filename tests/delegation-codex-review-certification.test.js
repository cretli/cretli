/**
 * Codex review sandbox and review certification read the same resolved
 * delegation env (workspace setting `codex_review_sandbox`).
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildCodexClientOptions } from '../lib/codex/codex-thread-options.js';
import { resolveDelegationSettings } from '../lib/delegation-settings.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import {
  assertReviewAdapterAllowed,
  describeReviewCertification,
} from '../lib/delegation-adapter-capabilities.js';
import { tempDir } from './helpers/temp-git-repo.js';

function withSandbox(fn) {
  const dataDir = tempDir('cretli-codex-cert-data-');
  const workspace = tempDir('cretli-codex-cert-ws-');
  try {
    return fn({ dataDir, workspace });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function resolveEnv({ dataDir, workspace }) {
  return resolveDelegationSettings({ workspaceFolder: workspace, dataDir, env: {} }).env;
}

test('workspace codex_review_sandbox=false: danger-full-access thread and uncertified gate', () => {
  withSandbox((sandbox) => {
    saveDelegationSettings(sandbox.workspace, { codex_review_sandbox: false }, { dataDir: sandbox.dataDir });
    const env = resolveEnv(sandbox);
    const options = buildCodexClientOptions({ cwd: sandbox.workspace, reviewReadOnly: true, env });
    assert.equal(options.threadOptions.sandboxMode, 'danger-full-access');
    const gate = assertReviewAdapterAllowed('codex', { env });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'review_uncertified');
    assert.equal(gate.reviewUncertified, true);
    const cert = describeReviewCertification('codex', { env });
    assert.equal(cert.certified, false);
    assert.equal(cert.reason, null);
  });
});

test('workspace codex_review_sandbox=true: read-only thread and certified gate', () => {
  withSandbox((sandbox) => {
    saveDelegationSettings(sandbox.workspace, { codex_review_sandbox: true }, { dataDir: sandbox.dataDir });
    const env = resolveEnv(sandbox);
    const options = buildCodexClientOptions({ cwd: sandbox.workspace, reviewReadOnly: true, env });
    assert.equal(options.threadOptions.sandboxMode, 'read-only');
    const gate = assertReviewAdapterAllowed('codex', { env });
    assert.equal(gate.ok, true);
    assert.equal(gate.reviewUncertified, false);
  });
});

test('scout stays read-only even when the review sandbox is off', () => {
  const options = buildCodexClientOptions({ cwd: '/tmp/x', scoutReadOnly: true, env: { CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX: '0' } });
  assert.equal(options.threadOptions.sandboxMode, 'read-only');
});

test('env layer keeps legacy semantics: only literal 0 turns the sandbox off', () => {
  const view = (value) => resolveDelegationSettings({ env: { CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX: value } }).effective.codex_review_sandbox;
  assert.equal(view('0'), false);
  assert.equal(view('false'), true);
  assert.equal(view('1'), true);
});

test('describeReviewCertification: reasons, traits and allow-uncertified opt-in', () => {
  const claude = describeReviewCertification('claude', { env: {} });
  assert.equal(claude.certified, true);
  assert.equal(claude.reason, 'preExecDeny');
  assert.equal(claude.reviewUncertified, false);
  assert.equal(claude.reviewCanRunTests, true);
  const deepseek = describeReviewCertification('deepseek', { env: {} });
  assert.equal(deepseek.reason, 'sandboxReadOnly');
  assert.equal(deepseek.reviewCanRunTests, false);
  assert.equal(deepseek.reviewCanRunTestsSource, 'prior');
  const off = { CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX: '0' };
  assert.equal(describeReviewCertification('codex', { env: off }).allowUncertified, false);
  const optIn = { ...off, CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED: '1' };
  assert.equal(describeReviewCertification('codex', { env: optIn }).allowUncertified, true);
  const gate = assertReviewAdapterAllowed('codex', { env: optIn });
  assert.equal(gate.ok, true);
  assert.equal(gate.reviewUncertified, true);
});
