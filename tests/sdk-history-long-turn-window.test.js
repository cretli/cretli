import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  buildHistoryTurnSegment,
  isUserTurnBoundaryRecord,
  resolveTurnAlignedHistoryWindow,
  splitHistoryPageAtUserTurn,
} from '../lib/sdk/sdk-history-turn-window.js';

const MOUNTED_CAP = 80;

function userRec(text = 'u') {
  return { kind: 'sdk', event: { type: 'user', text } };
}

function thinkingRec(text = 'plan') {
  return { kind: 'sdk', event: { type: 'thinking', text } };
}

function toolRec(name) {
  return { kind: 'sdk', event: { type: 'tool_call', name, status: 'completed' } };
}

function assistantRec(text) {
  return {
    kind: 'sdk',
    event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

function watcherRec(text) {
  return { kind: 'meta', variant: 'watcher', payload: JSON.stringify({ text }) };
}

/**
 * @param {number} toolCount
 * @returns {unknown[]}
 */
function buildSingleTurnHistory(toolCount) {
  const records = [userRec('prompt'), thinkingRec('plan')];
  for (let index = 0; index < toolCount; index += 1) {
    records.push(toolRec(`tool-${index}`));
  }
  records.push(assistantRec('done'));
  return records;
}

function assertWindowStable(totalTools, label) {
  const history = buildSingleTurnHistory(totalTools);
  const resolved = resolveTurnAlignedHistoryWindow(history, MOUNTED_CAP, MOUNTED_CAP);
  assert.equal(
    resolved.records.length,
    MOUNTED_CAP,
    `${label}: mounted records must stay at cap (${MOUNTED_CAP})`,
  );
  assert.equal(
    resolved.parked.length + resolved.records.length,
    history.length,
    `${label}: parked plus mounted must equal source length`,
  );
  assert.ok(resolved.turnSegment, `${label}: long turn must expose segment metadata`);
  assert.equal(resolved.turnSegment.partCount, Math.ceil(history.length / MOUNTED_CAP));
  const expectedPartIndex = Math.min(
    resolved.turnSegment.partCount,
    Math.floor((history.length - MOUNTED_CAP) / MOUNTED_CAP) + 1,
  );
  assert.equal(resolved.turnSegment.partIndex, expectedPartIndex, `${label}: segment index matches tail slice`);
  assert.equal(resolved.turnSegment.includesTurnOpen, false);
  const lastMounted = resolved.records[resolved.records.length - 1];
  assert.equal(lastMounted.event.type, 'assistant', `${label}: tail keeps assistant boundary`);
}

assertWindowStable(497, '500-record turn');
assertWindowStable(1997, '2000-record turn');

const hugePayload = 'x'.repeat(900_000);
const hugeRecord = {
  kind: 'sdk',
  event: {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: hugePayload }] },
  },
};
const hugeTurn = [userRec('big'), thinkingRec('t'), hugeRecord];
const hugeResolved = resolveTurnAlignedHistoryWindow(hugeTurn, MOUNTED_CAP, MOUNTED_CAP);
assert.equal(hugeResolved.records.length, 3, 'short turn with one huge record stays uncapped');
assert.equal(hugeResolved.parked.length, 0);

const metaFeed = [];
for (let index = 0; index < 120; index += 1) metaFeed.push(watcherRec(`n${index}`));
const metaResolved = resolveTurnAlignedHistoryWindow(metaFeed, MOUNTED_CAP, MOUNTED_CAP);
assert.equal(metaResolved.records.length, MOUNTED_CAP);
assert.equal(metaResolved.parked.length, 40);
assert.equal(metaResolved.turnSegment, null, 'meta-only feed has no turn segment');

const segment = buildHistoryTurnSegment(2000, 80, 1920);
assert.deepEqual(segment, { partIndex: 25, partCount: 25, includesTurnOpen: false });

const parkedPrefix = buildSingleTurnHistory(1998).slice(0, 1920);
const prependPage = parkedPrefix.slice(-MOUNTED_CAP);
const blocked = splitHistoryPageAtUserTurn(prependPage);
assert.equal(blocked.renderable.length, 0, 'mid-run page blocked without continuation flag');
const allowed = splitHistoryPageAtUserTurn(prependPage, { allowMidRunContinuation: true });
assert.equal(allowed.renderable.length, MOUNTED_CAP);
assert.equal(allowed.buffered.length, 0);

const turnOpenPage = parkedPrefix.slice(0, MOUNTED_CAP);
assert.ok(isUserTurnBoundaryRecord(turnOpenPage[0]));
const openSplit = splitHistoryPageAtUserTurn(turnOpenPage);
assert.equal(openSplit.renderable.length, MOUNTED_CAP);
assert.equal(openSplit.renderable[1].event.type, 'thinking');

console.log('sdk-history-long-turn-window.test.js OK');
