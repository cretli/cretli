import assert from 'node:assert/strict';
import {
  resolveHarnessPlanPolicy,
  resolveSdkPlanCreateOptions,
  SDK_PLAN_DISALLOWED_TOOLS,
} from '../lib/agent-harness/harness-plan-policy.js';
import { getToolsForMode, isMutatingToolName } from '../lib/agent-harness/tool-definitions.js';

const inputSdkPolicy = resolveHarnessPlanPolicy('sdk');
const expectedSdkPolicy = {
  nativeMode: true,
  denyMutatingTools: true,
  abortOnMutation: true,
  promptHint: false,
};
assert.deepEqual(inputSdkPolicy, expectedSdkPolicy);

const inputOpenCodePolicy = resolveHarnessPlanPolicy('opencode');
assert.equal(inputOpenCodePolicy.nativeMode, false);
assert.equal(inputOpenCodePolicy.denyMutatingTools, true);
assert.equal(inputOpenCodePolicy.abortOnMutation, false);
assert.equal(inputOpenCodePolicy.promptHint, true);

const inputOpenRouterPolicy = resolveHarnessPlanPolicy('openrouter');
assert.equal(inputOpenRouterPolicy.nativeMode, false);
assert.equal(inputOpenRouterPolicy.denyMutatingTools, true);
assert.equal(inputOpenRouterPolicy.abortOnMutation, false);
assert.equal(inputOpenRouterPolicy.promptHint, false);

const inputCodeBuddyPolicy = resolveHarnessPlanPolicy('codebuddy');
assert.equal(inputCodeBuddyPolicy.nativeMode, true);
assert.equal(inputCodeBuddyPolicy.denyMutatingTools, true);
assert.equal(inputCodeBuddyPolicy.abortOnMutation, true);

const inputDeepSeekPolicy = resolveHarnessPlanPolicy('deepseek');
assert.equal(inputDeepSeekPolicy.nativeMode, false);
assert.equal(inputDeepSeekPolicy.denyMutatingTools, true);
assert.equal(inputDeepSeekPolicy.abortOnMutation, true);
assert.equal(inputDeepSeekPolicy.promptHint, true);

const inputCodexPolicy = resolveHarnessPlanPolicy('codex');
assert.equal(inputCodexPolicy.nativeMode, false);
assert.equal(inputCodexPolicy.denyMutatingTools, false);
assert.equal(inputCodexPolicy.abortOnMutation, false);
assert.equal(inputCodexPolicy.promptHint, true);

const inputQwenPolicy = resolveHarnessPlanPolicy('qwen');
assert.equal(inputQwenPolicy.nativeMode, true);
assert.equal(inputQwenPolicy.denyMutatingTools, true);
assert.equal(inputQwenPolicy.abortOnMutation, true);
assert.equal(inputQwenPolicy.promptHint, false);

assert.deepEqual(resolveSdkPlanCreateOptions('plan').disallowedTools, SDK_PLAN_DISALLOWED_TOOLS);
assert.deepEqual(resolveSdkPlanCreateOptions('agent'), {});
assert.deepEqual([...SDK_PLAN_DISALLOWED_TOOLS], ['edit', 'delete', 'shell']);
assert.ok(!SDK_PLAN_DISALLOWED_TOOLS.includes('write'));
assert.ok(!SDK_PLAN_DISALLOWED_TOOLS.includes('task'));
assert.ok(!SDK_PLAN_DISALLOWED_TOOLS.includes('mcp'));

assert.equal(isMutatingToolName('write_file'), true);
assert.equal(isMutatingToolName('read_file'), false);
const actualPlanTools = getToolsForMode('plan').map((tool) => tool.function?.name);
assert.ok(actualPlanTools.includes('read_file'));
assert.ok(actualPlanTools.includes('grep'));
assert.ok(!actualPlanTools.includes('write_file'));
assert.ok(!actualPlanTools.includes('run_terminal_command'));
assert.ok(getToolsForMode('agent').some((tool) => tool.function?.name === 'write_file'));

console.log('All harness-plan-policy tests passed.');
