import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, isSuccessStatus, summarizeRoute, buildSyntheticTodos, exitCodeFor } from '../scripts/load-test-lib.mjs';
import { runBackgroundTask } from '../lib/background-worker-tasks.js';

test('percentile uses nearest rank and handles empty input', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([10, 1, 5], 0.5), 5);
});

test('only 2xx (and 3xx when allowed) are successes', () => {
  assert.equal(isSuccessStatus(200), true);
  assert.equal(isSuccessStatus(302), false);
  assert.equal(isSuccessStatus(302, true, '/login'), true);
  assert.equal(isSuccessStatus(404, true, '/x'), false);
  assert.equal(isSuccessStatus(500), false);
});

test('summarizeRoute separates errors from latency samples', () => {
  const s = summarizeRoute({ ok: [10, 20], errors: 2 });
  assert.equal(s.errors, 2);
  assert.equal(s.errorRate, 0.5);
  assert.equal(s.p95, 20);
});

test('synthetic todos are >=200 and yield ready leaves', () => {
  const items = buildSyntheticTodos(300);
  assert.equal(items.length, 300);
  assert.ok(runBackgroundTask('todo-readiness', { items }).readyIds.length > 0);
});

test('exit code is non-zero above threshold', () => {
  assert.equal(exitCodeFor([0, 0.01], 0.05), 0);
  assert.equal(exitCodeFor([0, 0.2], 0.05), 1);
});

import { classifyChatResponse } from '../scripts/load-test-lib.mjs';

test('empty HTTP 200 chat body is not a success', () => {
  assert.equal(classifyChatResponse(200, []).ok, false);
  assert.equal(classifyChatResponse(200, [{ atMs: 5, bytes: 0 }]).ok, false);
});

test('chat start is set by the first non-empty chunk', () => {
  const r = classifyChatResponse(200, [{ atMs: 1, bytes: 0 }, { atMs: 7, bytes: 10 }, { atMs: 20, bytes: 4 }]);
  assert.deepEqual(r, { ok: true, startMs: 7, streamMs: 20 });
});

test('chat redirect to login is an error', () => {
  assert.equal(classifyChatResponse(302, [{ atMs: 1, bytes: 10 }]).ok, false);
});

test('all chat attempts failing yields a non-zero exit', () => {
  assert.equal(exitCodeFor([0, 1], 0.05), 1);
});

test('/login redirect needs a Location; 304 and bare 3xx are errors', () => {
  assert.equal(isSuccessStatus(302, true, '/app'), true);
  assert.equal(isSuccessStatus(302, true, ''), false);
  assert.equal(isSuccessStatus(302, true), false);
  assert.equal(isSuccessStatus(304, true, '/x'), false);
});
