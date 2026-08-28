import assert from 'node:assert/strict';
import {
  buildOpenCodePermissionSdkEvent,
  buildOpenCodePlanPermissionRuleset,
  isOpenCodePlanMutatingPermission,
  resolveOpenCodePermissionResolvedRequestId,
} from '../lib/opencode/opencode-permission.js';

const askedV2 = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: {
    id: 'perm_test',
    sessionID: 'ses_test',
    action: 'Write file',
    resources: ['src/app.js'],
    save: ['write'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedV2);
assert.equal(askedV2.type, 'opencode_permission');
assert.equal(askedV2.requestId, 'perm_test');
assert.equal(askedV2.action, 'Write file');
assert.deepEqual(askedV2.resources, ['src/app.js']);

const askedV1 = buildOpenCodePermissionSdkEvent({
  type: 'permission.asked',
  properties: {
    id: 'perm_v1',
    sessionID: 'ses_test',
    permission: 'bash',
    patterns: ['npm test'],
    metadata: {},
    always: ['bash'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedV1);
assert.equal(askedV1.action, 'bash');
assert.deepEqual(askedV1.resources, ['npm test']);
assert.deepEqual(askedV1.saveOptions, ['bash']);

const resolved = resolveOpenCodePermissionResolvedRequestId({
  type: 'permission.v2.replied',
  properties: {
    sessionID: 'ses_test',
    requestID: 'perm_test',
    reply: 'once',
  },
}, { opencodeSessionId: 'ses_test' });
assert.equal(resolved, 'perm_test');

assert.equal(isOpenCodePlanMutatingPermission(askedV2), true);
assert.equal(isOpenCodePlanMutatingPermission(askedV1), true);
assert.equal(isOpenCodePlanMutatingPermission({ action: 'Read file' }), false);
assert.equal(isOpenCodePlanMutatingPermission({ action: 'task' }), false);

const inputPlanRules = buildOpenCodePlanPermissionRuleset('plan');
const expectedPlanRules = [
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'deny' },
];
assert.deepEqual(inputPlanRules, expectedPlanRules);
assert.equal(buildOpenCodePlanPermissionRuleset('agent')[0].action, 'ask');

console.log('opencode-permission.test.js OK');
