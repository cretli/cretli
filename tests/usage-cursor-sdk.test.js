import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberRoomUsagePayload,
  recordSdkRunTelemetry,
} from '../lib/sdk/cursor-agent-sdk-ws.js';

test('cursor sdk usage snapshots record harness sdk deltas only', () => {
  const records = [];
  const record = (partial) => {
    records.push(partial);
    return partial;
  };
  const room = { modelId: 'composer-2.5::fast=true', chatId: 'chat-1' };

  rememberRoomUsagePayload(
    room,
    {
      type: 'sdkEvent',
      event: {
        type: 'usage',
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, reasoningTokens: 10 },
      },
    },
    record
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].harness, 'sdk');
  assert.equal(records[0].provider, 'cursor');
  assert.equal(records[0].eventType, 'delta');
  assert.equal(records[0].model, 'composer-2.5');
  assert.equal(records[0].role, 'chat');
  assert.deepEqual(records[0].tokens, {
    textInput: 1000,
    textOutput: 100,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 200,
    reasoning: 10,
  });

  // The SDK reports cumulative snapshots: the second event only adds the diff.
  rememberRoomUsagePayload(
    room,
    {
      type: 'sdkEvent',
      event: {
        type: 'usage',
        usage: { inputTokens: 1500, outputTokens: 150, cacheReadTokens: 200, reasoningTokens: 10 },
      },
    },
    record
  );
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].tokens, {
    textInput: 500,
    textOutput: 50,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 0,
    reasoning: 0,
  });
});

test('cursor sdk run telemetry carries outcome and latency but no tokens', () => {
  const records = [];
  const record = (partial) => {
    records.push(partial);
    return partial;
  };
  const room = {
    modelId: 'composer-2.5',
    chatId: 'chat-1',
    _runStartedAt: Date.now() - 40,
    _firstOutputAt: Date.now() - 20,
  };
  const partial = recordSdkRunTelemetry(
    room,
    { type: 'sdkRunFinished', status: 'completed', lastErrorMessage: '' },
    record
  );
  assert.ok(partial);
  assert.equal(records.length, 1);
  assert.equal(partial.harness, 'sdk');
  assert.equal(partial.eventType, 'run');
  assert.equal(partial.provider, 'cursor');
  assert.equal(partial.outcome, 'ok');
  assert.equal(partial.tokens, undefined);
  assert.ok(partial.latencyMs >= 40);
  assert.ok(partial.ttftMs >= 20);
  assert.equal(room._runStartedAt, null);
});
