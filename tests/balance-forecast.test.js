import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BALANCE_ALERT_ACTION_URL,
  BALANCE_ALERT_HYSTERESIS_RATIO,
  BALANCE_ALERT_THRESHOLD_MS,
  balanceAlertKey,
  buildBalanceAlertNotification,
  buildBalanceAlertPushPayload,
  buildBalanceForecast,
  buildBalanceForecasts,
  dispatchBalanceForecastAlerts,
  evaluateBalanceForecastAlert,
  pruneBalanceAlertState,
  readBalanceAlertState,
  readBalanceForecastReport,
  writeBalanceAlertState,
} from '../lib/credit-ledger/balance-forecast.ts';
import {
  createAccount,
  recordSnapshot,
  recordTransaction,
  tombstoneTransaction,
} from '../lib/credit-ledger/credit-ledger-store.ts';
import { registerCreditLedgerRoutes } from '../lib/routes/credit-ledger-routes.js';
import { runBalanceForecastAlertsMaintenance } from '../lib/usage/usage-maintenance.ts';

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const SERIES = 'deepseek-api';
const ACCOUNT = { id: 'acct_1', label: 'DeepSeek API', walletCurrency: 'CNY' };

const iso = (ms) => new Date(ms).toISOString();
const dec = (value) => ({ value, scale: 2 });

function snapshot(ms, {
  total,
  granted = '0.00',
  toppedUp = total,
  currency = 'CNY',
  series = SERIES,
  completeness = 'complete',
  boundaryUncertain = false,
  isAvailable = true,
  accountId = ACCOUNT.id,
  id = `snap_${currency}_${ms}`,
  recordedAt = null,
} = {}) {
  return {
    id,
    accountId,
    currency,
    series,
    totalBalance: dec(total),
    grantedBalance: dec(granted),
    toppedUpBalance: dec(toppedUp),
    isAvailable,
    observedAt: { at: iso(ms), date: null, precision: 'instant', uncertain: false },
    completeness,
    boundaryUncertain,
    source: 'test',
    recordedAt: recordedAt || iso(ms),
    tombstone: false,
    supersedes: null,
  };
}

function transaction({
  id,
  type,
  amount,
  at,
  currency = 'CNY',
  state = 'posted',
  expiresAt = null,
  supersedes = null,
  tombstone = false,
  accountId = ACCOUNT.id,
  occurredAt = null,
}) {
  return {
    id,
    accountId,
    type,
    state,
    credit: { ...dec(amount), currency },
    occurredAt: occurredAt
      || { at: iso(at), date: null, precision: 'instant', uncertain: false },
    expiresAt,
    source: 'test',
    tombstone,
    supersedes,
  };
}

function forecastFor(snapshots, transactions = [], options = {}) {
  return buildBalanceForecast({
    account: ACCOUNT,
    currency: 'CNY',
    series: SERIES,
    snapshots,
    transactions,
    now: NOW,
    ...options,
  });
}

test('acceptance example: top-up and expiry are not double counted', () => {
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '5.00', toppedUp: '95.00' }),
      snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
    ],
    [
      transaction({ id: 'tx_topup', type: 'topup', amount: '20.00', at: NOW - 5 * DAY }),
      transaction({ id: 'tx_expiry', type: 'expiry', amount: '5.00', at: NOW - 4 * DAY }),
    ],
  );
  assert.equal(forecast.status, 'ok');
  assert.equal(forecast.windows['7d'].spend, '30.00');
  assert.equal(forecast.windows['7d'].coverage, 'full');
  assert.equal(forecast.windows['7d'].flows.topups, '20.00');
  assert.equal(forecast.windows['7d'].flows.expiries, '5.00');
  assert.equal(forecast.latestBalance, '85.00');
  assert.ok(forecast.remainingMs > 0);
});

test('portfolio credits, not a gross payment in another currency, drive the spend', () => {
  const topup = {
    // Paid 3 USD but 20 CNY landed in the wallet: only the credit may count.
    ...transaction({ id: 'tx_topup', type: 'topup', amount: '20.00', at: NOW - 5 * DAY }),
    payment: { value: '3.00', scale: 2, currency: 'USD' },
  };
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
    ],
    [topup],
  );
  assert.equal(forecast.status, 'ok');
  assert.equal(forecast.windows['7d'].flows.topups, '20.00');
  assert.equal(forecast.windows['7d'].spend, '35.00');
});

test('a grant that never appears as a granted rise is an uncertain inflow/expiry', () => {
  // A booked grant with no observed rise in grantedBalance may have been
  // consumed OR expired without a booked expiry. Presenting the resulting
  // figure as certain API spend would hide the ambiguity.
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '50.00', granted: '0.00', toppedUp: '50.00' }),
      snapshot(NOW, { total: '40.00', granted: '0.00', toppedUp: '40.00' }),
    ],
    [transaction({ id: 'tx_grant', type: 'grant', amount: '10.00', at: NOW - 3 * DAY })],
  );
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.equal(forecast.balanceDropUncertain, true);
  assert.ok(forecast.reasons.includes('uncertain_grant_inflow'));
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_grant_inflow'));
  assert.equal(forecast.windows['7d'].unexplainedGrantInflow, '10.00');
  assert.equal(forecast.windows['7d'].flows.grants, '10.00');
  assert.equal(
    forecast.status,
    'needs_reconciliation',
    'the forecast is never presented as a certain spend',
  );
});

test('a grant observed as a granted rise is not reported as uncertain', () => {
  const reflected = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '50.00', granted: '0.00', toppedUp: '50.00' }),
      snapshot(NOW, { total: '55.00', granted: '10.00', toppedUp: '45.00' }),
    ],
    [transaction({ id: 'tx_grant', type: 'grant', amount: '10.00', at: NOW - 3 * DAY })],
  );
  assert.equal(reflected.status, 'ok');
  assert.equal(reflected.windows['7d'].unexplainedGrantInflow, null);

  // A booked expiry explains the missing granted rise, so it stays certain.
  const explained = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '5.00', toppedUp: '95.00' }),
      snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
    ],
    [
      transaction({ id: 'tx_grant', type: 'grant', amount: '10.00', at: NOW - 5 * DAY }),
      transaction({ id: 'tx_expiry', type: 'expiry', amount: '15.00', at: NOW - 4 * DAY }),
    ],
  );
  assert.equal(explained.windows['7d'].unexplainedGrantInflow, null);
});

test('a credit refund lowers the balance and is added with its real sign', () => {
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '70.00', granted: '0.00', toppedUp: '70.00' }),
    ],
    [transaction({ id: 'tx_refund', type: 'refund', amount: '10.00', at: NOW - 5 * DAY })],
  );
  assert.equal(forecast.status, 'ok');
  assert.equal(forecast.windows['7d'].flows.refunds, '10.00');
  assert.equal(forecast.windows['7d'].spend, '20.00');
});

test('an expiry is a negative wallet change and is not counted as API spend', () => {
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '40.00', granted: '10.00', toppedUp: '30.00' }),
      snapshot(NOW, { total: '20.00', granted: '0.00', toppedUp: '20.00' }),
    ],
    [transaction({ id: 'tx_expiry', type: 'expiry', amount: '10.00', at: NOW - 2 * DAY })],
  );
  assert.equal(forecast.status, 'ok');
  assert.equal(forecast.windows['7d'].spend, '10.00');
});

