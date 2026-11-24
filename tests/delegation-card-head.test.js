import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsedClock, parseExecutorModel } from '../app_front/features/chat/history/views/delegationCardHead.js';

test('parseExecutorModel splits the effort param', () => {
  assert.deepEqual(parseExecutorModel('gpt-6-luna::effort=low'), { name: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(parseExecutorModel('claude-opus-5-5'), { name: 'claude-opus-5-5', effort: '' });
  assert.deepEqual(parseExecutorModel(undefined), { name: '', effort: '' });
});

test('formatElapsedClock formats minutes and hours', () => {
  assert.equal(formatElapsedClock(5000), '0:05');
  assert.equal(formatElapsedClock(125000), '2:05');
  assert.equal(formatElapsedClock(3725000), '1:02:05');
  assert.equal(formatElapsedClock(-1), '0:00');
});
