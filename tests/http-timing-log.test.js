/**
 * Leveled HTTP timing: fast requests stay silent, slow requests produce one
 * ISO-timestamped line, long-polls are excluded, the flag-off warn is budgeted
 * and the threshold comes from the environment.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHttpTimingLog,
  isHttpTimingExcludedPath,
  resolveHttpTimingMinMs,
} from '../lib/http-timing-log.js';

function createCapture() {
  const lines = [];
  const warns = [];
  return {
    lines,
    warns,
    log: (...args) => lines.push(args.join(' ')),
    warn: (...args) => warns.push(args.join(' ')),
  };
}

test('50 ms request is silent', () => {
  const capture = createCapture();
  const timing = createHttpTimingLog({ clock: () => 0, ...capture });
  timing.record({ method: 'GET', url: '/api/x', path: '/api/x', statusCode: 200, durationMs: 50, timingEnabled: true });
  assert.equal(capture.lines.length, 0);
  assert.equal(capture.warns.length, 0);
});

test('700 ms request with timing on logs exactly one ISO-timestamped line', () => {
  const capture = createCapture();
  const timing = createHttpTimingLog({ clock: () => Date.UTC(2026, 0, 2, 3, 4, 5), ...capture });
  timing.record({ method: 'GET', url: '/api/x', path: '/api/x', statusCode: 200, durationMs: 700, timingEnabled: true });
  assert.equal(capture.warns.length, 0);
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0], /^\[http-timing\] end 2026-01-02T03:04:05\.000Z 200 700ms GET \/api\/x$/);
});

test('the long-poll bridge path is excluded from timing and warnings', () => {
  const capture = createCapture();
  const timing = createHttpTimingLog({ clock: () => 0, ...capture });
  assert.equal(isHttpTimingExcludedPath('/api/mcp/bridge/call'), true);
  timing.record({ method: 'POST', url: '/api/mcp/bridge/call', path: '/api/mcp/bridge/call', statusCode: 200, durationMs: 25_000, timingEnabled: true });
  timing.record({ method: 'POST', url: '/api/mcp/bridge/call', path: '/api/mcp/bridge/call', statusCode: 200, durationMs: 25_000, timingEnabled: false });
  assert.equal(capture.lines.length, 0);
  assert.equal(capture.warns.length, 0);
});

test('a slow request warns when the timing flag is off', () => {
  const capture = createCapture();
  const timing = createHttpTimingLog({ clock: () => 0, ...capture });
  timing.record({ method: 'GET', url: '/api/slow', path: '/api/slow', statusCode: 200, durationMs: 700, timingEnabled: false });
  assert.equal(capture.lines.length, 0);
  assert.equal(capture.warns.length, 1);
  assert.match(capture.warns[0], /^\[slow-request\] 1970-01-01T00:00:00\.000Z 200 700ms GET \/api\/slow$/);
});

test('slow-request warnings are budgeted to 20 per minute plus one suppressed summary', () => {
  const capture = createCapture();
  let now = 1_800_000_000_000;
  const timing = createHttpTimingLog({ clock: () => now, ...capture });

  for (let index = 0; index < 100; index += 1) {
    timing.record({
      method: 'GET',
      url: `/api/slow/${index}`,
      path: `/api/slow/${index}`,
      statusCode: 200,
      durationMs: 700,
      timingEnabled: false,
    });
  }
  assert.equal(capture.warns.length, 20);

  now += 60_001;
  // A fast request rolls the window and flushes the suppressed summary.
  timing.record({ method: 'GET', url: '/api/fast', path: '/api/fast', statusCode: 200, durationMs: 10, timingEnabled: false });
  assert.equal(capture.warns.length, 21);
  assert.match(capture.warns[20], /suppressed 80 slow-request lines/);
});

test('the threshold is configurable through the environment and options', () => {
  assert.equal(resolveHttpTimingMinMs({ CRETLI_HTTP_TIMING_MIN_MS: '1000' }), 1000);
  assert.equal(resolveHttpTimingMinMs({}), 500);
  assert.equal(resolveHttpTimingMinMs({ CRETLI_HTTP_TIMING_MIN_MS: 'nope' }), 500);

  const capture = createCapture();
  const timing = createHttpTimingLog({ clock: () => 0, minMs: 2000, ...capture });
  timing.record({ method: 'GET', url: '/api/x', path: '/api/x', statusCode: 200, durationMs: 700, timingEnabled: true });
  assert.equal(capture.lines.length, 0);
});
