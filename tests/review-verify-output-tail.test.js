import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { buildOutputTail } from '../lib/sdk/sdk-review-verify.ts';

after(removeIsolatedDataDir);

test('short output is returned whole', () => {
  assert.equal(buildOutputTail('not ok 1 - x', false), 'not ok 1 - x');
});

test('failing overflow keeps not ok lines ahead of the tail, bounded', () => {
  const text = `ok 1 - a\nnot ok 2 - the failing subtest\n${'noise line\n'.repeat(2000)}# fail 1\n`;
  const out = buildOutputTail(text, false);
  assert.match(out, /not ok 2 - the failing subtest/);
  assert.match(out, /# fail 1\n$/);
  assert.ok(out.length <= 4096 + 64, String(out.length));
});

test('passing overflow is the plain tail', () => {
  const text = `not ok 2 - old\n${'x'.repeat(10000)}`;
  assert.equal(buildOutputTail(text, true), text.slice(-4096));
});

test('failing overflow without not ok lines is the plain tail', () => {
  const text = 'y'.repeat(10000);
  assert.equal(buildOutputTail(text, false), text.slice(-4096));
});
