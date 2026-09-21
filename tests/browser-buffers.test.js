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
