import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  APPROVAL_BROKER_POLICY_VERSION,
  applyApprovalBrokerSettingsPatch,
  normalizeApprovalBrokerMode,
  normalizeApprovalBrokerSettings,
  readApprovalBrokerMode,
  recordOpenCodeApprovalAudit,
} from '../lib/approval/approval-broker.js';
import { appendApprovalAuditEntry, readApprovalAuditEntries } from '../lib/approval/approval-audit.js';
import {
  classifyOpenCodePermissionRisk,
  resolveOpenCodeApprovalAction,
} from '../lib/opencode/opencode-permission.js';
import { createOpenCodePermissionReplyGuard } from '../lib/opencode/opencode-permission-reply-guard.js';

// --- defaults and settings -------------------------------------------------

assert.equal(normalizeApprovalBrokerMode(undefined), 'off');
assert.equal(normalizeApprovalBrokerMode(''), 'off');
assert.equal(normalizeApprovalBrokerMode('OFF'), 'off');
assert.equal(normalizeApprovalBrokerMode('shadow'), 'shadow');
assert.equal(normalizeApprovalBrokerMode('local_reads'), 'local_reads');
assert.equal(normalizeApprovalBrokerMode('yolo'), 'off');
assert.equal(readApprovalBrokerMode({}), 'off');
assert.equal(readApprovalBrokerMode({ approvalBroker: { mode: 'local_reads' } }), 'local_reads');
assert.deepEqual(normalizeApprovalBrokerSettings(null), {
  mode: 'off',
  policyVersion: APPROVAL_BROKER_POLICY_VERSION,
});

const scratch = {};
applyApprovalBrokerSettingsPatch(scratch, 'local_reads');
assert.deepEqual(scratch.approvalBroker, { mode: 'local_reads' });
applyApprovalBrokerSettingsPatch(scratch, { mode: 'off' });
assert.equal('approvalBroker' in scratch, false, 'off must not persist a settings block');
applyApprovalBrokerSettingsPatch(scratch, { mode: 'bogus' });
assert.equal('approvalBroker' in scratch, false, 'invalid mode fails closed to off');

// --- pure decision matrix --------------------------------------------------

const readEvent = { action: 'read', resources: ['src/app.js'] };
const rmEvent = { action: 'bash', metadata: { command: 'rm -rf data' } };
const curlEvent = { action: 'bash', metadata: { command: 'curl https://example.com' } };
const envEvent = { action: 'bash', metadata: { command: 'cat .env' } };
const editEvent = { action: 'edit', resources: ['src/app.js'] };
const webEvent = { action: 'web_fetch', resources: ['https://example.com'] };
const pushEvent = { action: 'bash', metadata: { command: 'git push origin main' } };
const brokerWorkspace = process.cwd();

assert.deepEqual(classifyOpenCodePermissionRisk(curlEvent).categories.includes('network'), true);
assert.deepEqual(classifyOpenCodePermissionRisk(envEvent).categories.includes('secrets'), true);
assert.equal(classifyOpenCodePermissionRisk(rmEvent).risk, 'high');
assert.equal(classifyOpenCodePermissionRisk(readEvent).risk, 'low');

const serviceFilename = {
  action: 'bash',
  metadata: { command: 'grep -n "title" lib/chat-title-service.js | head -30' },
};
assert.equal(classifyOpenCodePermissionRisk(serviceFilename).categories.includes('privilege'), false);
assert.equal(classifyOpenCodePermissionRisk(serviceFilename).risk, 'low');
assert.equal(classifyOpenCodePermissionRisk({ action: 'bash', metadata: { command: 'service nginx restart' } }).categories.includes('privilege'), true);
assert.equal(classifyOpenCodePermissionRisk({ action: 'bash', metadata: { command: 'sudo true' } }).categories.includes('privilege'), true);
assert.equal(classifyOpenCodePermissionRisk({ action: 'bash', metadata: { command: '/usr/sbin/service nginx start' } }).categories.includes('privilege'), true);
assert.equal(classifyOpenCodePermissionRisk({ action: 'bash', metadata: { command: 'echo service' } }).categories.includes('privilege'), false);

const offRead = resolveOpenCodeApprovalAction({ mode: 'off', sdkMode: 'agent', permissionEvent: readEvent, assignment: '' });
assert.equal(offRead.decision, 'ask_user');
assert.equal(offRead.reply, null, 'off keeps the interactive card');

const shadowRead = resolveOpenCodeApprovalAction({ mode: 'shadow', sdkMode: 'agent', permissionEvent: readEvent, assignment: '', workspaceFolder: brokerWorkspace });
assert.equal(shadowRead.decision, 'allow');
assert.equal(shadowRead.reply, null, 'shadow never replies to the harness');
assert.equal(shadowRead.shadow, true);
assert.equal(shadowRead.notifyUser, true);

