/**
 * Subscription register: plan, price, billing cycle, state and limit view.
 *
 * Separation rules (stage 8):
 * - Cash and quota are different things. A subscription fee is cash and only a
 *   *confirmed* payment counts; quota consumption comes from the existing
 *   plan-limit history (`lib/usage/plan-limit-history.js`) and never carries
 *   money. This module does not measure limits itself.
 * - A scheduled payment is derived from the cycle calendar and stays "planned".
 *   It becomes a payment record only through `confirmSubscriptionPayment`, which
 *   needs evidence: a verified upload (existing file, hash computed here) or an
 *   operator-attested provider transaction id.
 * - Nothing here buys, renews or cancels anything. "cancelled" is a state the
 *   operator records after doing that at the provider.
 * - Subscription fees never enter the prepaid wallet ledger, so a subscription
 *   harness and an API wallet cannot be counted twice.
 *
 * Persistence: `credit-subscriptions.json` next to the credit ledger file,
 * written with tmp+rename; `revision` is the optimistic-lock token.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { readHarnessPlanLimitHistory } from '../usage/plan-limit-history.ts';
import { LedgerError, resolveCreditLedgerPath } from './credit-ledger-store.ts';
import { verifyUploadAttachment } from './screen-import.ts';
import { addDecimal, formatDecimal, parseDecimal } from './decimal.ts';
import type { Decimal } from './decimal.ts';

export type SubscriptionInterval = 'month' | 'year';

export interface SubscriptionCycle {
  interval: SubscriptionInterval;
  anchorDate: string;
}

export interface SubscriptionMoney {
  value: string;
  currency: string;
}

export interface SubscriptionLimit {
  label: string | null;
  utilization: number | null;
  resetsAt: string | null;
  observedAt: string;
  source: 'manual';
}

export interface SubscriptionPayment {
  id: string;
  dueDate: string;
  paidAt: string | null;
  paid: SubscriptionMoney;
  providerTransactionId: string | null;
  attachmentRef: string | null;
  imageHash: string | null;
  source: string | null;
  confirmedAt: string;
}

export interface Subscription {
  id: string;
  label: string | null;
  provider: string;
  plan: string | null;
  billingAccountId: string | null;
  harness: string | null;
  price: SubscriptionMoney;
  cycle: SubscriptionCycle;
  endsAt: string | null;
  limit: SubscriptionLimit | null;
  source: string | null;
  attachmentRef: string | null;
  state: string;
  stateHistory: Array<{ state: string; at: string }>;
  priceHistory: Array<{ price: SubscriptionMoney; cycle: SubscriptionCycle; until: string }>;
  cycleHistory?: Array<{ cycle: SubscriptionCycle; until: string }>;
  payments: SubscriptionPayment[];
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionsDocument {
  version: number;
  revision: number;
  subscriptions: Subscription[];
}

/** Plan-limit history row (only the fields this module reads). */
export interface PlanLimitRow {
  harness?: string;
  rateLimitType?: string;
  observedAt?: string;
  resetsAt?: string | null;
  status?: string | null;
  utilization?: number | null;
}

/** Loosely-typed caller input (tool arguments / request body); validated at runtime. */
export interface SubscriptionInput {
  idempotencyKey?: unknown;
  state?: unknown;
  label?: unknown;
  provider?: unknown;
  plan?: unknown;
  billingAccountId?: unknown;
  harness?: unknown;
  price?: unknown;
  cycle?: { interval?: unknown; anchorDate?: unknown };
  interval?: unknown;
  anchorDate?: unknown;
  endsAt?: unknown;
  limit?: unknown;
  source?: unknown;
  attachmentRef?: unknown;
  payments?: unknown;
  [key: string]: unknown;
}

interface MutateOutcome {
  noWrite?: boolean;
  value: Record<string, unknown>;
}

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

export const SUBSCRIPTIONS_SCHEMA_VERSION = 1;
export const SUBSCRIPTION_STATES = Object.freeze(['active', 'paused', 'past_due', 'cancelled', 'ended']);
export const SUBSCRIPTION_INTERVALS = Object.freeze(['month', 'year']);

