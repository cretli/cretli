/**
 * DeepSeek contribution to the credit ledger: the balance-reading routes and the
 * top-up listener. Registered through the light entry
 * (lib/agent-harness/optional-harness-hooks.ts), so the shared ledger routes
 * never name DeepSeek.
 *
 * `GET  /api/credit-ledger/deepseek-balance`         last provider reading + freshness (36 h)
 * `POST /api/credit-ledger/deepseek-balance/refresh` manual refresh (throttled; errors carry kind only)
 */

import { readDeepSeekBalanceStatus, readDeepSeekLastAttempt, refreshDeepSeekBalance } from './deepseek-balance.js';

/**
 * @param {import('express').Express} app
 * @param {{ filePath?: string, denied: (req: any) => boolean }} ctx
 */
export function registerDeepSeekLedgerRoutes(app, { filePath, denied }) {
  app.get('/api/credit-ledger/deepseek-balance', (req, res) => {
    if (denied(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      return res.json({ ok: true, ...readDeepSeekBalanceStatus({ ledgerPath: filePath }), lastAttempt: readDeepSeekLastAttempt() });
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
}

/**
 * A new posted top-up triggers one bounded (cached/backoff) balance read.
 *
 * @param {{ filePath?: string }} event
 */
export function onDeepSeekTopupPosted({ filePath }) {
  void refreshDeepSeekBalance({ reason: 'topup', ledgerPath: filePath }).catch(() => {});
}
