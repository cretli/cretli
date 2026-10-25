/**
 * Links between harness bindings (billing registry) and credit-ledger wallets.
 *
 * A ledger account is linked to a registry account through the idempotency key
 * `billing-account:<registryId>` (see `harnesses/deepseek/deepseek-balance.js`). Several bindings
 * can point at one wallet; the UI shows that wallet once and lists the
 * harnesses, so this module only reports the relation and never sums anything.
 */

import { loadBillingAccountsDocument } from '../persist/billing-accounts-persist.js';
import { loadLedger } from './credit-ledger-store.ts';

/** Billing registry account (only the fields read here). */
export interface BillingAccountLike {
  accountId?: string;
  label?: string;
  bindings?: Array<{ harness?: string; profileKey?: string } | null | undefined>;
}

/** Ledger account (only the fields read here). */
export interface LedgerAccountLike {
  id: string;
  idempotencyKey?: string | null;
}

export interface HarnessLink {
  harness: string;
  profileKey: string;
  billingAccountId: string;
  billingLabel: string;
  ledgerAccountId: string | null;
}

const LINK_KEY_PREFIX = 'billing-account:';

export function buildHarnessLinks(input: { billingAccounts?: BillingAccountLike[]; ledgerAccounts?: LedgerAccountLike[] } = {}): HarnessLink[] {
  const ledgerAccounts = Array.isArray(input.ledgerAccounts) ? input.ledgerAccounts : [];
  const byKey = new Map(ledgerAccounts.filter((a) => a?.idempotencyKey).map((a): [string, LedgerAccountLike] => [a.idempotencyKey as string, a]));
  const links: HarnessLink[] = [];
  for (const account of Array.isArray(input.billingAccounts) ? input.billingAccounts : []) {
    const wallet = byKey.get(`${LINK_KEY_PREFIX}${account.accountId}`) || null;
    for (const binding of Array.isArray(account.bindings) ? account.bindings : []) {
      if (!binding?.harness) continue;
      links.push({
        harness: String(binding.harness),
        profileKey: String(binding.profileKey || 'default'),
        billingAccountId: String(account.accountId),
        billingLabel: String(account.label || account.accountId),
        ledgerAccountId: wallet ? wallet.id : null,
      });
    }
  }
  return links.sort((a, b) => a.harness.localeCompare(b.harness) || a.profileKey.localeCompare(b.profileKey));
}

export function readHarnessLinks(input: { ledgerPath?: string; billingPath?: string } = {}): HarnessLink[] {
  const ledger = loadLedger(input.ledgerPath);
  const billing = loadBillingAccountsDocument({ filePath: input.billingPath });
  return buildHarnessLinks({ billingAccounts: billing.accounts, ledgerAccounts: ledger.accounts });
}
