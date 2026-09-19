import assert from 'node:assert/strict';
import {
  listAllRunItems,
  listRunItems,
  registerRunItem,
  stopSdkBlockSpinners,
} from '../lib/sdk/sdk-run-block-registry.js';

const inputRegistry = new Map();

registerRunItem(inputRegistry, '', { skipped: true });
registerRunItem(inputRegistry, 'run-1', null);
assert.equal(inputRegistry.size, 0);

const mockFirstBlock = { id: 'thinking-1' };
const mockSecondBlock = { id: 'thinking-2' };
const mockOtherRunBlock = { id: 'thinking-3' };

registerRunItem(inputRegistry, 'run-1', mockFirstBlock);
registerRunItem(inputRegistry, ' run-1 ', mockSecondBlock);
registerRunItem(inputRegistry, 'run-1', mockSecondBlock);
registerRunItem(inputRegistry, 'run-2', mockOtherRunBlock);

assert.deepEqual(listRunItems(inputRegistry, 'run-1'), [mockFirstBlock, mockSecondBlock]);
assert.deepEqual(listRunItems(inputRegistry, 'run-2'), [mockOtherRunBlock]);
assert.deepEqual(listRunItems(inputRegistry, 'run-3'), []);
assert.deepEqual(listRunItems(inputRegistry, ''), []);
assert.deepEqual(listAllRunItems(inputRegistry), [
  mockFirstBlock,
  mockSecondBlock,
  mockOtherRunBlock,
]);
assert.deepEqual(listAllRunItems(new Map()), []);

// A finished run must be able to stop the spinner on every block it rendered,
// not just the last one.
const mockBlocks = [{ running: true }, { running: true }, { running: true }];
const inputBlockRegistry = new Map();
for (const block of mockBlocks) registerRunItem(inputBlockRegistry, 'run-1', block);
stopSdkBlockSpinners(listAllRunItems(inputBlockRegistry));
assert.deepEqual(mockBlocks, [{ running: false }, { running: false }, { running: false }]);

const inputOlder = { running: true };
const inputLatest = { running: true };
const inputLiveRegistry = new Map();
registerRunItem(inputLiveRegistry, 'run-1', inputOlder);
registerRunItem(inputLiveRegistry, 'run-1', inputLatest);
const inputLatestByRun = new Map([['run-1', inputLatest]]);
stopSdkBlockSpinners(listAllRunItems(inputLiveRegistry));
stopSdkBlockSpinners(inputLatestByRun.values());
assert.equal(inputOlder.running, false);
assert.equal(inputLatest.running, false);

console.log('sdk-run-block-registry.test.js OK');
