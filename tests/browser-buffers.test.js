/**
 * Browser bounded ring buffer contract tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedRingBuffer, ConsoleBuffer, NetworkBuffer } from '../lib/browser/buffers.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';

test('BoundedRingBuffer caps entries and tracks drops', () => {
  const buf = new BoundedRingBuffer({ maxEntries: 3, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 5; i += 1) buf.push({ seq: i + 1, text: `entry ${i}` });
  assert.equal(buf.entries.length, 3);
  assert.equal(buf.dropped, 2);
  assert.equal(buf.total, 5);
  const pull = buf.pull({ since: 3 });
  assert.equal(pull.entries.length, 2);
  assert.equal(pull.nextSince, 5);
});

test('ConsoleBuffer redacts secrets and caps entry size', () => {
  const buf = new ConsoleBuffer();
  buf.pushConsole({ level: 'log', text: 'token=abc123secret value', location: '' });
  assert.match(buf.entries[0].text, /token=\[redacted\]/);
  const huge = 'x'.repeat(BROWSER_LIMITS.CONSOLE_TEXT_MAX + 5000);
  buf.pushConsole({ level: 'error', text: huge });
  const last = buf.entries[buf.entries.length - 1];
  assert.equal(last.truncated, true);
  assert.ok(last.text.length <= BROWSER_LIMITS.CONSOLE_TEXT_MAX);
});

test('NetworkBuffer records metadata only and redacts the URL', () => {
  const buf = new NetworkBuffer();
  const { requestId } = buf.recordRequest({
    method: 'post',
    url: 'https://api.test/v1?access_token=supersecret&page=2',
    resourceType: 'xhr',
  });
  buf.recordResponse(requestId, { status: 200, ok: true });
  const entry = buf.entries[0];
  assert.equal(entry.method, 'POST');
  assert.match(entry.url, /access_token=(?:%5Bredacted%5D|\[redacted\])/);
  assert.match(entry.url, /page=2/);
  assert.equal(entry.status, 200);
  assert.equal(entry.ok, true);
  // No body/header fields exist on the MVP entry.
  assert.equal('headers' in entry, false);
  assert.equal('body' in entry, false);
});

test('pull delivers a response that updated an already-pulled request', () => {
  const buf = new NetworkBuffer();
  const { requestId } = buf.recordRequest({ method: 'GET', url: 'https://example.com/a', at: 1 });

  const first = buf.pull({ since: 0 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].requestId, requestId);
  assert.equal(first.entries[0].status, null);
  const pendingCursor = first.nextSince;

  buf.recordResponse(requestId, { status: 200, ok: true, at: 2 });
  const second = buf.pull({ since: pendingCursor });
  // The mutation must reach a cursor that already passed the pending row.
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].requestId, requestId);
  assert.equal(second.entries[0].seq, first.entries[0].seq);
  assert.equal(second.entries[0].status, 200);
  assert.equal(second.entries[0].ok, true);
  assert.equal(second.entries[0].finishedAt, 2);
  assert.ok(second.nextSince > pendingCursor);
  // Delivery is single-shot: the resolved row is not re-sent behind its cursor.
  assert.deepEqual(buf.pull({ since: second.nextSince }).entries, []);
});

test('pull delivers a failure that updated an already-pulled request', () => {
  const buf = new NetworkBuffer();
  const { requestId } = buf.recordRequest({ method: 'GET', url: 'https://example.com/b', at: 1 });
  const first = buf.pull({ since: 0 });

  buf.recordFailure(requestId, { errorText: 'net::ERR_CONNECTION_RESET', at: 2 });
  const second = buf.pull({ since: first.nextSince });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].requestId, requestId);
  assert.equal(second.entries[0].failure, 'net::ERR_CONNECTION_RESET');
  assert.equal(second.entries[0].finishedAt, 2);
  assert.ok(second.nextSince > first.nextSince);
});

test('a limited pull never strands an updated entry behind the cut', () => {
  const buf = new NetworkBuffer();
  buf.recordRequest({ requestId: 'a', url: 'https://example.com/a' });
  buf.recordRequest({ requestId: 'b', url: 'https://example.com/b' });
  const seen = buf.pull({ since: 0, limit: 5 });
  assert.deepEqual(seen.entries.map((entry) => entry.requestId), ['a', 'b']);

  // 'a' keeps its array position but gets the newest revision, so a page of
  // one must still surface it rather than skipping to a later seq.
  buf.recordResponse('a', { status: 200, ok: true });
  const page = buf.pull({ since: seen.nextSince, limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].requestId, 'a');
  assert.equal(page.entries[0].status, 200);
  // rev 1 = request a, 2 = request b, 3 = the response update on a.
  assert.equal(Number(page.entries[0].rev), 3);
  assert.equal(page.nextSince, 3);
});

test('clear resets entries and counters', () => {
  const buf = new ConsoleBuffer();
  buf.pushConsole({ text: 'a' });
  buf.pushConsole({ text: 'b' });
  buf.clear();
  assert.equal(buf.entries.length, 0);
  assert.equal(buf.total, 0);
  assert.equal(buf.dropped, 0);
});

test('pull coerces string since/limit from REST query params', () => {
  const buf = new BoundedRingBuffer({ maxEntries: 10, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 6; i += 1) buf.push({ seq: i + 1, text: `e${i}` });
  // `since`/`limit` arrive as query strings over REST and must be parsed.
  const bySince = buf.pull({ since: '3' });
  assert.deepEqual(bySince.entries.map((entry) => entry.seq), [4, 5, 6]);
  assert.equal(bySince.nextSince, 6);
  const byLimit = buf.pull({ since: '0', limit: '2' });
  assert.deepEqual(byLimit.entries.map((entry) => entry.seq), [1, 2]);
  assert.equal(byLimit.nextSince, 2);
  // Non-numeric values fall back to defaults rather than returning nothing.
  const garbage = buf.pull({ since: 'nope', limit: 'x' });
  assert.deepEqual(garbage.entries.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6]);
});
