import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeVersion, minimumFromRange } from '../scripts/node-version-check.mjs';

test('checkNodeVersion gates on the engines.node minimum', () => {
  const min = minimumFromRange('>=22.16');
  assert.deepEqual(min, [22, 16, 0]);
  const old = checkNodeVersion('20.20.0', min);
  assert.equal(old.ok, false);
  assert.match(old.message, /Node >= 22\.16/);
  assert.match(old.message, /nvm use/);
  assert.equal(checkNodeVersion('22.15.9', min).ok, false);
  assert.equal(checkNodeVersion('22.16.0', min).ok, true);
  assert.equal(checkNodeVersion('v24.1.0', min).ok, true);
  assert.equal(checkNodeVersion('18.0.0', null).ok, true);
});
