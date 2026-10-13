import assert from 'node:assert/strict';
import { summarizeChatHistoryUsage } from '../lib/persist/chat-history-persist.js';
import {
  buildContextPressureAssessment,
  collectChatHistoryContextStats,
  collectSdkLocalStoreStats,
  estimateEffectiveUsageInputTokens,
  findLastUsageEventPayload,
  formatContextTokenCount,
  getContextMeterFillPercent,
  getModelContextWindowTokens,
  readReportedTokenCount,
  resolveExactTotalTokens,
  resolveLiveContextUsageInputTokens,
  shouldSuggestContextMaintenance,
} from '../lib/sdk/sdk-context-stats.js';
import { inferProbeSignals } from '../lib/sdk/sdk-agent-probe.js';
import { getModelContextParamWindowTokens } from '../lib/sdk/sdk-context-advisory.js';

assert.equal(getModelContextWindowTokens('composer-2.5'), 272000);
assert.equal(getModelContextWindowTokens('grok-4.6::effort=high,fast=true'), 500000);
assert.equal(getModelContextWindowTokens('grok-4'), 256000);
// Cursor variants carry the window in `context=`; it wins over the prefix default.
assert.equal(getModelContextWindowTokens('grok-4.7::context=500k,fast=false'), 500000);
assert.equal(getModelContextWindowTokens('grok-4.7::context=256k,fast=false'), 256000);
assert.equal(getModelContextWindowTokens('claude-opus-4-8::context=300k,effort=high'), 300000);
assert.equal(getModelContextWindowTokens('composer-2::context=1m'), 1000000);
assert.equal(getModelContextParamWindowTokens('grok-4.7::context=500k,fast=false'), 500000);
assert.equal(getModelContextParamWindowTokens('grok-4.7::fast=false'), null);
assert.equal(getModelContextParamWindowTokens('grok-4.7'), null);
assert.equal(getModelContextParamWindowTokens('grok-4.7::context=wide'), null);
assert.equal(formatContextTokenCount(null), '—');
assert.equal(formatContextTokenCount(undefined), '—');
assert.equal(formatContextTokenCount(''), '—');
assert.equal(formatContextTokenCount(0), '0');
assert.equal(readReportedTokenCount(null), null);
assert.equal(readReportedTokenCount(undefined), null);
assert.equal(readReportedTokenCount(0), 0);
assert.equal(readReportedTokenCount('3862'), 3862);
assert.equal(resolveExactTotalTokens({ inputTokens: 3862, outputTokens: 0, totalTokens: 0 }), 3862);
assert.equal(resolveExactTotalTokens({ inputTokens: 3862, outputTokens: 10, totalTokens: null }), 3872);
assert.equal(resolveExactTotalTokens({ inputTokens: 3862, outputTokens: 10, totalTokens: 4000 }), 4000);
assert.deepEqual(
  findLastUsageEventPayload(
    [
      { payload: { type: 'sdkEvent', event: { type: 'usage', usage: { inputTokens: 10 } } } },
      { payload: { type: 'sdkEvent', event: { type: 'assistant' } } },
      { payload: { type: 'sdkEvent', event: { type: 'assistant' } } },
      { payload: { type: 'sdkEvent', event: { type: 'assistant' } } },
      { payload: { type: 'sdkEvent', event: { type: 'assistant' } } },
      { payload: { type: 'sdkEvent', event: { type: 'assistant' } } },
    ],
    null,
  ),
  { inputTokens: 10 },
);
assert.deepEqual(
  findLastUsageEventPayload([], { inputTokens: 42, totalTokens: 50 }),
  { inputTokens: 42, totalTokens: 50 },
);
assert.equal(getContextMeterFillPercent(451.1), 100);
assert.equal(shouldSuggestContextMaintenance(74, 75), false);
assert.equal(shouldSuggestContextMaintenance(75, 75), true);
assert.equal(shouldSuggestContextMaintenance(120, 80), true);

assert.equal(estimateEffectiveUsageInputTokens(1230916, 1176416), 54500);
assert.equal(estimateEffectiveUsageInputTokens(22496, 7968), 14528);
assert.equal(estimateEffectiveUsageInputTokens(474000, 389408), 84592);

