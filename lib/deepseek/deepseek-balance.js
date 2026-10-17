/**
 * DeepSeek account balance (`GET {endpoint}/user/balance`).
 *
 * Contract (https://api-docs.deepseek.com/api/get-user-balance/):
 * `{ is_available: boolean, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }` with amounts as exact decimal
 * strings. Amounts are kept verbatim (never parsed to float, currencies never
 * summed). `is_available=false` is an availability state, not a read error and
 * not a zero balance.
 *
 * A failed read (401/429/5xx/timeout/invalid schema) writes no snapshot, never
 * overwrites the last stored balance and never touches manual ledger entries.
 * The credential comes from the existing effective-key resolver through the
 * billing registry; the key is never logged or returned.
 */

import { resolveHarnessBillingCredential, resolveBillingAccountForUsage } from '../usage/billing-account-registry.js';
import {
  createAccount,
  loadLedger,
  activeRows,
  recordSnapshot,
} from '../credit-ledger/credit-ledger-store.js';
import { clearInsufficientBalanceLimit } from '../harness-usage-limits.js';

const HARNESS = 'deepseek';
/** Snapshot series used for provider-read balances (kept apart from manual entries). */
export const DEEPSEEK_BALANCE_SERIES = 'deepseek-api';
export const DEEPSEEK_BALANCE_SOURCE = 'deepseek-api';

/**
 * Default freshness threshold: a provider balance reading older than 36 h is
 * reported as stale (a daily refresh plus one missed cycle of slack). Stale
 * readings are still shown, never treated as zero or as proof of availability.
 */
export const DEEPSEEK_BALANCE_FRESHNESS_MS = 36 * 60 * 60 * 1000;
/** Scheduled refresh cadence while the server runs (no backfill after a pause). */
export const DEEPSEEK_BALANCE_DAILY_MS = 24 * 60 * 60 * 1000;
/** Minimum spacing between attempts per reason (cache). */
const MIN_INTERVAL_MS = Object.freeze({ manual: 5_000, topup: 60_000, daily: 60_000 });
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3,10}$/;

/** In-memory attempt state keyed by ledger file + billing account. */
const attemptState = new Map();

/**
 * Validates the `/user/balance` JSON body.
 *
 * @param {unknown} body
 * @returns {{ ok: true, isAvailable: boolean, balances: Array<{ currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string }> } | { ok: false }}
 */
export function parseDeepSeekBalanceResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  if (typeof body.is_available !== 'boolean') return { ok: false };
  if (!Array.isArray(body.balance_infos)) return { ok: false };
  const balances = [];
  const seen = new Set();
  for (const row of body.balance_infos) {
    if (!row || typeof row !== 'object') return { ok: false };
    const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
    if (!CURRENCY_RE.test(currency) || seen.has(currency)) return { ok: false };
    for (const field of ['total_balance', 'granted_balance', 'topped_up_balance']) {
      if (typeof row[field] !== 'string' || !DECIMAL_RE.test(row[field].trim())) return { ok: false };
    }
    seen.add(currency);
    balances.push({
      currency,
      totalBalance: row.total_balance.trim(),
      grantedBalance: row.granted_balance.trim(),
      toppedUpBalance: row.topped_up_balance.trim(),
    });
  }
  return { ok: true, isAvailable: body.is_available, balances };
}

/**
 * Classifies an HTTP status of a failed read.
 *
 * @param {number} status
 * @returns {'auth'|'rate_limited'|'server'|'http'}
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'http';
}

/**
 * One HTTP read. Never throws; never includes the key or amounts in errors.
 *
 * @param {{ endpoint: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ ok: true, isAvailable: boolean, balances: object[], requestId?: string } | { ok: false, kind: string, status?: number, requestId?: string }>}
 */
