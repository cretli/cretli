/**
 * Credit ledger: accounts, transactions and balance observations.
 *
 * Persistence: one JSON document (`data/credit-ledger.json`) written with
 * tmp+rename. Every mutation is a synchronous load → apply → save cycle on the
 * single Node thread, so concurrent API calls are serialized and a restart only
 * ever sees whole documents. The document `revision` is the optimistic-lock
 * token exposed as the HTTP ETag.
 *
 * Money rules: amounts are decimal strings (BigInt math, explicit scale);
 * currencies are never summed or converted. `payment` (what was paid) is kept
 * apart from `credit` (what was booked in the wallet currency).
 * Snapshots are observations, not transactions. Corrections append a record
 * with `supersedes`; withdrawal appends a tombstone. Nothing is deleted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { addDecimal, formatDecimal, negateDecimal, parseDecimal } from './decimal.ts';
import type { Decimal } from './decimal.ts';

/** Normalized moment (see {@link normalizeMoment}). */
export interface LedgerMoment {
  at: string | null;
  date: string | null;
  precision: 'instant' | 'hour' | 'day';
  sourceZone: string | null;
  uncertain: boolean;
}

/** Validated amount: decimal string kept verbatim plus its scale. */
export interface LedgerAmount {
  value: string;
  scale: number;
}

export interface LedgerMoney extends LedgerAmount {
  currency: string;
}

export interface LedgerAccount {
  id: string;
  label: string | null;
  walletCurrency: string;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface LedgerTransaction {
  id: string;
  accountId: string;
  type: string;
  state: string;
  occurredAt: LedgerMoment;
  source: string | null;
  providerTransactionId: string | null;
  idempotencyKey: string | null;
  imageHash: string | null;
  chatRef: string | null;
  attachmentRef: string | null;
  payment: LedgerMoney | null;
  credit: LedgerMoney;
  expiresAt: LedgerMoment | null;
  supersedes: string | null;
  tombstone: boolean;
  possibleDuplicateOf: string[];
  recordedAt: string;
  reason?: string | null;
  attachmentRemoved?: boolean;
}

export interface LedgerSnapshot {
  id: string;
  accountId: string;
  currency: string;
  series: string | null;
  totalBalance: LedgerAmount | null;
  grantedBalance: LedgerAmount | null;
  toppedUpBalance: LedgerAmount | null;
  isAvailable: boolean | null;
  observedAt: LedgerMoment;
  source: string | null;
  imageHash: string | null;
  chatRef: string | null;
  attachmentRef: string | null;
  completeness: string;
  boundaryUncertain: boolean;
  idempotencyKey: string | null;
  supersedes: string | null;
  tombstone: boolean;
  recordedAt: string;
}

export interface LedgerDocument {
  version: number;
  revision: number;
  accounts: LedgerAccount[];
  transactions: LedgerTransaction[];
  snapshots: LedgerSnapshot[];
}

/** Money-like caller input; fields are validated at runtime. */
export interface LedgerMoneyInput {
  amount?: unknown;
  currency?: unknown;
}

/** Caller input for a transaction (parsed JSON / tool arguments); validated at runtime. */
export interface TransactionInput {
  accountId?: unknown;
  type?: unknown;
  state?: unknown;
  credit?: LedgerMoneyInput;
  payment?: LedgerMoneyInput | null;
  expiresAt?: unknown;
  occurredAt?: unknown;
  source?: unknown;
  providerTransactionId?: unknown;
  idempotencyKey?: unknown;
  imageHash?: unknown;
  chatRef?: unknown;
  attachmentRef?: unknown;
  [key: string]: unknown;
}

/** Caller input for a balance snapshot; validated at runtime. */
export interface SnapshotInput {
  accountId?: unknown;
  currency?: unknown;
  completeness?: unknown;
  observedAt?: unknown;
  series?: unknown;
  totalBalance?: unknown;
  grantedBalance?: unknown;
  toppedUpBalance?: unknown;
  isAvailable?: unknown;
  source?: unknown;
  imageHash?: unknown;
  chatRef?: unknown;
  attachmentRef?: unknown;
  boundaryUncertain?: unknown;
  idempotencyKey?: unknown;
  [key: string]: unknown;
}

/** Result envelope used by {@link mutate}. */
interface MutateOutcome {
  noWrite?: boolean;
  value: Record<string, unknown>;
}

export const CREDIT_LEDGER_SCHEMA_VERSION = 1;
export const TRANSACTION_TYPES = ['topup', 'refund', 'grant', 'adjustment', 'expiry'];
export const TRANSACTION_STATES = ['pending', 'posted'];
export const COMPLETENESS = ['complete', 'partial', 'unknown'];
const CURRENCY_RE = /^[A-Z0-9_]{2,16}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 200;

/** Error carrying an HTTP-friendly code. */
export class LedgerError extends Error {
  declare code: string;
  declare status: number;
  declare revision?: number;
  constructor(code: string, status = 400, extra: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export function resolveCreditLedgerPath(filePath?: unknown): string {
  return String(filePath || '').trim() || resolveDataPath('credit-ledger.json');
}

function emptyDocument(): LedgerDocument {
  return { version: CREDIT_LEDGER_SCHEMA_VERSION, revision: 0, accounts: [], transactions: [], snapshots: [] };
}

export function loadLedger(filePath?: unknown): LedgerDocument {
  const file = resolveCreditLedgerPath(filePath);
  if (!fs.existsSync(file)) return emptyDocument();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...emptyDocument(),
      revision: Number(parsed.revision) || 0,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    };
  } catch {
    // A corrupt file must not be silently replaced by an empty ledger.
    throw new LedgerError('ledger_unreadable', 500);
  }
}

function text(value: unknown, { required = false, field = 'field' }: { required?: boolean; field?: string } = {}): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LedgerError(`${field}_required`);
    return null;
  }
  const s = String(value).trim();
  if (!s || s.length > TEXT_MAX || /[\r\n]/.test(s)) throw new LedgerError(`${field}_invalid`);
  return s;
}

