/**
 * Credit balance forecast and exhaustion alerts.
 *
 * The projection is deliberately based on measured balance snapshots only:
 *
 *   spend(t1, t2) = balance(t1) - balance(t2) + bookedWalletChanges(t1, t2]
 *
 * The wallet-change sum contains ONLY movements unrelated to paid API use
 * (top-ups, grants, credit refunds, expiries and corrections). Usage charges are
 * already present in the balance difference and are never counted again.
 * Pending and superseded records are ignored; currencies are never summed or
 * converted.
 *
 * The module is pure for every calculation entry point: snapshots and
 * transactions are passed in, no provider history API is assumed, and local
 * DeepSeek pricing has no versioned rates, so no USD spend is derived from
 * tokens (a `reportedUsd` figure is not invented).
 *
 * Money is exact decimal arithmetic on the ledger's decimal strings; only the
 * derived per-day rate and the time estimate use IEEE numbers.
 *
 * The state/alert helpers at the bottom are the only side-effecting part. A new
 * threshold crossing is published once to the in-app notification centre (the
 * UI alert) and optionally pushed through the existing `lib/push.js` broadcaster,
 * which honours the endpoint's push preferences (the `balance-alert` data type
 * maps to the global `enabled` switch). Neither payload carries transaction data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { activeRows, loadLedger } from './credit-ledger-store.ts';
import type { LedgerAccount, LedgerSnapshot, LedgerTransaction } from './credit-ledger-store.ts';
import { addDecimal, formatDecimal, negateDecimal, parseDecimal } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

/** Minimum separation between the two measured points of a forecast. */
export const BALANCE_FORECAST_MIN_SPAN_MS = 24 * 60 * 60 * 1000;
/** Latest-point freshness: one daily refresh plus one missed cycle. */
export const BALANCE_FORECAST_FRESHNESS_MS = 36 * 60 * 60 * 1000;
/** A point within 10% (or one day) of the window start counts as a boundary hit. */
export const BALANCE_FORECAST_BOUNDARY_TOLERANCE_RATIO = 0.1;
/** A short/long rate ratio of 2x marks an explicit rate-change state. */
export const BALANCE_FORECAST_RATE_CHANGE_FACTOR = 2;

/** Forecast scenarios; two points are two workloads, not a confidence interval. */
export const BALANCE_FORECAST_WINDOWS = Object.freeze([
  Object.freeze({ id: '7d', requestedMs: 7 * 24 * 60 * 60 * 1000 }),
  Object.freeze({ id: '30d', requestedMs: 30 * 24 * 60 * 60 * 1000 }),
]);

/** Alert is raised when the projected runway falls to/under this threshold. */
export const BALANCE_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** Alert clears only after a verified runway exceeds the threshold by 25%. */
export const BALANCE_ALERT_HYSTERESIS_RATIO = 0.25;
/** Stable kind used by the push payload and the persisted alert state. */
export const BALANCE_ALERT_KIND = 'balance-alert';
/** Settings page opened by an alert tap (generic link, no transaction data). */
export const BALANCE_ALERT_ACTION_URL = '/?panel=settings&tab=usage';

/** Alert fingerprints older than this are pruned. */
export const BALANCE_ALERT_STATE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** Upper bound of tracked alert fingerprints. */
export const BALANCE_ALERT_STATE_MAX_KEYS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const WALL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/;
const ZONE_OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;
/**
 * Real-world UTC offsets reach -12:00..+14:00. An unknown zone must be treated
 * as possibly spanning that whole range: `UTC = wall - offset`, so the possible
 * instants of a wall reading run from `wall - 14 h` to `wall + 12 h`.
 */
const MIN_ZONE_OFFSET_MS = -12 * HOUR_MS;
const MAX_ZONE_OFFSET_MS = 14 * HOUR_MS;
/** An explicit `+HH:MM` offset must stay inside the real -12:00..+14:00 range. */
const MAX_ZONE_OFFSET_HOURS = 14;
const MIN_ZONE_OFFSET_HOURS = -12;

/** Cached `Intl.DateTimeFormat` per IANA zone; `null` marks an invalid zone. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

/** A ledger moment as read from rows or fixtures (every field is validated at runtime). */
interface MomentLike {
  at?: unknown;
  date?: unknown;
  precision?: unknown;
  sourceZone?: unknown;
}

interface Interval {
  start: number;
  end: number;
}

interface ObservationInterval extends Interval {
  possibleStart: number;
  possibleEnd: number;
  imprecise: boolean;
}

interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface WalletChange {
  at: number | null;
  interval: Interval | null;
  signed: Decimal;
  amount: Decimal;
  type: string;
}

interface WindowChanges {
  total: Decimal;
  topups: Decimal;
  grants: Decimal;
  expiries: Decimal;
  refunds: Decimal;
  count: number;
  uncertain: boolean;
}

/** One measured balance point. */
interface BalancePoint {
  ms: number;
  total: Decimal;
  granted: Decimal | null;
  toppedUp: Decimal | null;
  completeness: string;
  boundaryUncertain: boolean;
  isAvailable: boolean | null;
}

interface WindowSpec {
  id: string;
  requestedMs: number;
}

export interface BalanceWindow {
  id: string;
  requestedMs: number;
  actualMs: number | null;
  from: string | null;
  to: string;
  coverage: string;
  status: string;
  reasons: string[];
  spend: string | null;
  spendPerDay: number | null;
  balance: string;
  exhaustsAt: string | null;
  remainingMs: number | null;
  flows: { total: string; topups: string; grants: string; expiries: string; refunds: string; count: number } | null;
  unexplainedGrantedDrop: string | null;
  unexplainedGrantInflow: string | null;
  unexplainedTopUpIncrease: string | null;
  snapshots: number;
  largestGapMs: number | null;
}

export interface BalanceExpiry {
  at: string | null;
  date: string | null;
  precision: string;
  amount: string | null;
  currency: string;
}

export interface RateChange {
  detector: string;
  shortPerDay: number;
  longPerDay: number;
  factor: number | null;
}

/** Persisted alert state of one crossing. */
export interface AlertEntry {
  active?: boolean;
  crossedAt?: string;
  remainingMs?: number | null;
  thresholdMs?: number;
  updatedAt?: string;
  deliveryPending?: boolean;
  pushDelivered?: boolean;
  uiDelivered?: boolean;
  uiId?: string;
  deliveredAt?: string;
}

export interface AlertState {
  version?: number;
  alerts?: Record<string, AlertEntry>;
}

export interface ForecastAlertSummary {
  active: boolean;
  deliveryPending: boolean;
  crossedAt: string | null;
  remainingMs: number | null;
  thresholdMs: number;
}

export interface BalanceForecast {
  accountId: string;
  accountLabel: string;
  walletCurrency: string;
  currency: string;
  series: string;
  updatedAt: string;
  freshnessMs: number;
  status: string;
  reasons: string[];
  latestObservedAt: string | null;
  latestBalance: string | null;
  latestGrantedBalance: string | null;
  latestToppedUpBalance: string | null;
  isAvailable: boolean | null;
  stale: boolean;
  windows: Record<string, BalanceWindow | null>;
  exhaustion: { windowId: string; spendPerDay: number | null; exhaustsAt: string | null; remainingMs: number | null } | null;
  remainingMs: number | null;
  balanceDropUncertain: boolean;
  expiries: BalanceExpiry[];
  rateChange: RateChange | null;
  alert?: ForecastAlertSummary | null;
}

/** The forecast fields the alert helpers read; tolerant of partial fixtures. */
export interface ForecastLike {
  accountId?: unknown;
  currency?: unknown;
  series?: unknown;
  status?: unknown;
  remainingMs?: unknown;
}

export interface BalanceAlertEvaluation {
  key: string;
  metric: number | null;
  thresholdMs: number;
  exitThresholdMs: number;
  active: boolean;
  notify: boolean;
  reset: boolean;
  state: AlertEntry | null;
}

