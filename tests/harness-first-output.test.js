import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginHarnessRun,
  noteHarnessFirstOutput,
  recordHarnessRunFinished,
} from '../lib/usage/harness-usage.ts';

function startedRoom() {
  const room = {};
  beginHarnessRun(room, { type: 'sdkPromptStarted' });
  assert.ok(room._runStartedAt);
  return room;
}

for (const type of ['assistant', 'thinking', 'text', 'tool_call']) {
  test(`noteHarnessFirstOutput sets _firstOutputAt for ${type}`, () => {
    const room = startedRoom();
    noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type } });
    assert.ok(room._firstOutputAt > 0);
  });
}

for (const type of ['status', 'usage', 'context_usage', 'tool_result']) {
  test(`noteHarnessFirstOutput ignores non-model event ${type}`, () => {
    const room = startedRoom();
    noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type } });
    assert.ok(!room._firstOutputAt);
  });
}

test('noteHarnessFirstOutput ignores non-sdkEvent payloads', () => {
  const room = startedRoom();
  noteHarnessFirstOutput(room, { type: 'status', event: { type: 'text' } });
  assert.ok(!room._firstOutputAt);
});

for (const type of ['text', 'tool_call']) {
  test(`run with only ${type} reports ttftMs`, async () => {
    const room = startedRoom();
    noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    let recorded = null;
    recordHarnessRunFinished(room, 'claude', { status: 'completed' }, (partial) => {
      recorded = partial;
    });
    assert.equal(recorded.eventType, 'run');
    assert.notEqual(recorded.ttftMs, undefined);
    assert.ok(recorded.ttftMs >= 0);
  });
}

test('run with only status events has no ttftMs', () => {
  const room = startedRoom();
  noteHarnessFirstOutput(room, { type: 'sdkEvent', event: { type: 'status' } });
  let recorded = null;
  recordHarnessRunFinished(room, 'claude', { status: 'completed' }, (partial) => {
    recorded = partial;
  });
  assert.equal(recorded.ttftMs, undefined);
});
