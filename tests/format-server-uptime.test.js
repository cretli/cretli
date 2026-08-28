import assert from 'node:assert/strict';
import { formatServerUptime } from '../app_front/lib/format-server-uptime.js';

const inputNow = 1_700_000_000_000;

assert.equal(formatServerUptime(0, inputNow), '');
assert.equal(formatServerUptime(Number.NaN, inputNow), '');
assert.equal(formatServerUptime(inputNow - 12_000, inputNow), '12s');
assert.equal(formatServerUptime(inputNow - (5 * 60 * 1000), inputNow), '5m');
assert.equal(formatServerUptime(inputNow - (2 * 60 * 60 * 1000) - (10 * 60 * 1000), inputNow), '2h 10m');
assert.equal(formatServerUptime(inputNow - (2 * 24 * 60 * 60 * 1000) - (3 * 60 * 60 * 1000), inputNow), '2d 3h');

console.log('format-server-uptime.test.js: ok');
