import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { priceUsage } from '../lib/usage/usage-rates.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import { readUsageEvents } from '../lib/persist/usage-persist.js';
import {
  fingerprintBillingCredential,
} from '../lib/usage/billing-account-fingerprint.js';
import {
  applyBillingAccountToUsagePartial,
  bindingLookupKey,
  confirmBillingAccountFingerprint,
  resolveBillingAccountForUsage,
  upsertBillingAccount,
  billingModeToDeclaredClass,
} from '../lib/usage/billing-account-registry.js';
import { loadBillingAccountsDocument } from '../lib/persist/billing-accounts-persist.js';

const TEST_SECRET = 'a'.repeat(64);
const TEST_SECRET_ID = 'test-secret-id';

/**
 * @returns {{ dir: string, accountsFile: string, secretFile: string, usageDir: string, hmac: object }}
 */
function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-acct-'));
  const accountsFile = path.join(dir, 'billing-accounts.json');
  const secretFile = path.join(dir, 'billing-hmac.json');
  const usageDir = path.join(dir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const hmac = { secret: TEST_SECRET, secretId: TEST_SECRET_ID };
  return { dir, accountsFile, secretFile, usageDir, hmac };
}

test('billingMode maps to subscription_quota without a parallel vocabulary', () => {
  assert.equal(billingModeToDeclaredClass('subscription'), 'subscription_quota');
  const event = createUsageEvent({ billingMode: 'subscription', harness: 'claude', provider: 'other' });
  assert.equal(event.billingClass, 'subscription_quota');
  assert.equal(priceUsage(event).usd, null);
});

