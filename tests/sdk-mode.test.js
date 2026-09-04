import assert from 'node:assert/strict';
import { normalizeSdkMode, SDK_MODE_DEFAULT } from '../lib/sdk/sdk-mode.js';

assert.equal(SDK_MODE_DEFAULT, 'agent');
assert.equal(normalizeSdkMode('plan'), 'plan');
assert.equal(normalizeSdkMode('PLAN'), 'plan');
assert.equal(normalizeSdkMode('agent'), 'agent');
assert.equal(normalizeSdkMode(''), 'agent');
assert.equal(normalizeSdkMode(null), 'agent');
assert.equal(normalizeSdkMode('other'), 'agent');

console.log('All sdk-mode tests passed.');
