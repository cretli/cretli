import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { readDelegationMaterialRevisionForRecord } from '../lib/delegation-material-revision.js';
import {
  DELEGATION_VERIFY_FAILED_BEFORE_REVIEW,
  inspectImplementVerifyBeforeReview,
} from '../lib/delegation-implement-verify-gate.js';
import { recordDelegationVerifyResult } from '../lib/delegation-service.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

/** Git checkout for material revision; review-verify runs tests in a non-repo temp cwd. */
const gitWorkspace = createTempRepo();

test.after(() => {
  fs.rmSync(gitWorkspace.dir, { recursive: true, force: true });
});

test('review start blocked after failed verify on same material', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: gitWorkspace.dir,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  const material = readDelegationMaterialRevisionForRecord(implement);
  assert.ok(material, 'test workspace must be a git checkout');
  updateDelegationRecord(implement.id, {
    verifyResult: {
      status: 'failed',
      exitCode: 1,
      verdict: '',
      source: 'delegation_verify',
      dataDir: '/tmp/x',
      recordedAt: '2026-10-12T12:01:00.000Z',
      attemptId: implement.attemptId,
      materialRevision: material,
    },
  });
  const blocked = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, DELEGATION_VERIFY_FAILED_BEFORE_REVIEW);
});

test('review start allowed with allowVerifyFailedReview override', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: gitWorkspace.dir,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  const material = readDelegationMaterialRevisionForRecord(implement);
  assert.ok(material, 'test workspace must be a git checkout');
  updateDelegationRecord(implement.id, {
    verifyResult: {
      status: 'failed',
      exitCode: 1,
      verdict: '',
      source: 'delegation_verify',
      dataDir: '/tmp/x',
      recordedAt: '2026-10-12T12:01:00.000Z',
      attemptId: implement.attemptId,
      materialRevision: material,
    },
  });
  const blocked = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  });
  assert.equal(blocked.ok, false);
  const allowed = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
    allowVerifyFailedReview: true,
  });
  assert.equal(allowed.ok, true);
});

test('review start allowed after passed verify', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  recordDelegationVerifyResult({
    delegationId: implement.id,
    attemptId: implement.attemptId,
    result: { ok: true, dataDir: '/tmp/x' },
    source: 'delegation_verify',
  });
  const allowed = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  });
  assert.equal(allowed.ok, true);
});

test('review start allowed when material changed since failed verify', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: gitWorkspace.dir,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  const material = readDelegationMaterialRevisionForRecord(implement);
  assert.ok(material, 'test workspace must be a git checkout');
  updateDelegationRecord(implement.id, {
    verifyResult: {
      status: 'failed',
      exitCode: 1,
      verdict: '',
      source: 'delegation_verify',
      dataDir: '/tmp/x',
      recordedAt: '2026-10-12T12:01:00.000Z',
      attemptId: implement.attemptId,
      materialRevision: `${material}-old`,
    },
  });
  const allowed = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  });
  assert.equal(allowed.ok, true);
});

test('review start allowed when implement has no verify result (empty catalog match)', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  const allowed = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  });
  assert.equal(allowed.ok, true);
});

test('delegation_verify on implement persists material revision', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
  });
  const updated = recordDelegationVerifyResult({
    delegationId: implement.id,
    attemptId: implement.attemptId,
    result: { ok: true, dataDir: '/tmp/y' },
    source: 'delegation_verify',
  });
  assert.ok(updated);
  assert.equal(updated.verifyResult.status, 'passed');
  assert.equal(typeof updated.verifyResult.materialRevision, 'string');
});

test('delegation_verify on implement is idempotent on repeat', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
  });
  const recordCount = loadDelegations().length;
  const payload = {
    delegationId: implement.id,
    attemptId: implement.attemptId,
    result: { ok: true, dataDir: '/tmp/z' },
    source: 'delegation_verify',
  };
  const first = recordDelegationVerifyResult(payload);
  const second = recordDelegationVerifyResult(payload);
  assert.ok(first);
  assert.ok(second);
  assert.equal(loadDelegations().length, recordCount);
  assert.equal(second.verifyResult.status, first.verifyResult.status);
  assert.equal(second.verifyResult.materialRevision, first.verifyResult.materialRevision);
  assert.equal(second.verifyResult.exitCode, first.verifyResult.exitCode);
  assert.equal(second.verifyResult.source, first.verifyResult.source);
  assert.equal(second.verifyResult.dataDir, first.verifyResult.dataDir);
  assert.equal(second.verifyResult.recordedAt, first.verifyResult.recordedAt);
});

console.log('delegation-implement-verify-gate.test.js OK');
