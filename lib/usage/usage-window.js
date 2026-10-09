/**
 * Instant-based usage windows with an explicit IANA time zone.
 *
 * The ledger stores events in UTC day files. Before this module a range was an
 * inclusive pair of UTC days, which made "today"/"month" wrong for any user not
 * living in UTC and could not answer an exact `[from, to)` instant range.
 *
 * This module is pure (no I/O): it resolves a caller query into
 *   1. an exact `[from, to)` instant range (ISO 8601),
 *   2. the inclusive UTC day files that must be read (the neighbours of the
 *      zone-local window), and
 *   3. zone-local bucket keys for grouping.
 *
 * Rules:
 * - a full ISO 8601 instant is used as-is, so `[from, to)` is exact;
 * - a date-only value is interpreted as the start of that calendar day in the
 *   requested zone; a date-only `to` is exclusive at the start of the *next*
 *   zone day (so `from=2026-08-01&to=2026-08-28` still means 28 days);
 * - "today"/"month" are calendar periods in the zone, "24h"/"7d"/"30d" are
 *   exact rolling periods anchored at `now`;
 * - an unknown zone is a validation error, never a silent UTC fallback.
 */

/** Fallback zone when the caller sends none. Overridable for tests/deploys. */
export const DEFAULT_USAGE_TIME_ZONE = (() => {
  const raw = String(process.env?.CRETLI_USAGE_TZ || '').trim();
  return raw || 'UTC';
})();

/** Upper bound of the usage range, matching the HTTP API contract. */
export const USAGE_MAX_RANGE_DAYS = 92;

/** Zones that are safe to accept without leaking an arbitrary Intl error. */
const zoneFormatterCache = new Map();

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * True when `tz` is an IANA zone this runtime can resolve.
 *
 * @param {unknown} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  const zone = text(tz);
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the caller zone, defaulting only when nothing was sent.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {{ tz: string, error?: string }}
 */
export function resolveUsageTimeZone(value, fallback = DEFAULT_USAGE_TIME_ZONE) {
  const raw = text(value);
  if (!raw) {
    const zone = isValidTimeZone(fallback) ? fallback : 'UTC';
    return { tz: zone };
  }
  if (!isValidTimeZone(raw)) return { tz: '', error: `Invalid tz (expected an IANA zone, got "${raw}")` };
  return { tz: raw };
}

/**
 * @param {string} tz
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(tz) {
  let formatter = zoneFormatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    zoneFormatterCache.set(tz, formatter);
  }
  return formatter;
}

/**
 * Wall-clock parts of one instant in a zone.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function getZoneParts(ms, tz) {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  /** @type {Record<string, number>} */
  const out = {};
  for (const part of parts) {
    if (part.type === 'literal' || part.type === 'dayPeriod') continue;
    out[part.type] = Number(part.value);
  }
  // `hour: '2-digit'` may format midnight as 24 in some engines.
  if (out.hour === 24) out.hour = 0;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/**
 * Zone offset (zone wall time minus UTC) in ms at one instant.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {number}
 */
export function zoneOffsetMs(ms, tz) {
  const parts = getZoneParts(ms, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a zone-local wall time to a UTC instant. Two passes settle the DST
 * offset even when the first guess lands on the other side of a transition.
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} wall
 * @param {string} tz
 * @returns {number}
 */
export function zonedWallTimeToMs(wall, tz) {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour || 0,
    wall.minute || 0,
    wall.second || 0
  );
  let ms = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const candidate = guess - zoneOffsetMs(ms, tz);
    if (candidate === ms) break;
    ms = candidate;
  }
  return ms;
}

/**
 * Start of the zone-local calendar day containing `ms`.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {number}
 */
export function zoneDayStartMs(ms, tz) {
  const parts = getZoneParts(ms, tz);
  return zonedWallTimeToMs({ year: parts.year, month: parts.month, day: parts.day }, tz);
}

/**
 * Add whole zone-local calendar days (DST-safe: wall date first, then resolve).
 *
 * @param {number} ms
 * @param {number} days
 * @param {string} tz
 * @returns {number}
 */
export function addZoneDays(ms, days, tz) {
  const parts = getZoneParts(zoneDayStartMs(ms, tz), tz);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0)));
  return zonedWallTimeToMs(
    { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() },
    tz
  );
}

/**
 * Start of the zone-local calendar month containing `ms`.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {number}
 */
export function zoneMonthStartMs(ms, tz) {
  const parts = getZoneParts(ms, tz);
  return zonedWallTimeToMs({ year: parts.year, month: parts.month, day: 1 }, tz);
}

/**
 * Add whole zone-local calendar months.
 *
 * @param {number} ms
 * @param {number} months
 * @param {string} tz
 * @returns {number}
 */
