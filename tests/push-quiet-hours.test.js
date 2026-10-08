/**
 * lib/push-quiet-hours.js — device quiet window helpers.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_QUIET_HOURS,
  formatQuietTime,
  isQuietHoursActive,
  mergeQuietHours,
  normalizeQuietHours,
  parseQuietTime,
  resolveDeviceMinutes,
  resolveQuietState,
  validateQuietHours,
} from '../lib/push-quiet-hours.js';

assert.equal(parseQuietTime('22:00'), 22 * 60);
assert.equal(parseQuietTime('7:05'), 7 * 60 + 5);
assert.equal(parseQuietTime('07:05'), 7 * 60 + 5);
assert.equal(parseQuietTime('24:00'), -1);
assert.equal(parseQuietTime('ab:cd'), -1);

assert.equal(formatQuietTime(0), '00:00');
assert.equal(formatQuietTime(22 * 60), '22:00');

assert.deepEqual(normalizeQuietHours(null), {
  schemaVersion: 1,
  enabled: false,
  start: '22:00',
  end: '07:00',
});

assert.deepEqual(
  normalizeQuietHours({ enabled: true, start: '22:00', end: '22:00' }),
  { schemaVersion: 1, enabled: false, start: '22:00', end: '22:00' },
);

assert.equal(validateQuietHours({ enabled: true, start: '22:00', end: '22:00' }).ok, false);
assert.equal(validateQuietHours({ enabled: true, start: '22:00', end: '22:00' }).error, 'quiet_start_equals_end');
assert.equal(validateQuietHours('nope').error, 'not_an_object');

assert.deepEqual(
  mergeQuietHours({ enabled: false, start: '22:00', end: '07:00' }, { enabled: true }),
  normalizeQuietHours({ enabled: true, start: '22:00', end: '07:00' }),
);
assert.deepEqual(
  mergeQuietHours({ enabled: true, start: '22:00', end: '07:00' }, { start: 'bad' }),
  normalizeQuietHours({ enabled: true, start: '22:00', end: '07:00' }),
);

// Wrap past midnight: 22:00–07:00
assert.equal(isQuietHoursActive({ getHours: () => 23, getMinutes: () => 0 }, { enabled: true, start: '22:00', end: '07:00' }), true);
assert.equal(isQuietHoursActive({ getHours: () => 6, getMinutes: () => 30 }, { enabled: true, start: '22:00', end: '07:00' }), true);
assert.equal(isQuietHoursActive({ getHours: () => 12, getMinutes: () => 0 }, { enabled: true, start: '22:00', end: '07:00' }), false);

// Same-day window start < end
assert.equal(isQuietHoursActive({ getHours: () => 10, getMinutes: () => 0 }, { enabled: true, start: '09:00', end: '17:00' }), true);
assert.equal(isQuietHoursActive({ getHours: () => 8, getMinutes: () => 0 }, { enabled: true, start: '09:00', end: '17:00' }), false);

assert.equal(isQuietHoursActive({ getHours: () => 10, getMinutes: () => 0 }, { enabled: true, start: '10:00', end: '10:00' }), false);

// DST: wall clock after spring-forward (03:30 local) — not 02:30 UTC
const springForwardClock = { getHours: () => 3, getMinutes: () => 30 };
assert.equal(
  resolveDeviceMinutes(springForwardClock),
  3 * 60 + 30,
  'quiet hours follow device wall clock, not UTC',
);
assert.equal(
  isQuietHoursActive(springForwardClock, { enabled: true, start: '03:00', end: '04:00' }),
  true,
);

const state = resolveQuietState({ getHours: () => 23, getMinutes: () => 0 }, { enabled: true, start: '22:00', end: '07:00' });
assert.equal(state.active, true);
assert.equal(state.reason, 'active');
assert.equal(state.nowMinutes, 23 * 60);

assert.equal(resolveQuietState({}, DEFAULT_QUIET_HOURS).reason, 'disabled');

console.log('push-quiet-hours.test.js: ok');
