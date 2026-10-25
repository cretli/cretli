import assert from 'node:assert/strict';
import test from 'node:test';

import { rememberRoomUsagePayload, recordSdkRunUsageFallback } from '../lib/sdk/cursor-agent-sdk-ws.ts';
import { beginHarnessRun, noteHarnessFirstOutput, recordHarnessRunFinished } from '../lib/usage/harness-usage.ts';

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 120 };

function setup() {
  const room = { chatId: 'chat-1', sessionKey: 'sk-1', delegationId: 'deleg-1', modelId: 'composer', delegationRole: 'implement' };
  const recorded = [];
  const record = (partial) => { recorded.push(partial); return partial; };
  beginHarnessRun(room, { type: 'sdkPromptStarted', runId: 'run-1' }, {});
  noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type: 'assistant' } });
  return { room, recorded, record };
}

test('stream usage event yields one delta with delegationId and no fallback', () => {
  const { room, recorded, record } = setup();
  rememberRoomUsagePayload(room, { type: 'sdkEvent', event: { type: 'usage', usage } }, record);
  const result = recordSdkRunUsageFallback(room, { usage }, record);
  assert.equal(result, 'stream');
  const deltas = recorded.filter((e) => e.eventType === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delegationId, 'deleg-1');
  assert.equal(deltas[0].usageSource, undefined);
});

test('no stream usage but run.usage populated records a tagged fallback delta', () => {
  const { room, recorded, record } = setup();
  assert.equal(recordSdkRunUsageFallback(room, { usage }, record), 'fallback');
  const deltas = recorded.filter((e) => e.eventType === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delegationId, 'deleg-1');
  assert.equal(deltas[0].usageSource, 'run.usage');
  assert.equal(deltas[0].tokens.textInput, 100);
  assert.equal(room._runHadMeasurement, true);
});

test('no usage anywhere leaves an explicit marker and no tokens', () => {
  const { room, recorded, record } = setup();
  const orig = console.debug;
  console.debug = () => {};
  try {
    assert.equal(recordSdkRunUsageFallback(room, {}, record), 'none');
  } finally {
    console.debug = orig;
  }
  assert.equal(recorded.filter((e) => e.eventType === 'delta').length, 0);
  assert.equal(room._runUsageMissingReason, 'provider_reported_no_usage');
  const run = recordHarnessRunFinished(room, 'sdk', { type: 'sdkRunFinished', runId: 'run-1', status: 'finished' }, record);
  assert.equal(run.measurementPresent, false);
  assert.equal(run.usageMissingReason, 'provider_reported_no_usage');
});
