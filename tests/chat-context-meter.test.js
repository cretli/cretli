import assert from 'node:assert/strict';
import {
  buildChatContextSnapshot,
  resolveChatContextUsageSource,
} from '../app_front/features/chat/chatContextMeter.js';
import { setDynamicModelContextWindows } from '../lib/sdk/sdk-context-advisory.js';

const sdkChat = {
  agentTransport: 'sdk',
  model: 'gpt-5-mini',
  _contextUsageInputTokens: 42000,
  _contextUsageOutputTokens: 120,
  _contextUsageTotalTokens: 42120,
  _contextUsageSource: 'sdk-live',
  _contextFillPercent: 15.4,
  _contextPeakFillPercent: 31.2,
  _contextWarnings: ['context_fill_high'],
  _contextUsageUpdatedAt: 1750000000000,
};

const sdkSnapshot = buildChatContextSnapshot(
  sdkChat,
  'gpt-5-mini',
  (inputTokens, modelId, percent, estimated) => `${inputTokens}:${modelId}:${percent}:${estimated}`,
);

assert.equal(sdkSnapshot.source, 'sdk-live');
assert.equal(sdkSnapshot.isEstimated, false);
assert.equal(sdkSnapshot.inputTokens, 42000);
assert.equal(sdkSnapshot.outputTokens, 120);
assert.equal(sdkSnapshot.totalTokens, 42120);
assert.equal(sdkSnapshot.contextWindowTokens, 272000);
assert.equal(sdkSnapshot.fillPercent, 15.4);
assert.equal(sdkSnapshot.peakFillPercent, 31.2);
assert.deepEqual(sdkSnapshot.warnings, ['context_fill_high']);
assert.equal(sdkSnapshot.label, '42000:gpt-5-mini:15.4:false');

const opencodeChat = {
  agentTransport: 'opencode',
  model: 'gpt-5-mini',
  _buffer: 'A'.repeat(4000),
};

const opencodeSnapshot = buildChatContextSnapshot(opencodeChat, 'gpt-5-mini');
assert.equal(opencodeSnapshot.isEstimated, true);
assert.equal(opencodeSnapshot.source, 'opencode-estimated');
assert.equal(opencodeSnapshot.inputTokens, 1000);
assert.equal(opencodeSnapshot.fillPercent, 0.4);

setDynamicModelContextWindows([
  { id: 'opencode/x-preview-f-free', contextWindowTokens: 1000000 },
]);
const opencodeSnapshotWithRuntimeWindow = buildChatContextSnapshot(
  { agentTransport: 'opencode', model: 'opencode/x-preview-f-free', _buffer: 'A'.repeat(4000) },
  'opencode/x-preview-f-free',
);
assert.equal(opencodeSnapshotWithRuntimeWindow.contextWindowTokens, 1000000);
assert.equal(opencodeSnapshotWithRuntimeWindow.fillPercent, 0.1);

const sourceFallback = resolveChatContextUsageSource(
  { agentTransport: 'openrouter' },
  { estimated: false, hasReportedUsage: true },
);
assert.equal(sourceFallback, 'openrouter-live');

const sourceEstimated = resolveChatContextUsageSource(
  { agentTransport: 'openrouter' },
  { estimated: true, hasReportedUsage: false },
);
assert.equal(sourceEstimated, 'openrouter-estimated');

const estimatedSdkChat = {
  agentTransport: 'sdk',
  model: 'grok-4.6::effort=high,fast=true',
  _buffer: 'A'.repeat(15448),
  _contextUsageOutputTokens: 0,
  _contextUsageTotalTokens: 0,
};
const estimatedSdkSnapshot = buildChatContextSnapshot(estimatedSdkChat, estimatedSdkChat.model);
assert.equal(estimatedSdkSnapshot.isEstimated, true);
assert.equal(estimatedSdkSnapshot.source, 'sdk-estimated');
assert.equal(estimatedSdkSnapshot.inputTokens, 3862);
assert.equal(estimatedSdkSnapshot.outputTokens, null);
assert.equal(estimatedSdkSnapshot.totalTokens, null);
assert.equal(estimatedSdkSnapshot.contextWindowTokens, 500000);

const exactMissingTotal = buildChatContextSnapshot(
  {
    agentTransport: 'sdk',
    model: 'gpt-5-mini',
    _contextUsageInputTokens: 3862,
    _contextUsageOutputTokens: 0,
    _contextUsageTotalTokens: 0,
  },
  'gpt-5-mini',
);
assert.equal(exactMissingTotal.isEstimated, false);
assert.equal(exactMissingTotal.inputTokens, 3862);
assert.equal(exactMissingTotal.outputTokens, 0);
assert.equal(exactMissingTotal.totalTokens, 3862);

console.log('chat-context-meter.test.js OK');
