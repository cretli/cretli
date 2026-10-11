import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  HARNESS_NEUTRAL_POLICY_VERSION,
  buildAdvisoryPermissionTuple,
  deriveHarnessBoundedAlwaysScopeFromSaveOptions,
  isAdvisoryAssessmentPayloadLimited,
  needsMinimalAdvisorPayload,
  normalizePermissionRequest,
  resolveApprovalPolicyVersion,
} from '../lib/approval/permission-request.js';
import {
  APPROVAL_BROKER_POLICY_VERSION,
  recordApprovalAudit,
  recordOpenCodeApprovalAudit,
} from '../lib/approval/approval-broker.js';
import { buildAdvisorPermissionTuple } from '../lib/approval/approval-advisor.js';
import { resolveOpenCodeApprovalAction } from '../lib/opencode/opencode-permission.js';

const lowRiskReadAction = {
  action: 'read',
  mode: 'local_reads',
  decision: 'ask_user',
  reply: null,
  risk: 'low',
  categories: [],
  command: '',
};

assert.equal(resolveApprovalPolicyVersion('opencode'), APPROVAL_BROKER_POLICY_VERSION);
assert.equal(resolveApprovalPolicyVersion('OpenCode'), APPROVAL_BROKER_POLICY_VERSION);
assert.equal(resolveApprovalPolicyVersion('claude'), HARNESS_NEUTRAL_POLICY_VERSION);

const event = {
  requestId: 'perm_read_1',
  action: 'read',
  resources: ['/home/user/workspace/src/app.js'],
};

const tupleViaNormalizer = normalizePermissionRequest({
  harness: 'opencode',
  permissionEvent: event,
  approvalAction: lowRiskReadAction,
});
const tupleViaWrapper = buildAdvisorPermissionTuple({ permissionEvent: event, approvalAction: lowRiskReadAction });
assert.deepEqual(tupleViaWrapper, tupleViaNormalizer, 'advisor wrapper must match opencode normalization');
assert.equal(tupleViaWrapper.harness, 'opencode');
assert.equal(tupleViaWrapper.policyVersion, APPROVAL_BROKER_POLICY_VERSION);
assert.deepEqual(tupleViaWrapper.resources, ['app.js']);

const qwenTuple = normalizePermissionRequest({
  harness: 'qwen',
  permissionEvent: event,
  approvalAction: lowRiskReadAction,
});
assert.equal(qwenTuple.harness, 'qwen');
assert.equal(qwenTuple.policyVersion, HARNESS_NEUTRAL_POLICY_VERSION);

{
  const longId = `id_${'x'.repeat(100)}`;
  const normalized = normalizePermissionRequest({
    harness: 'opencode',
    requestId: longId,
    permissionEvent: { action: `act_${'y'.repeat(200)}`, resources: [] },
    approvalAction: {
      ...lowRiskReadAction,
      command: `echo ${'z'.repeat(400)}`,
      categories: Array.from({ length: 12 }, (_, i) => `c${i}`),
      policyVersion: `pv_${'w'.repeat(100)}`,
    },
  });
  assert.equal(normalized.requestId.length, 64);
  assert.equal(normalized.permission, 'other', 'oversized or unsafe permission names collapse to other');
  assert.equal(normalized.command.length, 300);
  assert.equal(normalized.categories.length, 8);
  assert.equal(normalized.policyVersion.length, 80);
}

{
  const windowsTuple = buildAdvisorPermissionTuple({
    permissionEvent: { requestId: 'path_2', action: 'read' },
    approvalAction: { ...lowRiskReadAction, command: 'type C:\\Users\\alice\\workspace\\private.txt' },
  });
  assert.equal(windowsTuple.command, 'type private.txt');
}

const auditFile = path.join(ISOLATED_DATA_DIR, 'approvals-permission-request', 'audit.jsonl');
const secretCommand = 'curl -H "Authorization: Bearer sk-or-v1-0123456789abcdef" https://example.com';
const permissionEvent = {
  requestId: 'per_123',
  action: 'bash',
  metadata: { command: secretCommand },
};
const action = resolveOpenCodeApprovalAction({
  mode: 'shadow',
  sdkMode: 'agent',
  permissionEvent: { action: 'bash', metadata: { command: secretCommand } },
  assignment: '',
});

const opencodeAudit = recordOpenCodeApprovalAudit({
  room: { chatId: 'chat_1' },
  permissionEvent,
  action,
  now: Date.UTC(2026, 0, 2, 3, 4, 5),
}, { file: auditFile });
assert.ok(opencodeAudit);
assert.equal(opencodeAudit.harness, 'opencode');
assert.equal(opencodeAudit.policyVersion, APPROVAL_BROKER_POLICY_VERSION);

const claudeAction = { ...action, policyVersion: undefined };
const claudeAudit = recordApprovalAudit({
  harness: 'claude',
  room: { chatId: 'chat_2' },
  permissionEvent,
  action: claudeAction,
  now: Date.UTC(2026, 0, 2, 3, 4, 6),
}, { file: auditFile });
assert.ok(claudeAudit);
assert.equal(claudeAudit.harness, 'claude');
assert.equal(claudeAudit.policyVersion, HARNESS_NEUTRAL_POLICY_VERSION);

assert.equal(needsMinimalAdvisorPayload({ risk: 'high', categories: [] }), true);
assert.equal(needsMinimalAdvisorPayload({ risk: 'low', categories: ['secrets'] }), true);
assert.equal(needsMinimalAdvisorPayload({ risk: 'low', categories: [] }), false);

const advisoryMinimal = buildAdvisoryPermissionTuple({
  permissionEvent: event,
  approvalAction: { ...lowRiskReadAction, risk: 'high', command: 'rm -rf /tmp/x', categories: ['destructive'] },
});
assert.equal(advisoryMinimal.command, '');
assert.equal(advisoryMinimal.resources.length, 0);
assert.equal(advisoryMinimal.permission, 'read');

assert.equal(deriveHarnessBoundedAlwaysScopeFromSaveOptions(['bash']), 'bash');
assert.equal(deriveHarnessBoundedAlwaysScopeFromSaveOptions(['**']), null);
assert.equal(isAdvisoryAssessmentPayloadLimited({ command: '', resources: [], risk: 'low' }, { risk: 'low', categories: [] }), true);
assert.equal(
  isAdvisoryAssessmentPayloadLimited({ command: 'cat x', resources: [], risk: 'low' }, { risk: 'low', categories: [] }),
  false,
);

console.log('approval-permission-request.test.js OK');