/** Allowed state moves. `ended` is terminal; reactivation goes through `active`. */
const STATE_TRANSITIONS: Readonly<Record<string, string[]>> = Object.freeze({
  active: ['paused', 'past_due', 'cancelled', 'ended'],
  paused: ['active', 'past_due', 'cancelled', 'ended'],
  past_due: ['active', 'paused', 'cancelled', 'ended'],
  cancelled: ['active', 'ended'],
  ended: [],
});

/**
 * Services the operator typically runs. Only a hint for which accounts to add;
 * no price, no endpoint, no data fetch. `balanceApi` records what was verified
 * in this repo: only DeepSeek has a provider balance reader (a wallet, not a
 * subscription), so subscription data is manual or screenshot-based.
 */
export const SERVICE_CATALOG = Object.freeze([
  { service: 'openrouter', harnesses: ['openrouter'], billingClass: 'api_metered', accountKind: 'wallet', balanceApi: 'not_integrated' },
  { service: 'cursor', harnesses: ['sdk', 'cursor'], billingClass: 'subscription_quota', accountKind: 'subscription', balanceApi: 'none_verified' },
  { service: 'codex', harnesses: ['codex'], billingClass: 'subscription_quota', accountKind: 'subscription', balanceApi: 'none_verified' },
  { service: 'claude', harnesses: ['claude'], billingClass: 'subscription_quota', accountKind: 'subscription', balanceApi: 'none_verified' },
]);

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RE = /^[A-Z0-9_]{2,16}$/;
const TEXT_MAX = 200;

export function resolveSubscriptionsPath(ledgerPath?: unknown): string {
  return path.join(path.dirname(resolveCreditLedgerPath(ledgerPath)), 'credit-subscriptions.json');
}

// ---------------------------------------------------------------- calendar

/** Returns null unless the value is a real calendar day. */
export function parseDay(value: unknown): CalendarDay | null {
  const match = ISO_DAY_RE.exec(String(value ?? ''));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 2026-02-30 into March; reject anything that did not round-trip.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Days in the 1-based month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDay({ y, m, d }: CalendarDay): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The n-th payment date of a cycle. Always derived from the anchor (never from
 * the previous occurrence), so a 31st anchor gives Feb 28/29 and returns to the
 * 31st afterwards; a Feb 29 yearly anchor gives Feb 28 in non-leap years.
 * Dates are calendar days: no time zone is invented.
 *
 * @param anchor YYYY-MM-DD of the first payment
 * @param n zero-based occurrence index
 */
export function cycleOccurrence(anchor: string, interval: SubscriptionInterval, n: number): string {
  const a = parseDay(anchor);
  if (!a || !SUBSCRIPTION_INTERVALS.includes(interval) || !Number.isInteger(n) || n < 0) {
    throw new LedgerError('cycle_invalid');
  }
  const monthIndex = a.y * 12 + (a.m - 1) + n * (interval === 'year' ? 12 : 1);
  const y = Math.floor(monthIndex / 12);
  const m = (monthIndex % 12) + 1;
  return formatDay({ y, m, d: Math.min(a.d, daysInMonth(y, m)) });
}

/** Index of the first occurrence on or after `day`. */
function firstOccurrenceIndexOnOrAfter(anchor: string, interval: SubscriptionInterval, day: string): number {
  const a = parseDay(anchor) as CalendarDay;
  const target = parseDay(day) as CalendarDay;
  if (formatDay(target) <= formatDay(a)) return 0;
  const months = (target.y - a.y) * 12 + (target.m - a.m);
  let n = Math.max(0, Math.floor(months / (interval === 'year' ? 12 : 1)) - 1);
  while (cycleOccurrence(anchor, interval, n) < formatDay(target)) n += 1;
  return n;
}

/** Whether `day` is exactly one of the cycle's payment dates. */
export function isCycleDate(anchor: string, interval: SubscriptionInterval, day: string): boolean {
  if (!parseDay(day) || formatDay(parseDay(anchor) as CalendarDay) > day) return false;
  return cycleOccurrence(anchor, interval, firstOccurrenceIndexOnOrAfter(anchor, interval, day)) === day;
}

// ----------------------------------------------------------- persistence

function emptyDocument(): SubscriptionsDocument {
  return { version: SUBSCRIPTIONS_SCHEMA_VERSION, revision: 0, subscriptions: [] };
}

export function loadSubscriptions(ledgerPath?: unknown): SubscriptionsDocument {
  const file = resolveSubscriptionsPath(ledgerPath);
  if (!fs.existsSync(file)) return emptyDocument();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...emptyDocument(),
      revision: Number(parsed.revision) || 0,
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
    };
  } catch {
    // A corrupt file must not be silently replaced by an empty register.
    throw new LedgerError('subscriptions_unreadable', 500);
  }
}

