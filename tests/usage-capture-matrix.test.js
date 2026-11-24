import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenCodeUsageSdkEvent, resolveOpenCodeUsageFromStreamEvent, noteOpenCodeMessageTokenDelta } from '../harnesses/opencode/opencode-usage.js';
import { recordSdkRunUsageFallback } from '../lib/sdk/cursor-agent-sdk-ws.ts';
import {
  beginHarnessRun,
  noteHarnessFirstOutput,
  recordHarnessRunFinished,
  recordHarnessUsageDelta,
  resolveHarnessRole,
} from '../lib/usage/harness-usage.ts';

const HARNESSES = ['sdk', 'opencode', 'qwen'];
// Room shape per role: work roles come from the delegation work role, the orchestrator from the cycle id.
const ROLES = {
  plan: { delegationId: 'd1', delegationAttemptId: 'a1', delegationAssignment: 'review', delegationWorkRole: 'plan' },
  implement: { delegationId: 'd1', delegationAttemptId: 'a1', delegationAssignment: 'implement', delegationWorkRole: 'implement' },
  review: { delegationId: 'd1', delegationAttemptId: 'a1', delegationAssignment: 'review', delegationWorkRole: 'review_code' },
  fix: { delegationId: 'd1', delegationAttemptId: 'a1', delegationAssignment: 'implement', delegationWorkRole: 'fix' },
  orchestrator: { watcherCycleId: 'cycle-1' },
};
// Normalized work role used by the writer: review_* folds into review.
const EXPECTED_ROLE = { plan: 'plan', implement: 'implement', review: 'review', fix: 'fix', orchestrator: 'orchestrator' };

function usageEvent(harness) {
  if (harness === 'sdk') return { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 120 } };
  if (harness === 'qwen') return { type: 'usage', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 } };
  return buildOpenCodeUsageSdkEvent({ input: 100, output: 20, reasoning: 0, cacheRead: 10, cacheWrite: 0 });
}

function setup(harness, roleKey, { meta = true } = {}) {
  const room = { chatId: 'chat-1', sessionKey: 'sk-1', modelId: 'm', ...(meta ? ROLES[roleKey] : {}) };
  const recorded = [];
  const record = (partial) => { recorded.push(partial); return partial; };
  beginHarnessRun(room, { type: 'sdkPromptStarted', runId: 'run-1' }, {});
  const output = () => noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } });
  const finish = (status, extra = {}) => recordHarnessRunFinished(room, harness, { type: 'sdkRunFinished', runId: 'run-1', status, ...extra }, record);
  return { room, recorded, record, output, finish };
}

