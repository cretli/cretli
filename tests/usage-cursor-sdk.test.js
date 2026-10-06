import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberRoomUsagePayload,
  recordSdkRunTelemetry,
} from '../lib/sdk/cursor-agent-sdk-ws.js';
import { beginHarnessRun } from '../lib/usage/harness-usage.js';

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
    cacheWrite: 0,
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
    cacheWrite: 0,
    reasoning: 0,
  });
});

test('a new Cursor SDK run (reconnect) resets the snapshot baseline', () => {
  const records = [];
  const record = (partial) => {
    records.push(partial);
    return partial;
  };
  const room = { modelId: 'composer-2.5', chatId: 'chat-1' };

  beginHarnessRun(room, { runId: 'run-1' });
  rememberRoomUsagePayload(room, {
    type: 'sdkEvent',
    event: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } },
  }, record);
  assert.equal(records[0].tokens.textInput, 1000);

  // A reconnect opens a fresh run; the previous snapshot must not be subtracted.
  beginHarnessRun(room, { runId: 'run-2' });
  rememberRoomUsagePayload(room, {
    type: 'sdkEvent',
    event: { type: 'usage', usage: { inputTokens: 800, outputTokens: 40 } },
  }, record);
  assert.equal(records[1].tokens.textInput, 800);
  assert.equal(records[1].tokens.textOutput, 40);
  assert.equal(records[1].runId, 'run-2');
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

/**
 * Stage 2 boundary (finding 2): a snapshot that flushes after `sdkRunFinished`
 * (reconnect) still records its token delta and never mints a second run event.
 * Correcting the already-persisted run's coverage needs the stage-3
 * journal/read-model (`2d05fded`); see the TODO in `rememberRoomUsagePayload`.
 */
test('a late Cursor SDK usage after run finish records tokens but never adds a run', () => {
  const records = [];
  const record = (partial) => {
    records.push(partial);
    return partial;
  };
  const room = { modelId: 'composer-2.5', chatId: 'chat-1' };

  beginHarnessRun(room, { runId: 'run-late' });
  rememberRoomUsagePayload(
    room,
    { type: 'sdkEvent', event: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } },
    record
  );
  recordSdkRunTelemetry(room, { type: 'sdkRunFinished', status: 'completed' }, record);
  assert.equal(records.filter((row) => row.eventType === 'run').length, 1);
  assert.equal(room._runFinishedRecorded, true);

  // Late flush: the cumulative snapshot is diffed to a delta, not a run.
  rememberRoomUsagePayload(
    room,
    { type: 'sdkEvent', event: { type: 'usage', usage: { inputTokens: 160, outputTokens: 16 } } },
    record
  );
  const lateDelta = records.filter((row) => row.eventType === 'delta').at(-1);
  assert.equal(lateDelta.tokens.textInput, 60);
  assert.equal(lateDelta.tokens.textOutput, 6);
  assert.equal(
    records.filter((row) => row.eventType === 'run').length,
    1,
    'a late measurement never changes the run count'
  );

  // A repeated finish for the same run is a no-op, so no duplicate run either.
  assert.equal(recordSdkRunTelemetry(room, { type: 'sdkRunFinished', status: 'completed' }, record), null);
  assert.equal(records.filter((row) => row.eventType === 'run').length, 1);
});
