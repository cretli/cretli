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
 * `GET  /api/credit-ledger/deepseek-balance`      last provider reading + freshness (36 h)
 * `POST /api/credit-ledger/deepseek-balance/refresh` manual refresh (throttled; errors carry kind only)
 *
 * Mutations require If-Match (428 when missing, 409 when stale). A replayed
 * idempotency key / provider id is answered before the revision check.
 * Request bodies and amounts are never logged.
 */

import {
  LedgerError,
  readLedgerView,
  recordSnapshot,
  recordTransaction,
  createAccount,
  supersedeSnapshot,
  supersedeTransaction,
  tombstoneTransaction,
} from '../credit-ledger/credit-ledger-store.js';
import { readDeepSeekBalanceStatus, refreshDeepSeekBalance } from '../deepseek/deepseek-balance.js';

function parseIfMatch(req) {
  const raw = String(Array.isArray(req.headers['if-match']) ? req.headers['if-match'][0] : req.headers['if-match'] || '');
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
  return raw.trim() && Number.isInteger(n) ? n : null;
}

/**
 * @param {import('express').Express} app
 * @param {{ filePath?: string }} [ctx]
 */
export function registerCreditLedgerRoutes(app, ctx = {}) {
  const filePath = ctx.filePath;
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
    // A new posted top-up triggers one bounded (cached/backoff) balance read.
    // The entry itself never proves availability; only the reading does.
    if (!result.deduplicated && result.transaction?.type === 'topup' && result.transaction?.state === 'posted') {
      void refreshDeepSeekBalance({ reason: 'topup', ledgerPath: filePath }).catch(() => {});
    }
    return result;
  }, { successStatus: 201 }));

  app.get('/api/credit-ledger/deepseek-balance', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      return res.json({ ok: true, ...readDeepSeekBalanceStatus({ ledgerPath: filePath }) });
    } catch {
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.post('/api/credit-ledger/deepseek-balance/refresh', async (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const result = await refreshDeepSeekBalance({ reason: 'manual', ledgerPath: filePath });
      if (result.ok) return res.json({ ok: true, ...result });
      // Failure bodies carry classification only: no key, no amounts.
      const status = result.kind === 'throttled' || result.kind === 'rate_limited' ? 429 : 502;
      return res.status(result.kind === 'no_key' || result.kind === 'identity_pending' ? 409 : status)
        .json({ ok: false, error: result.kind, ...(result.status ? { upstreamStatus: result.status } : {}), ...(result.requestId ? { requestId: result.requestId } : {}) });
    } catch {
      return res.status(500).json({ ok: false, error: 'internal_error' });
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