export interface BalanceAlertPushPayload {
  title: string;
  body: string;
  tag: string;
  data: Record<string, unknown>;
}

export type BalanceAlertNotification = {
  category: string;
  severity: string;
  title: string;
  body: string;
  actionUrl: string;
  fingerprint: string;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function toNow(value: unknown): number {
  if (value == null || value === '') return Date.now();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Validates an explicit `+HH:MM` zone offset. `Date.parse` accepts values such
 * as `+14:30` that are not real offsets, so the suffix is checked before an
 * instant is trusted.
 *
 * @param sign '+' or '-'
 */
function isValidOffset(sign: string, hours: number, minutes: number): boolean {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return false;
  if (minutes >= 60) return false;
  const total = hours * 60 + minutes;
  // Real offsets span -12:00..+14:00.
  return sign === '+' ? total <= MAX_ZONE_OFFSET_HOURS * 60 : total <= -MIN_ZONE_OFFSET_HOURS * 60;
}

/**
 * Parses a strict ISO-8601 instant. A date-only moment must never become an
 * invented midnight, so only strings with a time and an explicit zone pass. An
 * out-of-range offset is malformed and yields NaN instead of an instant.
 *
 * @returns epoch ms or NaN
 */
function instantMs(value: unknown): number {
  let raw = '';
  if (typeof value === 'string') raw = value.trim();
  else if (value && typeof value === 'object' && typeof (value as MomentLike).at === 'string') raw = ((value as MomentLike).at as string).trim();
  else return NaN;
  if (!ISO_INSTANT_RE.test(raw)) return NaN;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (offset && !isValidOffset(offset[1], Number(offset[2]), Number(offset[3]))) return NaN;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * A ledger amount is `{ value, scale }`; plain decimal strings are accepted so
 * the pure forecast can be driven by fixtures without the store.
 */
function amount(value: unknown): Decimal | null {
  if (typeof value === 'string') return parseDecimal(value);
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return parseDecimal((value as { value: string }).value);
  }
  return null;
}

function subtract(a: Decimal, b: Decimal): Decimal {
  return addDecimal(a, negateDecimal(b));
}

function toNumber(value: Decimal): number {
  return Number(formatDecimal(value));
}

function roundNumber(value: number, digits = 6): number | null {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Wall-clock milliseconds for a `YYYY-MM-DD` / `YYYY-MM-DDTHH` local moment.
 * `Date.UTC` is used so the server time zone never leaks into the result.
 *
 * @returns epoch ms of the wall clock read as UTC, or NaN
 */
function wallClockMs(date: unknown, precision: 'hour' | 'day'): number {
  const match = WALL_DATE_RE.exec(text(date));
  if (!match) return NaN;
  const hour = precision === 'hour' ? Number(match[4]) : 0;
  if (precision === 'hour' && match[4] == null) return NaN;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Offset in milliseconds of a fixed `+HH:MM` zone string, or null. The value is
 * validated against the real UTC range: `+99:99` is malformed, not an offset.
 */
function fixedZoneOffsetMs(zone: unknown): number | null {
  const match = ZONE_OFFSET_RE.exec(text(zone));
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (!isValidOffset(match[1], hours, minutes)) return null;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  if (zoneFormatters.has(zone)) return zoneFormatters.get(zone) as Intl.DateTimeFormat | null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Resolving a reference instant rejects unknown IANA zones up front.
    formatter.formatToParts(new Date(0));
  } catch {
    formatter = null;
  }
  zoneFormatters.set(zone, formatter);
  return formatter;
}

/**
 * Local wall-clock fields of `utcMs` in an IANA `zone`, or null.
 */
function localFieldsAt(zone: string, utcMs: number): LocalFields | null {
  const formatter = zoneFormatter(zone);
  if (!formatter) return null;
  const parts = formatter.formatToParts(new Date(utcMs));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const fields = {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
  return Object.values(fields).every(Number.isFinite) ? fields : null;
}

/**
 * UTC offset of `zone` at `utcMs`, in milliseconds, or null when the zone is
 * missing or unparseable.
 */
function zoneOffsetMs(zone: string, utcMs: number): number | null {
  const fixed = fixedZoneOffsetMs(zone);
  if (fixed != null) return fixed;
  const fields = localFieldsAt(zone, utcMs);
  if (!fields) return null;
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  // Offsets are whole minutes; ignore sub-second residues from the probe instant.
  return Math.round((asUtc - utcMs) / 60000) * 60000;
}

/**
 * Converts a wall-clock reading in `zone` to a UTC instant.
 *
 * Every offset that can apply near the reading is tried and each candidate is
 * formatted back: exactly one match is a unique instant. Zero matches mean a
 * DST gap (a local time that never happened) and two matches mean a fold (a
 * local time that happened twice); neither has one correct instant, so both
 * return null and the caller treats the placement as uncertain. The host time
 * zone is never involved.
 */
function wallClockToUtc(zone: string, wallMs: number): number | null {
  if (!text(zone)) return null;
  const fixed = fixedZoneOffsetMs(zone);
  if (fixed != null) return wallMs - fixed;
  if (!zoneFormatter(zone)) return null;
  const offsets = new Set<number>();
  for (const shift of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    const offset = zoneOffsetMs(zone, wallMs + shift);
    if (offset == null) return null;
    offsets.add(offset);
  }
  const want = new Date(wallMs);
  const expected: LocalFields = {
    year: want.getUTCFullYear(),
    month: want.getUTCMonth() + 1,
    day: want.getUTCDate(),
    hour: want.getUTCHours(),
    minute: want.getUTCMinutes(),
    second: want.getUTCSeconds(),
  };
  let resolved: number | null = null;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    const fields = localFieldsAt(zone, candidate);
    if (!fields) continue;
    const matches = (Object.keys(expected) as Array<keyof LocalFields>).every((key) => fields[key] === expected[key]);
    if (!matches) continue;
    if (resolved != null) return null;
    resolved = candidate;
  }
  return resolved;
}

/**
 * Places a day/hour moment on the real timeline. A recorded `sourceZone` (IANA
 * name or explicit `+HH:MM` offset) is required to know which instants the local
 * reading covers; a missing or unparseable zone stays uncertain instead of
 * silently being read as UTC.
 *
 * Both interval boundaries are resolved through the zone, so a DST transition
 * day keeps its real length (23 h or 25 h in Europe/Warsaw) instead of an
 * invented fixed 24 h span that would exclude a movement near the real end. An
 * ambiguous (fold) or nonexistent (gap) boundary has no single instant, so the
 * whole interval is uncertain (`null`).
 */
function momentInterval(rawMoment: unknown): Interval | null {
  if (!rawMoment || typeof rawMoment !== 'object') return null;
  const moment = rawMoment as MomentLike;
  const precision = moment.precision === 'hour' ? 'hour' : 'day';
  const wall = wallClockMs(moment.date, precision);
  if (!Number.isFinite(wall)) return null;
  const zone = text(moment.sourceZone);
  const span = precision === 'hour' ? HOUR_MS : DAY_MS;
  const start = wallClockToUtc(zone, wall);
  if (start == null) return null;
  const end = wallClockToUtc(zone, wall + span);
  if (end == null || end <= start) return null;
  return { start, end };
}

/**
 * Best-effort interval used for ordering observations and proving that an
 * endpoint is stale. A resolved zone gives the exact interval. A missing,
 * unknown or ambiguous zone cannot be placed, but its possible bounds are the
 * wall reading shifted by the full real-world UTC range (`UTC-12..UTC+14`), so
 * any possible overlap invalidates an endpoint instead of a naive UTC guess
 * accepting a stale one. Interval placement itself still goes through
 * `momentInterval` and stays uncertain.
 */
function observationInterval(rawMoment: unknown): ObservationInterval | null {
  const precise = instantMs(rawMoment);
  if (Number.isFinite(precise)) {
    return { start: precise, end: precise, possibleStart: precise, possibleEnd: precise, imprecise: false };
  }
  if (!rawMoment || typeof rawMoment !== 'object') return null;
  const moment = rawMoment as MomentLike;
  const precision = moment.precision === 'hour' ? 'hour' : 'day';
  const wall = wallClockMs(moment.date, precision);
  if (!Number.isFinite(wall)) return null;
  const span = precision === 'hour' ? HOUR_MS : DAY_MS;
  const zone = text(moment.sourceZone);
  const start = wallClockToUtc(zone, wall);
  if (start != null) {
    const end = wallClockToUtc(zone, wall + span);
    if (end != null) {
      return { start, end, possibleStart: start, possibleEnd: end, imprecise: true };
    }
  }
  // The wall reading cannot be placed: keep a naive position for ordering but
  // expose the full possible range so overlap checks stay conservative.
  const naiveStart = start == null ? wall : start;
  return {
    start: naiveStart,
    end: naiveStart + span,
    possibleStart: wall - MAX_ZONE_OFFSET_MS,
    possibleEnd: wall + span - MIN_ZONE_OFFSET_MS,
    imprecise: true,
  };
}

/**
 * Orders observations by their effective instant, then by recording order. A
 * broader imprecise reading recorded at the same instant comes last so it
 * supersedes a precise one.
 */
function compareObservations(a: { observedAt?: unknown; recordedAt?: unknown } | null | undefined, b: { observedAt?: unknown; recordedAt?: unknown } | null | undefined): number {
  const left = observationInterval(a?.observedAt);
  const right = observationInterval(b?.observedAt);
  const leftStart = left ? left.start : Number.NEGATIVE_INFINITY;
  const rightStart = right ? right.start : Number.NEGATIVE_INFINITY;
  if (leftStart !== rightStart) return leftStart - rightStart;
  const recorded = text(a?.recordedAt).localeCompare(text(b?.recordedAt));
  if (recorded !== 0) return recorded;
  return (left?.imprecise ? 1 : 0) - (right?.imprecise ? 1 : 0);
}

function intervalRelation(interval: Interval | null, fromMs: number, toMs: number): 'in' | 'out' | 'uncertain' {
  if (!interval) return 'uncertain';
  if (interval.end <= fromMs || interval.start > toMs) return 'out';
  if (interval.start >= fromMs && interval.end <= toMs) return 'in';
  return 'uncertain';
}

/**
 * Wallet movements for one account/currency. `refund` and `expiry` are booked
 * as negative credit by the ledger; `adjustment` keeps its stored sign.
 */
function walletChanges(rows: LedgerTransaction[] | undefined, accountId: string, currency: string): WalletChange[] {
  const changes: WalletChange[] = [];
  for (const tx of activeRows(Array.isArray(rows) ? rows : [])) {
    if (!tx || tx.accountId !== accountId) continue;
    if (tx.state !== 'posted') continue;
    const creditCurrency = text(tx.credit?.currency || currency).toUpperCase();
    if (creditCurrency !== currency) continue;
    const value = amount(tx.credit);
    if (!value) continue;
    const at = instantMs(tx.occurredAt);
    changes.push({
      at: Number.isFinite(at) ? at : null,
      interval: Number.isFinite(at) ? null : momentInterval(tx.occurredAt),
      signed: tx.type === 'refund' || tx.type === 'expiry' ? negateDecimal(value) : value,
      amount: value,
      type: text(tx.type),
    });
  }
  return changes;
}

/**
 * Sums the booked wallet changes whose effect lies in `(from, to]`. A change
 * whose imprecise moment overlaps a boundary makes the window uncertain: it is
 * never counted as zero and never silently assigned to one side.
 */
function sumWindowChanges(changes: WalletChange[], fromMs: number, toMs: number): WindowChanges {
  let total = { units: 0n, scale: 0 };
  let topups = { units: 0n, scale: 0 };
  let grants = { units: 0n, scale: 0 };
  let expiries = { units: 0n, scale: 0 };
  let refunds = { units: 0n, scale: 0 };
  let count = 0;
  let uncertain = false;
  for (const change of changes) {
    const relation = change.at != null
      ? (change.at > fromMs && change.at <= toMs ? 'in' : 'out')
      : intervalRelation(change.interval, fromMs, toMs);
    if (relation === 'uncertain') {
      uncertain = true;
      continue;
    }
    if (relation === 'out') continue;
    total = addDecimal(total, change.signed);
    if (change.type === 'topup') topups = addDecimal(topups, change.amount);
    if (change.type === 'grant') grants = addDecimal(grants, change.amount);
    if (change.type === 'expiry') expiries = addDecimal(expiries, change.amount);
    if (change.type === 'refund') refunds = addDecimal(refunds, change.amount);
    count += 1;
  }
  return { total, topups, grants, expiries, refunds, count, uncertain };
}

/**
 * Positive difference `left - right`, or null when either side is missing.
 */
function positiveDifference(left: Decimal | null, right: Decimal | null): Decimal | null {
  if (!left || !right) return null;
  const difference = subtract(left, right);
  return difference.units > 0n ? difference : null;
}

/**
 * Known future `expiresAt` dates for grants/top-ups. Showing them next to a
 * forecast never promises that the full balance stays available.
 */
function collectExpiries(transactions: LedgerTransaction[] | undefined, accountId: string, currency: string, now: number): BalanceExpiry[] {
  const rows: BalanceExpiry[] = [];
  for (const tx of activeRows(Array.isArray(transactions) ? transactions : [])) {
    if (!tx || tx.accountId !== accountId) continue;
    if (tx.state !== 'posted') continue;
    if (tx.type !== 'topup' && tx.type !== 'grant') continue;
    const creditCurrency = text(tx.credit?.currency || currency).toUpperCase();
    if (creditCurrency !== currency) continue;
    const moment = tx.expiresAt;
    if (!moment || typeof moment !== 'object') continue;
    const at = instantMs(moment);
    let expiresAt: string | null = null;
    let date: string | null = null;
    let precision = 'instant';
    let nearMs = NaN;
    if (Number.isFinite(at)) {
      expiresAt = iso(at);
      nearMs = at;
    } else if (text(moment.date)) {
      date = moment.date as string;
      precision = moment.precision === 'hour' ? 'hour' : 'day';
      // Display only: an unplaceable zone falls back to the naive wall clock so
      // a past expiry is still hidden instead of being listed as future.
      const interval = momentInterval(moment) || observationInterval(moment);
      nearMs = interval ? interval.end : NaN;
    }
    if (Number.isFinite(nearMs) && nearMs <= now) continue;
    const value = amount(tx.credit);
    rows.push({
      at: expiresAt,
      date,
      precision,
      amount: value ? formatDecimal(value) : null,
      currency,
    });
  }
  return rows.sort((a, b) => (a.at || a.date || '').localeCompare(b.at || b.date || ''));
}

/**
 * @param point baseline candidate
 */
function buildWindow(point: BalancePoint | null, endPoint: BalancePoint, points: BalancePoint[], changes: WalletChange[], window: WindowSpec, now: number): BalanceWindow {
  const endMs = endPoint.ms;
  const startTarget = endMs - window.requestedMs;
  const tolerance = Math.max(DAY_MS, window.requestedMs * BALANCE_FORECAST_BOUNDARY_TOLERANCE_RATIO);
  const before = point && point.ms <= startTarget ? point : null;
  const boundaryHit = Boolean(before) && startTarget - (before as BalancePoint).ms <= tolerance;
  let baseline = boundaryHit ? before : null;
  // Each scenario resolves its own baseline. A sparse series can cover the
  // 30-day period (reported as `shorter`) while the 7-day scenario has no
  // boundary point (`insufficient_window`); a scenario is never silently
  // widened or borrowed from the other one.
  if (!baseline) {
    const after = points.find((candidate) => candidate.ms > startTarget && candidate.ms < endMs);
    if (after) baseline = after;
  }
  if (!baseline) {
    return {
      id: window.id,
      requestedMs: window.requestedMs,
      actualMs: null,
      from: null,
      to: iso(endMs),
      coverage: 'none',
      status: 'insufficient_window',
      reasons: ['no_window_start'],
      spend: null,
      spendPerDay: null,
      balance: formatDecimal(endPoint.total),
      exhaustsAt: null,
      remainingMs: null,
      flows: null,
      unexplainedGrantedDrop: null,
      unexplainedGrantInflow: null,
      unexplainedTopUpIncrease: null,
      snapshots: 0,
      largestGapMs: null,
    };
  }
  const elapsedMs = endMs - baseline.ms;
  if (elapsedMs < BALANCE_FORECAST_MIN_SPAN_MS) {
    return {
      id: window.id,
      requestedMs: window.requestedMs,
      actualMs: elapsedMs,
      from: iso(baseline.ms),
      to: iso(endMs),
      coverage: 'short',
      status: 'insufficient_window',
      reasons: ['span_below_24h'],
      spend: null,
      spendPerDay: null,
      balance: formatDecimal(endPoint.total),
      exhaustsAt: null,
      remainingMs: null,
      flows: null,
      unexplainedGrantedDrop: null,
      unexplainedGrantInflow: null,
      unexplainedTopUpIncrease: null,
      snapshots: 0,
      largestGapMs: null,
    };
  }
  const flows = sumWindowChanges(changes, baseline.ms, endMs);
  const spend = addDecimal(subtract(baseline.total, endPoint.total), flows.total);
  const spendNumber = toNumber(spend);
  const elapsedDays = elapsedMs / DAY_MS;
  // Keep the exact rate for the runway: rounding a tiny consumption rate to a
  // handful of decimals would turn a valid (long) runway into a zero rate.
  const exactSpendPerDay = elapsedDays > 0 ? spendNumber / elapsedDays : null;
  const spendPerDay = exactSpendPerDay == null ? null : roundNumber(exactSpendPerDay, 12);

  const reasons: string[] = [];
  // The measured period may be shorter (no point at the window start) but a
  // point older than the tolerated boundary makes the window longer, not a
  // 7/30-day scenario.
  if (baseline.ms < startTarget && !boundaryHit) reasons.push('window_start_too_old');
  if (baseline.boundaryUncertain || endPoint.boundaryUncertain) reasons.push('uncertain_snapshot_boundary');
  if (baseline.completeness !== 'complete' || endPoint.completeness !== 'complete') reasons.push('incomplete_snapshot');
  if (flows.uncertain) reasons.push('uncertain_flow_boundary');

  const grantedDrop = positiveDifference(baseline.granted, endPoint.granted);
  const toppedUpIncrease = positiveDifference(endPoint.toppedUp, baseline.toppedUp);
  // Recorded expiries explain a granted drop. Any residual drop could be
  // consumption or an unrecorded expiry, so it stays an uncertain cause instead
  // of being presented as certain spend.
  const unexplainedGrantedDrop = grantedDrop ? positiveDifference(grantedDrop, flows.expiries) : null;
  const unexplainedTopUpIncrease = toppedUpIncrease
    ? positiveDifference(toppedUpIncrease, flows.topups)
    : null;
  // A booked grant that never shows up as a rise in the granted balance is
  // ambiguous: the credit may have been consumed OR expired without a booked
  // expiry. Adding it to the wallet-change sum silently presents that as
  // certain API spend, so the window needs reconciliation instead.
  const unexplainedGrantInflow = flows.grants.units > 0n
    ? positiveDifference(
      addDecimal(baseline.granted || { units: 0n, scale: 0 }, flows.grants),
      addDecimal(endPoint.granted || { units: 0n, scale: 0 }, flows.expiries),
    )
    : null;
  if (unexplainedGrantedDrop) reasons.push('unknown_expiry');
  if (unexplainedGrantInflow) reasons.push('uncertain_grant_inflow');
  if (unexplainedTopUpIncrease) reasons.push('missing_topup');

  const balanceNumber = toNumber(endPoint.total);
  let exhaustsAt: string | null = null;
  let remainingMs: number | null = null;
  if (balanceNumber <= 0) {
    remainingMs = 0;
    exhaustsAt = iso(now);
  } else if (exactSpendPerDay != null && exactSpendPerDay > 0) {
    const days = balanceNumber / exactSpendPerDay;
    const exhaustMs = endMs + days * DAY_MS;
    if (Number.isFinite(exhaustMs) && Math.abs(exhaustMs) <= 8.64e15) {
      exhaustsAt = iso(exhaustMs);
      remainingMs = Math.max(0, exhaustMs - now);
    }
  }

  const inWindow = points.filter((candidate) => candidate.ms >= baseline.ms && candidate.ms <= endMs);
  let largestGapMs = 0;
  for (let i = 1; i < inWindow.length; i += 1) {
    largestGapMs = Math.max(largestGapMs, inWindow[i].ms - inWindow[i - 1].ms);
  }

  let status = 'ok';
  // A missing top-up explains a negative difference; that is a reconciliation
  // problem, not a provably impossible balance movement.
  if (spendNumber < 0 && !reasons.includes('missing_topup')) status = 'inconsistent';
  else if (reasons.length > 0) status = 'needs_reconciliation';
  else if (spendNumber === 0) status = 'zero_rate';

  return {
    id: window.id,
    requestedMs: window.requestedMs,
    actualMs: elapsedMs,
    from: iso(baseline.ms),
    to: iso(endMs),
    coverage: boundaryHit ? 'full' : baseline.ms > startTarget ? 'shorter' : 'longer',
    status,
    reasons,
    spend: formatDecimal(spend),
    spendPerDay,
    balance: formatDecimal(endPoint.total),
    exhaustsAt,
    remainingMs,
    flows: {
      total: formatDecimal(flows.total),
      topups: formatDecimal(flows.topups),
      grants: formatDecimal(flows.grants),
      expiries: formatDecimal(flows.expiries),
      refunds: formatDecimal(flows.refunds),
      count: flows.count,
    },
    unexplainedGrantedDrop: unexplainedGrantedDrop ? formatDecimal(unexplainedGrantedDrop) : null,
    unexplainedGrantInflow: unexplainedGrantInflow ? formatDecimal(unexplainedGrantInflow) : null,
    unexplainedTopUpIncrease: unexplainedTopUpIncrease ? formatDecimal(unexplainedTopUpIncrease) : null,
    snapshots: inWindow.length,
    largestGapMs,
  };
}

/**
 * Forecast for one `{account, currency, series}` group.
 */
export interface BalanceForecastInput {
  account?: Partial<LedgerAccount>;
  currency?: string;
  series?: string;
  snapshots?: LedgerSnapshot[];
  transactions?: LedgerTransaction[];
  now?: unknown;
  freshnessMs?: unknown;
}

export function buildBalanceForecast(input: BalanceForecastInput = {}): BalanceForecast {
  const now = toNow(input.now);
  const freshnessMs = Number.isFinite(Number(input.freshnessMs)) && Number(input.freshnessMs) > 0
    ? Number(input.freshnessMs)
    : BALANCE_FORECAST_FRESHNESS_MS;
  const account: Partial<LedgerAccount> = input.account || {};
  const accountId = text(account.id);
  const currency = text(input.currency || account.walletCurrency).toUpperCase();
  const series = text(input.series) || 'default';
  const base = {
    accountId,
    accountLabel: text(account.label) || accountId,
    walletCurrency: text(account.walletCurrency).toUpperCase(),
    currency,
    series,
    updatedAt: iso(now),
    freshnessMs,
  };

  const rows = activeRows(Array.isArray(input.snapshots) ? input.snapshots : [])
    .filter((row) => row && row.accountId === accountId
      && text(row.currency).toUpperCase() === currency
      && (text(row.series) || 'default') === series)
    .sort(compareObservations);

  if (rows.length === 0) {
    return {
      ...base,
      status: 'no_data',
      reasons: ['no_snapshots'],
      latestObservedAt: null,
      latestBalance: null,
      latestGrantedBalance: null,
      latestToppedUpBalance: null,
      isAvailable: null,
      stale: true,
      windows: Object.fromEntries(BALANCE_FORECAST_WINDOWS.map((window) => [window.id, null])),
      exhaustion: null,
      remainingMs: null,
      balanceDropUncertain: false,
      expiries: [],
      rateChange: null,
    };
  }

  const latest = rows[rows.length - 1];
  const isUsableRow = (row: LedgerSnapshot) => Number.isFinite(instantMs(row.observedAt))
    && Boolean(amount(row.totalBalance))
    && instantMs(row.observedAt) <= now;
  // Without a trustworthy current endpoint no forecast is produced: a newer
  // imprecise/impossible/future reading cannot anchor the scenario. A later
  // same-day imprecise reading supersedes a precise one even when its interval
  // starts before that reading, so the endpoint is invalidated explicitly.
  const usableRows = rows.filter(isUsableRow);
  const endRow = usableRows.length > 0 ? usableRows[usableRows.length - 1] : null;
  let endpointInvalid = !endRow || latest !== endRow;
  if (!endpointInvalid) {
    const endMs = instantMs((endRow as LedgerSnapshot).observedAt);
    const endRecordedAt = text((endRow as LedgerSnapshot).recordedAt);
    for (const row of rows) {
      if (row === endRow) continue;
      const interval = observationInterval(row.observedAt);
      if (!interval?.imprecise) continue;
      // An unplaceable reading can fall anywhere in its possible range; any
      // possible overlap makes the precise endpoint stale, so a naive UTC
      // interval must never be the proof that it cannot.
      if (!(interval.possibleStart <= endMs && interval.possibleEnd > endMs)) continue;
      const recordedAt = text(row.recordedAt);
      if (recordedAt && endRecordedAt && recordedAt < endRecordedAt) continue;
      endpointInvalid = true;
      break;
    }
  }

  const points: BalancePoint[] = [];
  for (const row of rows) {
    if (!isUsableRow(row)) continue;
    points.push({
      ms: instantMs(row.observedAt),
      total: amount(row.totalBalance) as Decimal,
      granted: amount(row.grantedBalance),
      toppedUp: amount(row.toppedUpBalance),
      completeness: text(row.completeness) || 'unknown',
      boundaryUncertain: row.boundaryUncertain === true,
      isAvailable: typeof row.isAvailable === 'boolean' ? row.isAvailable : null,
    });
  }
  // Keep one point per instant (the last recorded version wins).
  const unique = new Map<number, BalancePoint>();
  for (const point of points) unique.set(point.ms, point);
  const ordered = [...unique.values()].sort((a, b) => a.ms - b.ms);
  const endPoint = endpointInvalid ? null : ordered[ordered.length - 1];

  const windows: Record<string, BalanceWindow | null> = Object.fromEntries(BALANCE_FORECAST_WINDOWS.map((window) => [window.id, null]));
  if (endPoint) {
    const changes = walletChanges(input.transactions, accountId, currency);
    for (const window of BALANCE_FORECAST_WINDOWS) {
      windows[window.id] = buildWindow(
        findBaseline(ordered, endPoint, window),
        endPoint,
        ordered,
        changes,
        window,
        now,
      );
    }
  }

  const usable = Object.values(windows).filter((window) => window && window.spend != null) as BalanceWindow[];
  const reasons = new Set<string>();
  if (endpointInvalid) reasons.add('uncertain_endpoint');
  for (const window of Object.values(windows)) {
    if (window?.status !== 'needs_reconciliation') continue;
    for (const reason of window.reasons) reasons.add(reason);
  }
  const stale = !endPoint || now - endPoint.ms > freshnessMs;
  const balance = endPoint ? toNumber(endPoint.total) : null;
  // A negative spend that a recorded/absent top-up cannot explain is an
  // inconsistency. It must surface even when a DIFFERENT window happens to have
  // a `missing_topup` reason: the reason is per window, so aggregating on its
  // mere presence hid an inconsistent scenario behind a reconcilable one.
  const anyInconsistent = usable.some((window) => window.status === 'inconsistent');
  const allZero = usable.length > 0 && usable.every((window) => Number(window.spend) === 0);

  const rateChange = detectRateChange(windows);
  let status = 'ok';
  if (anyInconsistent) status = 'inconsistent';
  else if (reasons.size > 0) status = 'needs_reconciliation';
  else if (ordered.length < 2) status = 'no_data';
  else if (usable.length === 0) status = 'insufficient_window';
  else if (stale) status = 'stale';
  else if (balance != null && balance <= 0) status = 'no_funds';
  else if (allZero) status = 'zero_rate';
  else if (rateChange) status = 'rate_change';

  const primary = pickPrimaryWindow(windows);
  const remainingMs = primary?.remainingMs ?? (balance != null && balance <= 0 ? 0 : null);

  return {
    ...base,
    status,
    reasons: [...reasons],
    latestObservedAt: endPoint ? iso(endPoint.ms) : null,
    latestBalance: endPoint ? formatDecimal(endPoint.total) : null,
    latestGrantedBalance: endPoint?.granted ? formatDecimal(endPoint.granted) : null,
    latestToppedUpBalance: endPoint?.toppedUp ? formatDecimal(endPoint.toppedUp) : null,
    isAvailable: endPoint?.isAvailable ?? null,
    stale,
    windows,
    exhaustion: primary
      ? {
        windowId: primary.id,
        spendPerDay: primary.spendPerDay,
        exhaustsAt: primary.exhaustsAt,
        remainingMs: primary.remainingMs,
      }
      : null,
    remainingMs,
    balanceDropUncertain: reasons.has('unknown_expiry') || reasons.has('uncertain_grant_inflow'),
    expiries: collectExpiries(input.transactions, accountId, currency, now),
    rateChange,
  };
}

/**
 * Latest point at or before a window start, otherwise the earliest point after
 * it (a shorter actual period is reported instead of pretending a gap is zero).
 */
function findBaseline(points: BalancePoint[], endPoint: BalancePoint, window: WindowSpec): BalancePoint | null {
  const startTarget = endPoint.ms - window.requestedMs;
  const before = points.filter((point) => point.ms <= startTarget).at(-1) || null;
  const tolerance = Math.max(DAY_MS, window.requestedMs * BALANCE_FORECAST_BOUNDARY_TOLERANCE_RATIO);
  if (before && startTarget - before.ms <= tolerance) return before;
  const after = points.find((point) => point.ms > startTarget && point.ms < endPoint.ms);
  return after || before;
}

function detectRateChange(windows: Record<string, BalanceWindow | null>): RateChange | null {
  const short = windows['7d'];
  const long = windows['30d'];
  if (!short || !long) return null;
  if (!((short.spendPerDay as number) > 0) || !((long.spendPerDay as number) > 0)) return null;
  if (short.status === 'inconsistent' || long.status === 'inconsistent') return null;
  const factor = (short.spendPerDay as number) / (long.spendPerDay as number);
  if (!Number.isFinite(factor)) return null;
  if (factor >= BALANCE_FORECAST_RATE_CHANGE_FACTOR || factor <= 1 / BALANCE_FORECAST_RATE_CHANGE_FACTOR) {
    return {
      detector: '7d-vs-30d',
      shortPerDay: short.spendPerDay as number,
      longPerDay: long.spendPerDay as number,
      factor: roundNumber(factor, 3),
    };
  }
  return null;
}

/**
 * Prefer the shorter scenario (7 days) when it produced a usable rate.
 */
function pickPrimaryWindow(windows: Record<string, BalanceWindow | null>): BalanceWindow | null {
  for (const { id } of BALANCE_FORECAST_WINDOWS) {
    const window = windows[id];
    if (window && window.exhaustsAt) return window;
  }
  return null;
}

/**
 * Forecasts every account/currency/series group present in a ledger view.
 */
export function buildBalanceForecasts(input: Partial<{ accounts: LedgerAccount[], snapshots: LedgerSnapshot[], transactions: LedgerTransaction[], now: unknown, freshnessMs: unknown }> = {}): BalanceForecast[] {
  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  const rows = activeRows(Array.isArray(input.snapshots) ? input.snapshots : []);
  const forecasts: BalanceForecast[] = [];
  for (const account of accounts) {
    if (!account || !text(account.id)) continue;
    const groups = new Map<string, { currency: string; series: string }>();
    for (const row of rows) {
      if (!row || row.accountId !== account.id) continue;
      const currency = text(row.currency).toUpperCase();
      if (!currency) continue;
      const key = `${currency}\u0000${text(row.series) || 'default'}`;
      if (!groups.has(key)) groups.set(key, { currency, series: text(row.series) || 'default' });
    }
    if (groups.size === 0) {
      groups.set(`${text(account.walletCurrency).toUpperCase()}\u0000default`, {
        currency: text(account.walletCurrency).toUpperCase() || 'UNKNOWN',
        series: 'default',
      });
    }
    for (const group of groups.values()) {
      forecasts.push(buildBalanceForecast({
        account,
        currency: group.currency,
        series: group.series,
        snapshots: input.snapshots,
        transactions: input.transactions,
        now: input.now,
        freshnessMs: input.freshnessMs,
      }));
    }
  }
  return forecasts.sort((a, b) =>
    a.accountLabel.localeCompare(b.accountLabel)
    || a.currency.localeCompare(b.currency)
    || a.series.localeCompare(b.series));
}

/**
 * Stable state key for one forecast + threshold crossing.
 */
export function balanceAlertKey(forecast: ForecastLike | null | undefined, thresholdMs: number = BALANCE_ALERT_THRESHOLD_MS) {
  return `${BALANCE_ALERT_KIND}:${text(forecast?.accountId)}:${text(forecast?.currency)}:${text(forecast?.series)}:${thresholdMs}`;
}

/**
 * Forecasts that may raise or clear an alert. A stale, inconsistent or
 * unreconciled forecast is never presented as a certain crossing.
 */
export function isVerifiedBalanceForecast(forecast: ForecastLike | null | undefined): boolean {
  const f = forecast as ForecastLike;
  return Boolean(forecast)
    && ['ok', 'rate_change', 'no_funds'].includes(text(f.status))
    && f.remainingMs != null
    && Number.isFinite(Number(f.remainingMs));
}

/**
 * Pure alert state machine with hysteresis. `previous` is the persisted entry
 * (`{ active, crossedAt, remainingMs }`) or null.
 */
export function evaluateBalanceForecastAlert(forecast: ForecastLike | null | undefined, previous: AlertEntry | null = null, options: Partial<{ thresholdMs?: unknown, hysteresisRatio?: unknown, now?: unknown }> = {}): BalanceAlertEvaluation {
  const thresholdMs = Number.isFinite(Number(options.thresholdMs)) && Number(options.thresholdMs) > 0
    ? Number(options.thresholdMs)
    : BALANCE_ALERT_THRESHOLD_MS;
  const ratio = Number.isFinite(Number(options.hysteresisRatio)) && Number(options.hysteresisRatio) >= 0
    ? Number(options.hysteresisRatio)
    : BALANCE_ALERT_HYSTERESIS_RATIO;
  const exitThresholdMs = thresholdMs * (1 + ratio);
  const now = toNow(options.now);
  const key = balanceAlertKey(forecast, thresholdMs);
  const previousActive = previous?.active === true;
  const remainingMs = forecast?.remainingMs == null ? NaN : Number(forecast.remainingMs);
  const metric = Number.isFinite(remainingMs) ? remainingMs : null;

  if (!isVerifiedBalanceForecast(forecast)) {
    // Hold the current arm state: an unreadable forecast can neither raise nor
    // clear a crossing.
    return { key, metric, thresholdMs, exitThresholdMs, active: previousActive, notify: false, reset: false, state: previousActive ? previous : null };
  }

  if (previousActive) {
    if (remainingMs > exitThresholdMs) {
      return { key, metric, thresholdMs, exitThresholdMs, active: false, notify: false, reset: true, state: null };
    }
    return {
      key,
      metric,
      thresholdMs,
      exitThresholdMs,
      active: true,
      notify: false,
      reset: false,
      state: {
        active: true,
        crossedAt: text(previous?.crossedAt) || iso(now),
        remainingMs,
        thresholdMs,
        updatedAt: iso(now),
      },
    };
  }

  if (remainingMs <= thresholdMs) {
    return {
      key,
      metric,
      thresholdMs,
      exitThresholdMs,
      active: true,
      notify: true,
      reset: false,
      state: { active: true, crossedAt: iso(now), remainingMs, thresholdMs, updatedAt: iso(now) },
    };
  }
  return { key, metric, thresholdMs, exitThresholdMs, active: false, notify: false, reset: false, state: null };
}

/**
 * Generic web-push payload. No amounts, transactions or provider identifiers
 * beyond the currency label; the tap target is the Usage settings page.
 *
 * `data.eventId` is the stable crossing identity (`<alertKey>:<crossedAt>`), so
 * the service worker suppresses a re-alert when a retry re-sends the same push.
 */
export function buildBalanceAlertPushPayload(forecast: ForecastLike | null | undefined, options: Partial<{ thresholdMs?: unknown, crossedAt?: unknown, now?: unknown }> = {}): BalanceAlertPushPayload {
  const thresholdMs = Number.isFinite(Number(options.thresholdMs)) && Number(options.thresholdMs) > 0
    ? Number(options.thresholdMs)
    : BALANCE_ALERT_THRESHOLD_MS;
  const key = balanceAlertKey(forecast, thresholdMs);
  const crossedAt = text(options.crossedAt) || iso(toNow(options.now));
  const remainingMs = forecast?.remainingMs == null ? NaN : Number(forecast.remainingMs);
  const currency = text(forecast?.currency) || 'credit';
  let body = `The estimated ${currency} balance runway crossed the ${Math.round(thresholdMs / (60 * 60 * 1000))} h threshold.`;
  if (Number.isFinite(remainingMs) && remainingMs <= 0) {
    body = `The estimated ${currency} balance runway is exhausted or already elapsed.`;
  } else if (Number.isFinite(remainingMs)) {
    const days = remainingMs / DAY_MS;
    const human = days >= 1 ? `about ${Math.max(1, Math.round(days))} day(s)` : 'less than a day';
    body = `The estimated ${currency} balance runway is ${human}.`;
  }
  return {
    title: 'Cretli — balance forecast',
    body,
    tag: `${BALANCE_ALERT_KIND}-${text(forecast?.accountId)}-${currency}`,
    data: {
      type: BALANCE_ALERT_KIND,
      key,
      currency,
      series: text(forecast?.series),
      thresholdMs,
      url: BALANCE_ALERT_ACTION_URL,
      at: Date.now(),
      eventId: `${key}:${crossedAt}`,
    },
  };
}

/**
 * In-app notification-centre row for a crossing. It reuses the push text so the
 * UI alert and the optional push stay generic (currency + runway only). The
 * fingerprint carries the crossing timestamp, so one crossing produces one row
 * while a later re-crossing after a verified recovery is a new occurrence.
 */
export function buildBalanceAlertNotification(forecast: ForecastLike | null | undefined, options: Partial<{ thresholdMs?: unknown, crossedAt?: unknown, now?: unknown }> = {}): BalanceAlertNotification {
  const thresholdMs = Number.isFinite(Number(options.thresholdMs)) && Number(options.thresholdMs) > 0
    ? Number(options.thresholdMs)
    : BALANCE_ALERT_THRESHOLD_MS;
  const payload = buildBalanceAlertPushPayload(forecast, { thresholdMs });
  const crossedAt = text(options.crossedAt) || iso(toNow(options.now));
  return {
    category: 'system',
    severity: 'warning',
    title: payload.title.replace(/^Cretli — /, ''),
    body: payload.body,
    actionUrl: BALANCE_ALERT_ACTION_URL,
    fingerprint: `${balanceAlertKey(forecast, thresholdMs)}:${crossedAt}`,
  };
}

export function resolveBalanceAlertStatePath(dataDir?: unknown): string {
  const root = text(dataDir) || resolveDataPath();
  return path.join(root, 'usage', 'balance-alert-state.json');
}

export function readBalanceAlertState(dataDir?: unknown): { version: number; alerts: Record<string, AlertEntry> } {
  const file = resolveBalanceAlertStatePath(dataDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const alerts = parsed && typeof parsed === 'object' && parsed.alerts
      && typeof parsed.alerts === 'object' && !Array.isArray(parsed.alerts)
      ? parsed.alerts
      : {};
    return { version: 1, alerts };
  } catch {
    return { version: 1, alerts: {} };
  }
}

/**
 * @returns true when the state was persisted
 */
export function writeBalanceAlertState(dataDir: unknown, state: AlertState): boolean {
  try {
    writeJsonAtomic(resolveBalanceAlertStatePath(dataDir), state);
    return true;
  } catch (error) {
    console.warn('[balance-forecast] alert state write failed:', (error as Error | undefined)?.message || error);
    return false;
  }
}

/**
 * Keep only recent fingerprints and cap the map size. An active crossing is
 * never pruned or evicted: without a verified hysteresis recovery it must stay
 * armed, otherwise the same crossing would notify again.
 */
export function pruneBalanceAlertState(state: AlertState | null | undefined, now: unknown, options: Partial<{ maxAgeMs?: unknown, maxKeys?: unknown }> = {}): { version: number; alerts: Record<string, AlertEntry> } {
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : BALANCE_ALERT_STATE_MAX_AGE_MS;
  const maxKeys = Number.isFinite(Number(options.maxKeys)) ? Number(options.maxKeys) : BALANCE_ALERT_STATE_MAX_KEYS;
  const reference = toNow(now);
  const ageOf = (row: AlertEntry | undefined) => {
    const at = Date.parse(text(row?.updatedAt) || text(row?.crossedAt));
    return Number.isFinite(at) ? reference - at : 0;
  };
  const active: Array<[string, AlertEntry]> = [];
  const inactive: Array<[string, AlertEntry]> = [];
  for (const [key, row] of Object.entries(state?.alerts && typeof state.alerts === 'object' ? state.alerts : {})) {
    if (row?.active === true) {
      active.push([key, row]);
      continue;
    }
    if (ageOf(row) <= maxAgeMs) inactive.push([key, row]);
  }
  // Newest inactive entries survive the cap; active crossings always stay.
  inactive.sort((left, right) => ageOf(left[1]) - ageOf(right[1]));
  const keepInactive = Math.max(0, maxKeys - active.length);
  return { version: 1, alerts: Object.fromEntries([...active, ...inactive.slice(0, keepInactive)]) };
}

/**
 * Read the ledger and return forecasts with the persisted UI alert state.
 */
export function readBalanceForecastReport(input: Partial<{ dataDir?: unknown, filePath?: string, now?: unknown, thresholdMs?: unknown, freshnessMs?: unknown }> = {}): { now: string; revision: number; forecasts: BalanceForecast[]; alerts: Array<Record<string, unknown>> } {
  const now = toNow(input.now);
  const ledgerPath = text(input.filePath)
    || (text(input.dataDir) ? path.join(text(input.dataDir), 'credit-ledger.json') : resolveDataPath('credit-ledger.json'));
  const doc = loadLedger(ledgerPath);
  const forecasts = buildBalanceForecasts({
    accounts: doc.accounts,
    snapshots: doc.snapshots,
    transactions: doc.transactions,
    now,
    freshnessMs: input.freshnessMs,
  });
  const thresholdMs = Number.isFinite(Number(input.thresholdMs)) && Number(input.thresholdMs) > 0
    ? Number(input.thresholdMs)
    : BALANCE_ALERT_THRESHOLD_MS;
  const state = readBalanceAlertState(input.dataDir);
  const alerts: Array<Record<string, unknown>> = [];
  for (const forecast of forecasts) {
    const key = balanceAlertKey(forecast, thresholdMs);
    const entry = state.alerts[key] || null;
    forecast.alert = entry
      ? {
        active: entry.active === true,
        // A reservation whose delivery never completed stays visibly pending so
        // a reader never mistakes it for a delivered crossing.
        deliveryPending: entry.deliveryPending === true,
        crossedAt: text(entry.crossedAt) || null,
        remainingMs: Number.isFinite(Number(entry.remainingMs)) ? Number(entry.remainingMs) : null,
        thresholdMs,
      }
      : null;
    if (entry) alerts.push({ key, ...(forecast.alert as ForecastAlertSummary), accountId: forecast.accountId, currency: forecast.currency, series: forecast.series });
  }
  return { now: iso(now), revision: doc.revision, forecasts, alerts };
}

/**
 * Default push delivery through the existing broadcast path (lazy import so
 * pure forecast tests never load `push.js`).
 */
async function defaultBroadcastPush(payload: BalanceAlertPushPayload): Promise<unknown> {
  const { broadcastPush } = await import('../push.js');
  return broadcastPush(payload);
}

/**
 * Default in-app delivery through the existing notification centre (lazy import
 * for the same reason as push). This is what makes a crossing visible in the UI
 * even when web push is unavailable or disabled on every device.
 */
async function defaultPublishNotification(notification: BalanceAlertNotification, dataDir?: unknown): Promise<unknown> {
  const { publishNotification } = await import('../notifications/notification-store.ts');
  const root = text(dataDir);
  const options = root ? { storePath: path.join(root, 'notification-center.json') } : {};
  return publishNotification(notification, options);
}

/**
 * In-process serialization of alert dispatch per alert-state file. Two
 * overlapping maintenance passes must not both read an empty state and send the
 * same crossing.
 */
const alertDispatchChains = new Map<string, Promise<void>>();

async function withAlertDispatchLock<T>(dataDir: unknown, task: () => Promise<T>): Promise<T> {
  const key = resolveBalanceAlertStatePath(dataDir);
  const previous = alertDispatchChains.get(key) || Promise.resolve();
  const run = previous.then(() => task(), () => task());
  const guard = run.then(() => undefined, () => undefined);
  alertDispatchChains.set(key, guard);
  try {
    return await run;
  } finally {
    if (alertDispatchChains.get(key) === guard) alertDispatchChains.delete(key);
  }
}

/**
 * A delivery result counts only when the channel acknowledges something was
 * sent. A resolved `{ sent: 0 }` broadcast means no device received the push,
 * so the crossing must stay retryable instead of being recorded as delivered.
 */
function isDeliveryAcknowledged(rawResult: unknown): boolean {
  if (rawResult == null || typeof rawResult !== 'object') return true;
  const result = rawResult as { ok?: unknown; sent?: unknown; created?: unknown; id?: unknown };
  if (result.ok === false) return false;
  if (Object.prototype.hasOwnProperty.call(result, 'sent')) return Number(result.sent) > 0;
  if (Object.prototype.hasOwnProperty.call(result, 'created')) {
    // `publishNotification` returns `{ created:false, id:null, revision }` for
    // rejected input, so a revision alone proves nothing was published. Only a
    // nonempty existing notification id is a genuine duplicate that is already
    // visible in the UI.
    const hasExistingId = typeof result.id === 'string' && result.id.trim() !== '';
    if (result.created === false) return hasExistingId;
    return result.created === true || hasExistingId;
  }
  return true;
}

/**
 * Persist alert state or fail loudly: a swallowed write would leave a crossing
 * both unrecorded (re-sent) and undelivered. When a cleanup write fails, the
 * durable delivery reservation written before delivery stays in place, so the
 * crossing remains retryable.
 */
function persistBalanceAlertState(dataDir: unknown, state: AlertState, writeState: (dataDir: unknown, state: AlertState) => boolean = writeBalanceAlertState): void {
  if (!writeState(dataDir, state)) {
    throw new Error('balance_alert_state_unwritable');
  }
}

/** A crossing reserved for delivery during one dispatch pass. */
interface PendingAlert {
  key: string;
  forecast: BalanceForecast;
  state: AlertEntry;
  pushDelivered: boolean;
  uiDelivered: boolean;
  uiId: string | null;
}

/**
 * Evaluate every forecast, apply hysteresis/dedup and deliver NEW crossings to
 * the in-app notification centre and, optionally, as a push.
 *
 * Dispatch is serialized per state file and each crossing is reserved durably
 * before any channel is called, so overlapping or restarted maintenance passes
 * cannot deliver the same crossing twice. The reservation records which channel
 * already acknowledged delivery (`pushDelivered` / `uiDelivered`), so a retry
 * after a failed cleanup write calls only the still-undelivered channel and the
 * user is never alerted twice for one crossing. A reservation whose delivery
 * never completed (`deliveryPending`) is retried with its original `crossedAt`,
 * which keeps the notification fingerprint and the push `eventId` stable: a
 * retry updates the same UI occurrence instead of creating a duplicate.
 * A crossing that no channel acknowledged keeps its reservation for the next
 * tick instead of being silently dropped. A pending occurrence is never sent
 * from an unverified forecast (stale, inconsistent or needs reconciliation):
 * delivery is deferred until the forecast verifies again.
 */
export async function dispatchBalanceForecastAlerts(input: Partial<{ dataDir?: unknown, filePath?: string, now?: unknown, thresholdMs?: unknown, notify?: (payload: BalanceAlertPushPayload) => unknown, publishNotification?: (notification: BalanceAlertNotification, dataDir?: unknown) => unknown, writeState?: (dataDir: unknown, state: AlertState) => boolean }> = {}): Promise<{ evaluated: number; notified: string[]; alerts: Array<Record<string, unknown>> }> {
  const now = toNow(input.now);
  const thresholdMs = Number.isFinite(Number(input.thresholdMs)) && Number(input.thresholdMs) > 0
    ? Number(input.thresholdMs)
    : BALANCE_ALERT_THRESHOLD_MS;
  const writeState = typeof input.writeState === 'function' ? input.writeState : writeBalanceAlertState;
  return withAlertDispatchLock(input.dataDir, async () => {
    const report = readBalanceForecastReport({ ...input, now, thresholdMs });
    const state = readBalanceAlertState(input.dataDir);
    const notify = typeof input.notify === 'function' ? input.notify : defaultBroadcastPush;
    const publish = typeof input.publishNotification === 'function'
      ? input.publishNotification
      : defaultPublishNotification;
    const pending: PendingAlert[] = [];
    for (const forecast of report.forecasts) {
      const key = balanceAlertKey(forecast, thresholdMs);
      const previous = state.alerts[key] || null;
      const evaluation = evaluateBalanceForecastAlert(forecast, previous, { thresholdMs, now });
      if (evaluation.reset) {
        delete state.alerts[key];
        continue;
      }
      // A durable reservation that never reached a channel (crash after the
      // reservation write, or a failed cleanup write) is still pending.
      const retryPending = previous?.deliveryPending === true && previous?.active === true;
      if ((evaluation.notify || retryPending) && evaluation.state) {
        // Reserve before sending; the reservation is finalized below. The state
        // machine keeps the original `crossedAt` on a retry, and the per-channel
        // flags record what was already acknowledged before a retry.
        const pushDelivered = retryPending && previous?.pushDelivered === true;
        const uiDelivered = retryPending && previous?.uiDelivered === true;
        const uiId = retryPending && typeof previous?.uiId === 'string' ? previous.uiId : null;
        pending.push({
          key,
          forecast,
          state: evaluation.state,
          pushDelivered,
          uiDelivered,
          uiId,
        });
        state.alerts[key] = {
          ...evaluation.state,
          deliveryPending: true,
          pushDelivered,
          uiDelivered,
          ...(uiId ? { uiId } : {}),
        };
        continue;
      }
      if (evaluation.state?.active) state.alerts[key] = evaluation.state;
    }
    persistBalanceAlertState(input.dataDir, pruneBalanceAlertState(state, now), writeState);

    const notified: string[] = [];
    for (const item of pending) {
      // Defer an occurrence while the forecast is unverified: the ordinary path
      // would reject this forecast, so a pending retry must not deliver a
      // runway/exhaustion the current snapshot data does not support. Keeping
      // the reservation pending means it is delivered once it verifies again.
      if (!isVerifiedBalanceForecast(item.forecast)) continue;
      let delivered = item.pushDelivered || item.uiDelivered;
      if (!item.pushDelivered) {
        try {
          const result = await notify(buildBalanceAlertPushPayload(item.forecast, {
            thresholdMs,
            crossedAt: item.state.crossedAt,
          }));
          if (isDeliveryAcknowledged(result)) {
            item.pushDelivered = true;
            delivered = true;
          } else {
            console.warn('[balance-forecast] alert push not delivered:', JSON.stringify(result));
          }
        } catch (error) {
          console.warn('[balance-forecast] alert push failed:', (error as Error | undefined)?.message || error);
        }
      }
      if (!item.uiDelivered) {
        try {
          const result = await publish(
            buildBalanceAlertNotification(item.forecast, { thresholdMs, crossedAt: item.state.crossedAt }),
            input.dataDir,
          );
          if (isDeliveryAcknowledged(result)) {
            item.uiDelivered = true;
            const published = result as { id?: unknown } | null | undefined;
            const id = typeof published?.id === 'string' && published.id.trim() !== '' ? published.id : null;
            if (id) item.uiId = id;
            delivered = true;
          } else {
            console.warn('[balance-forecast] alert notification not delivered');
          }
        } catch (error) {
          console.warn('[balance-forecast] alert notification failed:', (error as Error | undefined)?.message || error);
        }
      }
      // One acknowledged channel avoids spamming the operator. A total failure
      // keeps the durable reservation so the next tick retries it; the stable
      // fingerprint/eventId make that retry idempotent for the UI and the push.
      if (delivered) notified.push(item.key);
    }
    // Persist per-channel progress BEFORE the final cleanup write. If that
    // cleanup write fails, the durable reservation still records which channels
    // already alerted the user, so the retry only calls the remaining ones and
    // never re-notifies through a channel that succeeded.
    const progressed = pending.some((item) => item.pushDelivered || item.uiDelivered);
    if (progressed) {
      for (const item of pending) {
        state.alerts[item.key] = {
          ...item.state,
          deliveryPending: true,
          pushDelivered: item.pushDelivered === true,
          uiDelivered: item.uiDelivered === true,
          ...(item.uiId ? { uiId: item.uiId } : {}),
        };
      }
      persistBalanceAlertState(input.dataDir, pruneBalanceAlertState(state, now), writeState);
    }
    if (pending.length > 0) {
      for (const item of pending) {
        const deliveredNow = notified.includes(item.key);
        const next = { ...item.state };
        delete next.deliveryPending;
        if (item.pushDelivered) next.pushDelivered = true;
        if (item.uiDelivered) next.uiDelivered = true;
        if (item.uiId) next.uiId = item.uiId;
        state.alerts[item.key] = deliveredNow
          ? { ...next, deliveredAt: iso(now) }
          : { ...next, deliveryPending: true };
      }
      // If this write fails, the earlier reservation (deliveryPending) survives
      // on disk, so the crossing is still retried instead of being lost.
      persistBalanceAlertState(input.dataDir, pruneBalanceAlertState(state, now), writeState);
    }
    const fresh = readBalanceAlertState(input.dataDir);
    return {
      evaluated: report.forecasts.length,
      notified,
      alerts: Object.entries(fresh.alerts).map(([key, entry]) => ({ key, ...entry })),
    };
  });
}