test('shared wallet: two harness bindings resolve to one accountId', () => {
  const ctx = makeCtx();
  const accountId = 'wallet-shared';
  upsertBillingAccount({
    accountId,
    label: 'Shared DeepSeek wallet',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: fingerprintBillingCredential({
      secret: TEST_SECRET,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com',
      credentialMaterial: 'key-alpha',
    }),
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [
      { harness: 'deepseek', profileKey: 'default', endpoint: 'https://api.deepseek.com' },
      { harness: 'codex', profileKey: 'deepseek-fallback', endpoint: 'https://api.deepseek.com' },
    ],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const deepseek = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key-alpha',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac });
  const codex = resolveBillingAccountForUsage({
    harness: 'codex',
    billingProfileKey: 'deepseek-fallback',
    billingEndpoint: 'https://api.deepseek.com',
    billingProvider: 'deepseek',
    billingCredentialMaterial: 'key-alpha',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  assert.equal(deepseek.accountId, accountId);
  assert.equal(codex.accountId, accountId);
});

test('different endpoints stay different accounts', () => {
  const ctx = makeCtx();
  upsertBillingAccount({
    accountId: 'acct-direct',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: fingerprintBillingCredential({
      secret: TEST_SECRET,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com',
      credentialMaterial: 'same-key',
    }),
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  upsertBillingAccount({
    accountId: 'acct-or',
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api',
    billingClass: 'unknown',
    rateTableKey: false,
    keyFingerprint: fingerprintBillingCredential({
      secret: TEST_SECRET,
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api',
      credentialMaterial: 'same-key',
    }),
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'openrouter', endpoint: 'https://openrouter.ai/api' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const direct = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'same-key',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  const routed = resolveBillingAccountForUsage({
    harness: 'openrouter',
    billingCredentialMaterial: 'same-key',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  assert.notEqual(direct.accountId, routed.accountId);
  assert.equal(routed.billingClass, 'unknown');
});

test('key rotation sets pending_identity until operator confirms', () => {
  const ctx = makeCtx();
  const accountId = 'acct-rotate';
  const oldFp = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'key-v1',
  });
  upsertBillingAccount({
    accountId,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: oldFp,
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const pending = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key-v2',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  assert.equal(pending.identityStatus, 'pending_identity');
  const newFp = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'key-v2',
  });
  confirmBillingAccountFingerprint(accountId, newFp, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const active = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key-v2',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  assert.equal(active.identityStatus, 'active');
  assert.equal(active.accountId, accountId);
});

test('fingerprint is stable across reloads with the same HMAC secret', () => {
  const fp1 = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'stable-key',
  });
  const fp2 = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'stable-key',
  });
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, fingerprintBillingCredential({
    secret: 'b'.repeat(64),
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'stable-key',
  }));
});

test('billingClass end-to-end on ledger events', () => {
  const ctx = makeCtx();
  const partial = applyBillingAccountToUsagePartial({
    harness: 'openrouter',
    provider: 'openrouter',
    feature: 'chat',
    model: 'deepseek/deepseek-chat',
    billingCredentialMaterial: 'or-key',
    billingClass: 'unknown',
    tokens: { textInput: 1000, textOutput: 200 },
  }, {
    accountsFilePath: ctx.accountsFile,
    secretFilePath: ctx.secretFile,
    hmac: ctx.hmac,
    autoRegister: true,
  });
  partial.billingRateTableKey = false;
  const priced = recordUsage(partial, {
    dataDir: ctx.dir,
    accountsFilePath: ctx.accountsFile,
    secretFilePath: ctx.secretFile,
    hmac: ctx.hmac,
  });
  assert.equal(priced.billingClass, 'unknown');
  assert.equal(priced.usd, null);
  assert.ok(priced.accountId);
  const events = readUsageEvents({ dataDir: ctx.dir });
  assert.equal(events.length, 1);
  assert.equal(events[0].billingClass, 'unknown');
  assert.equal(events[0].accountId, priced.accountId);
});

test('missing rate table does not price as zero for unknown-class events', () => {
  const event = createUsageEvent({
    harness: 'openrouter',
    provider: 'openrouter',
    model: 'vendor/deepseek-custom',
    billingClass: 'unknown',
    billingRateTableKey: false,
    tokens: { textInput: 1_000_000, textOutput: 0 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('binding lookup keys normalize endpoints', () => {
  assert.equal(
    bindingLookupKey({ harness: 'deepseek', endpoint: 'https://api.deepseek.com/' }),
    bindingLookupKey({ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }),
  );
});

test('pending_identity usage events omit accountId on the ledger', () => {
  const ctx = makeCtx();
  const accountId = 'acct-pending-ledger';
  upsertBillingAccount({
    accountId,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: fingerprintBillingCredential({
      secret: TEST_SECRET,
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com',
      credentialMaterial: 'key-v1',
    }),
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const priced = recordUsage({
    harness: 'deepseek',
    provider: 'deepseek',
    feature: 'chat',
    model: 'deepseek-chat',
    billingCredentialMaterial: 'key-v2',
    tokens: { textInput: 100, textOutput: 50 },
  }, {
    dataDir: ctx.dir,
    accountsFilePath: ctx.accountsFile,
    secretFilePath: ctx.secretFile,
    hmac: ctx.hmac,
    autoRegister: false,
  });
  assert.equal(priced.billingAccountIdentityStatus, 'pending_identity');
  assert.equal(priced.accountId, undefined);
  const events = readUsageEvents({ dataDir: ctx.dir });
  assert.equal(events.length, 1);
  assert.equal(events[0].billingAccountIdentityStatus, 'pending_identity');
  assert.equal(events[0].accountId, undefined);
});

test('confirm rotation keeps one accountId; new_account splits wallets', () => {
  const ctx = makeCtx();
  const accountId = 'acct-split';
  const oldFp = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'key-v1',
  });
  upsertBillingAccount({
    accountId,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: oldFp,
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  const newFp = fingerprintBillingCredential({
    secret: TEST_SECRET,
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    credentialMaterial: 'key-v2',
  });
  const rotated = confirmBillingAccountFingerprint(accountId, newFp, {
    filePath: ctx.accountsFile,
    hmac: ctx.hmac,
    decision: 'rotation',
  });
  assert.equal(rotated.decision, 'rotation');
  assert.equal(rotated.account.accountId, accountId);
  const afterRotate = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key-v2',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  assert.equal(afterRotate.accountId, accountId);
  assert.equal(afterRotate.identityStatus, 'active');
  const ctx2 = makeCtx();
  upsertBillingAccount({
    accountId: 'acct-old',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: oldFp,
    fingerprintSecretId: TEST_SECRET_ID,
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx2.accountsFile, hmac: ctx2.hmac });
  const split = confirmBillingAccountFingerprint('acct-old', newFp, {
    filePath: ctx2.accountsFile,
    hmac: ctx2.hmac,
    decision: 'new_account',
  });
  assert.equal(split.decision, 'new_account');
  assert.notEqual(split.account.accountId, 'acct-old');
  assert.equal(split.previousAccountId, 'acct-old');
  const doc = loadBillingAccountsDocument({ filePath: ctx2.accountsFile });
  const oldRow = doc.accounts.find((row) => row.accountId === 'acct-old');
  assert.equal(oldRow.identityStatus, 'pending_identity');
  const resolved = resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key-v2',
  }, { accountsFilePath: ctx2.accountsFile, hmac: ctx2.hmac, autoRegister: false });
  assert.equal(resolved.accountId, split.account.accountId);
  assert.equal(resolved.identityStatus, 'active');
});

test('recordUsage resolves billing registry from the same dataDir root', () => {
  const ctx = makeCtx();
  const priced = recordUsage({
    harness: 'deepseek',
    provider: 'deepseek',
    feature: 'chat',
    model: 'deepseek-chat',
    billingCredentialMaterial: 'auto-key',
    tokens: { textInput: 10, textOutput: 5 },
  }, {
    dataDir: ctx.dir,
    hmac: ctx.hmac,
    autoRegister: true,
  });
  assert.ok(priced.accountId);
  assert.ok(fs.existsSync(path.join(ctx.dir, 'billing-accounts.json')));
  const events = readUsageEvents({ dataDir: ctx.dir });
  assert.equal(events[0].accountId, priced.accountId);
});

test('secret id mismatch marks accounts pending without inventing a new wallet', () => {
  const ctx = makeCtx();
  upsertBillingAccount({
    accountId: 'acct-secret',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    billingClass: 'api_metered',
    keyFingerprint: 'abc',
    fingerprintSecretId: 'old-secret-id',
    bindings: [{ harness: 'deepseek', endpoint: 'https://api.deepseek.com' }],
  }, { filePath: ctx.accountsFile, hmac: ctx.hmac });
  resolveBillingAccountForUsage({
    harness: 'deepseek',
    billingCredentialMaterial: 'key',
  }, { accountsFilePath: ctx.accountsFile, hmac: ctx.hmac, autoRegister: false });
  const doc = loadBillingAccountsDocument({ filePath: ctx.accountsFile });
  assert.equal(doc.accounts[0].identityStatus, 'pending_identity');
});
