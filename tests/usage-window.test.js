/**
 * Instant + IANA-zone usage windows. The DST cases are the point: a
 * "today" window must follow the zone calendar even across a transition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addZoneDays,
  describeUsageWindow,
  filterEventsByWindow,
  formatZoneDay,
  formatZoneHour,
  getZoneParts,
  isValidTimeZone,
  parseUsageInstant,
  resolveUsageTimeZone,
  resolveUsageWindow,
  zoneDayStartMs,
  zoneMonthStartMs,
  zonedWallTimeToMs,
} from '../lib/usage/usage-window.js';

test('isValidTimeZone accepts IANA names and rejects junk', () => {
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Europe/Warsaw'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});

test('resolveUsageTimeZone defaults only when empty and never silently falls back', () => {
  assert.deepEqual(resolveUsageTimeZone('', 'Europe/Warsaw'), { tz: 'Europe/Warsaw' });
  assert.equal(resolveUsageTimeZone('Europe/Warsaw').tz, 'Europe/Warsaw');
  const bad = resolveUsageTimeZone('Not/AZone');
  assert.equal(bad.tz, '');
  assert.match(bad.error, /Invalid tz/);
});

test('resolveUsageWindow resolves calendar today in the zone (spring forward)', () => {
  // 2026-03-29 is the Europe/Warsaw spring-forward day (23 hours long).
  const now = Date.parse('2026-03-29T12:00:00.000Z');
  const window = resolveUsageWindow({ range: 'today', tz: 'Europe/Warsaw', now });
  assert.equal(window.ok, true);
  assert.equal(window.from, '2026-03-28T23:00:00.000Z');
  assert.equal(window.to, '2026-03-29T22:00:00.000Z');
  assert.equal(window.days, 1);
  assert.equal(window.labelFrom, '2026-03-29');
});

test('resolveUsageWindow resolves calendar today in the zone (fall back)', () => {
  // 2026-10-25 is the Europe/Warsaw fall-back day (25 hours long).
  const now = Date.parse('2026-10-25T12:00:00.000Z');
  const window = resolveUsageWindow({ range: 'today', tz: 'Europe/Warsaw', now });
  assert.equal(window.ok, true);
  assert.equal(window.from, '2026-10-24T22:00:00.000Z');
  assert.equal(window.to, '2026-10-25T23:00:00.000Z');
  assert.ok((window.toMs - window.fromMs) === 25 * 3_600_000);
});

test('resolveUsageWindow resolves calendar month in the zone', () => {
  const now = Date.parse('2026-03-15T12:00:00.000Z');
  const window = resolveUsageWindow({ range: 'month', tz: 'Europe/Warsaw', now });
  assert.equal(window.from, '2026-02-28T23:00:00.000Z');
  assert.equal(window.to, '2026-03-31T22:00:00.000Z');
  assert.equal(window.labelFrom, '2026-03-01');
  assert.equal(window.labelTo, '2026-03-31');
});

test('rolling 24h/7d/30d are exact periods anchored at now', () => {
  const now = Date.parse('2026-05-10T12:34:56.000Z');
  for (const [range, days] of [['24h', 1], ['7d', 7], ['30d', 30]]) {
    const window = resolveUsageWindow({ range, tz: 'UTC', now });
    assert.equal(window.to, new Date(now).toISOString());
    assert.equal(window.fromMs, now - days * 86_400_000);
  }
});

test('month7d spans the earlier of the zone month start and 6 days ago', () => {
  const now = Date.parse('2026-03-03T12:00:00.000Z');
  const window = resolveUsageWindow({ range: 'month7d', tz: 'Europe/Warsaw', now });
  // Week start (2026-02-25) is earlier than the month start (2026-03-01).
  assert.equal(window.labelFrom, '2026-02-25');
  assert.equal(window.toMs, now + 1);
  const lateMonth = resolveUsageWindow({ range: 'month7d', tz: 'Europe/Warsaw', now: Date.parse('2026-03-20T12:00:00.000Z') });
  assert.equal(lateMonth.labelFrom, '2026-03-01');
});

test('date-only from/to keeps the inclusive-day contract', () => {
  const window = resolveUsageWindow({ from: '2026-08-01', to: '2026-08-28', tz: 'UTC' });
  assert.equal(window.ok, true);
  assert.equal(window.inputKind, 'day');
  assert.equal(window.from, '2026-08-01T00:00:00.000Z');
  assert.equal(window.to, '2026-08-29T00:00:00.000Z');
  assert.equal(window.days, 28);
  assert.equal(window.legacyDayFrom, '2026-08-01');
  assert.equal(window.legacyDayTo, '2026-08-28');
});

test('full ISO instants use an exact [from, to) range', () => {
  const window = resolveUsageWindow({
    from: '2026-08-01T10:15:00.000Z',
    to: '2026-08-01T11:00:00.000Z',
    tz: 'UTC',
  });
  assert.equal(window.ok, true);
  assert.equal(window.inputKind, 'instant');
  assert.equal(window.from, '2026-08-01T10:15:00.000Z');
  assert.equal(window.to, '2026-08-01T11:00:00.000Z');
  assert.equal(window.fromMs, Date.parse('2026-08-01T10:15:00.000Z'));
});

test('readFrom/readTo cover the neighbouring UTC day files', () => {
  // A +13 zone day starts on the previous UTC day.
  const window = resolveUsageWindow({ range: 'today', tz: 'Pacific/Auckland', now: Date.parse('2026-01-02T00:30:00.000Z') });
  assert.equal(window.ok, true);
  assert.equal(window.readFrom, '2026-01-01');
  assert.equal(window.readTo, '2026-01-02');
});

test('invalid endpoints, reversed range and oversized range are rejected', () => {
  assert.match(resolveUsageWindow({ from: 'nope', tz: 'UTC' }).error, /Invalid from/);
  assert.match(resolveUsageWindow({ to: '2026-02-31', tz: 'UTC' }).error, /Invalid to/);
  assert.match(resolveUsageWindow({ from: '2026-08-02', to: '2026-08-01', tz: 'UTC' }).error, /before/);
  assert.match(
    resolveUsageWindow({ from: '2025-01-01', to: '2026-12-31', tz: 'UTC' }).error,
    /must not exceed/
  );
  assert.match(resolveUsageWindow({ range: 'yesterday', tz: 'UTC' }).error, /Invalid range/);
});

test('zone helpers add days across DST without losing the wall date', () => {
  const start = zoneDayStartMs(Date.parse('2026-03-28T12:00:00.000Z'), 'Europe/Warsaw');
  assert.equal(formatZoneDay(start, 'Europe/Warsaw'), '2026-03-28');
  const next = addZoneDays(start, 1, 'Europe/Warsaw');
  assert.equal(formatZoneDay(next, 'Europe/Warsaw'), '2026-03-29');
  const after = addZoneDays(next, 1, 'Europe/Warsaw');
  assert.equal(formatZoneDay(after, 'Europe/Warsaw'), '2026-03-30');
  // A naive +24h would land on 2026-03-30 01:00 local; the wall-date helper does not.
  const monthStart = zoneMonthStartMs(Date.parse('2026-03-15T12:00:00.000Z'), 'Europe/Warsaw');
  assert.equal(formatZoneDay(monthStart, 'Europe/Warsaw'), '2026-03-01');
});

test('parseUsageInstant resolves date-only in the requested zone', () => {
  const parsed = parseUsageInstant('2026-01-02', 'America/New_York');
  assert.equal(parsed.dateOnly, true);
  assert.equal(parsed.iso, '2026-01-02T05:00:00.000Z');
  assert.equal(parsed.day, '2026-01-02');
  assert.equal(parseUsageInstant('not-a-date', 'UTC'), null);
});

test('zonedWallTimeToMs and getZoneParts agree around a DST edge', () => {
  const ms = zonedWallTimeToMs({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/Warsaw');
  const parts = getZoneParts(ms, 'Europe/Warsaw');
  assert.equal(parts.hour, 1);
  assert.equal(parts.minute, 30);
});

test('formatZoneHour produces a stable zone-local axis key', () => {
  const ms = Date.parse('2026-01-02T23:30:00.000Z');
  assert.equal(formatZoneHour(ms, 'UTC'), '2026-01-02T23:00');
  assert.equal(formatZoneHour(ms, 'Europe/Warsaw'), '2026-01-03T00:00');
});

test('filterEventsByWindow keeps [from, to) and drops unparseable timestamps', () => {
  const events = [
    { id: 'before', at: '2026-08-01T09:59:59.999Z' },
    { id: 'start', at: '2026-08-01T10:00:00.000Z' },
    { id: 'inside', at: '2026-08-01T10:30:00.000Z' },
    { id: 'end', at: '2026-08-01T11:00:00.000Z' },
    { id: 'bad', at: 'nope' },
  ];
  const kept = filterEventsByWindow(events, {
    fromMs: Date.parse('2026-08-01T10:00:00.000Z'),
    toMs: Date.parse('2026-08-01T11:00:00.000Z'),
  });
  assert.deepEqual(kept.map((event) => event.id), ['start', 'inside']);
});

test('describeUsageWindow exposes scope-neutral metadata for exports', () => {
  const window = resolveUsageWindow({ range: 'month', tz: 'Europe/Warsaw', now: Date.parse('2026-03-15T12:00:00.000Z') });
  const described = describeUsageWindow(window);
  assert.equal(described.tz, 'Europe/Warsaw');
  assert.equal(described.range, 'month');
  assert.match(described.definition, /calendar month/);
  assert.equal(described.from_day, '2026-03-01');
  assert.equal(describeUsageWindow({ ok: false, error: 'x' }).ok, false);
});
