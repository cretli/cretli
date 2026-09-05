import assert from 'node:assert/strict';
import {
  buildOpenCodePermissionSdkEvent,
  buildOpenCodePlanPermissionRuleset,
  isOpenCodePlanMutatingPermission,
  listOpenCodePermissionIdsForFailedTool,
  postOpenCodePermissionResponse,
  resolveOpenCodePermissionResolvedRequestId,
  shouldRejectOpenCodePlanPermission,
} from '../lib/opencode/opencode-permission.js';
import { isOpenCodeStaleSkillError } from '../lib/opencode/opencode-instance-http.js';

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
assert.equal(isOpenCodePlanMutatingPermission({
  action: 'bash',
  metadata: { command: 'ls node_modules/@mdi/' },
}), false);
assert.equal(isOpenCodePlanMutatingPermission({
  action: 'bash',
  metadata: { command: 'node tests/conversation-fork.test.js' },
}), true);

const inputPlanRules = buildOpenCodePlanPermissionRuleset('plan');
const expectedPlanRules = [
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'ask' },
];
assert.deepEqual(inputPlanRules, expectedPlanRules);
assert.equal(buildOpenCodePlanPermissionRuleset('agent')[0].action, 'ask');
assert.equal(shouldRejectOpenCodePlanPermission('plan', askedV2), true);
assert.equal(shouldRejectOpenCodePlanPermission('plan', askedV1), true);
assert.equal(shouldRejectOpenCodePlanPermission('agent', askedV2), false);
assert.equal(shouldRejectOpenCodePlanPermission('plan', { action: 'Read file' }), false);

const askedFromData = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: { extra: true },
  data: {
    id: 'per_data',
    sessionID: 'ses_test',
    action: 'bash',
    resources: ['ls'],
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedFromData);
assert.equal(askedFromData.requestId, 'per_data');

assert.equal(
  buildOpenCodePermissionSdkEvent({
    type: 'permission.v2.asked',
    properties: {
      id: 'perm_leak',
      sessionID: 'ses_other',
      action: 'Write file',
    },
  }, {}),
  null,
);

const originalFetch = globalThis.fetch;
/** @type {Array<{ url: string, init?: RequestInit }>} */
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (fetchCalls.length === 1) {
    return new Response(JSON.stringify({
      _tag: 'PermissionNotFoundError',
      requestID: 'per_0710aab7c001tNzSXJ7FmCltDr',
      message: 'Permission request not found: per_0710aab7c001tNzSXJ7FmCltDr',
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(null, { status: 204 });
};
try {
  await postOpenCodePermissionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'per_0710aab7c001tNzSXJ7FmCltDr',
    sessionId: 'ses_f8ef57ab2ffe8vNtb0MDAa4EPv',
    directory: '/tmp/cretli-workspace',
    reply: 'once',
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);
assert.match(fetchCalls[0].url, /\/api\/session\/ses_f8ef57ab2ffe8vNtb0MDAa4EPv\/permission\/per_0710aab7c001tNzSXJ7FmCltDr\/reply/);
assert.match(fetchCalls[0].url, /directory=/);
assert.equal(
  /** @type {Record<string, string>} */ (fetchCalls[0].init?.headers)?.['x-opencode-directory'],
  encodeURIComponent('/tmp/cretli-workspace'),
);
assert.match(fetchCalls[1].url, /\/permission\/per_0710aab7c001tNzSXJ7FmCltDr\/reply\?/);

const askedWithCommand = buildOpenCodePermissionSdkEvent({
  type: 'permission.v2.asked',
  properties: {
    id: 'per_cmd',
    sessionID: 'ses_test',
    action: 'bash',
    resources: ['ls', 'head -2'],
    metadata: {
      command: 'ls; head -2',
    },
  },
}, { opencodeSessionId: 'ses_test' });
assert.deepEqual(askedWithCommand?.resources, ['ls; head -2']);

const repliedFromRequestId = resolveOpenCodePermissionResolvedRequestId({
  type: 'permission.v2.replied',
  id: 'evt_not_the_permission',
  properties: { extra: true },
  data: {
    sessionID: 'ses_test',
    requestID: 'per_from_data',
    reply: 'once',
  },
}, { opencodeSessionId: 'ses_test' });
assert.equal(repliedFromRequestId, 'per_from_data');

const pending = new Map([
  ['per_bash', { action: 'bash', requestId: 'per_bash' }],
  ['per_edit', { action: 'edit', requestId: 'per_edit' }],
]);
assert.deepEqual(
  listOpenCodePermissionIdsForFailedTool(pending, { type: 'tool_call', name: 'bash', status: 'error' }),
  ['per_bash'],
);
assert.deepEqual(
  listOpenCodePermissionIdsForFailedTool(pending, { type: 'tool_call', name: 'bash', status: 'running' }),
  [],
);
assert.equal(isOpenCodeStaleSkillError(404, '{"_tag":"PermissionNotFoundError"}'), true);
assert.equal(isOpenCodeStaleSkillError(404, '{"_tag":"NotFoundError"}'), false);

fetchCalls.length = 0;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({
    _tag: 'PermissionNotFoundError',
    requestID: 'per_gone',
    message: 'Permission request not found: per_gone',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
};
try {
  await postOpenCodePermissionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'per_gone',
    sessionId: 'ses_test',
    directory: '/tmp/cretli-workspace',
    reply: 'once',
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);

console.log('opencode-permission.test.js OK');
