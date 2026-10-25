/**
 * Ledger operations behind the builtin billing MCP tools.
 *
 * Scope: the HTTP routes are owner-only and refuse MCP integration tokens, so
 * the in-process session is the only MCP path. A delegation child gets no
 * finance access at all (neither read nor write), which keeps its privileges
 * identical to before this feature. Plan/review denial of mutations is done by
 * the host policy from the tools' `readOnly` flag, not here.
 */

import path from 'node:path';
import {
  LedgerError,
  activeRows,
  createAccount,
  loadLedger,
  renameAccount,
  supersedeSnapshot,
  supersedeTransaction,
  tombstoneTransaction,
} from './credit-ledger-store.ts';
import type { LedgerAccount, LedgerDocument, LedgerSnapshot, LedgerTransaction } from './credit-ledger-store.ts';
import { importLedgerEntry, withAttachmentState } from './screen-import.ts';
import type { ImportInput } from './screen-import.ts';
import {
  confirmSubscriptionPayment,
  createSubscription,
  loadSubscriptions,
  readSubscriptionsView,
  transitionSubscription,
  updateSubscription,
} from './subscriptions.ts';
import type { SubscriptionInput } from './subscriptions.ts';

/** Raw tool input for a ledger row; fields are validated by the underlying modules. */
type LedgerRowInput = ImportInput & SubscriptionInput & { subscriptionId?: string; walletCurrency?: unknown };

/** `subscription_payment` is write-only (create): payments are listed inside their subscription. */
export const BILLING_KINDS = Object.freeze(['account', 'transaction', 'snapshot', 'subscription', 'subscription_payment']);

function uploadsDirFor(dataDir?: string): string {
  return path.join(String(dataDir || ''), 'uploads');
}

function collection(doc: LedgerDocument, kind: string) {
  if (kind === 'account') return doc.accounts;
  return kind === 'transaction' ? doc.transactions : doc.snapshots;
}

/** Active rows only unless `history`. */
export function listLedgerRows({ dataDir, kind, accountId, history = false }: { dataDir?: string; kind: string; accountId?: string; history?: boolean }): { items: object[]; revision: number } {
  if (!BILLING_KINDS.includes(kind)) throw new LedgerError('kind_invalid');
  if (kind === 'subscription') {
    const view = readSubscriptionsView({ dataDir });
    return { items: view.subscriptions, revision: view.revision };
  }
  if (kind === 'subscription_payment') throw new LedgerError('kind_invalid');
  const doc = loadLedger();
  let rows: Array<LedgerAccount | LedgerTransaction | LedgerSnapshot> = kind === 'account' ? doc.accounts : (history ? collection(doc, kind) : activeRows(collection(doc, kind) as Array<LedgerTransaction | LedgerSnapshot>));
  if (accountId && kind !== 'account') rows = (rows as Array<LedgerTransaction | LedgerSnapshot>).filter((r) => r.accountId === accountId);
  const uploads = uploadsDirFor(dataDir);
  return { items: kind === 'account' ? rows : rows.map((r) => withAttachmentState(r, uploads)), revision: doc.revision };
}

export function showLedgerRow({ dataDir, kind, id }: { dataDir?: string; kind: string; id: string }) {
  if (!BILLING_KINDS.includes(kind)) throw new LedgerError('kind_invalid');
  if (kind === 'subscription') {
    const doc = loadSubscriptions();
    const item = doc.subscriptions.find((s) => s.id === id);
    if (!item) throw new LedgerError('subscription_not_found', 404);
    return { item, revision: doc.revision };
  }
  if (kind === 'subscription_payment') throw new LedgerError('kind_invalid');
  const doc = loadLedger();
  const row = collection(doc, kind).find((r) => r.id === id);
  if (!row) throw new LedgerError(`${kind}_not_found`, 404);
  return { item: kind === 'account' ? row : withAttachmentState(row, uploadsDirFor(dataDir)), revision: doc.revision };
}

/** Creates an account; transactions and snapshots go through the screenshot-aware import. */
export function createLedgerRow({ dataDir, chatId, kind, input }: { dataDir?: string; chatId?: string; kind: string; input: LedgerRowInput }) {
  if (kind === 'subscription' || kind === 'subscription_payment') {
    // Same rule as transactions: persisting needs an explicit save request.
    if (input.save !== true) return { status: 'draft', reason: 'save_not_requested', saved: false };
    const res = kind === 'subscription'
      ? createSubscription({ input })
      : confirmSubscriptionPayment({ id: input.subscriptionId, input, uploadsDir: uploadsDirFor(dataDir) });
    return { status: 'saved', id: ((res.payment || res.subscription) as { id: string }).id, ...res };
  }
  if (kind === 'account') {
    return createAccount({ label: input.label, walletCurrency: input.walletCurrency, idempotencyKey: input.idempotencyKey });
  }
  return importLedgerEntry({
    uploadsDir: uploadsDirFor(dataDir), chatId,
    // Persisting finance data needs an explicit save request; omitting it must
    // stay a draft so a mistaken read never writes on its own.
    input: { ...input, kind, save: input.save === true },
  });
}

export function updateLedgerRow({ kind, id, patch, withdraw = false }: { kind: string; id: string; patch?: Record<string, unknown>; withdraw?: boolean }) {
  if (kind === 'subscription') {
    if (withdraw) throw new LedgerError('withdraw_not_supported');
    // A state change is recorded, never executed at the provider.
    // `allowDuplicate` is always present in the tool's patch mapping and is transaction-only.
    const { state, at, allowDuplicate: _ignored, ...rest } = patch || {};
    if (state !== undefined && Object.keys(rest).length) throw new LedgerError('use_dedicated_operation');
    return state !== undefined
      ? transitionSubscription({ id, state, at })
      : updateSubscription({ id, patch: rest });
  }
  if (kind === 'account') return renameAccount({ id, label: patch?.label });
  if (kind === 'transaction') {
    return withdraw
      ? tombstoneTransaction({ id, reason: patch?.reason })
      : supersedeTransaction({ id, input: patch || {} });
  }
  if (kind === 'snapshot') {
    return supersedeSnapshot({ id, input: patch || {}, tombstone: withdraw });
  }
  throw new LedgerError('kind_invalid');
}

