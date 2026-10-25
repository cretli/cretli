import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { captureCursorSdkErrorOnly } from '../lib/sdk/cursor-agent-sdk-ws.ts';
import {
  beginRunEndSnapshot,
  captureRunEnd,
} from '../lib/usage/run-end-snapshot.js';
import {
  beginHarnessRun,
  noteHarnessFirstOutput,
  recordHarnessUsageSnapshot,
} from '../lib/usage/harness-usage.ts';

const KERNEL_HARNESSES = ['opencode', 'claude', 'codex', 'qwen', 'deepseek', 'openrouter', 'codebuddy'];

function tempDataDir() {
  return mkdtempSync(path.join(tmpdir(), 'cretli-run-end-'));
}

test('each room-kernel harness captures one unknown-usage error snapshot', () => {
  const dataDir = tempDataDir();
  try {
    for (const harness of KERNEL_HARNESSES) {
      const snapshots = [];
      const kernel = createAgentRoomKernel({
        transport: harness,
        usageDataDir: dataDir,
        persistHistory: () => {},
        recordUsage: (event) => event,
        captureRunEnd: (input) => captureRunEnd({
          ...input,
          dataDir,
          onSnapshot: (snapshot) => snapshots.push(snapshot),
        }),
      });
      const room = kernel.createRoomState({
        sessionKey: `${harness}-session`,
        chatId: `${harness}-chat`,
        modelId: `${harness}-model`,
      });
      kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: `${harness}-run` });
      kernel.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'thinking', content: 'checking' } });
      kernel.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'tool_call', name: 'read' } });
      kernel.broadcastRoom(room, {
        type: 'sdkRunFinished',
        runId: `${harness}-run`,
        status: 'error',
        result: `${harness} failed`,
      });
      const snapshot = snapshots[0];
      assert.equal(snapshot.usageKnown, false, harness);
      assert.equal(snapshot.outputTokens, null, harness);
      assert.equal(snapshot.outputSeen, false, harness);
      assert.equal(snapshot.errorStage, 'unknown', harness);
      assert.equal(snapshot.durationKnown, true, harness);
      kernel.broadcastRoom(room, {
        type: 'sdkRunFinished',
        runId: `${harness}-run`,
        status: 'error',
        result: `${harness} failed`,
      });
      assert.equal(snapshots.length, 1, harness);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('assistant content and explicit provider rejection remain distinct evidence', () => {
  const dataDir = tempDataDir();
  try {
    const outputRoom = { sessionKey: 'output', modelId: 'm' };
    beginHarnessRun(outputRoom, { runId: 'output-run' });
    noteHarnessFirstOutput(outputRoom, { type: 'sdkEvent', event: { type: 'assistant', content: 'answer' } });
    const afterOutput = captureRunEnd({
      room: outputRoom,
      harness: 'codex',
      dataDir,
      payload: { runId: 'output-run', status: 'error', result: 'late failure' },
    });
    assert.equal(afterOutput.outputSeen, true);
    assert.equal(afterOutput.errorStage, 'after_output');
    assert.equal(afterOutput.explicitProviderRejectionEvidence, false);

    const rejectedRoom = { sessionKey: 'rejected', modelId: 'm' };
    beginHarnessRun(rejectedRoom, { runId: 'rejected-run' });
    const rejected = captureRunEnd({
      room: rejectedRoom,
      harness: 'sdk',
      dataDir,
      payload: {
        runId: 'rejected-run',
        status: 'error',
        result: 'provider rejected request',
        providerRejectedBeforeGeneration: true,
      },
    });
    assert.equal(rejected.errorStage, 'before_generation');
    assert.equal(rejected.explicitProviderRejectionEvidence, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Cursor SDK usage snapshot contributes output tokens and its error reaches the signature store', () => {
  const dataDir = tempDataDir();
  try {
    const room = { sessionKey: 'sdk-session', modelId: 'cursor-model', _todoSyncDataDir: dataDir };
    beginHarnessRun(room, { runId: 'sdk-run' });
    recordHarnessUsageSnapshot(room, 'sdk', { inputTokens: 10, outputTokens: 19 }, (event) => event);
    const snapshot = captureCursorSdkErrorOnly(
      room,
      'run_setup_failed',
      'Cursor transport exploded',
      { runId: 'sdk-run' },
    );
    assert.equal(snapshot.usageKnown, true);
    assert.equal(snapshot.outputTokens, 19);
    const rows = readFileSync(path.join(dataDir, 'usage', 'unclassified-errors.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].harness, 'sdk');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('empty terminal run ids never reuse a stale room run id', () => {
  const dataDir = tempDataDir();
  try {
    const room = { sessionKey: 'session', _runId: 'stale-run' };
    beginRunEndSnapshot(room, { sessionId: 'session' });
    const first = captureRunEnd({ room, harness: 'sdk', dataDir, payload: { runId: '', status: 'error', result: 'first' } });
    assert.equal(captureRunEnd({ room, harness: 'sdk', dataDir, payload: { runId: '', status: 'error', result: 'first' } }), null);
    beginRunEndSnapshot(room, { sessionId: 'session' });
    const second = captureRunEnd({ room, harness: 'sdk', dataDir, payload: { runId: '', status: 'error', result: 'second' } });
    assert.notEqual(first.runId, 'stale-run');
    assert.notEqual(second.runId, 'stale-run');
    assert.notEqual(first.runId, second.runId);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('model unavailable without a model id stays in the unclassified store', () => {
  const dataDir = tempDataDir();
  try {
    const room = { sessionKey: 'missing-model' };
    beginRunEndSnapshot(room, { sessionId: 'missing-model' });
    captureRunEnd({
      room,
      harness: 'codebuddy',
      dataDir,
      payload: { runId: '', status: 'error', result: 'The requested model is unavailable' },
    });
    const text = readFileSync(path.join(dataDir, 'usage', 'unclassified-errors.jsonl'), 'utf8');
    assert.match(text, /requested model is unavailable/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('two fast provider errors with the same unknown message lock the model', async () => {
  const { getHarnessUsageLimit } = await import('../lib/harness-usage-limits.js');
  const dataDir = tempDataDir();
  try {
    for (const runId of ['fast-1', 'fast-2']) {
      const room = {
        sessionKey: 'fast-fail', _runStartedAt: Date.now() - 200, _runHadMeasurement: true, _runOutputTokens: 0,
      };
      beginRunEndSnapshot(room, { sessionId: 'fast-fail' });
      captureRunEnd({
        room, harness: 'fastwire', model: 'fw-model', dataDir,
        payload: { runId, status: 'error', result: 'Provider choked on mystery code 9921' },
      });
    }
    // The rule runs fire-and-forget; wait for it to settle.
    let row = null;
    for (let i = 0; i < 100 && !row; i += 1) {
      row = getHarnessUsageLimit({ harness: 'fastwire', model: 'fw-model', dataDir });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(row?.code, 'repeated_fast_fail');
    assert.equal(getHarnessUsageLimit({ harness: 'fastwire', model: 'other', dataDir }), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
