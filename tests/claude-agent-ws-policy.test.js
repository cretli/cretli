import assert from 'node:assert/strict';
import {
  CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
  buildClaudeNoticePayload,
  buildClaudeQueryOptions,
  createRoomClaudeCanUseTool,
  createRoomClaudePreToolUseHook,
  interruptActiveQuery,
  isClaudeReadOnlyRunMode,
  isResumableClaudeSessionId,
  resolveClaudePermissionMode,
  syncClaudeRoomModelFromChat,
} from '../lib/claude/claude-agent-ws.js';

assert.equal(resolveClaudePermissionMode('agent'), 'acceptEdits');
assert.equal(resolveClaudePermissionMode('plan'), 'plan');
assert.equal(resolveClaudePermissionMode('ask'), 'default');
assert.equal(resolveClaudePermissionMode('agent', 'review'), 'default');
assert.equal(resolveClaudePermissionMode('plan', 'review'), 'default');
assert.notEqual(resolveClaudePermissionMode('agent'), 'bypassPermissions');

assert.equal(isResumableClaudeSessionId('current'), false);
assert.equal(isResumableClaudeSessionId(''), false);
assert.equal(isResumableClaudeSessionId('claude-sess-1'), true);

/**
 * @param {string} mode
 * @param {string} [assignment]
 * @returns {Promise<{ behavior: string, message?: string, updatedInput?: Record<string, unknown> }>}
 */
function canUseTool(mode, assignment = '') {
  const room = { _activeRunMode: mode, sdkMode: mode, delegationAssignment: assignment };
  return createRoomClaudeCanUseTool(room)('Edit', { file_path: 'a.txt' }, {});
}

const agentDecision = await canUseTool('agent');
assert.equal(agentDecision.behavior, 'allow');
assert.equal(agentDecision.updatedInput.file_path, 'a.txt');

const planDecision = await canUseTool('plan');
assert.equal(planDecision.behavior, 'deny');
assert.match(String(planDecision.message), /Plan mode/);

const askDecision = await canUseTool('ask');
assert.equal(askDecision.behavior, 'deny');
assert.match(String(askDecision.message), /Ask mode/);

const reviewDecision = await canUseTool('agent', 'review');
assert.equal(reviewDecision.behavior, 'deny');
assert.match(String(reviewDecision.message), /review/i);

const readRoom = { _activeRunMode: 'plan', sdkMode: 'plan', delegationAssignment: '' };
const readDecision = await createRoomClaudeCanUseTool(readRoom)('Read', { file_path: 'a.txt' }, {});
assert.equal(readDecision.behavior, 'allow');

// --- Task 1: PreToolUse hook + disallowedTools close the read-only bypass ---

assert.equal(isClaudeReadOnlyRunMode('plan'), true);
assert.equal(isClaudeReadOnlyRunMode('ask'), true);
assert.equal(isClaudeReadOnlyRunMode('agent'), false);
assert.equal(isClaudeReadOnlyRunMode('agent', 'review'), true);

const planRoom = { _activeRunMode: 'plan', sdkMode: 'plan', delegationAssignment: '', cwd: '/tmp' };
const planOptions = buildClaudeQueryOptions(planRoom, 'plan', { model: 'claude-x' });
assert.equal(planOptions.permissionMode, 'plan');
assert.deepEqual(planOptions.settingSources, ['project']);
assert.deepEqual(planOptions.disallowedTools, [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS]);
assert.equal(typeof planOptions.canUseTool, 'function');
assert.equal(planOptions.hooks.PreToolUse.length, 1);
assert.equal(typeof planOptions.hooks.PreToolUse[0].hooks[0], 'function');

const planHook = planOptions.hooks.PreToolUse[0].hooks[0];
const planHookDeny = await planHook({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'a.txt' },
  tool_use_id: 'tool-1',
});
assert.equal(planHookDeny.hookSpecificOutput.hookEventName, 'PreToolUse');
assert.equal(planHookDeny.hookSpecificOutput.permissionDecision, 'deny');
assert.match(String(planHookDeny.hookSpecificOutput.permissionDecisionReason), /Plan mode/);