function currency(value: unknown, field: string): string {
  const s = String(value ?? '').trim().toUpperCase();
  if (!CURRENCY_RE.test(s)) throw new LedgerError(`${field}_invalid`);
  return s;
}

/** Validates an amount string and returns `{ value, scale }` (value kept verbatim). */
function amount(value: unknown, field: string, { allowNegative = false }: { allowNegative?: boolean } = {}): LedgerAmount {
  const dec = parseDecimal(value);
  if (!dec) throw new LedgerError(`${field}_invalid`);
  if (!allowNegative && dec.units < 0n) throw new LedgerError(`${field}_negative`);
  return { value: formatDecimal(dec), scale: dec.scale };
}

/**
 * Normalizes a moment. Date-only input keeps precision "day" (no invented
 * midnight); zone-less hour input needs a source zone to be a precise bound.
 */
export function normalizeMoment(input: unknown, field: string): LedgerMoment {
  const raw = (typeof input === 'string' ? { value: input } : (input || {})) as Record<string, unknown>;
  const value = String(raw.value ?? raw.at ?? raw.date ?? '').trim();
  const sourceZone = text(raw.sourceZone, { field: `${field}_zone` });
  if (ISO_INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new LedgerError(`${field}_invalid`);
    return { at: new Date(ms).toISOString(), date: null, precision: 'instant', sourceZone, uncertain: false };
  }
  if (ISO_HOUR_RE.test(value) && Number.isFinite(Date.parse(`${value}:00:00Z`))) {
    return { at: null, date: value, precision: 'hour', sourceZone, uncertain: true };
  }
  if (ISO_DAY_RE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    return { at: null, date: value, precision: 'day', sourceZone, uncertain: true };
  }
  throw new LedgerError(`${field}_invalid`);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function mutate(filePath: unknown, expectedRevision: unknown, apply: (doc: LedgerDocument) => MutateOutcome): Record<string, unknown> & { revision: number } {
  const file = resolveCreditLedgerPath(filePath);
  const doc = loadLedger(file);
  const result = apply(doc);
  if (result?.noWrite) return { ...result.value, revision: doc.revision };
  if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== doc.revision) {
    throw new LedgerError('revision_conflict', 409, { revision: doc.revision });
  }
  doc.revision += 1;
  writeJsonAtomic(file, doc);
  return { ...result.value, revision: doc.revision };
}

