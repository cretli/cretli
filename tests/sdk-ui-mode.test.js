import assert from 'node:assert/strict';
import { normalizeSdkUiMode, SDK_UI_MODE_DEFAULT } from '../lib/sdk/sdk-ui-mode.js';

assert.equal(SDK_UI_MODE_DEFAULT, 'compact');
assert.equal(normalizeSdkUiMode('compact'), 'compact');
assert.equal(normalizeSdkUiMode('full'), 'full');
assert.equal(normalizeSdkUiMode('COMPACT'), 'compact');
assert.equal(normalizeSdkUiMode(''), 'compact');
assert.equal(normalizeSdkUiMode(null), 'compact');

console.log('All sdk-ui-mode tests passed.');