test('an hour-precision local moment honours the explicit zone offset', () => {
  // Local 2026-06-24 01:00 in UTC+08 is 2026-06-23T17:00Z: before the window
  // start. Reading it as UTC would put it at 2026-06-24T01:00Z, inside.
  const start = Date.parse('2026-06-23T20:00:00Z');
  const end = Date.parse('2026-06-25T00:00:00Z');
  const shifted = {
    ...transaction({ id: 'tx_shifted', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-06-24T01', precision: 'hour', sourceZone: '+08:00' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [shifted],
    { now: end },
  );
  assert.equal(forecast.windows['7d'].flows.count, 0, 'the zoned moment is outside the window');
  assert.equal(forecast.windows['7d'].flows.topups, '0');
  assert.equal(forecast.windows['7d'].spend, '5.00');
});

test('an hour-precision local moment honours a negative zone offset', () => {
  // Local 2026-06-24 01:00 in UTC-05 is 2026-06-24T06:00Z: inside the window.
  // Flipping the sign would put it at 2026-06-23T20:00Z, before the window.
  const start = Date.parse('2026-06-24T00:00:00Z');
  const end = Date.parse('2026-06-25T04:00:00Z');
  const shifted = {
    ...transaction({ id: 'tx_negative_zone', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-06-24T01', precision: 'hour', sourceZone: '-05:00' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [shifted],
    { now: end },
  );
  assert.equal(forecast.windows['7d'].flows.count, 1, 'the negative offset places the moment inside');
  assert.equal(forecast.windows['7d'].flows.topups, '5.00');
  assert.equal(forecast.windows['7d'].spend, '10.00');
});

test('an hour-precision local moment keeps a fractional (+05:30) zone offset', () => {
  // Local 2026-06-24 01:00 in UTC+05:30 is 2026-06-23T19:30Z, so the hour
  // reading spans 19:30-20:30Z and straddles the 19:45Z window start. Dropping
  // the 30 minutes (+05:00) would place the whole hour at 20:00-21:00Z, inside
  // the window, so the boundary must be reported as uncertain either way.
  const start = Date.parse('2026-06-23T19:45:00Z');
  const end = Date.parse('2026-06-25T00:00:00Z');
  const shifted = {
    ...transaction({ id: 'tx_fractional_zone', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-06-24T01', precision: 'hour', sourceZone: '+05:30' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [shifted],
    { now: end },
  );
  const window = forecast.windows['7d'];
  assert.ok(
    window.reasons.includes('uncertain_flow_boundary'),
    'the real fractional-offset hour overlaps the window boundary',
  );
  assert.equal(window.status, 'needs_reconciliation');
  assert.equal(window.flows.count, 0, 'an uncertain movement is not silently assigned to one side');
  assert.equal(window.flows.topups, '0');
  assert.equal(window.spend, '5.00');
});

test('a fully contained fractional (+05:30) movement is counted', () => {
  // Local 2026-06-24 03:00 in UTC+05:30 is 2026-06-23T21:30Z; its hour spans
  // 21:30-22:30Z and lies fully inside the window, so it must enter the flow sum.
  const start = Date.parse('2026-06-23T19:45:00Z');
  const end = Date.parse('2026-06-25T00:00:00Z');
  const contained = {
    ...transaction({ id: 'tx_fractional_contained', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-06-24T03', precision: 'hour', sourceZone: '+05:30' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [contained],
    { now: end },
  );
  const window = forecast.windows['7d'];
  assert.equal(window.flows.count, 1, 'the contained fractional-offset movement is counted');
  assert.equal(window.flows.topups, '5.00');
  assert.equal(window.spend, '10.00');
  assert.ok(!window.reasons.includes('uncertain_flow_boundary'), 'a contained movement is not uncertain');
});

test('an hour-precision local moment resolves a known IANA zone', () => {
  // Local 2026-06-24 01:00 in Europe/Warsaw (UTC+2 in June) is
  // 2026-06-23T23:00Z: outside a window that starts at midnight UTC.
  const start = Date.parse('2026-06-24T00:00:00Z');
  const end = Date.parse('2026-06-25T04:00:00Z');
  const shifted = {
    ...transaction({ id: 'tx_warsaw', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-06-24T01', precision: 'hour', sourceZone: 'Europe/Warsaw' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [shifted],
    { now: end },
  );
  assert.equal(forecast.windows['7d'].flows.count, 0, 'the zoned moment is outside the window');
  assert.equal(forecast.windows['7d'].flows.topups, '0');
});

test('a DST day interval follows the real 25 h local day, not a fixed 24 h', () => {
  // Europe/Warsaw 2026-10-25 is 25 h long: local midnight starts at
  // 2026-10-24T22:00Z and the next one is 2026-10-25T23:00Z. The window starts
  // at 22:30Z, so the day reading still overlaps the boundary and is uncertain;
  // a fixed 24 h end (22:00Z) wrongly placed the movement before the window.
  const start = Date.parse('2026-10-25T22:30:00.000Z');
  const end = start + 7 * DAY;
  const day = {
    ...transaction({ id: 'tx_dst_long_day', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-10-25', precision: 'day', sourceZone: 'Europe/Warsaw' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [day],
    { now: end },
  );
  assert.ok(
    forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'),
    'a movement inside the real 25 h day overlaps the boundary',
  );
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('a DST day interval follows the real 23 h local day, not a fixed 24 h', () => {
  // Europe/Warsaw 2026-03-29 is 23 h long: it ends at 2026-03-29T22:00Z. A
  // movement anywhere in that day lies before a 22:30Z window start, so it is
  // certainly out; a fixed 24 h end (23:00Z) invented a false uncertainty.
  const start = Date.parse('2026-03-29T22:30:00.000Z');
  const end = start + 7 * DAY;
  const day = {
    ...transaction({ id: 'tx_dst_short_day', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-03-29', precision: 'day', sourceZone: 'Europe/Warsaw' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [day],
    { now: end },
  );
  assert.ok(
    !forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'),
    'the real 23 h day ends before the window start',
  );
  assert.equal(forecast.windows['7d'].status, 'ok');
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('an ambiguous (fold) local hour is uncertain instead of one guessed offset', () => {
  // 2026-10-25T02 exists twice in Europe/Warsaw (00:00Z and 01:00Z). Picking one
  // offset placed the movement before the 02:30Z window start and hid the
  // uncertainty; it must stay uncertain.
  const start = Date.parse('2026-10-25T02:30:00.000Z');
  const end = start + 7 * DAY;
  const fold = {
    ...transaction({ id: 'tx_dst_fold', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-10-25T02', precision: 'hour', sourceZone: 'Europe/Warsaw' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [fold],
    { now: end },
  );
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('a nonexistent (gap) local hour is uncertain instead of an unconverged guess', () => {
  // 2026-03-29T02 never happens in Europe/Warsaw. The old correction loop
  // oscillated and returned a wrong instant; the boundary must stay uncertain.
  const start = Date.parse('2026-03-29T03:30:00.000Z');
  const end = start + 7 * DAY;
  const gap = {
    ...transaction({ id: 'tx_dst_gap', type: 'topup', amount: '5.00', at: end }),
    occurredAt: { at: null, date: '2026-03-29T02', precision: 'hour', sourceZone: 'Europe/Warsaw' },
  };
  const forecast = forecastFor(
    [
      snapshot(start, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(end, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [gap],
    { now: end },
  );
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('a malformed explicit offset like +99:99 is uncertain, never accepted', () => {
  // +99:99 is not a zone offset. Treating it as +6039 minutes shifted the
  // movement into the window and booked it as a certain top-up.
  const malformed = {
    ...transaction({ id: 'tx_bad_offset', type: 'topup', amount: '5.00', at: NOW }),
    occurredAt: { at: null, date: '2026-06-28', precision: 'day', sourceZone: '+99:99' },
  };
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [malformed],
  );
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('an out-of-range ISO offset is malformed, not a precise instant', () => {
  // `Date.parse` accepts +14:30 even though no zone uses it. Trusting it would
  // place the movement inside the window as a certain top-up.
  const malformedInstant = {
    ...transaction({ id: 'tx_bad_instant', type: 'topup', amount: '5.00', at: NOW }),
    occurredAt: { at: '2026-06-28T12:00:00+14:30', date: null, precision: 'instant', uncertain: false },
  };
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
    ],
    [malformedInstant],
  );
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('an unparseable source zone is uncertain instead of read as UTC', () => {
  const unknown = {
    ...transaction({ id: 'tx_unknown_zone', type: 'topup', amount: '5.00', at: NOW }),
    occurredAt: { at: null, date: '2026-06-28', precision: 'day', sourceZone: 'Mars/Olympus' },
  };
  const forecast = forecastFor(
    [
      snapshot(NOW - 3 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '95.00', granted: '0.00', toppedUp: '95.00' }),
    ],
    [unknown],
  );
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.ok(forecast.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(forecast.windows['7d'].flows.count, 0);
});

test('negative and positive corrections use their actual booked effect', () => {
  const negative = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '80.00', granted: '0.00', toppedUp: '80.00' }),
    ],
    [transaction({ id: 'tx_adj', type: 'adjustment', amount: '-5.00', at: NOW - 3 * DAY })],
  );
  assert.equal(negative.status, 'ok');
  assert.equal(negative.windows['7d'].spend, '15.00');

  const positive = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '80.00', granted: '0.00', toppedUp: '80.00' }),
    ],
    [transaction({ id: 'tx_adj', type: 'adjustment', amount: '5.00', at: NOW - 3 * DAY })],
  );
  assert.equal(positive.status, 'ok');
  assert.equal(positive.windows['7d'].spend, '25.00');
});

test('an incomplete window reports the actual shorter period instead of zero', () => {
  const forecast = forecastFor([
    snapshot(NOW - 3 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '70.00', granted: '0.00', toppedUp: '70.00' }),
  ]);
  assert.equal(forecast.status, 'ok');
  for (const id of ['7d', '30d']) {
    assert.equal(forecast.windows[id].coverage, 'shorter');
    assert.equal(forecast.windows[id].actualMs, 3 * DAY);
    assert.equal(forecast.windows[id].spend, '30.00');
    assert.equal(forecast.windows[id].spendPerDay, 10);
  }
});

test('a sparse series keeps the longer scenario and marks the shorter one insufficient', () => {
  // Two points 20 days apart cannot cover a 7-day scenario, but they do cover a
  // 20-day actual period for the 30-day scenario. Each scenario reports its own
  // coverage instead of a sparse series silently collapsing both.
  const forecast = forecastFor([
    snapshot(NOW - 20 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '60.00', granted: '0.00', toppedUp: '60.00' }),
  ]);
  assert.equal(forecast.windows['7d'].status, 'insufficient_window');
  assert.deepEqual(forecast.windows['7d'].reasons, ['no_window_start']);
  assert.equal(forecast.windows['30d'].coverage, 'shorter');
  assert.equal(forecast.windows['30d'].actualMs, 20 * DAY);
  assert.equal(forecast.windows['30d'].spend, '40.00');
  assert.equal(forecast.status, 'ok');
});

test('a window shorter than 24 h is an explicit insufficient-window state', () => {
  const forecast = forecastFor([
    snapshot(NOW - 12 * HOUR, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
  ]);
  assert.equal(forecast.status, 'insufficient_window');
  assert.equal(forecast.windows['7d'].status, 'insufficient_window');
  assert.equal(forecast.windows['7d'].spend, null);
});

test('uncertain flow and snapshot boundaries need reconciliation instead of a certain spend', () => {
  // A day-precision top-up overlaps the 7-day window start, so it cannot be
  // assigned to either side; it must not be silently counted or dropped.
  const dayTopup = {
    ...transaction({ id: 'tx_day_topup', type: 'topup', amount: '5.00', at: NOW - 7 * DAY }),
    occurredAt: { at: null, date: '2026-06-23', precision: 'day', uncertain: true },
  };
  const uncertainFlow = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
    ],
    [dayTopup],
  );
  assert.equal(uncertainFlow.status, 'needs_reconciliation');
  assert.equal(uncertainFlow.windows['7d'].status, 'needs_reconciliation');
  assert.ok(uncertainFlow.windows['7d'].reasons.includes('uncertain_flow_boundary'));
  assert.equal(uncertainFlow.windows['7d'].flows.count, 0, 'an uncertain boundary is never assigned to one side');
  assert.equal(uncertainFlow.windows['7d'].spend, '15.00');

  const partial = forecastFor([
    snapshot(NOW - 7 * DAY, {
      total: '100.00', granted: '0.00', toppedUp: '100.00', completeness: 'partial',
    }),
    snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
  ]);
  assert.equal(partial.windows['7d'].status, 'needs_reconciliation');
  assert.ok(partial.windows['7d'].reasons.includes('incomplete_snapshot'));

  const uncertainSnapshot = forecastFor([
    snapshot(NOW - 7 * DAY, {
      total: '100.00', granted: '0.00', toppedUp: '100.00', boundaryUncertain: true,
    }),
    snapshot(NOW, { total: '85.00', granted: '0.00', toppedUp: '85.00' }),
  ]);
  assert.equal(uncertainSnapshot.windows['7d'].status, 'needs_reconciliation');
  assert.ok(uncertainSnapshot.windows['7d'].reasons.includes('uncertain_snapshot_boundary'));
});

test('negative spend is an inconsistency and is never clamped to zero', () => {
  const forecast = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '120.00', granted: '0.00', toppedUp: '100.00' }),
  ]);
  assert.equal(forecast.status, 'inconsistent');
  assert.equal(forecast.windows['7d'].status, 'inconsistent');
  assert.equal(forecast.windows['7d'].spend, '-20.00');
});

test('an unexplained topped-up increase is a missing top-up needing reconciliation', () => {
  const forecast = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '120.00', granted: '0.00', toppedUp: '120.00' }),
  ]);
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.ok(forecast.windows['7d'].reasons.includes('missing_topup'));
  assert.equal(forecast.windows['7d'].unexplainedTopUpIncrease, '20.00');
});

test('a missing top-up in one window does not mask another window inconsistency', () => {
  // The 7-day window has an unexplained topped-up increase (needs
  // reconciliation); the 30-day window has an impossible negative spend with no
  // missing top-up (inconsistent). Aggregating on the presence of the
  // `missing_topup` reason alone hid the real inconsistency.
  const forecast = forecastFor([
    snapshot(NOW - 30 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '90.00' }),
    snapshot(NOW, { total: '120.00', granted: '0.00', toppedUp: '100.00' }),
  ]);
  assert.equal(forecast.windows['7d'].status, 'needs_reconciliation');
  assert.ok(forecast.windows['7d'].reasons.includes('missing_topup'));
  assert.equal(forecast.windows['30d'].status, 'inconsistent');
  assert.equal(forecast.status, 'inconsistent');
});

test('an unexplained granted drop is a balance drop of uncertain cause', () => {
  const forecast = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '20.00', toppedUp: '80.00' }),
    snapshot(NOW, { total: '80.00', granted: '0.00', toppedUp: '80.00' }),
  ]);
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.equal(forecast.balanceDropUncertain, true);
  assert.equal(forecast.windows['7d'].unexplainedGrantedDrop, '20.00');
});

test('a newer imprecise observation invalidates the current endpoint', () => {
  const imprecise = {
    ...snapshot(NOW, { total: '60.00', granted: '0.00', toppedUp: '60.00' }),
    observedAt: { at: null, date: '2026-06-30', precision: 'day', uncertain: true },
  };
  const forecast = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW - DAY, { total: '70.00', granted: '0.00', toppedUp: '70.00' }),
    imprecise,
  ]);
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.equal(forecast.latestObservedAt, null);
  assert.equal(forecast.remainingMs, null);
  assert.ok(forecast.reasons.includes('uncertain_endpoint'));
});

test('a later same-day imprecise observation supersedes a precise endpoint', () => {
  // Lexicographic ordering put "2026-06-30" before "2026-06-30T12:00:00.000Z",
  // so a precise reading could anchor the forecast even though a broader
  // observation of the same day was recorded afterwards.
  const precise = snapshot(NOW, {
    total: '70.00', granted: '0.00', toppedUp: '70.00', id: 'snap_precise',
  });
  const imprecise = {
    ...snapshot(NOW, {
      total: '60.00', granted: '0.00', toppedUp: '60.00', id: 'snap_imprecise',
      recordedAt: iso(NOW + HOUR),
    }),
    observedAt: { at: null, date: '2026-06-30', precision: 'day', uncertain: true },
  };
  const forecast = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    precise,
    imprecise,
  ]);
  assert.equal(forecast.status, 'needs_reconciliation');
  assert.equal(forecast.latestObservedAt, null);
  assert.ok(forecast.reasons.includes('uncertain_endpoint'));
});

