import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPaymentInput,
  buildSubscriptionInput,
  renderSubscriptionsView as _renderSubscriptionsView,
} from '../app_front/features/usage/billingSubscriptions.js';
import { templateToString as _str } from './helpers/lit-template-string.js';
const renderSubscriptionsHtml = (...args) => _str(_renderSubscriptionsView(...args));

const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ''}`;

test('subscription input: validates dates, price and currency', () => {
  const ok = buildSubscriptionInput({ label: 'A', provider: 'claude', plan: 'Max', amount: '100', currency: 'usd', interval: 'year', anchorDate: '2024-02-29' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input.cycle, { interval: 'year', anchorDate: '2024-02-29' });
  assert.equal(ok.input.price.currency, 'USD');
  assert.deepEqual(buildSubscriptionInput({ label: 'A', provider: 'x', plan: 'p', amount: 'abc', currency: 'USD', anchorDate: 'nope' }).errors, ['price_amount_invalid', 'anchor_date_invalid']);
});

test('payment input requires a receipt reference', () => {
  const form = { dueDate: '2026-02-28', paidAt: '2026-02-28', amount: '20', currency: 'USD' };
  assert.deepEqual(buildPaymentInput(form).errors, ['payment_evidence_required']);
  assert.equal(buildPaymentInput({ ...form, providerTransactionId: 'r1' }).ok, true);
});

test('render: planned payment is never shown as paid; quota reset is separate; HTML escaped', () => {
  const html = renderSubscriptionsHtml({
    cash: { USD: '100.00' },
    suggestions: [{ service: 'cursor' }],
    subscriptions: [{
      id: 's1', label: '<b>x</b>', provider: 'claude', plan: 'Max', state: 'active',
      price: { value: '100.00', currency: 'USD' }, cycle: { interval: 'month', anchorDate: '2026-01-31' },
      nextPayment: { dueDate: '2026-02-28', state: 'planned', confirmed: false },
      awaitingConfirmation: { dueDate: '2026-01-31' },
      limits: [{ rateLimitType: 'five_hour', utilization: 70, resetsAt: '2026-02-10T12:00:00Z', resetElapsed: true }],
    }],
  }, { t });
  assert.match(html, /billing\.subNextPlanned/);
  assert.match(html, /billing\.subAwaiting/);
  assert.match(html, /billing\.subLimitResetElapsed/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /billing\.subSuggest/);
});
