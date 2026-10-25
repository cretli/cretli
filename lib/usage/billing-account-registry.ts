/**
 * Billing accounts: durable registry, credential fingerprints and harness bindings.
 *
 * Wallets are never inferred from model names. Each account is keyed by provider,
 * endpoint and an explicit binding (harness + profile). The same API key on two
 * endpoints or two providers is two accounts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCORING_FACT_BILLING_CLASSES } from '../model-facts/schema.ts';
import type { ScoringFactBillingClass } from '../model-facts/schema.ts';
import { resolveDataPath } from '../runtime-paths.js';
import { resolveTelemetryBillingClass } from '../model-facts/telemetry.ts';
import {
  loadBillingAccountsDocument,
  saveBillingAccountsDocument,
  BILLING_ACCOUNTS_SCHEMA_VERSION,
} from '../persist/billing-accounts-persist.js';
import { loadBillingAccountHmacSecret } from './billing-account-secret.ts';
import {
  fingerprintBillingCredential,
  normalizeEndpoint,
} from './billing-account-fingerprint.ts';
import { getHarnessBillingCredentialSource } from '../agent-harness/optional-harness-hooks.ts';

export const BILLING_ACCOUNT_IDENTITY_STATUSES = Object.freeze([
  'active',
  'pending_identity',
]);

const BILLING_CLASS_SET = new Set(SCORING_FACT_BILLING_CLASSES);

/**
 * Legacy `billingMode` on usage events maps to {@link SCORING_FACT_BILLING_CLASSES}
 * via {@link resolveTelemetryBillingClass}; this helper documents the subscription
 * alias only (no second vocabulary).
 *
 * @param {unknown} billingMode
 * @returns {'subscription_quota'|undefined}
 */