function requireAccount(doc: LedgerDocument, accountId: unknown): LedgerAccount {
  const account = doc.accounts.find((a) => a.id === accountId);
  if (!account) throw new LedgerError('account_not_found', 404);
  return account;
}

/** Ids of records that are superseded or tombstoned targets. */
function supersededIds(rows: Array<{ supersedes: string | null }>): Set<string | null> {
  return new Set(rows.map((r) => r.supersedes).filter(Boolean));
}

/** Active = latest non-superseded version that is not a tombstone. */
export function activeRows<T extends { id: string; supersedes: string | null; tombstone: boolean }>(rows: T[]): T[] {
  const dead = supersededIds(rows);
  return rows.filter((r) => !dead.has(r.id) && !r.tombstone);
}

/** Creates an account. Wallet currency is fixed per account. */
export function createAccount({ filePath, expectedRevision = undefined, label, walletCurrency, idempotencyKey }: { filePath?: unknown; expectedRevision?: unknown; label?: unknown; walletCurrency?: unknown; idempotencyKey?: unknown }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const key = text(idempotencyKey, { field: 'idempotency_key' });
    const existing = key && doc.accounts.find((a) => a.idempotencyKey === key);
    if (existing) return { noWrite: true, value: { account: existing, deduplicated: 'idempotency_key' } };
    const account: LedgerAccount = {
      id: newId('acct'),
      label: text(label, { required: true, field: 'label' }),
      walletCurrency: currency(walletCurrency, 'wallet_currency'),
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
    };
    doc.accounts.push(account);
    return { value: { account, deduplicated: null } };
  });
}

/** Renames an account. The wallet currency is fixed and cannot be changed. */
export function renameAccount({ filePath, expectedRevision = undefined, id, label }: { filePath?: unknown; expectedRevision?: unknown; id?: unknown; label?: unknown }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const account = requireAccount(doc, String(id || ''));
    account.label = text(label, { required: true, field: 'label' });
    account.updatedAt = new Date().toISOString();
    return { value: { account, deduplicated: null } };
  });
}

type BuiltTransaction = Omit<LedgerTransaction, 'id' | 'supersedes' | 'tombstone' | 'possibleDuplicateOf' | 'recordedAt'>;

function buildTransaction(doc: LedgerDocument, input: TransactionInput, account: LedgerAccount): BuiltTransaction {
  const type = String(input.type || '');
  if (!TRANSACTION_TYPES.includes(type)) throw new LedgerError('type_invalid');
  const state = String(input.state || 'posted');
  if (!TRANSACTION_STATES.includes(state)) throw new LedgerError('state_invalid');
  const creditCurrency = currency(input.credit?.currency ?? account.walletCurrency, 'credit_currency');
  if (creditCurrency !== account.walletCurrency) throw new LedgerError('credit_currency_mismatch');
  const credit = {
    ...amount(input.credit?.amount, 'credit_amount', { allowNegative: type === 'adjustment' }),
    currency: creditCurrency,
  };
  let payment: LedgerMoney | null = null;
  if (input.payment) {
    payment = { ...amount(input.payment.amount, 'payment_amount'), currency: currency(input.payment.currency, 'payment_currency') };
  }
  // expiresAt is stored only when the caller supplied it; it is never derived.
  const expiresAt = input.expiresAt ? normalizeMoment(input.expiresAt, 'expires_at') : null;
  return {
    accountId: account.id,
    type,
    state,
    occurredAt: normalizeMoment(input.occurredAt, 'occurred_at'),
    source: text(input.source, { required: true, field: 'source' }),
    providerTransactionId: text(input.providerTransactionId, { field: 'provider_transaction_id' }),
    idempotencyKey: text(input.idempotencyKey, { field: 'idempotency_key' }),
    imageHash: text(input.imageHash, { field: 'image_hash' }),
    chatRef: text(input.chatRef, { field: 'chat_ref' }),
    attachmentRef: text(input.attachmentRef, { field: 'attachment_ref' }),
    payment,
    credit,
    expiresAt,
  };
}