const localRead = resolveOpenCodeApprovalAction({ mode: 'local_reads', sdkMode: 'agent', permissionEvent: readEvent, assignment: '', workspaceFolder: brokerWorkspace });
assert.equal(localRead.decision, 'allow');
assert.equal(localRead.reply, 'once');
assert.equal(localRead.risk, 'low');

for (const [label, event] of [['curl', curlEvent], ['secret', envEvent], ['web', webEvent], ['push', pushEvent], ['edit', editEvent], ['rm', rmEvent]]) {
  const action = resolveOpenCodeApprovalAction({ mode: 'local_reads', sdkMode: 'agent', permissionEvent: event, assignment: '', workspaceFolder: brokerWorkspace });
  assert.notEqual(action.reply, 'once', `${label} must not be auto-approved`);
  assert.notEqual(action.reply, 'always', `${label} must never use always`);
  assert.equal(action.notifyUser, true, `${label} must stay with the user`);
}
assert.equal(
  resolveOpenCodeApprovalAction({ mode: 'local_reads', sdkMode: 'plan', permissionEvent: rmEvent, assignment: '', workspaceFolder: brokerWorkspace }).decision,
  'deny',
  'local plan guard deny always wins',
);
// `node scripts/review-verify.js` stays allowed for review children.
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'node scripts/review-verify.js delegation-contract' } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  }).reply,
  'once',
);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'node tests/conversation-fork.test.js' } },
    assignment: 'review',
    workspaceFolder: brokerWorkspace,
  }).decision,
  'deny',
);

// --- audit -----------------------------------------------------------------

const auditFile = path.join(ISOLATED_DATA_DIR, 'approvals-test', 'audit.jsonl');
assert.equal(
  recordOpenCodeApprovalAudit({
    room: { chatId: 'chat_1' },
    permissionEvent: { requestId: 'per_off', action: 'bash', metadata: { command: 'ls' } },
    action: offRead,
  }, { file: auditFile }),
  null,
  'broker off writes no audit',
);
assert.deepEqual(readApprovalAuditEntries({ file: auditFile }), []);

const secretCommand = `curl -H "Authorization: Bearer ${'sk-or-v1-'}${'0123456789abcdef0123456789abcdef'}" https://example.com`;
const written = recordOpenCodeApprovalAudit({
  room: { chatId: 'chat_1' },
  permissionEvent: { requestId: 'per_123', action: 'bash', metadata: { command: secretCommand } },
  action: resolveOpenCodeApprovalAction({
    mode: 'shadow',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: secretCommand } },
    assignment: '',
  }),
  now: Date.UTC(2026, 0, 2, 3, 4, 5),
}, { file: auditFile });
assert.ok(written);
assert.equal(written.requestId, 'per_123');
assert.equal(written.harness, 'opencode');
assert.equal(written.finalDecision, 'ask_user');
assert.equal(written.mode, 'shadow');
assert.equal(written.command.includes('sk-or-v1-0123456789abcdef'), false, 'audit must redact tokens');
assert.equal(written.command.includes('[redacted]'), true);
assert.equal(written.ts, '2026-01-02T03:04:05.000Z');

const entries = readApprovalAuditEntries({ file: auditFile, limit: 10 });
assert.equal(entries.length, 1);
assert.equal(entries[0].requestId, 'per_123');
assert.equal(entries[0].command.includes('sk-or-v1-0123456789abcdef'), false);

// rotation cap keeps the file from growing unbounded
const rotateFile = path.join(ISOLATED_DATA_DIR, 'approvals-test', 'rotate.jsonl');
for (let i = 0; i < 5; i += 1) {
  appendApprovalAuditEntry({ i }, { file: rotateFile, maxBytes: 20 });
}
assert.ok(readApprovalAuditEntries({ file: rotateFile }).length <= 2);

// --- reply idempotency guard ----------------------------------------------

const guard = createOpenCodePermissionReplyGuard(2);
assert.equal(guard.claim('per_1'), true);
assert.equal(guard.claim('per_1'), false, 'second reply for the same requestId is rejected');
assert.equal(guard.has('per_1'), true);
guard.release('per_1');
assert.equal(guard.claim('per_1'), true, 'released claim can be retried');
assert.equal(guard.claim(''), false);

const capped = createOpenCodePermissionReplyGuard(2);
assert.equal(capped.claim('per_a'), true);
assert.equal(capped.claim('per_b'), true);
assert.equal(capped.claim('per_c'), true);
assert.equal(capped.size, 2);
assert.equal(capped.has('per_a'), false, 'oldest entry is evicted at the cap');
assert.equal(capped.has('per_b'), true);

console.log('approval-broker.test.js OK');