function mutate(ledgerPath: unknown, expectedRevision: unknown, apply: (doc: SubscriptionsDocument) => MutateOutcome): Record<string, unknown> & { revision: number } {
  const file = resolveSubscriptionsPath(ledgerPath);
  const doc = loadSubscriptions(ledgerPath);
  const result = apply(doc);
  if (result?.noWrite) return { ...result.value, revision: doc.revision };
  if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== doc.revision) {
    throw new LedgerError('revision_conflict', 409, { revision: doc.revision });
  }
  doc.revision += 1;
  writeJsonAtomic(file, doc);
  return { ...result.value, revision: doc.revision };
}

// ------------------------------------------------------------ validation

function text(value: unknown, { required = false, field = 'field' }: { required?: boolean; field?: string } = {}): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LedgerError(`${field}_required`);
    return null;
  }
  const s = String(value).trim();
  if (!s || s.length > TEXT_MAX || /[\r\n]/.test(s)) throw new LedgerError(`${field}_invalid`);
  return s;
}

function money(input: unknown, field: string): SubscriptionMoney {
  // Stored rows use `value`; request bodies use `amount`.
  const m = input as { amount?: unknown; value?: unknown; currency?: unknown } | null | undefined;
  const dec = parseDecimal(m?.amount ?? m?.value);
  if (!dec || dec.units < 0n) throw new LedgerError(`${field}_amount_invalid`);
  const cur = String(m?.currency ?? '').trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) throw new LedgerError(`${field}_currency_invalid`);
  return { value: formatDecimal(dec), currency: cur };
}