function signature(tx: BuiltTransaction): string {
  return JSON.stringify([tx.accountId, tx.type, tx.state, tx.credit, tx.payment, tx.providerTransactionId, tx.imageHash]);
}

/** Heuristic hints only: same account + amount + currency + day, never merged. */
function findPossibleDuplicates(rows: LedgerTransaction[], tx: BuiltTransaction): string[] {
  const day = (tx.occurredAt.at || tx.occurredAt.date || '').slice(0, 10);
  return rows
    .filter((r) => r.accountId === tx.accountId && r.credit.value === tx.credit.value
      && r.credit.currency === tx.credit.currency && r.type === tx.type
      && (r.occurredAt.at || r.occurredAt.date || '').slice(0, 10) === day)
    .map((r) => r.id);
}

/**
 * Records a transaction. Dedup order: idempotency key, then accountId +
 * providerTransactionId, then image hash. A match returns the existing row.
 */
export function recordTransaction({ filePath, expectedRevision = undefined, input }: { filePath?: unknown; expectedRevision?: unknown; input?: TransactionInput }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const account = requireAccount(doc, String(input?.accountId || ''));
    const tx = buildTransaction(doc, input || {}, account);
    const active = activeRows(doc.transactions);
    if (tx.idempotencyKey) {
      const hit = doc.transactions.find((r) => r.accountId === tx.accountId && r.idempotencyKey === tx.idempotencyKey);
      if (hit) {
        if (signature(hit) !== signature(tx)) throw new LedgerError('idempotency_key_reused', 409);
        return { noWrite: true, value: { transaction: hit, deduplicated: 'idempotency_key' } };
      }
    }
    if (tx.providerTransactionId) {
      const hit = active.find((r) => r.accountId === tx.accountId && r.providerTransactionId === tx.providerTransactionId);
      if (hit) return { noWrite: true, value: { transaction: hit, deduplicated: 'provider_transaction_id' } };
    }
    if (tx.imageHash) {
      const hit = active.find((r) => r.accountId === tx.accountId && r.imageHash === tx.imageHash);
      if (hit) return { noWrite: true, value: { transaction: hit, deduplicated: 'image_hash' } };
    }
    const row: LedgerTransaction = {
      id: newId('tx'),
      ...tx,
      supersedes: null,
      tombstone: false,
      possibleDuplicateOf: findPossibleDuplicates(active, tx),
      recordedAt: new Date().toISOString(),
    };
    doc.transactions.push(row);
    return { value: { transaction: row, deduplicated: null } };
  });
}

/**
 * Dry run of {@link recordTransaction}: validates and reports what a write would
 * do (dedup hit or heuristic duplicate hints) without touching the file.
 */
export function previewTransaction({ filePath, input }: { filePath?: unknown; input?: TransactionInput }) {
  const doc = loadLedger(resolveCreditLedgerPath(filePath));
  const account = requireAccount(doc, String(input?.accountId || ''));
  const tx = buildTransaction(doc, input || {}, account);
  const active = activeRows(doc.transactions);
  const keyHit = tx.idempotencyKey
    && doc.transactions.find((r) => r.accountId === tx.accountId && r.idempotencyKey === tx.idempotencyKey);
  const providerHit = tx.providerTransactionId
    && active.find((r) => r.accountId === tx.accountId && r.providerTransactionId === tx.providerTransactionId);
  const imageHit = tx.imageHash
    && active.find((r) => r.accountId === tx.accountId && r.imageHash === tx.imageHash);
  const existing = keyHit || providerHit || imageHit || null;
  return {
    transaction: tx,
    existing,
    possibleDuplicateOf: existing ? [] : findPossibleDuplicates(active, tx),
  };
}

