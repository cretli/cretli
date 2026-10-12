import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { readDelegationMaterialRevisionForRecord } from '../lib/delegation-material-revision.js';
import {
  DELEGATION_VERIFY_FAILED_BEFORE_REVIEW,
  inspectImplementVerifyBeforeReview,
} from '../lib/delegation-implement-verify-gate.js';
import { recordDelegationVerifyResult } from '../lib/delegation-service.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

test('review start blocked after failed verify on same material', () => {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: process.cwd(),
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
    workspaceFolder: process.cwd(),
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

console.log('delegation-implement-verify-gate.test.js OK');
