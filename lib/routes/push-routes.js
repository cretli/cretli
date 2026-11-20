import {
  addSubscription,
  getVapidPublicKey,
  isPushAvailable,
  removeSubscription,
  sendPushToEndpoint,
} from '../push.js';
import { validatePushPreferences } from '../push-preferences.js';

/** Minimum spacing between two test pushes to the same endpoint. */
export const PUSH_TEST_MIN_INTERVAL_MS = 5000;

/** Last accepted test-push timestamp per endpoint. */
const pushTestLastAt = new Map();

/**
 * Pure-ish, exported for tests: clears the rate-limit memory.
 * @returns {void}
 */
export function resetPushTestRateLimits() {
  pushTestLastAt.clear();
}

/**
 * Per-endpoint rate limiter for `POST /api/push/test`. An accepted call records
 * the timestamp; a call within `PUSH_TEST_MIN_INTERVAL_MS` is rejected.
 *
 * @param {string} endpoint
 * @param {number} [nowMs]
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function checkPushTestRateLimit(endpoint, nowMs = Date.now()) {
  const key = String(endpoint || '');
  const last = pushTestLastAt.get(key) || 0;
  const elapsed = nowMs - last;
  if (last > 0 && elapsed >= 0 && elapsed < PUSH_TEST_MIN_INTERVAL_MS) {
    return { allowed: false, retryAfterMs: PUSH_TEST_MIN_INTERVAL_MS - elapsed };
  }
  pushTestLastAt.set(key, nowMs);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * @param {import('express').Express} app
 */
export function registerPushRoutes(app) {
  app.get('/api/push/vapid-public', (_req, res) => {
    if (!isPushAvailable()) {
      res.json({ ok: false, available: false, publicKey: '' });
      return;
    }
    res.json({ ok: true, available: true, publicKey: getVapidPublicKey() });
  });
  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body?.subscription;
    if (!subscription || !subscription.endpoint) {
      res.status(400).json({ ok: false, error: 'invalid_subscription' });
      return;
    }
    const body = req.body || {};
    let preferences;
    if (Object.prototype.hasOwnProperty.call(body, 'preferences') && body.preferences !== undefined) {
      const checked = validatePushPreferences(body.preferences);
      if (!checked.ok) {
        // Reject BEFORE touching storage, so invalid input cannot mutate prefs.
        res.status(400).json({ ok: false, error: 'invalid_preferences' });
        return;
      }
      // Pass the RAW validated patch, not the normalized object: addSubscription
      // merges a partial patch over the stored preferences, so omitted fields
      // must stay omitted here (a full normalized object would zero them).
      preferences = body.preferences;
    }
    // Absent preferences preserve the stored ones (merge upsert).
    addSubscription(subscription, preferences);
    res.json({ ok: true });
  });
  app.delete('/api/push/subscribe', (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) {
      res.status(400).json({ ok: false, error: 'missing_endpoint' });
      return;
    }
    removeSubscription(endpoint);
    res.json({ ok: true });
  });
  // Test notification to ONE device (the current endpoint in the body). Auth is
  // the global requireAuth; this route adds no auth of its own. It never
  // broadcasts, never touches chat state and (via data.type 'push-test') never
  // reaches the push inbox.
  app.post('/api/push/test', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    if (!endpoint) {
      res.status(400).json({ ok: false, error: 'missing_endpoint' });
      return;
    }
    const limit = checkPushTestRateLimit(endpoint);
    if (!limit.allowed) {
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        retryAfterMs: limit.retryAfterMs,
      });
      return;
    }
    void (async () => {
      let result;
      try {
        result = await sendPushToEndpoint(endpoint, {
          title: 'Cretli — push test',
          body: 'Test notification from Cretli.',
          tag: 'cretli-push-test',
          data: {
            type: 'push-test',
            at: Date.now(),
          },
        });
      } catch {
        result = { ok: false, sent: 0, failed: 1, error: 'send_failed' };
      }
      if (result.ok) {
        res.json({ ok: true, sent: result.sent });
        return;
      }
      const status = result.error === 'subscription_not_found'
        ? 404
        : result.error === 'missing_endpoint'
          ? 400
          : result.error === 'web-push-unavailable' || result.error === 'vapid-not-configured'
            ? 503
            : 502;
      res.status(status).json({
        ok: false,
        error: result.error,
        ...(result.statusCode ? { statusCode: result.statusCode } : {}),
      });
    })();
  });
}