for (const harness of HARNESSES) {
  for (const roleKey of Object.keys(ROLES)) {
    test(`${harness} x ${roleKey}: normal end is a measured run with the right role and identity`, () => {
      const { room, recorded, record, output, finish } = setup(harness, roleKey);
      output();
      assert.ok(recordHarnessUsageDelta(room, harness, usageEvent(harness), record));
      const run = finish('completed');
      const delta = recorded.find((e) => e.eventType === 'delta');
      assert.equal(delta.role, EXPECTED_ROLE[roleKey]);
      assert.equal(delta.harness, harness);
      if (roleKey === 'orchestrator') assert.equal(delta.cycleId, 'cycle-1');
      else assert.equal(delta.delegationId, 'd1');
      if (roleKey !== 'orchestrator') assert.equal(delta.attemptId, 'a1');
      assert.equal(run.measurementPresent, true);
      assert.equal(run.usageMissingReason, undefined);
      assert.equal(run.role, EXPECTED_ROLE[roleKey]);
    });

    test(`${harness} x ${roleKey}: cancel or error before usage is flagged, never silent`, () => {
      for (const [status, reason] of [['cancelled', 'aborted_before_usage'], ['error', 'error_before_usage']]) {
        const { output, finish } = setup(harness, roleKey);
        output();
        const run = finish(status);
        assert.equal(run.measurementPresent, false);
        assert.equal(run.usageMissingReason, reason, `${harness} ${status}`);
      }
    });
  }

  test(`${harness}: output without usage on a normal end is flagged provider_reported_no_usage`, () => {
    const { output, finish } = setup(harness, 'implement');
    output();
    assert.equal(finish('completed').usageMissingReason, 'provider_reported_no_usage');
  });

  test(`${harness}: a room without delegation meta falls back to chat and still records`, () => {
    assert.equal(resolveHarnessRole({}), 'chat');
    const { room, recorded, record, output, finish } = setup(harness, 'implement', { meta: false });
    output();
    recordHarnessUsageDelta(room, harness, usageEvent(harness), record);
    const run = finish('completed');
    assert.equal(recorded.find((e) => e.eventType === 'delta').role, 'chat');
    assert.equal(run.measurementPresent, true);
  });

  test(`${harness}: a resumed run (second run on the same room) is measured independently`, () => {
    const { room, recorded, record, output, finish } = setup(harness, 'implement');
    output();
    recordHarnessUsageDelta(room, harness, usageEvent(harness), record);
    finish('completed');
    beginHarnessRun(room, { type: 'sdkPromptStarted', runId: 'run-2' }, {});
    noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'again' }] } } });
    const run2 = recordHarnessRunFinished(room, harness, { type: 'sdkRunFinished', runId: 'run-2', status: 'completed' }, record);
    assert.equal(run2.measurementPresent, false, 'run-2 must not inherit run-1 measurement');
    assert.equal(run2.runId, 'run-2');
    assert.equal(recorded.filter((e) => e.eventType === 'run').length, 2, 'one run event per run');
    assert.equal(recorded.filter((e) => e.eventType === 'delta').length, 1);
  });
}

test('sdk: run.usage fallback also covers a cancelled run (status does not matter)', () => {
  const { room, recorded, record, output, finish } = setup('sdk', 'fix');
  output();
  const usage = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 55 };
  assert.equal(recordSdkRunUsageFallback(room, { usage }, record), 'fallback');
  const run = finish('cancelled');
  assert.equal(run.measurementPresent, true);
  assert.equal(recorded.find((e) => e.eventType === 'delta').role, 'fix');
});

test('opencode: message tokens are idempotent by message id (stream + end-of-run sweep count once)', () => {
  const map = new Map();
  const info = { id: 'msg-1', role: 'assistant', tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } } };
  const first = resolveOpenCodeUsageFromStreamEvent({ type: 'message.updated', properties: { info } }, map);
  assert.ok(first);
  assert.equal(first.delta.input, 100);
  // The fallback sweep replays the same message: no second delta.
  assert.equal(resolveOpenCodeUsageFromStreamEvent({ type: 'message.updated', properties: { info } }, map), null);
  // A grown snapshot yields only the increment.
  const grown = { ...info, tokens: { ...info.tokens, output: 50 } };
  assert.equal(resolveOpenCodeUsageFromStreamEvent({ type: 'message.updated', properties: { info: grown } }, map).delta.output, 30);
  assert.equal(noteOpenCodeMessageTokenDelta(map, '', { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test('opencode: the end-of-run sweep only selects assistant messages of the current run', async () => {
  const { selectOpenCodeRunAssistantInfos } = await import('../harnesses/opencode/opencode-usage.js');
  const tokens = { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  const msg = (id, role, created) => ({ info: { id, role, time: { created }, tokens }, parts: [] });
  const messages = [msg('old-a', 'assistant', 1000), msg('u2', 'user', 2000), msg('new-a', 'assistant', 2100), { info: { id: 'no-time', role: 'assistant', tokens } }];
  const infos = selectOpenCodeRunAssistantInfos(messages, 2000);
  assert.deepEqual(infos.map((i) => i.id), ['new-a']);
  assert.deepEqual(selectOpenCodeRunAssistantInfos(messages, 0), []);
  // Through the per-run idempotency map, earlier runs' tokens are never counted.
  const map = new Map();
  const deltas = infos.map((info) => resolveOpenCodeUsageFromStreamEvent({ type: 'message.updated', properties: { info } }, map)).filter(Boolean);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].messageId, 'new-a');
});