export async function fetchDeepSeekBalance(input) {
  const doFetch = input.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${String(input.endpoint).replace(/\/+$/, '')}/user/balance`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
    });
    const requestId = res.headers?.get?.('x-request-id') || res.headers?.get?.('x-ds-trace-id') || undefined;
    if (!res.ok) {
      return { ok: false, kind: classifyStatus(res.status), status: res.status, ...(requestId ? { requestId } : {}) };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: 'invalid_schema', status: res.status, ...(requestId ? { requestId } : {}) };
    }
    const parsed = parseDeepSeekBalanceResponse(body);
    if (!parsed.ok) return { ok: false, kind: 'invalid_schema', status: res.status, ...(requestId ? { requestId } : {}) };
    return { ok: true, isAvailable: parsed.isAvailable, balances: parsed.balances, ...(requestId ? { requestId } : {}) };
  } catch (err) {
    return { ok: false, kind: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Billing account bound to the current DeepSeek credential, without
 * registering a new one. Used to tag a balance lockout with a safe id.
 *
 * @param {{ dataDir?: string }} [ctx]
 * @returns {{ accountId?: string }}
 */
export function resolveDeepSeekLimitBinding(ctx = {}) {
  try {
    const resolved = resolveBillingAccountForUsage(
      { harness: HARNESS },
      { ...(ctx.dataDir ? { dataDir: ctx.dataDir } : {}), autoRegister: false },
    );
    if (resolved.accountId && resolved.identityStatus !== 'pending_identity') return { accountId: resolved.accountId };
  } catch { /* binding is best-effort */ }
  return {};
}

/** Idempotency key linking a ledger account to a billing registry account. */
function ledgerLinkKey(accountId) {
  return `billing-account:${accountId}`;
}

function nowIso(now) {
  return new Date(now).toISOString();
}

/**
 * Latest provider-read snapshots for a billing account, with freshness.
 *
 * @param {{ accountId?: string, ledgerPath?: string, now?: number, freshnessMs?: number }} [input]
 * @returns {{ accountId: string, observedAt: string|null, stale: boolean, freshnessMs: number, isAvailable: boolean|null, balances: object[] }}
 */
export function readDeepSeekBalanceStatus(input = {}) {
  const freshnessMs = input.freshnessMs || DEEPSEEK_BALANCE_FRESHNESS_MS;
  const now = input.now ?? Date.now();
  const accountId = String(input.accountId || resolveDeepSeekLimitBinding({}).accountId || '');
  const empty = { accountId, observedAt: null, stale: true, freshnessMs, isAvailable: null, balances: [] };
  if (!accountId) return empty;
  const doc = loadLedger(input.ledgerPath);
  const ledgerAccount = doc.accounts.find((a) => a.idempotencyKey === ledgerLinkKey(accountId));
  if (!ledgerAccount) return empty;
  const latest = new Map();
  for (const s of activeRows(doc.snapshots)) {
    if (s.accountId !== ledgerAccount.id || s.series !== DEEPSEEK_BALANCE_SERIES) continue;
    const at = s.observedAt?.at || '';
    const cur = latest.get(s.currency);
    if (!cur || at > (cur.observedAt?.at || '')) latest.set(s.currency, s);
  }
  const rows = [...latest.values()];
  if (!rows.length) return empty;
  const newest = rows.map((r) => r.observedAt.at).sort().at(-1);
  return {
    accountId,
    observedAt: newest,
    stale: now - Date.parse(newest) > freshnessMs,
    freshnessMs,
    isAvailable: rows.find((r) => r.observedAt.at === newest)?.isAvailable ?? null,
    balances: rows.map((r) => ({
      currency: r.currency,
      totalBalance: r.totalBalance?.value ?? null,
      grantedBalance: r.grantedBalance?.value ?? null,
      toppedUpBalance: r.toppedUpBalance?.value ?? null,
      observedAt: r.observedAt.at,
    })),
  };
}

function ensureLedgerAccount(ledgerPath, accountId, walletCurrency) {
  const doc = loadLedger(ledgerPath);
  const existing = doc.accounts.find((a) => a.idempotencyKey === ledgerLinkKey(accountId));
  if (existing) return existing;
  return createAccount({
    filePath: ledgerPath,
    label: 'DeepSeek API',
    walletCurrency,
    idempotencyKey: ledgerLinkKey(accountId),
  }).account;
}

/**
 * Refreshes the balance, records one snapshot per currency and, on a fresh
 * `is_available=true`, lifts only this account's `insufficient_balance` lockout.
 *
 * @param {{ reason?: 'manual'|'topup'|'daily', ledgerPath?: string, dataDir?: string, now?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>} `{ ok, kind, ... }`; `skipped: true` when throttled.
 */
export async function refreshDeepSeekBalance(options = {}) {
  const reason = MIN_INTERVAL_MS[options.reason] ? options.reason : 'manual';
  const now = options.now ?? Date.now();
  const cred = resolveHarnessBillingCredential(HARNESS);
  if (!cred || !cred.credentialMaterial) return { ok: false, kind: 'no_key' };
  const ctx = options.dataDir ? { dataDir: options.dataDir } : {};
  const binding = resolveBillingAccountForUsage({ harness: HARNESS }, ctx);
  // A pending identity may be a different wallet: never attach a reading to it.
  if (!binding.accountId || binding.identityStatus === 'pending_identity') {
    return { ok: false, kind: 'identity_pending' };
  }
  const accountId = binding.accountId;
  const stateKey = `${options.ledgerPath || ''}|${accountId}`;
  const state = attemptState.get(stateKey) || { lastAttemptAt: 0, failures: 0, nextAllowedAt: 0 };
  if (now - state.lastAttemptAt < MIN_INTERVAL_MS[reason]) return { ok: false, kind: 'throttled', skipped: true, accountId };
  // Manual refresh bypasses backoff; automatic reasons honour it.
  if (reason !== 'manual' && now < state.nextAllowedAt) {
    return { ok: false, kind: 'backoff', skipped: true, accountId, retryAt: nowIso(state.nextAllowedAt) };
  }
  state.lastAttemptAt = now;
  attemptState.set(stateKey, state);
  const result = await fetchDeepSeekBalance({
    endpoint: cred.endpoint,
    apiKey: cred.credentialMaterial,
    fetchImpl: options.fetchImpl,
  });
  if (!result.ok) {
    state.failures += 1;
    state.nextAllowedAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.failures - 1));
    return { ok: false, kind: result.kind, accountId, ...(result.status ? { status: result.status } : {}), ...(result.requestId ? { requestId: result.requestId } : {}) };
  }
  state.failures = 0;
  state.nextAllowedAt = 0;
  const observedAt = nowIso(now);
  const snapshots = [];
  if (result.balances.length) {
    const ledgerAccount = ensureLedgerAccount(options.ledgerPath, accountId, result.balances[0].currency);
    for (const b of result.balances) {
      const written = recordSnapshot({
        filePath: options.ledgerPath,
        input: {
          accountId: ledgerAccount.id,
          currency: b.currency,
          series: DEEPSEEK_BALANCE_SERIES,
          totalBalance: b.totalBalance,
          grantedBalance: b.grantedBalance,
          toppedUpBalance: b.toppedUpBalance,
          isAvailable: result.isAvailable,
          observedAt,
          source: DEEPSEEK_BALANCE_SOURCE,
          completeness: 'complete',
          idempotencyKey: `deepseek-balance:${accountId}:${b.currency}:${observedAt}`,
        },
      });
      snapshots.push(written.snapshot.id);
    }
  }
  // Only a fresh availability proof for the same account/key lifts the block.
  const unlocked = result.isAvailable === true
    ? clearInsufficientBalanceLimit({ harness: HARNESS, accountId, dataDir: options.dataDir })
    : 0;
  return {
    ok: true,
    kind: 'ok',
    accountId,
    isAvailable: result.isAvailable,
    balances: result.balances,
    observedAt,
    snapshots: snapshots.length,
    unlocked,
    ...(result.requestId ? { requestId: result.requestId } : {}),
  };
}

/**
 * Starts the daily refresh. A check runs hourly and refreshes only when the
 * last provider reading is older than a day; after a server pause exactly one
 * current reading is taken (no historical backfill).
 *
 * @param {{ ledgerPath?: string, dataDir?: string, checkEveryMs?: number }} [options]
 * @returns {() => void} stop function
 */
export function startDeepSeekBalanceScheduler(options = {}) {
  const tick = () => {
    try {
      const status = readDeepSeekBalanceStatus({ ledgerPath: options.ledgerPath, freshnessMs: DEEPSEEK_BALANCE_DAILY_MS });
      if (status.accountId && !status.stale) return;
      void refreshDeepSeekBalance({ reason: 'daily', ledgerPath: options.ledgerPath, dataDir: options.dataDir })
        .catch(() => {});
    } catch { /* never break the server loop */ }
  };
  const timer = setInterval(tick, options.checkEveryMs || 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
  return () => clearInterval(timer);
}

/** Test helper: forgets throttle/backoff state. */
export function resetDeepSeekBalanceAttemptState() {
  attemptState.clear();
}
