/**
 * Device-local quiet hours for push and in-app alerts.
 *
 * Pure ESM: no I/O, never throws. Quiet hours suppress vibration and sound only;
 * notifications stay visible and the server must not filter pushes by this window.
 */

export const PUSH_QUIET_HOURS_SCHEMA_VERSION = 1;

export const DEFAULT_QUIET_HOURS = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  start: '22:00',
  end: '07:00',
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number} minutes 0..1439, or -1 when invalid
 */
export function parseQuietTime(value) {
  if (typeof value !== 'string') return -1;
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return -1;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return -1;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
  return hours * 60 + minutes;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
export function formatQuietTime(minutes) {
  const total = Number(minutes);
  if (!Number.isFinite(total)) return DEFAULT_QUIET_HOURS.start;
  const clamped = ((Math.floor(total) % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Lenient normalization — always returns a fresh object.
 *
 * @param {unknown} raw
 * @returns {{ schemaVersion: number, enabled: boolean, start: string, end: string }}
 */
export function normalizeQuietHours(raw) {
  const source = isPlainObject(raw) ? raw : {};
  let enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_QUIET_HOURS.enabled;
  const startParsed = parseQuietTime(source.start);
  const endParsed = parseQuietTime(source.end);
  const start = startParsed >= 0 ? formatQuietTime(startParsed) : DEFAULT_QUIET_HOURS.start;
  const end = endParsed >= 0 ? formatQuietTime(endParsed) : DEFAULT_QUIET_HOURS.end;
  if (enabled && start === end) {
    enabled = false;
  }
  return {
    schemaVersion: PUSH_QUIET_HOURS_SCHEMA_VERSION,
    enabled,
    start,
    end,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: ReturnType<typeof normalizeQuietHours> } | { ok: false, error: string }}
 */
export function validateQuietHours(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'not_an_object' };
  if (
    raw.schemaVersion !== undefined
    && raw.schemaVersion !== PUSH_QUIET_HOURS_SCHEMA_VERSION
  ) {
    return { ok: false, error: 'unsupported_schema_version' };
  }
  if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'invalid_enabled' };
  if (parseQuietTime(raw.start) < 0) return { ok: false, error: 'invalid_start' };
  if (parseQuietTime(raw.end) < 0) return { ok: false, error: 'invalid_end' };
  const start = formatQuietTime(parseQuietTime(raw.start));
  const end = formatQuietTime(parseQuietTime(raw.end));
  if (raw.enabled && start === end) return { ok: false, error: 'quiet_start_equals_end' };
  return {
    ok: true,
    value: normalizeQuietHours({ ...raw, start, end }),
  };
}

/**
 * Partial merge; invalid patch fields keep the existing value.
 *
 * @param {unknown} existing
 * @param {unknown} patch
 * @returns {ReturnType<typeof normalizeQuietHours>}
 */
export function mergeQuietHours(existing, patch) {
  const base = normalizeQuietHours(existing);
  if (!isPlainObject(patch)) return base;
  const next = { ...base };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (parseQuietTime(patch.start) >= 0) next.start = formatQuietTime(parseQuietTime(patch.start));
  if (parseQuietTime(patch.end) >= 0) next.end = formatQuietTime(parseQuietTime(patch.end));
  return normalizeQuietHours(next);
}

/**
 * Device-local wall clock minutes (DST follows the Date / clock object).
 *
 * @param {Date | { getHours: () => number, getMinutes: () => number }} [now]
 * @returns {number}
 */
export function resolveDeviceMinutes(now) {
  const clock = now instanceof Date ? now : (now && typeof now.getHours === 'function' ? now : new Date());
  const hours = Number(clock.getHours());
  const minutes = Number(clock.getMinutes());
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

/**
 * @param {Date | { getHours: () => number, getMinutes: () => number }} [now]
 * @param {unknown} quietHours
 * @returns {boolean}
 */
export function isQuietHoursActive(now, quietHours) {
  const cfg = normalizeQuietHours(quietHours);
  if (!cfg.enabled) return false;
  const start = parseQuietTime(cfg.start);
  const end = parseQuietTime(cfg.end);
  if (start < 0 || end < 0 || start === end) return false;
  const nowMinutes = resolveDeviceMinutes(now);
  if (start > end) {
    return nowMinutes >= start || nowMinutes < end;
  }
  return nowMinutes >= start && nowMinutes < end;
}

/**
 * @param {Date | { getHours: () => number, getMinutes: () => number }} [now]
 * @param {unknown} quietHours
 * @returns {{ active: boolean, reason: 'active' | 'outside' | 'disabled', nowMinutes: number, startMinutes: number, endMinutes: number }}
 */
export function resolveQuietState(now, quietHours) {
  const cfg = normalizeQuietHours(quietHours);
  const startMinutes = parseQuietTime(cfg.start);
  const endMinutes = parseQuietTime(cfg.end);
  const nowMinutes = resolveDeviceMinutes(now);
  if (!cfg.enabled) {
    return {
      active: false,
      reason: 'disabled',
      nowMinutes,
      startMinutes: startMinutes >= 0 ? startMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.start),
      endMinutes: endMinutes >= 0 ? endMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.end),
    };
  }
  const active = isQuietHoursActive(now, cfg);
  return {
    active,
    reason: active ? 'active' : 'outside',
    nowMinutes,
    startMinutes: startMinutes >= 0 ? startMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.start),
    endMinutes: endMinutes >= 0 ? endMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.end),
  };
}