export function addZoneMonths(ms, months, tz) {
  const parts = getZoneParts(zoneMonthStartMs(ms, tz), tz);
  const base = new Date(Date.UTC(parts.year, parts.month - 1 + Number(months || 0), 1));
  return zonedWallTimeToMs({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: 1 }, tz);
}

/**
 * @param {number} value
 * @param {number} [width]
 * @returns {string}
 */
function pad(value, width = 2) {
  return String(Math.abs(Math.trunc(value))).padStart(width, '0');
}

/**
 * Zone-local calendar day key (`YYYY-MM-DD`).
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {string}
 */
export function formatZoneDay(ms, tz) {
  const parts = getZoneParts(ms, tz);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Zone-local hour key (`YYYY-MM-DDTHH:00`), stable for chart axes.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {string}
 */
export function formatZoneHour(ms, tz) {
  const parts = getZoneParts(ms, tz);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:00`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse one range endpoint. Date-only values resolve to the start of the zone
 * day; full instants are exact.
 *
 * @param {unknown} value
 * @param {string} tz
 * @returns {{ ms: number, iso: string, dateOnly: boolean, day: string } | null}
 */
export function parseUsageInstant(value, tz) {
  const raw = text(value);
  if (!raw) return null;
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const ms = zonedWallTimeToMs({ year, month, day }, tz);
    if (!Number.isFinite(ms)) return null;
    // Reject impossible dates such as 2026-02-31 that Date.UTC would roll over.
    const check = getZoneParts(ms, tz);
    if (check.year !== year || check.month !== month || check.day !== day) return null;
    return { ms, iso: new Date(ms).toISOString(), dateOnly: true, day: raw };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return { ms, iso: new Date(ms).toISOString(), dateOnly: false, day: formatZoneDay(ms, tz) };
}

/** Named rolling/calendar ranges and the exact meaning shown to the caller. */
export const USAGE_NAMED_RANGES = Object.freeze({
  today: 'calendar day in the chosen zone',
  month: 'calendar month in the chosen zone',
  '24h': 'exact rolling 24 hours ending now',
  '7d': 'exact rolling 7 days ending now',
  '30d': 'exact rolling 30 days ending now',
  // UI KPI helper: wide enough for both "calendar month" and "last 7 days".
  month7d: 'from the earlier of the zone month start and 6 days ago through now',
});

/**
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {number}
 */
function spanDays(fromMs, toMs) {
  return Math.ceil(Math.max(0, toMs - fromMs) / 86_400_000);
}

/**
 * Resolve a caller query into an exact zone-aware window.
 *
 * @param {{ from?: unknown, to?: unknown, tz?: unknown, range?: unknown, now?: number, maxDays?: number, defaultTz?: string }} [query]
 * @returns {{
 *   ok: true,
 *   tz: string,
 *   range: string,
 *   definition: string,
 *   from: string,
 *   to: string,
 *   fromMs: number,
 *   toMs: number,
 *   days: number,
 *   readFrom: string,
 *   readTo: string,
 *   labelFrom: string,
 *   labelTo: string,
 *   inputKind: 'day'|'instant'|'named',
 *   legacyDayFrom: string|null,
 *   legacyDayTo: string|null,
 * } | { ok: false, error: string }}
 */
export function resolveUsageWindow(query = {}) {
  const now = Number.isFinite(Number(query.now)) ? Number(query.now) : Date.now();
  const zone = resolveUsageTimeZone(query.tz, query.defaultTz);
  if (zone.error) return { ok: false, error: zone.error };
  const tz = zone.tz;
  const maxDays = Number.isFinite(Number(query.maxDays)) ? Number(query.maxDays) : USAGE_MAX_RANGE_DAYS;
  const named = text(query.range).toLowerCase();
  const rawFrom = text(query.from);
  const rawTo = text(query.to);

  let fromMs;
  let toMs;
  let range = 'custom';
  let inputKind = 'instant';
  let definition = 'exact [from, to) instants';
  let legacyDayFrom = null;
  let legacyDayTo = null;

  if (named) {
    if (!Object.prototype.hasOwnProperty.call(USAGE_NAMED_RANGES, named)) {
      return { ok: false, error: `Invalid range (${Object.keys(USAGE_NAMED_RANGES).join('|')})` };
    }
    range = named;
    definition = USAGE_NAMED_RANGES[named];
    inputKind = 'named';
    if (named === 'today') {
      fromMs = zoneDayStartMs(now, tz);
      toMs = addZoneDays(fromMs, 1, tz);
    } else if (named === 'month') {
      fromMs = zoneMonthStartMs(now, tz);
      toMs = addZoneMonths(fromMs, 1, tz);
    } else if (named === '24h') {
      toMs = now;
      fromMs = now - 86_400_000;
    } else if (named === '7d') {
      toMs = now;
      fromMs = now - 7 * 86_400_000;
    } else if (named === 'month7d') {
      const monthStart = zoneMonthStartMs(now, tz);
      const weekStart = addZoneDays(zoneDayStartMs(now, tz), -6, tz);
      fromMs = Math.min(monthStart, weekStart);
      // `now + 1` keeps an event stamped exactly at `now` inside [from, to).
      toMs = now + 1;
    } else {
      toMs = now;
      fromMs = now - 30 * 86_400_000;
    }
  } else {
    const parsedFrom = parseUsageInstant(rawFrom, tz);
    const parsedTo = parseUsageInstant(rawTo, tz);
    if (rawTo && !parsedTo) return { ok: false, error: 'Invalid to (expected an ISO 8601 instant or YYYY-MM-DD)' };
    if (rawFrom && !parsedFrom) return { ok: false, error: 'Invalid from (expected an ISO 8601 instant or YYYY-MM-DD)' };
    if (parsedFrom && parsedTo) {
      fromMs = parsedFrom.ms;
      // A date-only `to` is the whole zone day, i.e. exclusive at the next midnight.
      toMs = parsedTo.dateOnly ? addZoneDays(parsedTo.ms, 1, tz) : parsedTo.ms;
      if (parsedFrom.dateOnly && parsedTo.dateOnly) {
        inputKind = 'day';
        legacyDayFrom = parsedFrom.day;
        legacyDayTo = parsedTo.day;
        definition = 'inclusive zone calendar days';
      }
    } else if (parsedTo) {
      // Only `to`: default to the zone month that contains it.
      toMs = parsedTo.dateOnly ? addZoneDays(parsedTo.ms, 1, tz) : parsedTo.ms;
      const anchor = parsedTo.ms;
      fromMs = zoneMonthStartMs(anchor, tz);
      if (parsedTo.dateOnly) {
        inputKind = 'day';
        legacyDayTo = parsedTo.day;
        legacyDayFrom = formatZoneDay(fromMs, tz);
        definition = 'inclusive zone calendar days';
      }
    } else if (parsedFrom) {
      fromMs = parsedFrom.ms;
      toMs = now;
      if (parsedFrom.dateOnly) {
        inputKind = 'day';
        legacyDayFrom = parsedFrom.day;
        legacyDayTo = formatZoneDay(now, tz);
        definition = 'inclusive zone calendar days';
      }
    } else {
      // No endpoints: default to the current zone month.
      fromMs = zoneMonthStartMs(now, tz);
      toMs = now;
      inputKind = 'named';
      range = 'month';
      definition = USAGE_NAMED_RANGES.month;
    }
  }

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: 'Invalid range' };
  }
  if (toMs <= fromMs) return { ok: false, error: 'from must be before to' };
  const days = spanDays(fromMs, toMs);
  if (days > maxDays) return { ok: false, error: `Range must not exceed ${maxDays} days` };

  // The exact UTC files the window can touch. Reading one day either side of the
  // zone-local window is what makes a neighbouring zone offset correct.
  const readFrom = new Date(fromMs).toISOString().slice(0, 10);
  const readTo = new Date(toMs - 1).toISOString().slice(0, 10);

  return {
    ok: true,
    tz,
    range,
    definition,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    days,
    readFrom,
    readTo,
    labelFrom: formatZoneDay(fromMs, tz),
    labelTo: formatZoneDay(toMs - 1, tz),
    inputKind,
    legacyDayFrom,
    legacyDayTo,
  };
}

/**
 * @param {unknown} at
 * @returns {number}
 */
export function eventInstantMs(at) {
  const ms = Date.parse(text(at));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Keep only events whose instant is inside `[fromMs, toMs)`. An event without a
 * parseable timestamp is dropped, never silently kept.
 *
 * @param {object[]} events
 * @param {{ fromMs: number, toMs: number }} window
 * @returns {object[]}
 */
export function filterEventsByWindow(events, window) {
  const fromMs = Number(window?.fromMs);
  const toMs = Number(window?.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
  return (Array.isArray(events) ? events : []).filter((event) => {
    const ms = eventInstantMs(event?.at);
    return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
  });
}

/**
 * Window descriptor for the API response / export, without inventing values.
 *
 * @param {ReturnType<typeof resolveUsageWindow>} window
 * @returns {object}
 */
export function describeUsageWindow(window) {
  if (!window || window.ok !== true) return { ok: false, error: window?.error || 'invalid range' };
  return {
    ok: true,
    tz: window.tz,
    range: window.range,
    definition: window.definition,
    from: window.from,
    to: window.to,
    days: window.days,
    from_day: window.labelFrom,
    to_day: window.labelTo,
    input_kind: window.inputKind,
  };
}
