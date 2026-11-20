/**
 * Credit ledger API (owner-only; global requireAuth, no multi-user isolation).
 *
 * `GET  /api/credit-ledger`                        accounts, history, derived views; ETag = revision
 * `POST /api/credit-ledger/accounts`
 * `POST /api/credit-ledger/transactions`
 * `PUT  /api/credit-ledger/transactions/:id`       correction (appends, supersedes)
 * `DELETE /api/credit-ledger/transactions/:id`     tombstone
 * `POST /api/credit-ledger/snapshots`
 * `PUT  /api/credit-ledger/snapshots/:id`
 * `DELETE /api/credit-ledger/snapshots/:id`
 *
 * Harness plugins may add routes under this prefix (see optional-harness-hooks.js).
 * `GET  /api/credit-ledger/harness-links`         harness binding -> wallet relation (wallet shown once by the UI)
 * `GET  /api/credit-ledger/forecast`              per-account/currency spend scenarios + alert state
 *
 * `GET  /api/credit-ledger/subscriptions`        subscriptions, schedule, limits (plan-limit history), cash, suggestions
 * `POST /api/credit-ledger/subscriptions`         manual / screenshot-based record
 * `PUT  /api/credit-ledger/subscriptions/:id`     plan, price, cycle, limit edits
 * `POST /api/credit-ledger/subscriptions/:id/state`    record a state the operator caused at the provider
 * `POST /api/credit-ledger/subscriptions/:id/payments` confirm a payment (needs evidence)
 * The subscription routes use their own revision (ETag/If-Match of the subscription
 * register). No route buys, renews or cancels anything at a provider.
 *
 * Mutations require If-Match (428 when missing, 409 when stale). A replayed
 * idempotency key / provider id is answered before the revision check.
 * Request bodies and amounts are never logged.
 */

import { createHash } from 'node:crypto';
import {
  LedgerError,
  readLedgerView,
  recordSnapshot,
  recordTransaction,
  createAccount,
  supersedeSnapshot,
  supersedeTransaction,
  tombstoneTransaction,
} from '../credit-ledger/credit-ledger-store.ts';
import { listCreditLedgerContributions } from '../agent-harness/optional-harness-hooks.ts';
import { readBalanceForecastReport } from '../credit-ledger/balance-forecast.ts';
import { readHarnessLinks } from '../credit-ledger/harness-links.ts';
import {
  confirmSubscriptionPayment,
  createSubscription,
  readSubscriptionsView,
  transitionSubscription,
  updateSubscription,
} from '../credit-ledger/subscriptions.ts';
import { resolveDataPath } from '../runtime-paths.js';
import { loadBillingAccountsDocument } from '../persist/billing-accounts-persist.js';

function parseIfMatch(req) {
  const raw = String(Array.isArray(req.headers['if-match']) ? req.headers['if-match'][0] : req.headers['if-match'] || '');
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
  return raw.trim() && Number.isInteger(n) ? n : null;
}

/**
 * @param {import('express').Express} app
 * @param {{ filePath?: string, uploadsDir?: string, billingPath?: string }} [ctx]
 */
