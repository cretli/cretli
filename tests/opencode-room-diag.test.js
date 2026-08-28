/**
 * OpenCode room diagnostics snapshot — run/event age metrics.
 */
import assert from 'node:assert/strict';
import { buildOpenCodeRoomDiagSnapshot } from '../lib/opencode/opencode-agent-ws.js';

const nowMs = 200000;
const room = {
  busy: true,
  sdkMode: 'agent',
  modelId: 'opencode/x-preview-f-free',
  opencodeSessionId: 'ses_123',
  clients: new Set([{}, {}]),
  eventSeq: 12,
  eventStreamId: 'stream-1',
  pendingPrompts: [{ text: 'a', mode: 'agent' }],
  _pendingOpenCodeQuestions: new Map([['q1', {}]]),
  _pendingOpenCodePermissions: new Map([['p1', {}], ['p2', {}]]),
  lastEventAt: 199000,
  _awaitingPromptFinish: true,
  _planGuardTriggered: false,
  currentRun: { id: 'run-1', startedAt: 150000 },
};

const diag = buildOpenCodeRoomDiagSnapshot(room, nowMs);
assert.equal(diag.transport, 'opencode');
assert.equal(diag.busy, true);
assert.equal(diag.clients, 2);
assert.equal(diag.queuedCount, 1);
assert.equal(diag.pendingQuestions, 1);
assert.equal(diag.pendingPermissions, 2);
assert.equal(diag.awaitingPromptFinish, true);
assert.equal(diag.currentRunId, 'run-1');
assert.equal(diag.currentRunStartedAt, 150000);
assert.equal(diag.currentRunAgeMs, 50000);
assert.equal(diag.lastEventAt, 199000);
assert.equal(diag.lastEventAgeMs, 1000);

const roomWithoutTimestamps = {
  busy: false,
  sdkMode: 'agent',
  modelId: 'opencode/x-preview-f-free',
  clients: new Set(),
  eventSeq: 0,
  eventStreamId: 'stream-2',
  pendingPrompts: [],
  _pendingOpenCodeQuestions: new Map(),
  _pendingOpenCodePermissions: new Map(),
  _awaitingPromptFinish: false,
  _planGuardTriggered: false,
};

const diagWithoutTimestamps = buildOpenCodeRoomDiagSnapshot(roomWithoutTimestamps, nowMs);
assert.equal(diagWithoutTimestamps.currentRunId, null);
assert.equal(diagWithoutTimestamps.currentRunStartedAt, null);
assert.equal(diagWithoutTimestamps.currentRunAgeMs, null);
assert.equal(diagWithoutTimestamps.lastEventAt, null);
assert.equal(diagWithoutTimestamps.lastEventAgeMs, null);

console.log('opencode-room-diag.test.js OK');
