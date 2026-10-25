import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerCreditLedgerRoutes } from '../lib/routes/credit-ledger-routes.js';
import { createAccount } from '../lib/credit-ledger/credit-ledger-store.ts';

test('harness-links route: owner reads links; widget/MCP access is forbidden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-links-'));
  const filePath = path.join(dir, 'credit-ledger.json');
  const billingPath = path.join(dir, 'billing-accounts.json');
  const { account } = createAccount({ filePath, label: 'DS', walletCurrency: 'USD', idempotencyKey: 'billing-account:ba1' });
  fs.writeFileSync(billingPath, JSON.stringify({ version: 1, secretId: '', accounts: [{ accountId: 'ba1', label: 'DeepSeek', bindings: [{ harness: 'deepseek', profileKey: 'default' }] }] }));
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-widget']) req.widgetAccess = true; next(); });
  registerCreditLedgerRoutes(app, { filePath, billingPath });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await (await fetch(`${base}/api/credit-ledger/harness-links`)).json();
    assert.equal(ok.links[0].harness, 'deepseek');
    assert.equal(ok.links[0].ledgerAccountId, account.id);
    const denied = await fetch(`${base}/api/credit-ledger/harness-links`, { headers: { 'x-widget': '1' } });
    assert.equal(denied.status, 403);
  } finally { server.close(); }
});