const planHookAllow = await planHook({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'a.txt' },
});
assert.equal(planHookAllow.continue, true);
assert.equal(planHookAllow.hookSpecificOutput, undefined);

const askOptions = buildClaudeQueryOptions({ _activeRunMode: 'ask', sdkMode: 'ask' }, 'ask');
assert.equal(askOptions.permissionMode, 'default');
assert.deepEqual(askOptions.settingSources, ['project']);
assert.deepEqual(askOptions.disallowedTools, [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS]);
const askHookDeny = await askOptions.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
assert.equal(askHookDeny.hookSpecificOutput.permissionDecision, 'deny');
assert.match(String(askHookDeny.hookSpecificOutput.permissionDecisionReason), /Ask mode/);

const reviewOptions = buildClaudeQueryOptions(
  { _activeRunMode: 'agent', sdkMode: 'agent', delegationAssignment: 'review' },
  'agent',
);
assert.equal(reviewOptions.permissionMode, 'default');
assert.deepEqual(reviewOptions.settingSources, ['project']);
assert.deepEqual(reviewOptions.disallowedTools, [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS]);
const reviewHookDeny = await reviewOptions.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: {} });
assert.equal(reviewHookDeny.hookSpecificOutput.permissionDecision, 'deny');
assert.match(String(reviewHookDeny.hookSpecificOutput.permissionDecisionReason), /review/i);

const agentOptions = buildClaudeQueryOptions({ _activeRunMode: 'agent', sdkMode: 'agent' }, 'agent', { model: 'claude-x' });
assert.equal(agentOptions.permissionMode, 'acceptEdits');
assert.equal(agentOptions.settingSources, undefined);
assert.equal(agentOptions.disallowedTools, undefined);
assert.equal(agentOptions.resume, undefined);
const agentHookAllow = await agentOptions.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Edit', tool_input: {} });
assert.equal(agentHookAllow.continue, true);
assert.equal(agentHookAllow.hookSpecificOutput, undefined);

const resumeOptions = buildClaudeQueryOptions(planRoom, 'plan', { resumeSessionId: 'claude-sess-1' });
assert.equal(resumeOptions.resume, 'claude-sess-1');
const noResumeOptions = buildClaudeQueryOptions(planRoom, 'plan', { resumeSessionId: 'current' });
assert.equal(noResumeOptions.resume, undefined);

// --- Task 3: model sync must not interrupt the active run ---
let modelInterrupts = 0;
const modelRoom = {
  modelId: 'old-model',
  _activeQuery: { interrupt: async () => { modelInterrupts += 1; } },
  _abortController: { abort() {} },
};
const rooms = new Map([['sess-1', modelRoom]]);
syncClaudeRoomModelFromChat('sess-1', 'new-model', rooms);
assert.equal(modelRoom.modelId, 'new-model');
assert.equal(modelInterrupts, 0);
assert.notEqual(modelRoom._activeQuery, null);
syncClaudeRoomModelFromChat('missing', 'new-model', rooms);
assert.equal(modelInterrupts, 0);

// --- Task 7: interrupt() first, abort/close only on failure/timeout ---
let fastAborts = 0;
let fastCloses = 0;
const fastRoom = {
  _activeQuery: { interrupt: async () => {}, close: () => { fastCloses += 1; } },
  _abortController: { abort: () => { fastAborts += 1; } },
};
await interruptActiveQuery(fastRoom, 20, 60_000);
assert.equal(fastAborts, 0);
assert.equal(fastCloses, 0);
// On success the handles are kept so a second cancel/interrupt still reaches
// the live query; runPrompt's finally clears them when the iterator ends.
assert.notEqual(fastRoom._activeQuery, null);
assert.notEqual(fastRoom._abortController, null);

// A second cancel after a successful interrupt still reaches the live query.
let secondInterrupts = 0;
const secondRoom = {
  _activeQuery: { interrupt: async () => { secondInterrupts += 1; }, close: () => {} },
  _abortController: { abort: () => {} },
};
await interruptActiveQuery(secondRoom, 20, 60_000);
await interruptActiveQuery(secondRoom, 20, 60_000);
assert.equal(secondInterrupts, 2);

