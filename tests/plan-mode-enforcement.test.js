import assert from 'node:assert/strict';
import { createCodeBuddyLiveSession } from '../lib/codebuddy/codebuddy-live-session.js';
import {
  ASK_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  resolvePlanModeSdkEventDecision,
  resolvePlanModeToolDecision,
} from '../lib/sdk/sdk-plan-guard.js';
import { HARNESS_ASK_MODE_HINT, HARNESS_PLAN_MODE_HINT, applyHarnessOutboundPrompt } from '../lib/sdk/harness-plan-prompt.js';

const editEvent = { type: 'tool_call', name: 'edit', status: 'running' };
const readEvent = { type: 'tool_call', name: 'read', status: 'running' };
const rgEvent = {
  type: 'tool_call',
  name: 'shell',
  status: 'running',
  args: { command: 'rg -n foo' },
};
const rmEvent = {
  type: 'tool_call',
  name: 'shell',
  status: 'running',
  args: { command: 'rm -rf tmp' },
};

const sdkEdit = resolvePlanModeSdkEventDecision({ transport: 'sdk', mode: 'plan', event: editEvent });
assert.equal(sdkEdit.deny, true);
assert.equal(sdkEdit.abortRun, true);
assert.equal(sdkEdit.notify, true);

const sdkRead = resolvePlanModeSdkEventDecision({ transport: 'sdk', mode: 'plan', event: readEvent });
assert.equal(sdkRead.deny, false);
assert.equal(sdkRead.abortRun, false);

const openCodeEdit = resolvePlanModeSdkEventDecision({
  transport: 'opencode',
  mode: 'plan',
  event: editEvent,
});
assert.equal(openCodeEdit.deny, true);
assert.equal(openCodeEdit.abortRun, false);

const openRouterWrite = resolvePlanModeToolDecision({
  transport: 'openrouter',
  mode: 'plan',
  toolName: 'write_file',
  input: { path: 'x.txt', content: 'nope' },
});
assert.equal(openRouterWrite.deny, true);
assert.equal(openRouterWrite.abortRun, false);

const openRouterRead = resolvePlanModeToolDecision({
  transport: 'openrouter',
  mode: 'plan',
  toolName: 'read_file',
  input: { path: 'x.txt' },
});
assert.equal(openRouterRead.deny, false);

const qwenRg = resolvePlanModeSdkEventDecision({ transport: 'qwen', mode: 'plan', event: rgEvent });
assert.equal(qwenRg.deny, false);
const qwenRm = resolvePlanModeSdkEventDecision({ transport: 'qwen', mode: 'plan', event: rmEvent });
assert.equal(qwenRm.deny, true);
assert.equal(qwenRm.abortRun, true);

const codexEdit = resolvePlanModeSdkEventDecision({
  transport: 'codex',
  mode: 'plan',
  event: editEvent,
});
assert.equal(codexEdit.deny, false);
assert.equal(codexEdit.abortRun, false);
assert.equal(codexEdit.notify, false);
assert.ok(applyHarnessOutboundPrompt('hello', { mode: 'plan', transport: 'codex' }).startsWith(HARNESS_PLAN_MODE_HINT));
const codexAskEdit = resolvePlanModeSdkEventDecision({
  transport: 'codex',
  mode: 'ask',
  event: editEvent,
});
assert.equal(codexAskEdit.deny, true);
assert.equal(codexAskEdit.abortRun, true);
assert.ok(applyHarnessOutboundPrompt('hello', { mode: 'ask', transport: 'codex' }).startsWith(HARNESS_ASK_MODE_HINT));
assert.equal(applyHarnessOutboundPrompt('hello', { mode: 'ask', transport: 'codex' }).includes('question-UI approval'), false);

const sdkAskRead = resolvePlanModeSdkEventDecision({
  transport: 'sdk',
  mode: 'ask',
  event: readEvent,
});
assert.equal(sdkAskRead.deny, false);

let capturedCanUseTool = null;
createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => {
      capturedCanUseTool = options.canUseTool;
      return { closed: false, transport: { options: {} } };
    },
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: {},
  cwd: '/tmp/workspace',
  permissionMode: 'plan',
});
assert.equal(typeof capturedCanUseTool, 'function');
const deniedEdit = await capturedCanUseTool('edit', { path: 'a.js' });
assert.equal(deniedEdit.behavior, 'deny');
assert.equal(deniedEdit.message, PLAN_GUARD_USER_MESSAGE);
const allowedRead = await capturedCanUseTool('read', { path: 'a.js' });
assert.equal(allowedRead.behavior, 'allow');
let executed = false;
const allowedRg = await capturedCanUseTool('shell', { command: 'rg -n foo' });
assert.equal(allowedRg.behavior, 'allow');
executed = true;
assert.equal(executed, true);

let agentCanUseTool = null;
createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => {
      agentCanUseTool = options.canUseTool;
      return { closed: false, transport: { options: {} } };
    },
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: {},
  cwd: '/tmp/workspace',
  permissionMode: 'bypassPermissions',
});
const agentEdit = await agentCanUseTool('edit', { path: 'a.js' });
assert.equal(agentEdit.behavior, 'allow');

let askCanUseTool = null;
createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => {
      askCanUseTool = options.canUseTool;
      return { closed: false, transport: { options: {} } };
    },
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: {},
  cwd: '/tmp/workspace',
  permissionMode: 'bypassPermissions',
  conversationMode: 'ask',
});
const askDeniedEdit = await askCanUseTool('edit', { path: 'a.js' });
assert.equal(askDeniedEdit.behavior, 'deny');
assert.equal(askDeniedEdit.message, ASK_GUARD_USER_MESSAGE);
const askAllowedRead = await askCanUseTool('read', { path: 'a.js' });
assert.equal(askAllowedRead.behavior, 'allow');

console.log('plan-mode-enforcement.test.js OK');