const missingHistory = collectChatHistoryContextStats('00000000-0000-4000-8000-000000000000');
assert.equal(missingHistory?.lastUsageInputTokens, null);
assert.equal(missingHistory?.lastUsageOutputTokens, null);
assert.equal(missingHistory?.lastUsageTotalTokens, null);

const pressure = buildContextPressureAssessment({
  modelId: 'composer-2.5',
  lastUsageInputTokens: 44662,
  maxUsageInputTokens: 2339986,
  rawLastUsageInputTokens: 44662,
  rawMaxUsageInputTokens: 2339986,
  localStoreTotalBytes: 87 * 1024 * 1024,
  headSeq: 10832,
});
assert.equal(pressure.contextFillPercent, 16.4);
assert.equal(pressure.peakContextFillPercent, 860.3);
assert.equal(pressure.likelyContextPressure, false);
assert.ok(pressure.warnings.includes('context_peak_over_model_window'));
assert.ok(pressure.warnings.includes('local_store_large'));

const currentPressure = buildContextPressureAssessment({
  modelId: 'composer-2.5',
  lastUsageInputTokens: 22496,
  maxUsageInputTokens: 54500,
  rawLastUsageInputTokens: 22496,
  rawMaxUsageInputTokens: 1230916,
});
assert.equal(currentPressure.contextFillPercent, 8.3);
assert.equal(currentPressure.peakContextFillPercent, 20);
assert.equal(currentPressure.likelyContextPressure, false);

assert.equal(
  resolveLiveContextUsageInputTokens({
    chat: { sdkAgentId: 'agent-1' },
    room: { lastUsageInputTokens: 12000 },
    historyStats: { lastUsageInputTokens: 217000 },
  }),
  12000
);
assert.equal(
  resolveLiveContextUsageInputTokens({
    chat: { sdkAgentId: 'agent-1' },
    room: { lastUsageInputTokens: null },
    historyStats: { lastUsageInputTokens: 217000 },
  }),
  null
);
assert.equal(
  resolveLiveContextUsageInputTokens({
    chat: {},
    room: null,
    historyStats: { lastUsageInputTokens: 217000 },
  }),
  null
);
assert.equal(
  resolveLiveContextUsageInputTokens({
    chat: { sdkAgentId: 'agent-1' },
    room: null,
    historyStats: { lastUsageInputTokens: 217000 },
  }),
  217000
);

const storeStats = collectSdkLocalStoreStats('');
assert.equal(storeStats, null);

const probe = {
  chat: { sdkAgentId: 'agent-aaaf947c-444b-4838-8d41-b15495c74a8f' },
  resume: { ok: false, isAuthenticationError: true },
  create: { ok: true, firstAssistantText: 'PROBE_OK' },
  contextPressure: { likelyContextPressure: false, contextFillPercent: 8.3, peakContextFillPercent: 451.1 },
  localStore: {
    agents: [{ agentId: 'agent-aaaf947c-444b-4838-8d41-b15495c74a8f', status: 'error' }],
  },
};
const signals = inferProbeSignals(probe);
assert.ok(signals.includes('misleading_auth_on_resume'));
assert.equal(signals.includes('context_over_model_window'), false);

const historyUsageSummary = summarizeChatHistoryUsage([
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'usage',
        usage: { inputTokens: 1600, totalTokens: 1600 },
        lastCallUsage: { totalTokens: 85000 },
        lastCallModel: 'claude-sonnet-4-20250514',
      },
    },
  },
  { rec: { kind: 'sdk', event: { type: 'assistant' } } },
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'usage',
        usage: { inputTokens: 40, totalTokens: 40 },
        lastCallUsage: { totalTokens: 90000 },
        lastCallModel: 'claude-opus-4-20250514',
        modelUsage: { 'claude-opus-4-20250514': { contextWindow: 1000000 } },
      },
    },
  },
]);
assert.equal(historyUsageSummary.lastCallContextTokens, 90000);
assert.equal(historyUsageSummary.lastCallModel, 'claude-opus-4-20250514');
// Stored runs carry the SDK window in `modelUsage` even without the explicit field.
assert.equal(historyUsageSummary.lastCallContextWindowTokens, 1000000);
assert.equal(summarizeChatHistoryUsage([]).lastCallContextTokens, null);
assert.equal(summarizeChatHistoryUsage([]).lastCallContextWindowTokens, null);

console.log('All sdk-context-stats tests passed.');