test('an unplaceable observation keeps possible bounds so a stale endpoint is invalidated', () => {
  // A day-only reading with no usable zone recorded after a precise endpoint
  // could be at any real UTC offset. Its naive UTC interval ended before the
  // endpoint, so the old validation kept a stale endpoint; the possible range
  // (UTC-12..UTC+14) overlaps and must invalidate it.
  const endpointMs = Date.parse('2026-06-30T11:30:00.000Z');
  const unknown = {
    ...snapshot(endpointMs, { total: '70.00', granted: '0.00', toppedUp: '70.00', id: 'snap_unknown_zone' }),
    observedAt: { at: null, date: '2026-06-29', precision: 'day', uncertain: true },
    recordedAt: iso(endpointMs + 10 * 60 * 1000),
  };
  const endpoint = {
    ...snapshot(endpointMs, { total: '80.00', granted: '0.00', toppedUp: '80.00', id: 'snap_precise_endpoint' }),
    recordedAt: iso(endpointMs - HOUR),
  };
  const forecast = forecastFor(
    [snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }), endpoint, unknown],
    [],
    { now: NOW },
  );
  assert.equal(forecast.latestObservedAt, null, 'the stale precise endpoint is not used');
  assert.ok(forecast.reasons.includes('uncertain_endpoint'));
});

