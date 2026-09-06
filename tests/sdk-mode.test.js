import assert from 'node:assert/strict';
import {
  beginEnforcedSdkMode,
  clearEnforcedSdkMode,
  isAskSdkMode,
  isPlanSdkMode,
  isReadOnlySdkMode,
  normalizeSdkMode,
  parseExplicitSdkMode,
  readEnforcedSdkMode,
  SDK_MODE_DEFAULT,
  toNativeAgentMode,
} from '../lib/sdk/sdk-mode.js';

assert.equal(SDK_MODE_DEFAULT, 'agent');
assert.equal(normalizeSdkMode('plan'), 'plan');
assert.equal(normalizeSdkMode('PLAN'), 'plan');
assert.equal(normalizeSdkMode('ask'), 'ask');
assert.equal(normalizeSdkMode(' ASK '), 'ask');
assert.equal(normalizeSdkMode('agent'), 'agent');
assert.equal(normalizeSdkMode(''), 'agent');
assert.equal(normalizeSdkMode(null), 'agent');
assert.equal(normalizeSdkMode('other'), 'agent');

assert.equal(parseExplicitSdkMode('ask'), 'ask');
assert.equal(parseExplicitSdkMode('agent'), 'agent');
assert.equal(parseExplicitSdkMode('nope'), '');

assert.equal(isReadOnlySdkMode('plan'), true);
assert.equal(isReadOnlySdkMode('ask'), true);
assert.equal(isReadOnlySdkMode('agent'), false);
assert.equal(isPlanSdkMode('ask'), false);
assert.equal(isAskSdkMode('ask'), true);
assert.equal(toNativeAgentMode('ask'), 'agent');
assert.equal(toNativeAgentMode('plan'), 'plan');

const inputRoom = {};
assert.equal(beginEnforcedSdkMode(inputRoom, 'ask'), 'ask');
assert.equal(readEnforcedSdkMode(inputRoom, 'agent'), 'ask');
inputRoom.sdkMode = 'agent';
assert.equal(readEnforcedSdkMode(inputRoom), 'ask');
clearEnforcedSdkMode(inputRoom);
assert.equal(readEnforcedSdkMode(inputRoom, 'agent'), 'agent');

console.log('All sdk-mode tests passed.');
