/**
 * Settings → Usage: subscriptions section of the billing view.
 *
 * Pure rendering and input building (no DOM, no network) so it is unit-testable.
 * A planned payment is always labelled "planned"; only a confirmed payment is
 * shown as paid. Quota reset is the provider's reading and is shown apart from
 * the payment date. Nothing here buys, renews or cancels at a provider.
 */

import { html, nothing } from 'lit';

export const SUBSCRIPTION_STATES = ['active', 'paused', 'past_due', 'cancelled', 'ended'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z0-9_]{2,16}$/;

/**
 * @param {Record<string, string>} form
 * @returns {{ ok: boolean, input?: any, errors?: string[] }}
 */
export function buildSubscriptionInput(form) {
  const errors = [];
  const label = String(form.label || '').trim();
  const provider = String(form.provider || '').trim();
  const plan = String(form.plan || '').trim();
  const currency = String(form.currency || '').trim().toUpperCase();
  const anchorDate = String(form.anchorDate || '').trim();
  if (!label) errors.push('label_required');
  if (!provider) errors.push('provider_required');
  if (!plan) errors.push('plan_required');
  if (!/^\d+(\.\d+)?$/.test(String(form.amount || '').trim())) errors.push('price_amount_invalid');
  if (!CURRENCY_RE.test(currency)) errors.push('price_currency_invalid');
  if (!DAY_RE.test(anchorDate)) errors.push('anchor_date_invalid');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      label, provider, plan,
      price: { amount: String(form.amount).trim(), currency },
      cycle: { interval: form.interval === 'year' ? 'year' : 'month', anchorDate },
      harness: String(form.harness || '').trim() || undefined,
      source: String(form.source || 'manual').trim() || 'manual',
    },
  };
}

/**
 * @param {Record<string, string>} form
 * @returns {{ ok: boolean, input?: any, errors?: string[] }}
 */
export function buildPaymentInput(form) {
  const errors = [];
  const currency = String(form.currency || '').trim().toUpperCase();
  const evidence = String(form.providerTransactionId || '').trim();
  if (!DAY_RE.test(String(form.dueDate || ''))) errors.push('due_date_invalid');
  if (!DAY_RE.test(String(form.paidAt || ''))) errors.push('paid_at_invalid');
  if (!/^\d+(\.\d+)?$/.test(String(form.amount || '').trim())) errors.push('paid_amount_invalid');
  if (!CURRENCY_RE.test(currency)) errors.push('paid_currency_invalid');
  if (!evidence) errors.push('payment_evidence_required');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      dueDate: form.dueDate, paidAt: form.paidAt, paid: { amount: String(form.amount).trim(), currency },
      providerTransactionId: evidence, source: 'manual',
    },
  };
}

/** @param {any} limit */
function limitView(limit, t) {
  const pct = limit.utilization == null ? t('billing.subLimitUnknown') : `${limit.utilization}%`;
  const reset = limit.resetsAt
    ? t(limit.resetElapsed ? 'billing.subLimitResetElapsed' : 'billing.subLimitResets', { at: limit.resetsAt })
    : t('billing.subLimitNoReset');
  return html`<li class="billing-sub-limit"><span>${limit.rateLimitType}</span> <span>${pct}</span> <span class="cr-hint">${reset}</span></li>`;
}

/**
 * @param {{ subscriptions?: any[], cash?: any, suggestions?: any[] }} data
 * @param {{ t: (key: string, vars?: any) => string }} deps
 * @returns {import('lit').TemplateResult}
 */
export function renderSubscriptionsView(data, { t }) {
  const subs = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  const cash = Object.entries(data?.cash || {});
  const rows = subs.map((s) => {
    const next = s.nextPayment
      ? t('billing.subNextPlanned', { date: s.nextPayment.dueDate })
      : t('billing.subNoNext');
    const awaiting = s.awaitingConfirmation
      ? html`<p class="cr-hint">${t('billing.subAwaiting', { date: s.awaitingConfirmation.dueDate })}</p>` : nothing;
    const limits = (s.limits || []).length
      ? html`<ul class="billing-sub-limits">${s.limits.map((l) => limitView(l, t))}</ul>`
      : html`<p class="cr-hint">${t('billing.subNoLimits')}</p>`;
    return html`<article class="cr-card billing-subscription" data-sub-id=${s.id}>
      <h5>${s.label} <span class="cr-hint">${s.provider} · ${s.plan}</span></h5>
      <p>${s.price.value} ${s.price.currency} / ${t(`billing.subInterval_${s.cycle.interval}`)}
        · ${t(`billing.subState_${s.state}`)}</p>
      <p>${next}</p>${awaiting}${limits}
      <div class="cr-row">
        <cr-bar-button data-billing-action="sub-confirm" data-sub-id=${s.id}>${t('billing.subConfirmPayment')}</cr-bar-button>
        <cr-bar-button data-billing-action="sub-state" data-sub-id=${s.id}>${t('billing.subRecordState')}</cr-bar-button>
      </div></article>`;
  });
  const cashView = cash.length
    ? html`<p class="cr-hint">${t('billing.subCash', { totals: cash.map(([c, v]) => `${v} ${c}`).join(', ') })}</p>` : nothing;
  const hints = suggestions.length
    ? html`<p class="cr-hint">${t('billing.subSuggest', { services: suggestions.map((x) => x.service).join(', ') })}</p>` : nothing;
  return html`<h5 class="cr-section-title">${t('billing.subTitle')}</h5>
    <p class="cr-hint">${t('billing.subHint')}</p>
    ${rows.length ? rows : html`<p class="cr-hint">${t('billing.subEmpty')}</p>`}${cashView}${hints}`;
}