/** Appends a corrected version of an active transaction (`supersedes` = old id). */
export function supersedeTransaction({ filePath, expectedRevision = undefined, id, input }: { filePath?: unknown; expectedRevision?: unknown; id?: unknown; input?: TransactionInput }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const old = activeRows(doc.transactions).find((r) => r.id === id);
    if (!old) throw new LedgerError('transaction_not_found', 404);
    const account = requireAccount(doc, old.accountId);
    const merged = { ...old, ...input, accountId: old.accountId };
    const tx = buildTransaction(doc, merged, account);
    const row: LedgerTransaction = {
      id: newId('tx'), ...tx, supersedes: old.id, tombstone: false,
      possibleDuplicateOf: [], recordedAt: new Date().toISOString(),
    };
    doc.transactions.push(row);
    return { value: { transaction: row } };
  });
}

/** Withdraws an active transaction by appending a tombstone; history is kept. */
export function tombstoneTransaction({ filePath, expectedRevision = undefined, id, reason }: { filePath?: unknown; expectedRevision?: unknown; id?: unknown; reason?: unknown }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const old = activeRows(doc.transactions).find((r) => r.id === id);
    if (!old) throw new LedgerError('transaction_not_found', 404);
    const row = {
      ...old, id: newId('tx'), supersedes: old.id, tombstone: true,
      reason: text(reason, { field: 'reason' }), recordedAt: new Date().toISOString(),
    };
    doc.transactions.push(row);
    return { value: { transaction: row } };
  });
}

type BuiltSnapshot = Omit<LedgerSnapshot, 'id' | 'idempotencyKey' | 'supersedes' | 'tombstone' | 'recordedAt'>;

function buildSnapshot(doc: LedgerDocument, input: SnapshotInput): BuiltSnapshot {
  const account = requireAccount(doc, String(input.accountId || ''));
  const cur = currency(input.currency ?? account.walletCurrency, 'currency');
  const completeness = String(input.completeness || 'unknown');
  if (!COMPLETENESS.includes(completeness)) throw new LedgerError('completeness_invalid');
  const observedAt = normalizeMoment(input.observedAt, 'observed_at');
  const optional = (v: unknown, f: string) => (v === undefined || v === null ? null : amount(v, f, { allowNegative: true }));
  return {
    accountId: account.id,
    currency: cur,
    series: text(input.series ?? 'default', { field: 'series' }),
    totalBalance: optional(input.totalBalance, 'total_balance'),
    grantedBalance: optional(input.grantedBalance, 'granted_balance'),
    toppedUpBalance: optional(input.toppedUpBalance, 'topped_up_balance'),
    isAvailable: typeof input.isAvailable === 'boolean' ? input.isAvailable : null,
    observedAt,
    source: text(input.source, { required: true, field: 'source' }),
    imageHash: text(input.imageHash, { field: 'image_hash' }),
    chatRef: text(input.chatRef, { field: 'chat_ref' }),
    attachmentRef: text(input.attachmentRef, { field: 'attachment_ref' }),
    completeness,
    // An unclear observation boundary is flagged, never guessed.
    boundaryUncertain: observedAt.uncertain || input.boundaryUncertain === true,
  };
}

/** Appends a balance observation (not a transaction). Dedup by idempotency key. */
export function recordSnapshot({ filePath, expectedRevision = undefined, input }: { filePath?: unknown; expectedRevision?: unknown; input?: SnapshotInput }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const key = text(input?.idempotencyKey, { field: 'idempotency_key' });
    if (key) {
      const hit = doc.snapshots.find((s) => s.accountId === input?.accountId && s.idempotencyKey === key);
      if (hit) return { noWrite: true, value: { snapshot: hit, deduplicated: 'idempotency_key' } };
    }
    const snap = buildSnapshot(doc, input || {});
    if (snap.imageHash) {
      const hit = activeRows(doc.snapshots).find((s) => s.accountId === snap.accountId && s.imageHash === snap.imageHash);
      if (hit) return { noWrite: true, value: { snapshot: hit, deduplicated: 'image_hash' } };
    }
    const row: LedgerSnapshot = {
      id: newId('snap'), ...snap, idempotencyKey: key, supersedes: null, tombstone: false,
      recordedAt: new Date().toISOString(),
    };
    doc.snapshots.push(row);
    return { value: { snapshot: row, deduplicated: null } };
  });
}