test('pending and superseded records are not booked', () => {
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    ],
    [
      transaction({ id: 'tx_pending', type: 'topup', amount: '50.00', at: NOW - 2 * DAY, state: 'pending' }),
      transaction({ id: 'tx_old', type: 'topup', amount: '30.00', at: NOW - 3 * DAY }),
      transaction({ id: 'tx_corrected', type: 'adjustment', amount: '0.00', at: NOW - 3 * DAY, supersedes: 'tx_old' }),
    ],
  );
  assert.equal(forecast.status, 'zero_rate');
  assert.equal(forecast.windows['7d'].spend, '0.00');
});

test('no snapshots is an explicit no-data state', () => {
  const forecast = forecastFor([]);
  assert.equal(forecast.status, 'no_data');
  assert.equal(forecast.latestBalance, null);
  assert.equal(forecast.remainingMs, null);
  assert.deepEqual(forecast.reasons, ['no_snapshots']);
});

test('stale, no-funds and zero-rate are explicit states', () => {
  const stale = forecastFor([
    snapshot(NOW - 40 * HOUR - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW - 40 * HOUR, { total: '70.00', granted: '0.00', toppedUp: '70.00' }),
  ]);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.stale, true);

  const noFunds = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '0.00', granted: '0.00', toppedUp: '0.00' }),
  ]);
  assert.equal(noFunds.status, 'no_funds');
  assert.equal(noFunds.remainingMs, 0);

  const zero = forecastFor([
    snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
  ]);
  assert.equal(zero.status, 'zero_rate');
  assert.equal(zero.exhaustion, null);
});

test('a faster recent rate is an explicit rate-change state', () => {
  const forecast = forecastFor([
    snapshot(NOW - 30 * DAY, { total: '1000.00', granted: '0.00', toppedUp: '1000.00' }),
    snapshot(NOW - 7 * DAY, { total: '1000.00', granted: '0.00', toppedUp: '1000.00' }),
    snapshot(NOW - DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
    snapshot(NOW, { total: '90.00', granted: '0.00', toppedUp: '90.00' }),
  ]);
  assert.equal(forecast.status, 'rate_change');
  assert.equal(forecast.rateChange.detector, '7d-vs-30d');
  assert.ok(forecast.rateChange.factor >= 2);
});

test('a tiny consumption rate still produces a runway', () => {
  // 0.000001 CNY over 30 days is a real (very long) runway. Rounding the rate to
  // six decimals collapsed it to zero and dropped the forecast entirely.
  const forecast = forecastFor([
    snapshot(NOW - 30 * DAY, { total: '1.000000', granted: '0.00', toppedUp: '1.000000' }),
    snapshot(NOW, { total: '0.999999', granted: '0.00', toppedUp: '0.999999' }),
  ]);
  const window = forecast.windows['30d'];
  assert.equal(window.spend, '0.000001');
  assert.ok(window.spendPerDay > 0, 'the presented rate is not collapsed to zero');
  assert.ok(window.exhaustsAt, 'the low-consumption runway is not discarded');
  assert.ok(forecast.remainingMs > 0);
});

test('currencies are forecast separately and never summed', () => {
  const forecasts = buildBalanceForecasts({
    accounts: [ACCOUNT],
    snapshots: [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '0.00', toppedUp: '100.00' }),
      snapshot(NOW, { total: '70.00', granted: '0.00', toppedUp: '70.00' }),
      snapshot(NOW - 7 * DAY, { total: '10.00', granted: '0.00', toppedUp: '10.00', currency: 'USD', id: 'usd_start' }),
      snapshot(NOW, { total: '5.00', granted: '0.00', toppedUp: '5.00', currency: 'USD', id: 'usd_end' }),
    ],
    transactions: [],
    now: NOW,
  });
  assert.equal(forecasts.length, 2);
  assert.deepEqual(forecasts.map((row) => row.currency).sort(), ['CNY', 'USD']);
  assert.deepEqual(forecasts.map((row) => row.windows['7d'].spend).sort(), ['30.00', '5.00']);
});