// Successful interrupt but the iterator never ends -> fallback abort/close.
let fallbackAborts = 0;
let fallbackCloses = 0;
const fallbackRoom = {
  _activeQuery: { interrupt: async () => {}, close: () => { fallbackCloses += 1; } },
  _abortController: { abort: () => { fallbackAborts += 1; } },
};
await interruptActiveQuery(fallbackRoom, 20, 20);
assert.equal(fallbackAborts, 0);
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(fallbackAborts, 1);
assert.equal(fallbackCloses, 1);
assert.equal(fallbackRoom._activeQuery, null);
assert.equal(fallbackRoom._abortController, null);

// Successful interrupt and runPrompt's finally cleared the reference ->
// the fallback must not abort/close anything.
let settledAborts = 0;
let settledCloses = 0;
const settledRoom = {
  _activeQuery: { interrupt: async () => {}, close: () => { settledCloses += 1; } },
  _abortController: { abort: () => { settledAborts += 1; } },
};
await interruptActiveQuery(settledRoom, 20, 20);
settledRoom._activeQuery = null;
settledRoom._abortController = null;
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(settledAborts, 0);
assert.equal(settledCloses, 0);

let slowAborts = 0;
let slowCloses = 0;
const slowRoom = {
  _activeQuery: { interrupt: () => new Promise(() => {}), close: () => { slowCloses += 1; } },
  _abortController: { abort: () => { slowAborts += 1; } },
};
await interruptActiveQuery(slowRoom, 20);
assert.equal(slowAborts, 1);
assert.equal(slowCloses, 1);
assert.equal(slowRoom._activeQuery, null);
assert.equal(slowRoom._abortController, null);

let failAborts = 0;
let failCloses = 0;
const failRoom = {
  _activeQuery: {
    interrupt: async () => { throw new Error('interrupt failed'); },
    close: () => { failCloses += 1; },
  },
  _abortController: { abort: () => { failAborts += 1; } },
};
await interruptActiveQuery(failRoom, 20);
assert.equal(failAborts, 1);
assert.equal(failCloses, 1);
assert.equal(failRoom._activeQuery, null);

const missingInterruptRoom = { _activeQuery: { close() { failCloses += 1; } }, _abortController: { abort: () => { failAborts += 1; } } };
await interruptActiveQuery(missingInterruptRoom, 20);
assert.equal(failAborts, 2);
assert.equal(failCloses, 2);

// createRoomClaudePreToolUseHook is exported for direct wiring/tests.
const directHook = createRoomClaudePreToolUseHook(planRoom);
const directDeny = await directHook({ tool_name: 'Write', tool_input: {} });
assert.equal(directDeny.hookSpecificOutput.permissionDecision, 'deny');

// --- Task 9/10/11: informational events use sdkRunProgress, never sdkError ---
const retryNotice = buildClaudeNoticePayload({
  noticeType: 'api_retry',
  message: 'Claude API request failed and will be retried.',
  attempt: 2,
  max_retries: 5,
  retry_delay_ms: 1500,
  error: 'overloaded',
}, 'run-1');
assert.equal(retryNotice.type, 'sdkRunProgress');
assert.notEqual(retryNotice.type, 'sdkError');
assert.equal(retryNotice.phase, 'retry');
assert.equal(retryNotice.transport, 'claude');
assert.equal(retryNotice.runId, 'run-1');
assert.equal(retryNotice.attempt, 2);
assert.equal(retryNotice.max_retries, 5);
assert.equal(retryNotice.retry_delay_ms, 1500);

const deniedNotice = buildClaudeNoticePayload({
  noticeType: 'permission_denied',
  message: 'Permission denied for tool Bash',
  toolName: 'Bash',
}, 'run-1');
assert.equal(deniedNotice.phase, 'notice');
assert.equal(deniedNotice.noticeType, 'permission_denied');
assert.equal(deniedNotice.toolName, 'Bash');

const resetNotice = buildClaudeNoticePayload({
  noticeType: 'session_reset',
  message: 'Claude session could not be resumed. Starting a new session.',
});
assert.equal(resetNotice.phase, 'notice');
assert.equal(resetNotice.runId, undefined);

console.log('claude-agent-ws-policy.test.js OK');
