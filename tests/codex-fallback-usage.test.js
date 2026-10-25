import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  beginHarnessRun,
  noteHarnessCallUsage,
  recordHarnessFallbackUsage,
  recordHarnessUsageDelta,
} from '../lib/usage/harness-usage.ts';

// Usage recording persists under the data dir; it is isolated by the helper above.
after(() => removeIsolatedDataDir());

function makeRoom() {
  const room = { chatId: 'chat-1', modelId: 'gpt-6-astra', delegationId: 'd1', delegationAttemptId: 'a1', delegationAssignment: 'review' };
  beginHarnessRun(room, { runId: 'run-1' });
  return room;
}

const call = (id, over = {}) => ({
  type: 'context_usage',
  measurementId: id,
  turnId: 'turn-1',
  model: 'gpt-6-astra',
  observedAt: new Date(Date.now() + 1000).toISOString(),
  usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 10 },
  ...over,
});

test('a codex run that never got turn.completed is recorded from per-call context usage', () => {
  const room = makeRoom();
  noteHarnessCallUsage(room, 'codex', call('resp-1'));
  noteHarnessCallUsage(room, 'codex', call('resp-2'));
  // The rollout watcher repeats observations; the same measurementId counts once.
  noteHarnessCallUsage(room, 'codex', call('resp-2'));
  const recorded = [];
  const partial = recordHarnessFallbackUsage(room, 'codex', (p) => { recorded.push(p); return p; });
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { in: partial.tokens.textInput, cached: partial.tokens.cachedInput, out: partial.tokens.textOutput, reasoning: partial.tokens.reasoning },
    { in: 800, cached: 1200, out: 100, reasoning: 20 },
  );
  assert.equal(partial.delegationId, 'd1');
  assert.equal(partial.harness, 'codex');
  assert.equal(room._runHadMeasurement, true);
});

test('no fallback when the SDK already reported usage, so nothing is counted twice', () => {
  const room = makeRoom();
  noteHarnessCallUsage(room, 'codex', call('resp-1'));
  recordHarnessUsageDelta(room, 'codex', { usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }, final: true }, () => null);
  assert.equal(recordHarnessFallbackUsage(room, 'codex', () => assert.fail('must not record')), null);
});

test('fallback ignores replayed calls from before the run and other harnesses', () => {
  const room = makeRoom();
  noteHarnessCallUsage(room, 'codex', call('old', { observedAt: new Date(Date.now() - 60_000).toISOString() }));
  noteHarnessCallUsage(room, 'codex', { ...call('x'), type: 'usage' });
  noteHarnessCallUsage(room, 'claude', call('resp-1'));
  assert.equal(recordHarnessFallbackUsage(room, 'codex', () => assert.fail('must not record')), null);
});

test('fallback state resets with the next run', () => {
  const room = makeRoom();
  noteHarnessCallUsage(room, 'codex', call('resp-1'));
  beginHarnessRun(room, { runId: 'run-2' });
  assert.equal(recordHarnessFallbackUsage(room, 'codex', () => assert.fail('must not record')), null);
});

test('room kernel records codex usage for a run stopped before turn.completed', async () => {
  const { createAgentRoomKernel } = await import('../lib/agent-harness/room-kernel.ts');
  const recorded = [];
  const kernel = createAgentRoomKernel({
    transport: 'codex',
    persistHistory: () => {},
    recordUsage: (partial) => { recorded.push(partial); return null; },
    notifyRunFinished: () => {},
  });
  const room = kernel.createRoomState({ sessionKey: 's-codex', chatId: 'chat-codex', delegationId: 'd9', delegationAttemptId: 'a9' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-codex' });
  kernel.broadcastRoom(room, { type: 'sdkEvent', event: call('resp-1') });
  kernel.broadcastRoom(room, { type: 'sdkEvent', event: call('resp-2') });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', status: 'completed', runId: 'run-codex' });
  const deltas = recorded.filter((p) => p.eventType === 'delta');
  const runs = recorded.filter((p) => p.eventType === 'run');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].tokens.textInput, 800);
  assert.equal(deltas[0].delegationId, 'd9');
  assert.equal(runs.length, 1);
});