test('known expiresAt dates are shown next to the forecast', () => {
  const forecast = forecastFor(
    [
      snapshot(NOW - 7 * DAY, { total: '100.00', granted: '10.00', toppedUp: '90.00' }),
      snapshot(NOW, { total: '90.00', granted: '10.00', toppedUp: '80.00' }),
    ],
    [
      transaction({
        id: 'tx_grant',
        type: 'grant',
        amount: '10.00',
        at: NOW - 20 * DAY,
        expiresAt: { at: iso(NOW + 5 * DAY), date: null, precision: 'instant', uncertain: false },
      }),
    ],
  );
  assert.equal(forecast.expiries.length, 1);
  assert.equal(forecast.expiries[0].at, iso(NOW + 5 * DAY));
  assert.equal(forecast.expiries[0].currency, 'CNY');
});

test('alert state notifies once per crossing and resets only on a verified return', () => {
  const base = { accountId: 'acct_1', currency: 'CNY', series: SERIES };
  const low = { ...base, status: 'ok', remainingMs: 12 * HOUR };
  const first = evaluateBalanceForecastAlert(low, null, { now: NOW });
  assert.equal(first.notify, true);
  assert.equal(first.active, true);

  const repeat = evaluateBalanceForecastAlert(low, first.state, { now: NOW + HOUR });
  assert.equal(repeat.notify, false);
  assert.equal(repeat.active, true);

  const uncertainReturn = evaluateBalanceForecastAlert(
    { ...base, status: 'needs_reconciliation', remainingMs: 60 * HOUR },
    repeat.state,
    { now: NOW + 2 * HOUR },
  );
  assert.equal(uncertainReturn.reset, false);
  assert.equal(uncertainReturn.active, true);

  const exitThreshold = BALANCE_ALERT_THRESHOLD_MS * (1 + BALANCE_ALERT_HYSTERESIS_RATIO);
  const verifiedReturn = evaluateBalanceForecastAlert(
    { ...base, status: 'ok', remainingMs: exitThreshold + HOUR },
    uncertainReturn.state,
    { now: NOW + 3 * HOUR },
  );
  assert.equal(verifiedReturn.reset, true);
  assert.equal(verifiedReturn.active, false);
  assert.equal(verifiedReturn.state, null);

  const again = evaluateBalanceForecastAlert(low, verifiedReturn.state, { now: NOW + 4 * HOUR });
  assert.equal(again.notify, true);
});

test('push payload and in-app notification are generic and carry a link', () => {
  const forecast = {
    accountId: 'acct_1',
    accountLabel: 'DeepSeek API',
    currency: 'CNY',
    series: SERIES,
    status: 'ok',
    remainingMs: 5 * HOUR,
    // Real amounts from the forecast must never reach a push or a UI row.
    latestBalance: '123.45',
    latestGrantedBalance: '7.89',
    spendPerDay: '3.21',
    windows: { '7d': { spend: '22.22', flows: { total: '11.11', topups: '9.87' } } },
    expiries: [{ amount: '4.56', at: iso(NOW + DAY) }],
  };
  const payload = buildBalanceAlertPushPayload(forecast);
  assert.equal(payload.data.type, 'balance-alert');
  assert.equal(payload.data.url, '/?panel=settings&tab=usage');
  assert.match(payload.body, /CNY/);
  // A crossing identity is stable for the crossing and differs for a later one,
  // so the service worker suppresses a re-alert on a retry.
  const crossing = iso(NOW);
  const key = balanceAlertKey(forecast);
  assert.equal(buildBalanceAlertPushPayload(forecast, { crossedAt: crossing }).data.eventId, `${key}:${crossing}`);
  assert.equal(
    buildBalanceAlertPushPayload(forecast, { crossedAt: crossing }).data.eventId,
    buildBalanceAlertPushPayload(forecast, { crossedAt: crossing }).data.eventId,
    'the same crossing keeps its event id',
  );
  assert.notEqual(
    buildBalanceAlertPushPayload(forecast, { crossedAt: iso(NOW + HOUR) }).data.eventId,
    `${key}:${crossing}`,
    'a later crossing gets a new event id',
  );
  const serialized = JSON.stringify(payload);
  for (const amount of ['123.45', '7.89', '3.21', '22.22', '11.11', '9.87', '4.56']) {
    assert.ok(!serialized.includes(amount), `push payload leaks ${amount}`);
  }

  const row = buildBalanceAlertNotification(forecast, { crossedAt: iso(NOW) });
  assert.equal(row.category, 'system');
  assert.equal(row.severity, 'warning');
  assert.equal(row.actionUrl, BALANCE_ALERT_ACTION_URL);
  assert.match(row.fingerprint, /^balance-alert:acct_1:CNY:deepseek-api:/);
  assert.match(row.body, /CNY/);
  const serializedRow = JSON.stringify(row);
  for (const amount of ['123.45', '7.89', '3.21', '22.22', '11.11', '9.87', '4.56']) {
    assert.ok(!serializedRow.includes(amount), `UI row leaks ${amount}`);
  }
  // The same crossing keeps its fingerprint; a later crossing does not.
  assert.equal(row.fingerprint, buildBalanceAlertNotification(forecast, { crossedAt: iso(NOW) }).fingerprint);
  assert.notEqual(row.fingerprint, buildBalanceAlertNotification(forecast, { crossedAt: iso(NOW + HOUR) }).fingerprint);
});

/**
 * Minimal ledger fixture: one CNY account with the DeepSeek series, so the
 * dispatch tests exercise the real store read path instead of hand-built rows.
 */
function createLedgerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cretli-balance-forecast-'));
  const ledgerPath = path.join(dir, 'credit-ledger.json');
  const { account } = createAccount({
    filePath: ledgerPath,
    label: 'DeepSeek API',
    walletCurrency: 'CNY',
  });
  const writeSnapshot = (at, total) => recordSnapshot({
    filePath: ledgerPath,
    input: {
      accountId: account.id,
      currency: 'CNY',
      series: SERIES,
      totalBalance: total,
      grantedBalance: '0.00',
      toppedUpBalance: total,
      observedAt: iso(at),
      source: 'test',
      completeness: 'complete',
    },
  });
  const writeTopup = (amount, at) => recordTransaction({
    filePath: ledgerPath,
    input: {
      accountId: account.id,
      type: 'topup',
      state: 'posted',
      credit: { amount, currency: 'CNY' },
      occurredAt: iso(at),
      source: 'test',
    },
  });
  // A grant with no observed grantedBalance rise leaves the forecast needing
  // reconciliation; the ledger store can later tombstone it to restore a
  // verified forecast.
  const writeGrant = (amount, at) => recordTransaction({
    filePath: ledgerPath,
    input: {
      accountId: account.id,
      type: 'grant',
      state: 'posted',
      credit: { amount, currency: 'CNY' },
      occurredAt: iso(at),
      source: 'test',
    },
  });
  return {
    dir,
    ledgerPath,
    writeSnapshot,
    writeTopup,
    writeGrant,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('dispatch publishes one UI alert per crossing and notifies again after a reset', async () => {
  const fixture = createLedgerFixture();
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');

    let pushes = 0;
    const published = [];
    const notify = async (payload) => {
      pushes += 1;
      assert.equal(payload.data.type, 'balance-alert');
    };
    const publishNotification = async (row) => { published.push(row); };

    const first = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify, publishNotification,
    });
    assert.equal(first.notified.length, 1);
    assert.equal(pushes, 1);
    assert.equal(published.length, 1, 'a crossing is also published to the UI notification centre');
    assert.match(published[0].fingerprint, /^balance-alert:/);
    const report = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    assert.equal(report.forecasts[0].alert.active, true);
    assert.equal(report.alerts.length, 1);

    const second = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW + 5 * 60 * 1000, notify, publishNotification,
    });
    assert.equal(second.notified.length, 0);
    assert.equal(pushes, 1);
    assert.equal(published.length, 1, 'an active crossing is never re-published');

    // A verified return above the hysteresis threshold clears the arm state.
    fixture.writeTopup('990.00', NOW + 12 * HOUR);
    fixture.writeSnapshot(NOW + DAY, '1000.00');
    const reset = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW + DAY, notify, publishNotification,
    });
    assert.equal(reset.notified.length, 0);
    assert.deepEqual(readBalanceAlertState(fixture.dir).alerts, {});
    assert.equal(published.length, 1);

    // A new crossing after the reset notifies again as a new occurrence.
    fixture.writeSnapshot(NOW + 2 * DAY, '5.00');
    const third = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW + 2 * DAY, notify, publishNotification,
    });
    assert.equal(third.notified.length, 1);
    assert.equal(pushes, 2);
    assert.equal(published.length, 2);
    assert.notEqual(published[0].fingerprint, published[1].fingerprint);
    assert.equal(Object.keys(readBalanceAlertState(fixture.dir).alerts).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a new crossing is stored as a real in-app notification row', async () => {
  const fixture = createLedgerFixture();
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const result = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => {},
    });
    assert.equal(result.notified.length, 1);
    const { listNotifications } = await import('../lib/notifications/notification-store.ts');
    const { DEFAULT_NOTIFICATION_CENTER_PREFERENCES } = await import('../lib/notifications/notification-preferences.ts');
    const store = listNotifications({}, {
      storePath: path.join(fixture.dir, 'notification-center.json'),
      preferences: DEFAULT_NOTIFICATION_CENTER_PREFERENCES,
    });
    assert.equal(store.items.length, 1, 'the UI notification centre has the crossing');
    assert.equal(store.items[0].category, 'system');
    assert.equal(store.items[0].actionUrl, BALANCE_ALERT_ACTION_URL);
    assert.ok(!JSON.stringify(store.items[0]).includes('10.00'), 'no balance amount in the UI row');
  } finally {
    fixture.cleanup();
  }
});

test('a crossing is retried while every delivery channel fails', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const fail = async () => { throw new Error('channel down'); };
    const failed = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: fail, publishNotification: fail,
    });
    assert.deepEqual(failed.notified, []);
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts);
    assert.equal(reserved.length, 1, 'a total failure keeps the crossing reserved');
    assert.equal(reserved[0].deliveryPending, true, 'the crossing stays pending for a retry');

    let published = 0;
    const recovered = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => {},
      publishNotification: async () => { published += 1; },
    });
    assert.equal(recovered.notified.length, 1);
    assert.equal(published, 1);
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a push result that delivered to zero devices is retried, not acknowledged', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    // The real broadcaster resolves `{ sent: 0 }` when there are no devices.
    const noDevices = async () => ({ sent: 0, failed: 0, reason: 'no-subscriptions' });
    const uiDown = async () => { throw new Error('ui down'); };
    const first = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: noDevices, publishNotification: uiDown,
    });
    assert.deepEqual(first.notified, [], 'a zero-delivery push is not a delivered crossing');
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts);
    assert.equal(reserved.length, 1, 'the crossing stays reserved');
    assert.equal(reserved[0].deliveryPending, true, 'the crossing stays pending for a retry');

    let pushes = 0;
    const retried = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => { pushes += 1; return { sent: 1, failed: 0 }; },
      publishNotification: async () => {},
    });
    assert.equal(retried.notified.length, 1);
    assert.equal(pushes, 1, 'the crossing is delivered on the retry');
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a rejected UI publication is not acknowledged as a delivery', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    // `publishNotification` returns exactly this shape for rejected input: no
    // id, only the current store revision. A revision proves nothing published.
    const rejected = async () => ({ created: false, id: null, revision: 0 });
    const noDevices = async () => ({ sent: 0, failed: 0, reason: 'no-subscriptions' });
    const first = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: noDevices, publishNotification: rejected,
    });
    assert.deepEqual(first.notified, [], 'a rejected publication with sent:0 delivered nothing');
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts);
    assert.equal(reserved.length, 1, 'the crossing stays reserved');
    assert.equal(reserved[0].deliveryPending, true, 'the crossing stays retryable');
    assert.notEqual(reserved[0].pushDelivered, true);
    assert.notEqual(reserved[0].uiDelivered, true);

    const rows = [];
    const retried = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: noDevices,
      publishNotification: async (row) => { rows.push(row); return { created: true, id: 'n_2', revision: 1 }; },
    });
    assert.equal(retried.notified.length, 1, 'the retry delivers once a channel acknowledges');
    assert.equal(rows.length, 1);
    assert.notEqual(Object.values(readBalanceAlertState(fixture.dir).alerts)[0].deliveryPending, true);
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a genuine duplicate UI publication is acknowledged', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const noDevices = async () => ({ sent: 0, failed: 0, reason: 'no-subscriptions' });
    // A known fingerprint returns the existing notification id, which is proof
    // that the same crossing is already visible in the UI.
    const duplicate = async () => ({ created: false, id: 'n_1', revision: 5 });
    const result = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: noDevices, publishNotification: duplicate,
    });
    assert.equal(result.notified.length, 1, 'a genuine duplicate is a delivered crossing');
    const stored = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.notEqual(stored.deliveryPending, true, 'the crossing is finalized');
    assert.equal(stored.uiDelivered, true);
    assert.equal(stored.uiId, 'n_1');

    const again = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: noDevices, publishNotification: duplicate,
    });
    assert.equal(again.notified.length, 0, 'a finalized crossing is not delivered again');
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a delivery-pending reservation from a crashed pass is delivered exactly once', async () => {
  const fixture = createLedgerFixture();
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const report = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    const key = balanceAlertKey(report.forecasts[0]);
    // Simulate a crash after the durable reservation write but before any
    // channel was called.
    const crossedAt = iso(NOW - HOUR);
    writeBalanceAlertState(fixture.dir, {
      version: 1,
      alerts: {
        [key]: {
          active: true,
          crossedAt,
          remainingMs: report.forecasts[0].remainingMs,
          thresholdMs: BALANCE_ALERT_THRESHOLD_MS,
          updatedAt: crossedAt,
          deliveryPending: true,
        },
      },
    });

    // The pending reservation is not mistaken for a delivered crossing in a read.
    const pendingReport = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    assert.equal(pendingReport.forecasts[0].alert.deliveryPending, true);
    assert.equal(pendingReport.alerts[0].deliveryPending, true);

    const published = [];
    const notify = async () => {};
    const publishNotification = async (row) => { published.push(row); };
    const first = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify, publishNotification,
    });
    assert.equal(first.notified.length, 1, 'the pending crossing is delivered after the restart');
    assert.equal(published.length, 1);
    assert.equal(published[0].fingerprint, `${key}:${crossedAt}`, 'the crossing identity survives the restart');
    assert.notEqual(Object.values(readBalanceAlertState(fixture.dir).alerts)[0].deliveryPending, true);

    const second = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify, publishNotification,
    });
    assert.equal(second.notified.length, 0);
    assert.equal(published.length, 1, 'a delivered crossing is never delivered again');
  } finally {
    fixture.cleanup();
  }
});