function day(value: unknown, field: string, { required = false }: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LedgerError(`${field}_required`);
    return null;
  }
  if (!parseDay(value)) throw new LedgerError(`${field}_invalid`);
  return String(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function manualLimit(rawInput: unknown): SubscriptionLimit | null {
  if (rawInput === undefined || rawInput === null) return null;
  const input = rawInput as { utilization?: unknown; resetsAt?: unknown; label?: unknown; observedAt?: unknown };
  const utilization = input.utilization == null || input.utilization === '' ? null : Number(input.utilization);
  if (utilization !== null && (!Number.isFinite(utilization) || utilization < 0)) throw new LedgerError('limit_utilization_invalid');
  const resetsAt = input.resetsAt ? new Date(String(input.resetsAt)) : null;
  if (resetsAt && Number.isNaN(resetsAt.getTime())) throw new LedgerError('limit_resets_at_invalid');
  return {
    label: text(input.label, { field: 'limit_label' }),
    utilization,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    observedAt: new Date((input.observedAt || Date.now()) as string | number).toISOString(),
    source: 'manual',
  };
}

type SubscriptionFields = Pick<Subscription, 'label' | 'provider' | 'plan' | 'billingAccountId' | 'harness' | 'price' | 'cycle' | 'endsAt' | 'limit' | 'source' | 'attachmentRef'>;

function buildFields(input: SubscriptionInput, existing: Subscription | null = null): SubscriptionFields {
  const merged: SubscriptionInput = { ...(existing || {}), ...input };
  const interval = String(merged.cycle?.interval ?? merged.interval ?? '');
  if (!SUBSCRIPTION_INTERVALS.includes(interval)) throw new LedgerError('interval_invalid');
  const anchorDate = day(merged.cycle?.anchorDate ?? merged.anchorDate, 'anchor_date', { required: true });
  return {
    label: text(merged.label, { required: true, field: 'label' }),
    provider: (text(merged.provider, { required: true, field: 'provider' }) as string).toLowerCase(),
    plan: text(merged.plan, { required: true, field: 'plan' }),
    // Link to the billing-account registry (display/grouping only).
    billingAccountId: text(merged.billingAccountId, { field: 'billing_account_id' }),
    // Harness whose plan-limit readings describe this plan's quota.
    harness: text(merged.harness, { field: 'harness' })?.toLowerCase() ?? null,
    price: money(merged.price, 'price'),
    cycle: { interval: interval as SubscriptionInterval, anchorDate: anchorDate as string },
    endsAt: day(merged.endsAt, 'ends_at'),
    limit: manualLimit(merged.limit),
    source: text(merged.source, { required: true, field: 'source' }),
    attachmentRef: text(merged.attachmentRef, { field: 'attachment_ref' }),
  };
}

// ------------------------------------------------------------ operations

/** Creates a subscription in state `active` (or the given initial state). */
export function createSubscription({ ledgerPath, expectedRevision = undefined, input }: { ledgerPath?: unknown; expectedRevision?: unknown; input?: SubscriptionInput }) {
  return mutate(ledgerPath, expectedRevision, (doc) => {
    const key = text(input?.idempotencyKey, { field: 'idempotency_key' });
    const hit = key && doc.subscriptions.find((s) => s.idempotencyKey === key);
    if (hit) return { noWrite: true, value: { subscription: hit, deduplicated: 'idempotency_key' } };
    const state = String(input?.state || 'active');
    if (!SUBSCRIPTION_STATES.includes(state)) throw new LedgerError('state_invalid');
    const now = new Date().toISOString();
    const row: Subscription = {
      id: newId('sub'),
      ...buildFields(input || {}),
      state,
      stateHistory: [{ state, at: now }],
      priceHistory: [],
      payments: [],
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
    };
    doc.subscriptions.push(row);
    return { value: { subscription: row, deduplicated: null } };
  });
}

function requireSubscription(doc: SubscriptionsDocument, id: string): Subscription {
  const sub = doc.subscriptions.find((s) => s.id === id);
  if (!sub) throw new LedgerError('subscription_not_found', 404);
  return sub;
}

/**
 * Edits plan/price/cycle/limits. A price change keeps the previous price in
 * `priceHistory`; a cycle change (interval or anchorDate) keeps the previous
 * cycle in the optional `cycleHistory` (`{ cycle, until }`). Confirmed payments
 * are never rewritten or dropped; a cycle change that would leave a confirmed
 * future payment off the new calendar is refused. State changes go through
 * {@link transitionSubscription}.
 */
export function updateSubscription({ ledgerPath, expectedRevision = undefined, id, patch }: { ledgerPath?: unknown; expectedRevision?: unknown; id?: unknown; patch?: SubscriptionInput }) {
  return mutate(ledgerPath, expectedRevision, (doc) => {
    const sub = requireSubscription(doc, String(id || ''));
    const { state, payments, ...rest } = patch || {};
    if (state !== undefined || payments !== undefined) throw new LedgerError('use_dedicated_operation');
    const next = buildFields(rest, sub);
    const now = new Date().toISOString();
    if (next.price.value !== sub.price.value || next.price.currency !== sub.price.currency) {
      sub.priceHistory.push({ price: sub.price, cycle: sub.cycle, until: now });
    }
    if (next.cycle.interval !== sub.cycle.interval || next.cycle.anchorDate !== sub.cycle.anchorDate) {
      const today = now.slice(0, 10);
      const clash = (sub.payments || []).find((p) => p.dueDate > today
        && !isCycleDate(next.cycle.anchorDate, next.cycle.interval, p.dueDate));
      if (clash) throw new LedgerError('cycle_change_conflicts_with_confirmed_payment', 409);
      sub.cycleHistory = [...(sub.cycleHistory || []), { cycle: sub.cycle, until: now }];
    }
    Object.assign(sub, next, { updatedAt: now });
    return { value: { subscription: sub, deduplicated: null } };
  });
}

/** Records a state the operator already caused at the provider; executes nothing. */
export function transitionSubscription({ ledgerPath, expectedRevision = undefined, id, state, at }: { ledgerPath?: unknown; expectedRevision?: unknown; id?: unknown; state?: unknown; at?: unknown }) {
  return mutate(ledgerPath, expectedRevision, (doc) => {
    const sub = requireSubscription(doc, String(id || ''));
    if (!SUBSCRIPTION_STATES.includes(state as string)) throw new LedgerError('state_invalid');
    const nextState = state as string;
    if (!STATE_TRANSITIONS[sub.state].includes(nextState)) throw new LedgerError('state_transition_invalid', 409);
    const when = at ? new Date(String(at)) : new Date();
    if (Number.isNaN(when.getTime())) throw new LedgerError('at_invalid');
    sub.state = nextState;
    sub.stateHistory.push({ state: nextState, at: when.toISOString() });
    sub.updatedAt = new Date().toISOString();
    return { value: { subscription: sub, deduplicated: null } };
  });
}

/**
 * Confirms that one scheduled payment really happened. Requires the due date to
 * be an actual cycle date and reliable evidence (provider transaction id,
 * attachment reference or image hash); a plain claim is refused. The payment is
 * cash only: it is never written into the prepaid wallet ledger.
 */
export function confirmSubscriptionPayment({ ledgerPath, expectedRevision = undefined, id, input, uploadsDir }: { ledgerPath?: unknown; expectedRevision?: unknown; id?: unknown; input?: SubscriptionInput & { dueDate?: unknown; paidAt?: unknown; paid?: unknown; providerTransactionId?: unknown; imageHash?: unknown }; uploadsDir: string }) {
  return mutate(ledgerPath, expectedRevision, (doc) => {
    const sub = requireSubscription(doc, String(id || ''));
    const dueDate = day(input?.dueDate, 'due_date', { required: true });
    if (!isCycleDate(sub.cycle.anchorDate, sub.cycle.interval, dueDate as string)) throw new LedgerError('due_date_not_in_cycle');
    // The provider transaction id is an operator attestation: the app cannot
    // check it against the provider. An upload reference is verified: it must be
    // an existing file in the upload store, and the hash is computed from it.
    const providerTransactionId = text(input?.providerTransactionId, { field: 'provider_transaction_id' });
    const claimedHash = text(input?.imageHash, { field: 'image_hash' });
    let attachmentRef: string | null = null;
    let imageHash: string | null = null;
    if (input?.attachmentRef !== undefined && input?.attachmentRef !== null && String(input.attachmentRef).trim() !== '') {
      const verified = verifyUploadAttachment(input.attachmentRef, uploadsDir);
      if (claimedHash && claimedHash.toLowerCase() !== verified.imageHash) throw new LedgerError('image_hash_mismatch');
      ({ attachmentRef, imageHash } = verified);
    } else if (claimedHash) {
      // A bare hash cannot be verified without the file, so it proves nothing.
      throw new LedgerError('image_hash_unverifiable');
    }
    if (!providerTransactionId && !attachmentRef) throw new LedgerError('payment_evidence_required');
    const existing = sub.payments.find((p) => p.dueDate === dueDate);
    if (existing) return { noWrite: true, value: { subscription: sub, payment: existing, deduplicated: 'due_date' } };
    if (providerTransactionId && doc.subscriptions.some((s) => s.payments.some((p) => p.providerTransactionId === providerTransactionId))) {
      throw new LedgerError('provider_transaction_reused', 409);
    }
    if (imageHash && doc.subscriptions.some((s) => s.payments.some((p) => p.imageHash === imageHash))) {
      throw new LedgerError('attachment_reused', 409);
    }
    const paidAt = day(input?.paidAt, 'paid_at', { required: true });
    const payment: SubscriptionPayment = {
      id: newId('subpay'),
      dueDate: dueDate as string,
      paidAt,
      paid: money(input?.paid, 'paid'),
      providerTransactionId,
      attachmentRef,
      imageHash,
      source: text(input?.source, { required: true, field: 'source' }),
      confirmedAt: new Date().toISOString(),
    };
    sub.payments.push(payment);
    sub.updatedAt = payment.confirmedAt;
    return { value: { subscription: sub, payment, deduplicated: null } };
  });
}

// ------------------------------------------------------------------ views

/**
 * Latest reading per rate-limit window from the shared plan-limit history. The
 * quota reset is independent of the billing cycle: it is whatever the provider
 * reported, and an elapsed reset marks the reading outdated instead of
 * pretending the quota is still consumed.
 */
export function buildLimitView(sub: Subscription, { asOf, historyRows }: { asOf: string; historyRows?: PlanLimitRow[] }) {
  const nowMs = Date.parse(asOf);
  const latest = new Map<string, PlanLimitRow>();
  for (const row of historyRows || []) {
    if (!sub.harness || String(row.harness || '').toLowerCase() !== sub.harness) continue;
    const key = String(row.rateLimitType || 'default');
    const cur = latest.get(key);
    if (!cur || String(row.observedAt) >= String(cur.observedAt)) latest.set(key, row);
  }
  const windows = [...latest.entries()].map(([rateLimitType, row]) => {
    const resetMs = row.resetsAt ? Date.parse(row.resetsAt) : NaN;
    return {
      rateLimitType,
      status: row.status ?? null,
      utilization: row.utilization ?? null,
      resetsAt: row.resetsAt ?? null,
      observedAt: row.observedAt,
      resetElapsed: Number.isFinite(resetMs) && resetMs <= nowMs,
      source: 'plan-limit-history',
    };
  }).sort((a, b) => a.rateLimitType.localeCompare(b.rateLimitType));
  if (!windows.length && sub.limit) {
    const resetMs = sub.limit.resetsAt ? Date.parse(sub.limit.resetsAt) : NaN;
    windows.push({
      rateLimitType: sub.limit.label || 'manual',
      status: null,
      utilization: sub.limit.utilization,
      resetsAt: sub.limit.resetsAt,
      observedAt: sub.limit.observedAt,
      resetElapsed: Number.isFinite(resetMs) && resetMs <= nowMs,
      source: 'manual',
    });
  }
  return windows;
}

/**
 * Payment schedule for the view. Planned dates come from the calendar and are
 * never marked paid; only confirmed payments are. `awaitingConfirmation` is the
 * most recent past due date without evidence, so a missed confirmation is
 * visible instead of silently assumed paid.
 */
export function buildPaymentSchedule(sub: Subscription, asOfDay: string) {
  const { anchorDate, interval } = sub.cycle;
  const confirmed = new Set(sub.payments.map((p) => p.dueDate));
  const live = sub.state === 'active' || sub.state === 'past_due';
  // Occurrences on or before the latest cycle change belong to the old cycle;
  // their payments are listed as confirmed, never as missing on the new calendar.
  const changedDay = (sub.cycleHistory || []).reduce((m, h) => (h.until.slice(0, 10) > m ? h.until.slice(0, 10) : m), '');
  const confirmedPayments = sub.payments.map((p) => ({ dueDate: p.dueDate, state: 'confirmed', confirmed: true }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const withinEnd = (date: string) => !sub.endsAt || date <= sub.endsAt;
  let next: { dueDate: string; state: string; confirmed: boolean } | null = null;
  let awaitingConfirmation: { dueDate: string; state: string; confirmed: boolean } | null = null;
  if (live) {
    const nextIdx = firstOccurrenceIndexOnOrAfter(anchorDate, interval, asOfDay);
    for (let n = nextIdx; n < nextIdx + 3; n += 1) {
      const date = cycleOccurrence(anchorDate, interval, n);
      if (!withinEnd(date)) break;
      if (!confirmed.has(date)) { next = { dueDate: date, state: 'planned', confirmed: false }; break; }
    }
    if (nextIdx > 0) {
      const last = cycleOccurrence(anchorDate, interval, nextIdx - 1);
      if (!confirmed.has(last) && withinEnd(last) && last > changedDay) awaitingConfirmation = { dueDate: last, state: 'planned', confirmed: false };
    }
  }
  return { nextPayment: next, awaitingConfirmation, confirmedPayments };
}

/**
 * Calendar day (YYYY-MM-DD) of an instant in an IANA zone. Without a zone the
 * server zone is used, then UTC when the runtime cannot report one. An unknown
 * zone is a readable validation error (`time_zone_invalid`), never a crash.
 */
export function todayInZone(asOf: string, timeZone?: string | null): string {
  const instant = new Date(asOf);
  if (Number.isNaN(instant.getTime())) throw new LedgerError('as_of_invalid');
  let zone = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!zone) {
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { zone = 'UTC'; }
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  } catch {
    throw new LedgerError('time_zone_invalid');
  }
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function buildSubscriptionView(sub: Subscription, ctx: { asOf?: string; historyRows?: PlanLimitRow[]; timeZone?: string | null } = {}) {
  const asOf = ctx.asOf || new Date().toISOString();
  // "Today" is the owner's calendar day; anchor and due dates stay plain calendar dates.
  const schedule = buildPaymentSchedule(sub, todayInZone(asOf, ctx.timeZone));
  return {
    ...sub,
    ...schedule,
    limits: buildLimitView(sub, { asOf, historyRows: ctx.historyRows }),
  };
}

/** Confirmed cash per currency, newest state of every subscription; no conversion. */
export function summarizeSubscriptionCash(subscriptions: Array<Pick<Subscription, 'payments'>>) {
  const totals: Record<string, Decimal> = {};
  for (const sub of subscriptions) {
    for (const p of sub.payments || []) {
      const dec = parseDecimal(p.paid.value) as Decimal;
      totals[p.paid.currency] = addDecimal(totals[p.paid.currency] || { units: 0n, scale: 0 }, dec);
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([cur, v]) => [cur, formatDecimal(v)]));
}

/**
 * Cost accounting split that avoids double counting. Subscription fees are the
 * confirmed payments only; usage events of class `subscription_quota` add no
 * money (they are counted, not priced); API estimates come from `api_metered`
 * events only. A harness never contributes to both columns.
 */
export function buildCostSeparation({ subscriptions, usageEvents = [] }: { subscriptions: Array<Pick<Subscription, 'payments'>>; usageEvents?: Array<{ billingClass?: string; usd?: number | null }> }) {
  let apiUsd = 0;
  let apiEvents = 0;
  let quotaEvents = 0;
  let unknownEvents = 0;
  for (const ev of usageEvents) {
    if (ev.billingClass === 'subscription_quota') quotaEvents += 1;
    else if (ev.billingClass === 'api_metered') {
      apiEvents += 1;
      if (Number.isFinite(ev.usd)) apiUsd += ev.usd as number;
    } else unknownEvents += 1;
  }
  return {
    subscriptionCash: summarizeSubscriptionCash(subscriptions),
    api: { events: apiEvents, estimatedUsd: apiUsd },
    subscriptionQuota: { events: quotaEvents, money: null },
    unclassifiedEvents: unknownEvents,
  };
}

/**
 * Accounts worth adding, from the services actually in use. Pure: the caller
 * passes the harness ids seen in bindings/plan-limit history.
 */
export function suggestAccounts({ harnesses = [], subscriptions = [], billingAccounts = [] }: { harnesses?: string[]; subscriptions?: Array<{ state: string; provider: string }>; billingAccounts?: Array<{ provider?: string }> } = {}) {
  const used = new Set(harnesses.map((h) => String(h).toLowerCase()));
  const providers = new Set(billingAccounts.map((a) => String(a.provider || '').toLowerCase()));
  const subProviders = new Set(subscriptions.filter((s) => s.state !== 'ended').map((s) => s.provider));
  return SERVICE_CATALOG
    .filter((svc) => svc.harnesses.some((h) => used.has(h)))
    .filter((svc) => (svc.accountKind === 'subscription' ? !subProviders.has(svc.service) : !providers.has(svc.service)))
    .map((svc) => ({ ...svc }));
}

/** Full read model for the API/UI. */
export function readSubscriptionsView({ ledgerPath, asOf, timeZone, dataDir, harnesses = [], billingAccounts = [] }: { ledgerPath?: string; asOf?: string; timeZone?: string | null; dataDir?: string; harnesses?: string[]; billingAccounts?: Array<{ provider?: string }> } = {}) {
  const doc = loadSubscriptions(ledgerPath);
  const historyRows = readHarnessPlanLimitHistory({ dataDir });
  const subscriptions = doc.subscriptions.map((s) => buildSubscriptionView(s, { asOf, historyRows, timeZone }));
  const seen = new Set([...harnesses, ...historyRows.map((r) => r.harness)]);
  return {
    revision: doc.revision,
    subscriptions,
    cash: summarizeSubscriptionCash(doc.subscriptions),
    suggestions: suggestAccounts({ harnesses: [...seen], subscriptions: doc.subscriptions, billingAccounts }),
  };
}
