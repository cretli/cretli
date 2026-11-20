import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  applyClaudeHistoryContextUsage,
  applyClaudeMeasuredContextUsage,
  buildChatContextSnapshot,
  formatChatContextUsageLabel,
  resetChatContextMeterState,
  resolveChatContextUsage,
  resolveChatContextUsageSource,
  resolveContextMeterModelId,
} from '../app_front/features/chat/chatContextMeter.js';
import {
  estimateContextFillPercent,
  estimateTokensFromText,
  formatContextRingCenterLabel,
  setDynamicModelContextWindows,
} from '../lib/sdk/sdk-context-advisory.ts';

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
  { estimated: false, hasReportedUsage: true, fillProvenance: 'measured' },
);
assert.equal(sourceFallback, 'openrouter-live');

const sourceEstimated = resolveChatContextUsageSource(
  { agentTransport: 'openrouter' },
  { estimated: true, hasReportedUsage: false, fillProvenance: 'estimated' },
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

{
  const reported = resolveChatContextUsage({
    _contextUsageInputTokens: 999,
    _buffer: 'A'.repeat(4000),
  });
  assert.equal(reported.inputTokens, 999);
  assert.equal(reported.estimated, false);
  const estimatedOnly = resolveChatContextUsage({ _buffer: 'A'.repeat(4000) });
  assert.equal(estimatedOnly.estimated, true);
  assert.equal(estimatedOnly.inputTokens, 1000); // ceil(4000 / 4), specified independently of the helper
  assert.equal(estimateTokensFromText('A'.repeat(4001)), 1001);
  assert.equal(estimateTokensFromText(''), 0);
  const meterSource = readFileSync(new URL('../app_front/features/chat/chatContextMeter.js', import.meta.url), 'utf8');
  assert.match(meterSource, /estimateTokensFromText,?\s*\n?.*from '.*sdk-context-advisory\.ts'/s);
  assert.doesNotMatch(meterSource, /\.length\s*\/\s*4/);
}

const claudeRunUsageChat = {
  agentTransport: 'claude',
  model: 'claude-sonnet-4-20250514',
  _contextUsageInputTokens: 668_113,
  _contextUsageSource: 'claude-live',
  _contextFillPercent: 66.8,
};
const claudeRunUsageSnapshot = buildChatContextSnapshot(claudeRunUsageChat, claudeRunUsageChat.model);
assert.equal(claudeRunUsageSnapshot.fillPercent, null);
assert.equal(claudeRunUsageSnapshot.fillProvenance, 'none');
assert.equal(claudeRunUsageSnapshot.source, 'claude-no-data');
assert.equal(claudeRunUsageSnapshot.inputTokens, null);

const claudeEstimatedChat = {
  agentTransport: 'claude',
  model: 'claude-sonnet-4-20250514',
  _buffer: 'A'.repeat(4000),
};
const claudeEstimatedSnapshot = buildChatContextSnapshot(claudeEstimatedChat, claudeEstimatedChat.model);
assert.equal(claudeEstimatedSnapshot.isEstimated, true);
assert.equal(claudeEstimatedSnapshot.fillProvenance, 'estimated');
assert.equal(claudeEstimatedSnapshot.source, 'claude-estimated');
assert.equal(claudeEstimatedSnapshot.fillPercent, 0.5);

const claudeMeasuredChat = {
  agentTransport: 'claude',
  model: 'claude-sonnet-4-20250514',
  _contextMeasuredTokens: 85000,
  _contextMeasuredUpdatedAt: 1750000000000,
};
const claudeMeasuredSnapshot = buildChatContextSnapshot(claudeMeasuredChat, claudeMeasuredChat.model);
assert.equal(claudeMeasuredSnapshot.fillProvenance, 'measured');
assert.equal(claudeMeasuredSnapshot.source, 'claude-measured');
assert.equal(claudeMeasuredSnapshot.inputTokens, 85000);
assert.equal(claudeMeasuredSnapshot.fillPercent, 42.5);
assert.equal(claudeMeasuredSnapshot.isEstimated, false);

{
  const liveChat = { agentTransport: 'claude' };
  assert.equal(applyClaudeMeasuredContextUsage(liveChat, { totalTokens: 85000 }, 'claude-sonnet-4-20250514'), true);
  assert.equal(buildChatContextSnapshot(liveChat, liveChat._contextUsageModelId).fillPercent, 42.5);
  assert.equal(applyClaudeMeasuredContextUsage(liveChat, { totalTokens: 0 }, 'claude-sonnet-4-20250514'), false);
  assert.equal(applyClaudeMeasuredContextUsage(liveChat, null, 'claude-sonnet-4-20250514'), false);
  assert.equal(liveChat._contextMeasuredTokens, 85000);
  assert.equal(applyClaudeMeasuredContextUsage({ agentTransport: 'sdk' }, { totalTokens: 85000 }, 'gpt-5-mini'), false);
}

{
  const tinyChat = { agentTransport: 'claude' };
  applyClaudeMeasuredContextUsage(tinyChat, { totalTokens: 50 }, 'claude-sonnet-4-20250514');
  assert.equal(buildChatContextSnapshot(tinyChat, tinyChat._contextUsageModelId).fillPercent, 0.1);
  assert.equal(estimateContextFillPercent(50, 'claude-sonnet-4-20250514'), 0.1);
  assert.equal(estimateContextFillPercent(0, 'claude-sonnet-4-20250514'), null);
}

{
  const keyOf = (key) => key;
  assert.equal(formatChatContextUsageLabel(keyOf, null, 'sonnet', null, false, 'none', true), 'chat.contextMeterNoData');
  assert.equal(
    formatChatContextUsageLabel(keyOf, 85000, 'sonnet', null, false, 'measured', true),
    'chat.contextMeterTokensNoWindow',
  );
  assert.equal(
    formatChatContextUsageLabel(keyOf, 1000, 'sonnet', null, true, 'estimated', false),
    'chat.contextMeterEstimatedTokensNoWindow',
  );
  assert.equal(
    formatChatContextUsageLabel(keyOf, 1000, 'sonnet', 0.5, false, 'measured', false),
    'chat.contextMeterTokensOnly',
  );
  assert.equal(
    formatChatContextUsageLabel(keyOf, 85000, 'claude-sonnet-4-20250514', 42.5, false, 'measured', true),
    'chat.contextMeterMeasured',
  );
  assert.equal(
    formatChatContextUsageLabel(keyOf, 1000, 'claude-sonnet-4-20250514', 0.5, true, 'estimated', false),
    'chat.contextMeterEstimated',
  );
}

{
  const historyEntry = { lastCallContextTokens: 85000, lastCallModel: 'claude-sonnet-4-20250514' };
  const resetChat = { agentTransport: 'claude', model: 'claude-sonnet-4-20250514' };
  resetChatContextMeterState(resetChat, { reason: 'compact_boundary' });
  assert.equal(applyClaudeHistoryContextUsage(resetChat, historyEntry), false);
  assert.equal(resetChat._contextMeasuredTokens, undefined);

  const liveFirstChat = { agentTransport: 'claude', model: 'sonnet' };
  applyClaudeMeasuredContextUsage(liveFirstChat, { totalTokens: 100000 }, 'claude-sonnet-4-20250514');
  assert.equal(applyClaudeHistoryContextUsage(liveFirstChat, historyEntry), false);
  assert.equal(liveFirstChat._contextMeasuredTokens, 100000);

  const hydratedChat = { agentTransport: 'claude', model: 'sonnet' };
  assert.equal(applyClaudeHistoryContextUsage(hydratedChat, historyEntry), true);
  const hydratedModelId = resolveContextMeterModelId(hydratedChat, hydratedChat.model);
  assert.equal(hydratedModelId, 'claude-sonnet-4-20250514');
  assert.equal(buildChatContextSnapshot(hydratedChat, hydratedModelId).fillPercent, 42.5);
  assert.equal(
    applyClaudeHistoryContextUsage(hydratedChat, { lastCallContextTokens: 1, lastCallModel: 'claude-haiku-4-5-20251001' }),
    false,
  );
  assert.equal(hydratedChat._contextMeasuredTokens, 85000);
}

{
  // The SDK-reported window wins over the per-model table.
  const wideChat = { agentTransport: 'claude', model: 'claude-sonnet-4-20250514::effort=medium' };
  applyClaudeMeasuredContextUsage(wideChat, { totalTokens: 145001 }, 'claude-sonnet-4-20250514', 1000000);
  const wideSnapshot = buildChatContextSnapshot(wideChat, wideChat.model, (...args) => args[6]);
  assert.equal(wideSnapshot.contextWindowTokens, 1000000);
  assert.equal(wideSnapshot.fillPercent, 14.5);
  assert.equal(wideSnapshot.label, 1000000);
  // A later call without a window keeps it while the model is unchanged...
  applyClaudeMeasuredContextUsage(wideChat, { totalTokens: 150000 }, 'claude-sonnet-4-20250514', null);
  assert.equal(buildChatContextSnapshot(wideChat, wideChat.model).fillPercent, 15);
  // ...and drops it when the call ran on another model.
  applyClaudeMeasuredContextUsage(wideChat, { totalTokens: 150000 }, 'claude-haiku-4-5-20251001', null);
  assert.equal(buildChatContextSnapshot(wideChat, wideChat.model).contextWindowTokens, 200000);
  resetChatContextMeterState(wideChat, { reason: 'model_change' });
  assert.equal(wideChat._contextMeasuredWindowTokens, undefined);

  // Reload: the stored run supplies tokens and window together.
  const storedRun = {
    lastCallContextTokens: 145001,
    lastCallModel: 'claude-sonnet-4-20250514',
    lastCallContextWindowTokens: 1000000,
  };
  const reloadedChat = { agentTransport: 'claude', model: 'sonnet' };
  assert.equal(applyClaudeHistoryContextUsage(reloadedChat, storedRun), true);
  assert.equal(buildChatContextSnapshot(reloadedChat, reloadedChat.model).fillPercent, 14.5);
  // A live value measured first keeps its tokens and adopts the stored window.
  const liveBeforeHistoryChat = { agentTransport: 'claude', model: 'sonnet' };
  applyClaudeMeasuredContextUsage(liveBeforeHistoryChat, { totalTokens: 160000 }, 'claude-sonnet-4-20250514');
  assert.equal(applyClaudeHistoryContextUsage(liveBeforeHistoryChat, storedRun), true);
  assert.equal(liveBeforeHistoryChat._contextMeasuredTokens, 160000);
  assert.equal(buildChatContextSnapshot(liveBeforeHistoryChat, liveBeforeHistoryChat.model).fillPercent, 16);
  // Without a report the Claude 5 fallback is the 1M window Opus and Sonnet run on.
  assert.equal(estimateContextFillPercent(145001, 'claude-opus-5-5::effort=medium'), 14.5);
  assert.equal(estimateContextFillPercent(100000, 'claude-haiku-5-5'), 50);
}

assert.equal(formatContextRingCenterLabel(null), '—');
assert.equal(formatContextRingCenterLabel(undefined), '—');
assert.equal(formatContextRingCenterLabel(-3), '—');
assert.equal(formatContextRingCenterLabel(0.1), '<1');
assert.equal(formatContextRingCenterLabel(42.5), '43');
assert.equal(formatContextRingCenterLabel(99.6), '99+');

const claudeEpochChat = { agentTransport: 'claude', model: 'claude-sonnet-4-20250514' };
resetChatContextMeterState(claudeEpochChat, { reason: 'compact_boundary' });
assert.equal(claudeEpochChat._contextMeterEpoch, 1);
assert.equal(claudeEpochChat._contextMeterBoundaryReason, 'compact_boundary');
resetChatContextMeterState(claudeEpochChat, { reason: 'compact_boundary' });
assert.equal(claudeEpochChat._contextMeterEpoch, 2);

console.log('chat-context-meter.test.js OK');