test('a pending retry only calls the channel that has not delivered yet', async () => {
  const fixture = createLedgerFixture();
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const report = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    const key = balanceAlertKey(report.forecasts[0]);
    const crossedAt = iso(NOW - HOUR);
    // The push already reached a device before the process lost the final write,
    // so only the in-app occurrence is still owed to the operator.
    writeBalanceAlertState(fixture.dir, {
      version: 1,
      alerts: {
        [key]: {
          active: true,
          crossedAt,
          remainingMs: report.forecasts[0].remainingMs,
          thresholdMs: BALANCE_ALERT_THRESHOLD_MS,
          updatedAt: crossedAt,
          deliveryPending: true,
          pushDelivered: true,
        },
      },
    });
    let pushes = 0;
    const published = [];
    const result = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => { pushes += 1; },
      publishNotification: async (row) => { published.push(row); },
    });
    assert.equal(pushes, 0, 'the push channel that already delivered is not called again');
    assert.equal(published.length, 1, 'the undelivered UI channel is retried');
    assert.equal(result.notified.length, 1);
    assert.equal(published[0].fingerprint, `${key}:${crossedAt}`);
    const stored = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.notEqual(stored.deliveryPending, true);
    assert.equal(stored.pushDelivered, true);
    assert.equal(stored.uiDelivered, true);
  } finally {
    fixture.cleanup();
  }
});

