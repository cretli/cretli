import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenEventNormalizer } from '../harnesses/qwen/qwen-event-normalizer.js';
import {
  beginHarnessRun,
  noteHarnessFirstOutput,
  recordHarnessRunFinished,
  recordHarnessUsageDelta,
} from '../lib/usage/harness-usage.ts';

function makeRoom() {
  return { chatId: 'chat-1', sessionKey: 'sk-1', delegationId: 'deleg-1', modelId: 'qwen3-coder-plus', delegationRole: 'implement' };
}

/** Runs the normalizer over a stream the way the adapter + room kernel do. */
function runStream(records, { flush = false } = {}) {
  const room = makeRoom();
  const recorded = [];
  const record = (partial) => { recorded.push(partial); return partial; };
  beginHarnessRun(room, { type: 'sdkPromptStarted', runId: 'run-1' }, {});
  const n = createQwenEventNormalizer();
  const feed = (item) => {
    if (item.kind === 'assistant' || item.type === 'assistant') {
      noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type: 'assistant' } });
    }
    if (item.kind === 'usage') recordHarnessUsageDelta(room, 'qwen', { type: 'usage', usage: item.usage }, record);
  };
  for (const r of records) for (const item of n.normalize(r)) feed(item);
  if (flush) { const p = n.flushPendingUsage(); if (p) feed(p); }
  return { room, recorded, finish: (status) => recordHarnessRunFinished(room, 'qwen', { type: 'sdkRunFinished', runId: 'run-1', status }, record) };
}

const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
const withUsage = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 20 } } };

test('run with output and provider usage yields a delta with delegationId and tokens', () => {
  const { recorded, finish } = runStream([withUsage]);
  const run = finish('completed');
  const delta = recorded.find((e) => e.eventType === 'delta');
  assert.equal(delta.delegationId, 'deleg-1');
  assert.equal(delta.tokens.textOutput, 30);
  assert.equal(delta.tokens.cachedInput, 20);
  assert.equal(delta.tokens.textInput, 100);
  assert.equal(run.measurementPresent, true);
  assert.equal(run.usageMissingReason, undefined);
});

test('run with output but no provider usage is explicitly flagged, not silent', () => {
  const { recorded, finish } = runStream([text]);
  const run = finish('completed');
  assert.equal(recorded.filter((e) => e.eventType === 'delta').length, 0);
  assert.equal(run.measurementPresent, false);
  assert.equal(run.usageMissingReason, 'provider_reported_no_usage');
});

test('aborted run without usage carries an aborted_before_usage reason', () => {
  const { finish } = runStream([text]);
  assert.equal(finish('cancelled').usageMissingReason, 'aborted_before_usage');
});

test('stream usage of an unfinished assistant message is flushed on abort', () => {
  const { recorded, finish } = runStream([
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1 } } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'par' } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 15 } } },
  ], { flush: true });
  const run = finish('cancelled');
  const delta = recorded.find((e) => e.eventType === 'delta');
  assert.equal(delta.delegationId, 'deleg-1');
  assert.equal(delta.tokens.textInput, 200);
  assert.equal(delta.tokens.textOutput, 15);
  assert.equal(run.measurementPresent, true);
});

test('a completed assistant message supersedes stream usage (no double count)', () => {
  const n = createQwenEventNormalizer();
  n.normalize({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } } });
  const usages = n.normalize(withUsage).filter((e) => e.kind === 'usage');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].usage.input_tokens, 120);
  assert.equal(n.flushPendingUsage(), null);
});

test('stream usage is used when the complete message carries none', () => {
  const n = createQwenEventNormalizer();
  n.normalize({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 7, output_tokens: 3 } } });
  const usages = n.normalize(text).filter((e) => e.kind === 'usage');
  assert.deepEqual(usages.map((e) => e.usage), [{ input_tokens: 7, output_tokens: 3 }]);
});