/** Correction or withdrawal of an active snapshot. */
export function supersedeSnapshot({ filePath, expectedRevision = undefined, id, input, tombstone = false }: { filePath?: unknown; expectedRevision?: unknown; id?: unknown; input?: SnapshotInput; tombstone?: boolean }) {
  return mutate(filePath, expectedRevision, (doc) => {
    const old = activeRows(doc.snapshots).find((s) => s.id === id);
    if (!old) throw new LedgerError('snapshot_not_found', 404);
    const base = tombstone ? old : { ...buildSnapshot(doc, { ...old, ...input, accountId: old.accountId }) };
    const row: LedgerSnapshot = {
      ...base, id: newId('snap'), idempotencyKey: null, supersedes: old.id,
      tombstone, recordedAt: new Date().toISOString(),
    };
    doc.snapshots.push(row);
    return { value: { snapshot: row } };
  });
}

/**
 * Chat/file removal only drops the reference; the transaction stays.
 * Appends a corrected version (supersedes) marked `attachmentRemoved`.
 */
export function detachReferences({ filePath, chatId, attachmentRef }: { filePath?: unknown; chatId?: unknown; attachmentRef?: unknown }) {
  return mutate(filePath, undefined, (doc) => {
    const hits = activeRows(doc.transactions).filter((r) =>
      (chatId && r.chatRef === chatId) || (attachmentRef && r.attachmentRef === attachmentRef));
    for (const old of hits) {
      doc.transactions.push({
        ...old, id: newId('tx'), supersedes: old.id, chatRef: null, attachmentRef: null,
        attachmentRemoved: true, recordedAt: new Date().toISOString(),
      });
    }
    return { value: { detached: hits.length } };
  });
}

/**
 * Derived views from active versions only. Balances are per account and
 * currency; payments and credits are reported separately; no cross-currency sum.
 */
export function buildViews(doc: LedgerDocument) {
  const txs = activeRows(doc.transactions);
  const accounts = doc.accounts.map((account) => {
    const balances: Record<string, { posted: Decimal; pending: Decimal }> = {};
    const payments: Record<string, Decimal> = {};
    for (const tx of txs.filter((t) => t.accountId === account.id)) {
      const bucket = tx.state === 'posted' ? 'posted' : 'pending';
      const sign = tx.type === 'refund' || tx.type === 'expiry' ? -1 : 1;
      const cd = parseDecimal(tx.credit.value) as Decimal;
      const signed = sign < 0 ? negateDecimal(cd) : cd;
      const slot = (balances[tx.credit.currency] ||= { posted: { units: 0n, scale: 0 }, pending: { units: 0n, scale: 0 } });
      slot[bucket] = addDecimal(slot[bucket], signed);
      if (tx.payment) {
        const pslot = (payments[tx.payment.currency] ||= { units: 0n, scale: 0 });
        const pd = parseDecimal(tx.payment.value) as Decimal;
        payments[tx.payment.currency] = addDecimal(pslot, sign < 0 ? negateDecimal(pd) : pd);
      }
    }
    const fmt = (m: Record<string, { posted: Decimal; pending: Decimal } | Decimal>) => Object.fromEntries(Object.entries(m).map(([c, v]) => [c, 'posted' in v
      ? { posted: formatDecimal(v.posted), pending: formatDecimal(v.pending) }
      : formatDecimal(v)]));
    const latest: Record<string, LedgerSnapshot> = {};
    for (const s of activeRows(doc.snapshots).filter((x) => x.accountId === account.id)) {
      const k = `${s.currency}/${s.series}`;
      const cur = latest[k];
      const key = (x: LedgerSnapshot) => x.observedAt.at || x.observedAt.date || '';
      if (!cur || key(s) > key(cur) || (key(s) === key(cur) && s.recordedAt > cur.recordedAt)) latest[k] = s;
    }
    return { ...account, creditBalances: fmt(balances), paymentTotals: fmt(payments), latestSnapshots: latest };
  });
  return { accounts };
}

/** Full read model for the API. */
export function readLedgerView({ filePath }: { filePath?: unknown }) {
  const doc = loadLedger(filePath);
  return {
    revision: doc.revision,
    accounts: doc.accounts,
    transactions: doc.transactions,
    snapshots: doc.snapshots,
    views: buildViews(doc),
  };
}