test('a failed cleanup write leaves the crossing retryable without repeating the alert', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const writeState = (dataDir, state) => {
      // The reservation and per-channel progress writes succeed; the final
      // cleanup write that clears `deliveryPending` fails.
      const row = Object.values(state.alerts || {})[0];
      if (row && row.deliveryPending !== true) return false;
      return writeBalanceAlertState(dataDir, state);
    };
    let pushes = 0;
    const payloads = [];
    await assert.rejects(
      dispatchBalanceForecastAlerts({
        filePath: fixture.ledgerPath,
        dataDir: fixture.dir,
        now: NOW,
        notify: async (payload) => { pushes += 1; payloads.push(payload); },
        writeState,
      }),
      /balance_alert_state_unwritable/,
    );
    assert.equal(pushes, 1, 'the channel was called before the cleanup write failed');
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts);
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0].deliveryPending, true, 'the durable reservation stays retryable');
    assert.equal(payloads[0].data.eventId, `${Object.keys(readBalanceAlertState(fixture.dir).alerts)[0]}:${reserved[0].crossedAt}`,
      'the push carries a stable crossing event id');

    // A later maintenance pass retries. Both channels already acknowledged the
    // crossing before the cleanup write failed, so the retry must finalize the
    // reservation WITHOUT alerting the user a second time.
    const retried = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async (payload) => { pushes += 1; payloads.push(payload); },
    });
    assert.equal(retried.notified.length, 1);
    const settled = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.notEqual(settled.deliveryPending, true);
    assert.equal(settled.pushDelivered, true);
    assert.equal(settled.uiDelivered, true);
    assert.equal(pushes, 1, 'the already-delivered push is NOT sent again');
    assert.equal(payloads.length, 1, 'no second user-visible push for one crossing');
    const { listNotifications } = await import('../lib/notifications/notification-store.ts');
    const { DEFAULT_NOTIFICATION_CENTER_PREFERENCES } = await import('../lib/notifications/notification-preferences.ts');
    const store = listNotifications({}, {
      storePath: path.join(fixture.dir, 'notification-center.json'),
      preferences: DEFAULT_NOTIFICATION_CENTER_PREFERENCES,
    });
    assert.equal(store.items.length, 1, 'the retry did not duplicate the UI occurrence');
    assert.equal(payloads[0].data.eventId, store.items[0].fingerprint,
      'the push and the UI row share the crossing identity');
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a failed per-channel progress write retries with the same push event id', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    // The push and the UI channel acknowledge, but the write that records those
    // acknowledgements fails. On disk the reservation therefore still looks
    // undelivered and the next pass must resend the push.
    let failProgress = true;
    const writeState = (dataDir, state) => {
      const row = Object.values(state.alerts || {})[0];
      if (failProgress && row && row.deliveryPending === true && row.pushDelivered === true) {
        return false;
      }
      return writeBalanceAlertState(dataDir, state);
    };
    const payloads = [];
    const publish = async () => ({ created: true, id: 'n_1', revision: 1 });
    await assert.rejects(
      dispatchBalanceForecastAlerts({
        filePath: fixture.ledgerPath,
        dataDir: fixture.dir,
        now: NOW,
        notify: async (payload) => { payloads.push(payload); },
        publishNotification: publish,
        writeState,
      }),
      /balance_alert_state_unwritable/,
    );
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.equal(reserved.deliveryPending, true, 'the reservation is still retryable');
    assert.notEqual(reserved.pushDelivered, true, 'the failed progress write did not record the push');

    failProgress = false;
    const retried = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async (payload) => { payloads.push(payload); },
      publishNotification: publish,
    });
    assert.equal(retried.notified.length, 1);
    assert.equal(payloads.length, 2, 'the undelivered push is retried');
    assert.equal(
      payloads[1].data.eventId,
      payloads[0].data.eventId,
      'the retry reuses the stable crossing event id, so the device can suppress a re-alert',
    );
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a pending retry never sends from an unreconciled forecast', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const fail = async () => { throw new Error('channel down'); };
    await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: fail, publishNotification: fail,
    });
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.equal(reserved.deliveryPending, true);
    const key = balanceAlertKey(
      readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW }).forecasts[0],
    );

    // A booked grant with no observed grantedBalance rise leaves the forecast
    // needing reconciliation: the ordinary path would refuse to raise an alert.
    const grant = fixture.writeGrant('10.00', NOW - 3 * DAY);
    const unreconciled = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    assert.equal(unreconciled.forecasts[0].status, 'needs_reconciliation');

    let pushes = 0;
    let published = 0;
    const deferred = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => { pushes += 1; return { sent: 1 }; },
      publishNotification: async () => { published += 1; return { created: true, id: 'n_1', revision: 1 }; },
    });
    assert.equal(pushes, 0, 'no push from an unreconciled forecast');
    assert.equal(published, 0, 'no UI row from an unreconciled forecast');
    assert.deepEqual(deferred.notified, []);
    const stillPending = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.equal(stillPending.deliveryPending, true, 'the occurrence stays reserved');
    assert.equal(stillPending.crossedAt, reserved.crossedAt, 'the original crossing is preserved');

    // Tombstoning the unexplained grant reconciles the data again.
    tombstoneTransaction({
      filePath: fixture.ledgerPath,
      id: grant.transaction.id,
      reason: 'test: correcting snapshot data',
    });
    const verified = readBalanceForecastReport({ filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW });
    assert.equal(verified.forecasts[0].status, 'ok');

    const delivered = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => { pushes += 1; return { sent: 1 }; },
      publishNotification: async (row) => {
        published += 1;
        assert.equal(row.fingerprint, `${key}:${reserved.crossedAt}`);
        return { created: true, id: 'n_2', revision: 2 };
      },
    });
    assert.equal(pushes, 1, 'the pending occurrence is delivered once the forecast verifies again');
    assert.equal(published, 1);
    assert.equal(delivered.notified.length, 1);
    assert.notEqual(Object.values(readBalanceAlertState(fixture.dir).alerts)[0].deliveryPending, true);
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('a pending retry never sends from a stale forecast', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const fail = async () => { throw new Error('channel down'); };
    await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify: fail, publishNotification: fail,
    });
    const reserved = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.equal(reserved.deliveryPending, true);

    // 30 days later the same snapshot endpoint is far outside the freshness
    // window, so the forecast is stale and must not drive a delivery.
    const staleNow = NOW + 30 * DAY;
    const staleReport = readBalanceForecastReport({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: staleNow,
    });
    assert.equal(staleReport.forecasts[0].status, 'stale');
    let pushes = 0;
    let published = 0;
    const deferred = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: staleNow,
      notify: async () => { pushes += 1; return { sent: 1 }; },
      publishNotification: async () => { published += 1; return { created: true, id: 'n_1', revision: 1 }; },
    });
    assert.equal(pushes, 0, 'a stale forecast never sends a push');
    assert.equal(published, 0, 'a stale forecast never publishes a UI row');
    assert.deepEqual(deferred.notified, []);
    const stillPending = Object.values(readBalanceAlertState(fixture.dir).alerts)[0];
    assert.equal(stillPending.deliveryPending, true, 'the occurrence stays reserved');
    assert.equal(stillPending.crossedAt, reserved.crossedAt, 'the original crossing is preserved');

    const delivered = await dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath,
      dataDir: fixture.dir,
      now: NOW,
      notify: async () => { pushes += 1; return { sent: 1 }; },
      publishNotification: async () => { published += 1; return { created: true, id: 'n_2', revision: 2 }; },
    });
    assert.equal(pushes, 1, 'the occurrence is delivered once the forecast is fresh again');
    assert.equal(published, 1);
    assert.equal(delivered.notified.length, 1);
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('overlapping dispatch passes deliver one crossing once', async () => {
  const fixture = createLedgerFixture();
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    let pushes = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const notify = async () => {
      pushes += 1;
      await gate;
    };
    const publishNotification = async () => {};
    const first = dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify, publishNotification,
    });
    const second = dispatchBalanceForecastAlerts({
      filePath: fixture.ledgerPath, dataDir: fixture.dir, now: NOW, notify, publishNotification,
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(pushes, 1, 'an overlapping pass never re-sends the same crossing');
    assert.equal(a.notified.length + b.notified.length, 1);
    assert.equal(Object.keys(readBalanceAlertState(fixture.dir).alerts).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('an unwritable state reservation surfaces before anything is sent', async () => {
  const fixture = createLedgerFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const blocked = path.join(fixture.dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    let pushes = 0;
    await assert.rejects(
      dispatchBalanceForecastAlerts({
        filePath: fixture.ledgerPath,
        dataDir: blocked,
        now: NOW,
        notify: async () => { pushes += 1; },
        publishNotification: async () => {},
      }),
      /balance_alert_state_unwritable/,
    );
    assert.equal(pushes, 0, 'the crossing is reserved durably before any channel is called');
  } finally {
    console.warn = warn;
    fixture.cleanup();
  }
});

test('pruning keeps an active crossing and evicts inactive entries first', () => {
  const activeKey = 'balance-alert:acct_1:CNY:deepseek-api:86400000';
  const stale = iso(NOW - 400 * DAY);
  const state = {
    version: 1,
    alerts: {
      [activeKey]: {
        active: true,
        crossedAt: stale,
        updatedAt: stale,
        remainingMs: HOUR,
        thresholdMs: BALANCE_ALERT_THRESHOLD_MS,
      },
      'inactive-old': { active: false, crossedAt: stale, updatedAt: stale },
      'inactive-new-1': { active: false, crossedAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY) },
      'inactive-new-2': { active: false, crossedAt: iso(NOW), updatedAt: iso(NOW) },
    },
  };
  const pruned = pruneBalanceAlertState(state, NOW);
  assert.ok(pruned.alerts[activeKey], 'an active crossing is never pruned by age');
  assert.equal(pruned.alerts['inactive-old'], undefined);

  const capped = pruneBalanceAlertState(state, NOW, { maxKeys: 2 });
  assert.ok(capped.alerts[activeKey], 'an active crossing survives the key cap');
  assert.equal(Object.keys(capped.alerts).length, 2);
  assert.ok(capped.alerts['inactive-new-2'], 'the newest inactive entry fills the remaining slot');
  assert.equal(capped.alerts['inactive-new-1'], undefined);
});

test('maintenance dispatch runs the forecast alert pass and tolerates a broken ledger', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cretli-balance-maintenance-'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const empty = await runBalanceForecastAlertsMaintenance({ dataDir: dir, now: NOW });
    assert.equal(empty.evaluated, 0);
    assert.deepEqual(empty.notified, []);

    writeFileSync(path.join(dir, 'credit-ledger.json'), '{ not json');
    const broken = await runBalanceForecastAlertsMaintenance({ dataDir: dir, now: NOW });
    assert.equal(broken, null, 'an unreadable ledger never breaks the maintenance loop');
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

function registerForecastRoute(filePath) {
  const routes = new Map();
  const app = {
    get: (route, handler) => routes.set(route, handler),
    post: () => {},
    put: () => {},
    delete: () => {},
  };
  registerCreditLedgerRoutes(app, { filePath });
  return routes.get('/api/credit-ledger/forecast');
}

function createResponseRecorder() {
  const recorder = {
    headers: {},
    code: 200,
    body: null,
    set(name, value) { recorder.headers[name] = value; return recorder; },
    status(code) { recorder.code = code; return recorder; },
    json(payload) { recorder.body = payload; return recorder; },
  };
  return recorder;
}

test('the forecast API route exposes the report without transaction delivery', () => {
  const fixture = createLedgerFixture();
  const realNow = Date.now;
  // Pin the clock so the report does not depend on wall-clock time under load.
  Date.now = () => NOW;
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const handler = registerForecastRoute(fixture.ledgerPath);
    assert.equal(typeof handler, 'function');
    const res = createResponseRecorder();
    handler({ headers: {} }, res);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.forecasts));
    assert.ok(Array.isArray(res.body.alerts));
    assert.ok(!JSON.stringify(res.body).includes('"transactions"'));
  } finally {
    Date.now = realNow;
    fixture.cleanup();
  }
});

test('the forecast API route denies widget/MCP callers with 403', () => {
  const handler = registerForecastRoute(path.join(tmpdir(), 'missing-credit-ledger.json'));
  const res = createResponseRecorder();
  handler({ headers: {}, widgetAccess: true }, res);
  assert.equal(res.code, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('the forecast route validator covers the whole live representation', () => {
  const fixture = createLedgerFixture();
  const realNow = Date.now;
  try {
    fixture.writeSnapshot(NOW - 7 * DAY, '100.00');
    fixture.writeSnapshot(NOW, '10.00');
    const handler = registerForecastRoute(fixture.ledgerPath);
    const first = createResponseRecorder();
    Date.now = () => NOW;
    handler({ headers: {} }, first);
    assert.ok(first.headers.ETag, 'the live report still carries a validator');
    assert.match(first.headers['Cache-Control'] || '', /no-store/);
    assert.notEqual(first.headers.ETag, `"${first.body.revision}"`, 'a revision-only validator would be stale');
    // A conditional request after the clock moved must not keep the old body.
    const second = createResponseRecorder();
    Date.now = () => NOW + HOUR;
    handler({ headers: {} }, second);
    assert.notEqual(second.headers.ETag, first.headers.ETag);
  } finally {
    Date.now = realNow;
    fixture.cleanup();
  }
});