export function billingModeToDeclaredClass(billingMode) {
  const mode = String(billingMode ?? '').trim().toLowerCase();
  if (mode === 'subscription') return 'subscription_quota';
  if (mode === 'local') return 'local';
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {'api_metered'|'subscription_quota'|'local'|'unknown'}
 */
export function normalizeAccountBillingClass(value) {
  const billing = String(value ?? '').trim().toLowerCase();
  return (BILLING_CLASS_SET as Set<string>).has(billing) ? (billing as ScoringFactBillingClass) : 'unknown';
}

/**
 * @param {Record<string, any>} binding
 * @returns {string}
 */
export function bindingLookupKey(binding) {
  const harness = String(binding?.harness || '').trim().toLowerCase();
  const profileKey = String(binding?.profileKey ?? 'default').trim().toLowerCase() || 'default';
  const endpoint = normalizeEndpoint(binding?.endpoint || binding?.baseUrl);
  return `${harness}|${profileKey}|${endpoint}`;
}

/**
 * @param {Record<string, any>} account
 * @param {Record<string, any>} binding
 * @returns {boolean}
 */
function accountHasBinding(account, binding) {
  const key = bindingLookupKey(binding);
  const bindings = Array.isArray(account?.bindings) ? account.bindings : [];
  return bindings.some((row) => bindingLookupKey(row) === key);
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeBillingAccount(input) {
  const accountId = String(input?.accountId || '').trim();
  if (!accountId) throw new Error('billing account requires accountId');
  const bindings = Array.isArray(input.bindings) ? input.bindings.map((row) => ({
    harness: String(row?.harness || '').trim().toLowerCase(),
    profileKey: String(row?.profileKey ?? 'default').trim().toLowerCase() || 'default',
    endpoint: normalizeEndpoint(row?.endpoint || row?.baseUrl),
  })) : [];
  const currencies = Array.isArray(input.currencies)
    ? input.currencies.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const identityStatus = BILLING_ACCOUNT_IDENTITY_STATUSES.includes(input?.identityStatus)
    ? input.identityStatus
    : 'active';
  return {
    accountId,
    label: String(input?.label || accountId).trim(),
    provider: String(input?.provider || '').trim().toLowerCase(),
    endpoint: normalizeEndpoint(input?.endpoint || input?.baseUrl),
    currencies: currencies.length ? currencies : ['USD'],
    billingClass: normalizeAccountBillingClass(input?.billingClass),
    bindings,
    keyFingerprint: String(input?.keyFingerprint || '').trim(),
    fingerprintSecretId: String(input?.fingerprintSecretId || '').trim(),
    identityStatus,
    knownFingerprints: Array.isArray(input?.knownFingerprints)
      ? input.knownFingerprints.map((fp) => String(fp || '').trim()).filter(Boolean)
      : [],
    rateTableKey: input?.rateTableKey === false ? false : undefined,
    createdAt: String(input?.createdAt || new Date().toISOString()),
    updatedAt: String(input?.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {{ harness: string, profileKey?: string, endpoint?: string }} binding
 * @param {{ dataDir?: string, filePath?: string, hmac?: { secretId: string, secret: string, recreated?: boolean } }} [ctx]
 * @returns {{ account: Record<string, any>|null, document: Record<string, any>, secretState: Record<string, any> }}
 */
export function findBillingAccountByBinding(binding, ctx: Partial<{ dataDir?: string, filePath?: string, hmac?: { secretId: string, secret: string, recreated?: boolean } }> = {}) {
  const doc = loadBillingAccountsDocument(ctx);
  const match = doc.accounts.find((row) => accountHasBinding(row, binding)) || null;
  const secretState = loadBillingAccountHmacSecret(ctx.hmac ? { ...ctx.hmac, filePath: ctx.filePath } : ctx);
  return { account: match, document: doc, secretState };
}

/**
 * @param {Record<string, any>[]} accounts
 * @param {string} secretId
 * @returns {Record<string, any>[]}
 */
export function applySecretIdMismatchPolicy(accounts, secretId) {
  if (!secretId) return accounts;
  return accounts.map((row) => {
    if (!row?.fingerprintSecretId || row.fingerprintSecretId === secretId) return row;
    return {
      ...row,
      identityStatus: 'pending_identity',
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * @param {Record<string, any>} doc
 * @param {string} secretId
 * @param {{ filePath?: string }} [ctx]
 */
export function persistBillingAccounts(doc, secretId, ctx: Partial<{ filePath?: string }> = {}) {
  const payload = {
    version: BILLING_ACCOUNTS_SCHEMA_VERSION,
    secretId: String(secretId || doc.secretId || '').trim(),
    accounts: Array.isArray(doc.accounts) ? doc.accounts : [],
    updatedAt: new Date().toISOString(),
  };
  saveBillingAccountsDocument(payload, ctx);
  return payload;
}

/**
 * @param {Record<string, any>} account
 * @param {string} observedFingerprint
 * @param {string} secretId
 * @returns {Record<string, any>}
 */
export function reconcileAccountFingerprint(account, observedFingerprint, secretId) {
  const fp = String(observedFingerprint || '').trim();
  if (!fp) return account;
  const known = new Set([
    String(account.keyFingerprint || '').trim(),
    ...(Array.isArray(account.knownFingerprints) ? account.knownFingerprints : []),
  ].filter(Boolean));
  if (known.has(fp) && account.fingerprintSecretId === secretId) {
    return {
      ...account,
      keyFingerprint: fp,
      identityStatus: 'active',
      fingerprintSecretId: secretId,
      updatedAt: new Date().toISOString(),
    };
  }
  if (!account.keyFingerprint) {
    return {
      ...account,
      keyFingerprint: fp,
      fingerprintSecretId: secretId,
      identityStatus: 'active',
      knownFingerprints: known.size ? [...known] : [fp],
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...account,
    identityStatus: 'pending_identity',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Operator resolves a pending fingerprint identity on an existing account:
 * `rotation` attaches the fingerprint to that account (same wallet, new key),
 * `new_account` starts a separate account so future usage is not chained to the
 * old one.
 *
 * @param {string} accountId
 * @param {string} fingerprint
 * @param {{ dataDir?: string, filePath?: string, hmac?: Record<string, any>, decision?: 'rotation'|'new_account' }} [ctx]
 */
export function confirmBillingAccountFingerprint(accountId, fingerprint, ctx: Partial<{ dataDir?: string, filePath?: string, hmac?: Record<string, any>, decision?: 'rotation'|'new_account' }> = {}) {
  const id = String(accountId || '').trim();
  const fp = String(fingerprint || '').trim();
  if (!id || !fp) throw new Error('accountId and fingerprint required');
  const decision = ctx.decision === 'new_account' ? 'new_account' : 'rotation';
  const secretState = loadBillingAccountHmacSecret(ctx.hmac ? { ...ctx.hmac, filePath: ctx.filePath } : ctx);
  const doc = loadBillingAccountsDocument(ctx);
  doc.accounts = applySecretIdMismatchPolicy(doc.accounts, secretState.secretId);
  const index = doc.accounts.findIndex((row) => row.accountId === id);
  if (index < 0) throw new Error('billing account not found');
  const current = doc.accounts[index];
  if (decision === 'new_account') {
    // The fingerprint starts its own account; the old account keeps its own
    // history and is no longer the resolve target for that credential.
    const successor = normalizeBillingAccount({
      accountId: randomUUID(),
      label: `${current.label || current.provider || id} (new key)`,
      provider: current.provider,
      endpoint: current.endpoint,
      currencies: current.currencies,
      billingClass: current.billingClass,
      bindings: current.bindings,
      keyFingerprint: fp,
      fingerprintSecretId: secretState.secretId,
      identityStatus: 'active',
      knownFingerprints: [fp],
      rateTableKey: current.rateTableKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    doc.accounts[index] = normalizeBillingAccount({
      ...current,
      identityStatus: 'pending_identity',
      updatedAt: new Date().toISOString(),
    });
    doc.accounts.push(successor);
    persistBillingAccounts(doc, secretState.secretId, ctx);
    return { account: successor, decision, previousAccountId: id };
  }
  const known = new Set([
    ...(Array.isArray(current.knownFingerprints) ? current.knownFingerprints : []),
    String(current.keyFingerprint || '').trim(),
    fp,
  ].filter(Boolean));
  doc.accounts[index] = normalizeBillingAccount({
    ...current,
    keyFingerprint: fp,
    knownFingerprints: [...known],
    fingerprintSecretId: secretState.secretId,
    identityStatus: 'active',
    updatedAt: new Date().toISOString(),
  });
  persistBillingAccounts(doc, secretState.secretId, ctx);
  return { account: doc.accounts[index], decision, previousAccountId: id };
}

/**
 * @param {Record<string, any>} draft
 * @param {{ dataDir?: string, filePath?: string, hmac?: Record<string, any> }} [ctx]
 */
export function upsertBillingAccount(draft, ctx: Partial<{ dataDir?: string, filePath?: string, hmac?: Record<string, any> }> = {}) {
  const normalized = normalizeBillingAccount({
    ...draft,
    accountId: draft.accountId || randomUUID(),
  });
  const secretState = loadBillingAccountHmacSecret(ctx.hmac ? { ...ctx.hmac, filePath: ctx.filePath } : ctx);
  const doc = loadBillingAccountsDocument(ctx);
  doc.accounts = applySecretIdMismatchPolicy(doc.accounts, secretState.secretId);
  const index = doc.accounts.findIndex((row) => row.accountId === normalized.accountId);
  if (index >= 0) {
    doc.accounts[index] = normalizeBillingAccount({
      ...doc.accounts[index],
      ...normalized,
      createdAt: doc.accounts[index].createdAt,
    });
  } else {
    doc.accounts.push(normalized);
  }
  persistBillingAccounts(doc, secretState.secretId, ctx);
  return normalized;
}

/** @type {Record<string, { provider: string, endpoint: string, profileKey?: string, credential: () => string }>} */
const DEFAULT_CREDENTIAL_SOURCES = Object.freeze({
  openrouter: {
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api',
    profileKey: 'default',
    credential: () => String(process.env.OPENROUTER_API_KEY || '').trim(),
  },
});

/**
 * @param {string} harness
 * @param {{ profileKey?: string, endpoint?: string, credentialMaterial?: string, provider?: string }} [overrides]
 * @returns {{ harness: string, profileKey: string, endpoint: string, provider: string, credentialMaterial: string }|null}
 */
export function resolveHarnessBillingCredential(harness, overrides: Partial<{ profileKey?: string, endpoint?: string, credentialMaterial?: string, provider?: string }> = {}) {
  const id = String(harness || '').trim().toLowerCase();
  if (!id) return null;
  const source = DEFAULT_CREDENTIAL_SOURCES[id] || getHarnessBillingCredentialSource(id);
  const profileKey = String(overrides.profileKey ?? source?.profileKey ?? 'default').trim().toLowerCase() || 'default';
  const endpoint = normalizeEndpoint(overrides.endpoint || source?.endpoint);
  const provider = String(overrides.provider || source?.provider || '').trim().toLowerCase() || id;
  const credentialMaterial = String(
    overrides.credentialMaterial ?? (typeof source?.credential === 'function' ? source.credential() : ''),
  ).trim();
  if (!endpoint) return null;
  return { harness: id, profileKey, endpoint, provider, credentialMaterial };
}

/**
 * Registry paths anchored at one data directory. The usage ledger may be
 * pointed at a different data dir than the process default; the billing
 * registry belongs to that same dir so a recordUsage call can never resolve
 * (or auto-register) an account in a different registry than the one the
 * caller configured.
 *
 * @param {{ dataDir?: string, accountsFilePath?: string, secretFilePath?: string }} [ctx]
 * @returns {{ accountsFilePath?: string, secretFilePath?: string }}
 */
export function resolveBillingRegistryPaths(ctx: Partial<{ dataDir?: string, accountsFilePath?: string, secretFilePath?: string }> = {}) {
  const dataDir = String(ctx.dataDir || '').trim();
  if (!dataDir) {
    return {
      accountsFilePath: ctx.accountsFilePath ? String(ctx.accountsFilePath).trim() || undefined : undefined,
      secretFilePath: ctx.secretFilePath ? String(ctx.secretFilePath).trim() || undefined : undefined,
    };
  }
  // Same anchor as resolveUsageDataDir: explicit dataDir is the registry root,
  // not a segment under the process default data directory.
  const root = dataDir || resolveDataPath();
  return {
    accountsFilePath: String(ctx.accountsFilePath || '').trim()
      || path.join(root, 'billing-accounts.json'),
    secretFilePath: String(ctx.secretFilePath || '').trim()
      || path.join(root, 'billing-account-hmac-secret.json'),
  };
}

/**
 * Resolve or register the billing account for a harness usage event.
 *
 * @param {Record<string, any>} partial usage partial (harness, billingMode, billingClass, …)
 * @param {{ dataDir?: string, filePath?: string, accountsFilePath?: string, secretFilePath?: string, hmac?: Record<string, any>, autoRegister?: boolean }} [ctx]
 * @returns {{ accountId?: string, billingClass?: string, identityStatus?: string }}
 */
export function resolveBillingAccountForUsage(partial: Record<string, any> = {}, ctx: Partial<{ dataDir?: string, filePath?: string, accountsFilePath?: string, secretFilePath?: string, hmac?: Record<string, any>, autoRegister?: boolean }> = {}) {
  const harness = String(partial.harness || '').trim().toLowerCase();
  if (!harness) return {};
  const cred = resolveHarnessBillingCredential(harness, {
    profileKey: partial.billingProfileKey,
    endpoint: partial.billingEndpoint || partial.endpoint,
    credentialMaterial: partial.billingCredentialMaterial,
    provider: partial.billingProvider || partial.provider,
  });
  if (!cred) return {};
  const registryPaths = resolveBillingRegistryPaths(ctx);
  const persistCtx = {
    filePath: registryPaths.accountsFilePath,
  };
  const secretState = loadBillingAccountHmacSecret(
    ctx.hmac
      ? { ...ctx.hmac, filePath: registryPaths.secretFilePath }
      : { filePath: registryPaths.secretFilePath },
  );
  let doc = loadBillingAccountsDocument(persistCtx);
  const afterSecretPolicy = applySecretIdMismatchPolicy(doc.accounts, secretState.secretId);
  const secretPolicyChanged = afterSecretPolicy.some(
    (row, index) => row.identityStatus !== doc.accounts[index]?.identityStatus,
  );
  doc.accounts = afterSecretPolicy;
  if (secretState.recreated && doc.accounts.length > 0) {
    doc.accounts = doc.accounts.map((row) => ({
      ...row,
      identityStatus: 'pending_identity',
      updatedAt: new Date().toISOString(),
    }));
    persistBillingAccounts(doc, secretState.secretId, persistCtx);
  } else if (secretPolicyChanged) {
    persistBillingAccounts(doc, secretState.secretId, persistCtx);
  }
  const binding = {
    harness: cred.harness,
    profileKey: cred.profileKey,
    endpoint: cred.endpoint,
  };
  const observedFingerprint = cred.credentialMaterial
    ? fingerprintBillingCredential({
      secret: secretState.secret,
      provider: cred.provider,
      endpoint: cred.endpoint,
      credentialMaterial: cred.credentialMaterial,
    })
    : '';
  // Account selection skips accounts whose credential identity is unresolved:
  // a pending account must not absorb usage events that may belong to a
  // different wallet. When the credential proves the identity (the fingerprint
  // matches the account under the current HMAC secret), that account wins over
  // a binding-only match, so a second account on the same harness+endpoint is
  // never shadowed by the first one in the registry.
  const activeWithBinding = doc.accounts.filter((row) => (
    row.identityStatus !== 'pending_identity' && accountHasBinding(row, binding)
  ));
  let account = null;
  if (observedFingerprint) {
    account = activeWithBinding.find((row) => (
      row.fingerprintSecretId === secretState.secretId
        && (
          String(row.keyFingerprint || '').trim() === observedFingerprint
            || (Array.isArray(row.knownFingerprints) && row.knownFingerprints.includes(observedFingerprint))
        )
    )) || null;
  }
  if (!account) account = activeWithBinding[0] || null;
  const billingClassFor = (row) => resolveTelemetryBillingClass({
    billingClass: partial.billingClass ?? row.billingClass,
    billingMode: partial.billingMode,
    harness,
    provider: cred.provider,
    reportedUsd: partial.reportedUsd,
  });
  // A pending account on the same binding owns the returning credential: the
  // previously confirmed fingerprint is back, so the wallet identity is proven
  // again (transient key swap), not a new account.
  if (observedFingerprint) {
    const returning = doc.accounts.find((row) => (
      row.identityStatus === 'pending_identity'
        && row.accountId !== account?.accountId
        && accountHasBinding(row, binding)
        && (
          String(row.keyFingerprint || '').trim() === observedFingerprint
            || (Array.isArray(row.knownFingerprints) && row.knownFingerprints.includes(observedFingerprint))
        )
    )) || null;
    if (returning) {
      const revived = reconcileAccountFingerprint(returning, observedFingerprint, secretState.secretId);
      if (revived.identityStatus === 'active') {
        doc.accounts = doc.accounts.map((row) => (row.accountId === returning.accountId ? revived : row));
        persistBillingAccounts(doc, secretState.secretId, persistCtx);
        return {
          accountId: revived.accountId,
          billingClass: billingClassFor(revived),
          identityStatus: revived.identityStatus,
          rateTableKey: revived.rateTableKey,
        };
      }
    }
  }
  if (account && observedFingerprint) {
    const next = reconcileAccountFingerprint(account, observedFingerprint, secretState.secretId);
    if (next.identityStatus !== account.identityStatus || next.keyFingerprint !== account.keyFingerprint) {
      doc.accounts = doc.accounts.map((row) => (row.accountId === account.accountId ? next : row));
      account = next;
      persistBillingAccounts(doc, secretState.secretId, persistCtx);
    }
  }
  // While the credential identity is unresolved, the binding may belong to a
  // different wallet than the pending account. Resolve the class from the
  // declared inputs only and never attach the pending accountId: the ledger
  // must not chain the new series onto the old account's balance.
  if (account && account.identityStatus === 'pending_identity') {
    return {
      billingClass: billingClassFor(account),
      identityStatus: account.identityStatus,
      rateTableKey: account.rateTableKey,
    };
  }
  if (!account) {
    // Another pending account owns the binding (e.g. the operator moved the
    // credential to a new account and the old one is still pending): keep the
    // series unattached instead of auto-registering a third wallet.
    const pending = doc.accounts.find((row) => (
      row.identityStatus === 'pending_identity' && accountHasBinding(row, binding)
    )) || null;
    if (pending) {
      return {
        billingClass: billingClassFor(pending),
        identityStatus: pending.identityStatus,
        rateTableKey: pending.rateTableKey,
      };
    }
  }
  if (!account && ctx.autoRegister !== false && observedFingerprint) {
    account = normalizeBillingAccount({
      accountId: randomUUID(),
      label: `${cred.provider} ${cred.endpoint}`,
      provider: cred.provider,
      endpoint: cred.endpoint,
      billingClass: partial.billingClass || 'api_metered',
      bindings: [binding],
      keyFingerprint: observedFingerprint,
      fingerprintSecretId: secretState.secretId,
      identityStatus: 'active',
      knownFingerprints: [observedFingerprint],
    });
    doc.accounts.push(account);
    persistBillingAccounts(doc, secretState.secretId, persistCtx);
  }
  if (!account) return {};
  return {
    accountId: account.accountId,
    billingClass: billingClassFor(account),
    identityStatus: account.identityStatus,
    rateTableKey: account.rateTableKey,
  };
}

/**
 * @param {Record<string, any>} partial
 * @param {{ dataDir?: string, filePath?: string, accountsFilePath?: string, secretFilePath?: string, hmac?: Record<string, any>, autoRegister?: boolean }} [ctx]
 * @returns {Record<string, any>}
 */
export function applyBillingAccountToUsagePartial(partial: Record<string, any> = {}, ctx: Partial<{ dataDir?: string, filePath?: string, accountsFilePath?: string, secretFilePath?: string, hmac?: Record<string, any>, autoRegister?: boolean }> = {}) {
  const resolved = resolveBillingAccountForUsage(partial, ctx);
  if (!resolved.accountId && !resolved.billingClass) return partial;
  return {
    ...partial,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.billingClass ? { billingClass: resolved.billingClass } : {}),
    ...(resolved.identityStatus ? { billingAccountIdentityStatus: resolved.identityStatus } : {}),
    ...(resolved.rateTableKey === false || partial.billingRateTableKey === false
      ? { billingRateTableKey: false }
      : {}),
  };
}
