import {
  addSubscription,
  getVapidPublicKey,
  isPushAvailable,
  removeSubscription,
} from '../push.js';

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
    addSubscription(subscription);
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
}