export function registerCreditLedgerRoutes(app, ctx = {}) {
  const filePath = ctx.filePath;
  const uploadsDir = ctx.uploadsDir || resolveDataPath('uploads');
  const denied = (req) => Boolean(req.widgetAccess || req.mcpIntegration);

  const respond = (res, status, body) => {
    if (body.revision !== undefined) res.set('ETag', `"${body.revision}"`);
    res.status(status).json({ ok: true, ...body });
  };

  const handle = (fn, { needsRevision = true, successStatus = 200 } = {}) => (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const expectedRevision = parseIfMatch(req);
      if (needsRevision && expectedRevision === null) {
        const { revision } = readLedgerView({ filePath });
        res.set('ETag', `"${revision}"`);
        return res.status(428).json({ ok: false, error: 'if_match_required', revision });
      }
      const result = fn(req, expectedRevision);
      return respond(res, result.deduplicated ? 200 : successStatus, result);
    } catch (err) {
      if (err instanceof LedgerError) {
        return res.status(err.status).json({ ok: false, error: err.code, revision: err.revision });
      }
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  };

  const subscriptionView = () => {
    const billing = loadBillingAccountsDocument({ filePath: ctx.billingPath });
    const harnesses = billing.accounts.flatMap((/** @type {any} */ a) => (a.bindings || []).map((/** @type {any} */ b) => b.harness)).filter(Boolean);
    return readSubscriptionsView({ ledgerPath: filePath, harnesses, billingAccounts: billing.accounts });
  };
  const handleSubscription = (fn, successStatus = 200) => (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const expectedRevision = parseIfMatch(req);
      if (expectedRevision === null) {
        const { revision } = subscriptionView();
        res.set('ETag', `"${revision}"`);
        return res.status(428).json({ ok: false, error: 'if_match_required', revision });
      }
      const result = fn(req, expectedRevision);
      return respond(res, result.deduplicated ? 200 : successStatus, result);
    } catch (err) {
      if (err instanceof LedgerError) return res.status(err.status).json({ ok: false, error: err.code, revision: err.revision });
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  };

  app.get('/api/credit-ledger/subscriptions', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      res.set('Cache-Control', 'no-store');
      return respond(res, 200, subscriptionView());
    } catch (err) {
      return res.status(err instanceof LedgerError ? err.status : 500).json({ ok: false, error: err.code || 'internal_error' });
    }
  });

  app.post('/api/credit-ledger/subscriptions', handleSubscription((req, rev) => createSubscription({
    ledgerPath: filePath, expectedRevision: rev, input: req.body || {},
  }), 201));

  app.put('/api/credit-ledger/subscriptions/:id', handleSubscription((req, rev) => updateSubscription({
    ledgerPath: filePath, expectedRevision: rev, id: req.params.id, patch: req.body || {},
  })));

  app.post('/api/credit-ledger/subscriptions/:id/state', handleSubscription((req, rev) => transitionSubscription({
    ledgerPath: filePath, expectedRevision: rev, id: req.params.id, state: req.body?.state, at: req.body?.at,
  })));

  app.post('/api/credit-ledger/subscriptions/:id/payments', handleSubscription((req, rev) => confirmSubscriptionPayment({
    ledgerPath: filePath, expectedRevision: rev, id: req.params.id, input: req.body || {}, uploadsDir,
  }), 201));

  app.get('/api/credit-ledger', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      return respond(res, 200, readLedgerView({ filePath }));
    } catch (err) {
      return res.status(err instanceof LedgerError ? err.status : 500).json({ ok: false, error: err.code || 'internal_error' });
    }
  });

  app.post('/api/credit-ledger/accounts', handle((req, rev) => createAccount({
    filePath, expectedRevision: rev, label: req.body?.label,
    walletCurrency: req.body?.walletCurrency, idempotencyKey: req.body?.idempotencyKey,
  }), { successStatus: 201 }));

  app.post('/api/credit-ledger/transactions', handle((req, rev) => {
    const result = recordTransaction({ filePath, expectedRevision: rev, input: req.body });
    // A new posted top-up lets plugins run a bounded (cached/backoff) balance read.
    // The entry itself never proves availability; only the reading does.
    const posted = /** @type {{ type?: string, state?: string } | undefined} */ (result.transaction);
    if (!result.deduplicated && posted?.type === 'topup' && posted?.state === 'posted') {
      for (const contribution of listCreditLedgerContributions()) {
        try { contribution.onTopupPosted?.({ filePath }); } catch { /* a listener never fails the write */ }
      }
    }
    return result;
  }, { successStatus: 201 }));

  app.get('/api/credit-ledger/forecast', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const report = readBalanceForecastReport({ filePath });
      // The representation depends on the ledger revision, the wall clock and
      // the persisted alert state. A revision-only validator would let a
      // conditional request keep a stale forecast, so hash the whole report and
      // mark it non-storable.
      const validator = createHash('sha256').update(JSON.stringify(report)).digest('base64url');
      res.set('ETag', `"${validator}"`);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ...report });
    } catch (err) {
      return res.status(err instanceof LedgerError ? err.status : 500)
        .json({ ok: false, error: err.code || 'internal_error' });
    }
  });

  for (const contribution of listCreditLedgerContributions()) contribution.registerRoutes?.(app, { filePath, denied });
  app.get('/api/credit-ledger/harness-links', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, links: readHarnessLinks({ ledgerPath: filePath, billingPath: ctx.billingPath }) });
    } catch (err) {
      return res.status(err instanceof LedgerError ? err.status : 500).json({ ok: false, error: err.code || 'internal_error' });
    }
  });

  app.put('/api/credit-ledger/transactions/:id', handle((req, rev) => supersedeTransaction({
    filePath, expectedRevision: rev, id: req.params.id, input: req.body || {},
  })));

  app.delete('/api/credit-ledger/transactions/:id', handle((req, rev) => tombstoneTransaction({
    filePath, expectedRevision: rev, id: req.params.id, reason: req.body?.reason,
  })));

  app.post('/api/credit-ledger/snapshots', handle((req, rev) => recordSnapshot({
    filePath, expectedRevision: rev, input: req.body,
  }), { successStatus: 201 }));

  app.put('/api/credit-ledger/snapshots/:id', handle((req, rev) => supersedeSnapshot({
    filePath, expectedRevision: rev, id: req.params.id, input: req.body || {},
  })));

  app.delete('/api/credit-ledger/snapshots/:id', handle((req, rev) => supersedeSnapshot({
    filePath, expectedRevision: rev, id: req.params.id, tombstone: true,
  })));
}
