/**
 * Settings → Usage: billing panel wiring (DOM, dialogs, event delegation).
 * State and I/O live in `billingController.js`; markup in `billingView.js`.
 */

import {
  getCreditLedger,
  getCreditLedgerForecast,
  getCreditLedgerHarnessLinks,
  getDeepSeekBalanceStatus,
  getCreditSubscriptions,
  mutateCreditLedger,
  mutateCreditSubscriptions,
  refreshDeepSeekBalanceReading,
} from '../../core/api/index.js';
import { getCurrentLang, t } from '../../i18n/index.js';
import { createBillingFetchCache } from './billingCache.js';
import { createBillingController } from './billingController.js';
import { BILLING_TX_TYPES, billingErrorText, buildBillingViewModel, renderHarnessBillingView } from './billingView.js';
import {
  SUBSCRIPTION_STATES,
  buildPaymentInput,
  buildSubscriptionInput,
  renderSubscriptionsView,
} from './billingSubscriptions.js';
import { html } from 'lit';
import { clearUsageContent, renderUsage } from './usageDom.js';

/** Last subscription register revision seen; every write sends it as If-Match. */
let subscriptionRevision = 0;

/** @type {ReturnType<typeof createBillingController>|null} */
let controller = null;
let wired = false;

/** @returns {HTMLElement|null} */
const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

/**
 * @param {string} message
 * @param {'error'|'success'|''} tone
 */
function setStatus(message, tone) {
  const el = byId('usage-billing-status');
  if (!el) return;
  el.textContent = message;
  el.setAttribute('data-tone', tone);
}

/** One request triple shared by all harness cards; dropped after every write. */
const harnessBillingCache = createBillingFetchCache({
  getLedger: getCreditLedger,
  getForecast: getCreditLedgerForecast,
  getLinks: getCreditLedgerHarnessLinks,
});

/**
 * @template {any[]} A
 * @param {(...args: A) => Promise<any>} fn
 * @returns {(...args: A) => Promise<any>}
 */
function invalidatingAfter(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      harnessBillingCache.invalidate();
    }
  };
}

const saveCreditLedger = invalidatingAfter(mutateCreditLedger);
const saveCreditSubscriptions = invalidatingAfter(mutateCreditSubscriptions);

/** @returns {ReturnType<typeof createBillingController>} */
function ensureController() {
  if (controller) return controller;
  controller = createBillingController({
    api: {
      getLedger: getCreditLedger,
      getForecast: getCreditLedgerForecast,
      getLinks: getCreditLedgerHarnessLinks,
      getProviderStatus: getDeepSeekBalanceStatus,
      mutate: saveCreditLedger,
    },
    t,
    getLang: getCurrentLang,
    setStatus,
    paint(view) {
      const host = byId('usage-billing');
      if (host) renderUsage(host, view);
    },
  });
  return controller;
}

/**
 * @param {string} label
 * @param {string} field
 * @param {string} [value]
 * @param {string} [hint]
 * @returns {import('lit').TemplateResult}
 */
function inputField(label, field, value = '', hint = '') {
  return html`<div class="cr-field"><span class="cr-field-label">${label}</span>
    <cr-bar-input data-field=${field} value=${value}></cr-bar-input>
    ${hint ? html`<p class="cr-hint">${hint}</p>` : ''}</div>`;
}

/**
 * @param {string} label
 * @param {string} field
 * @param {{ value: string, label: string }[]} options
 * @param {string} value
 * @returns {import('lit').TemplateResult}
 */
function selectField(label, field, options, value) {
  return html`<div class="cr-field"><span class="cr-field-label">${label}</span>
    <cr-bar-select data-field=${field} value=${value}>${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</cr-bar-select></div>`;
}

/** @returns {{ value: string, label: string }[]} */
function accountOptions() {
  return (controller?.getState().model?.accounts || []).map((a) => ({ value: a.id, label: `${a.label} (${a.walletCurrency})` }));
}

/**
 * Opens a `cr-dialog` with the given form body and wires save/cancel.
 *
 * @param {{ heading: string, body: import('lit').TemplateResult | import('lit').TemplateResult[], onSave: (values: Record<string, string>) => Promise<{ ok: boolean }> }} spec
 */
function openDialog(spec) {
  const host = byId('usage-billing-dialog-host');
  if (!host) return;
  renderUsage(host, html`<cr-dialog heading=${spec.heading} open>
    ${spec.body}
    <p class="cr-status" data-dialog-status data-tone="" role="status"></p>
    <div slot="actions" class="cr-row">
      <cr-bar-button data-dialog-cancel>${t('billing.cancel')}</cr-bar-button>
      <cr-bar-button variant="primary" data-dialog-save>${t('billing.save')}</cr-bar-button>
    </div></cr-dialog>`);
  const dialog = host.querySelector('cr-dialog');
  const close = () => { clearUsageContent(host); };
  dialog.addEventListener('cr-dialog-close', close);
  dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', close);
  dialog.querySelector('[data-dialog-save]')?.addEventListener('click', async () => {
    const values = {};
    dialog.querySelectorAll('[data-field]').forEach((el) => { values[el.getAttribute('data-field')] = /** @type {HTMLInputElement} */ (el).value ?? ''; });
    const result = await spec.onSave(values);
    if (result.ok) close();
    else {
      const status = dialog.querySelector('[data-dialog-status]');
      const top = byId('usage-billing-status');
      if (status && top) { status.textContent = top.textContent; status.setAttribute('data-tone', 'error'); }
    }
  });
}

const nowIso = () => new Date().toISOString().slice(0, 16) + ':00Z';

function openAccountDialog() {
  openDialog({
    heading: t('billing.addAccount'),
    body: [inputField(t('billing.fieldLabel'), 'label'), inputField(t('billing.fieldWalletCurrency'), 'walletCurrency', 'USD', t('billing.fieldWalletCurrencyHint'))],
    onSave: (v) => ensureController().saveAccount(v),
  });
}

/**
 * @param {{ txId?: string }} [options] present when correcting an entry
 */
function openTransactionDialog(options = {}) {
  const tx = options.txId
    ? (controller?.getState().model?.accounts || []).flatMap((a) => a.transactions).find((x) => x.id === options.txId)
    : null;
  const accounts = accountOptions();
  if (!accounts.length) { setStatus(t('billing.needAccount'), 'error'); return; }
  const types = BILLING_TX_TYPES.map((type) => ({ value: type, label: t(`billing.type_${type}`) }));
  openDialog({
    heading: tx ? t('billing.correctEntry') : t('billing.addTransaction'),
    body: [
      selectField(t('billing.fieldAccount'), 'accountId', accounts, tx?.accountId || accounts[0].value),
      selectField(t('billing.fieldType'), 'type', types, tx?.type || 'topup'),
      selectField(t('billing.fieldState'), 'state', [{ value: 'posted', label: t('billing.statePosted') }, { value: 'pending', label: t('billing.pending') }], tx?.state || 'posted'),
      inputField(t('billing.fieldAmount'), 'amount', tx?.credit?.value || '', t('billing.fieldAmountHint')),
      inputField(t('billing.fieldOccurredAt'), 'occurredAt', tx?.occurredAt?.at || tx?.occurredAt?.date || nowIso(), t('billing.fieldMomentHint')),
      inputField(t('billing.fieldSource'), 'source', tx?.source || 'manual'),
      inputField(t('billing.fieldPaymentAmount'), 'paymentAmount', tx?.payment?.value || ''),
      inputField(t('billing.fieldPaymentCurrency'), 'paymentCurrency', tx?.payment?.currency || ''),
      inputField(t('billing.fieldExpiresAt'), 'expiresAt', tx?.expiresAt?.at || tx?.expiresAt?.date || '', t('billing.fieldExpiresHint')),
      inputField(t('billing.fieldProviderId'), 'providerTransactionId', tx?.providerTransactionId || ''),
    ],
    onSave: (v) => ensureController().saveTransaction(tx ? 'correct' : 'create', v, tx?.id || ''),
  });
}

function openSnapshotDialog() {
  const accounts = accountOptions();
  if (!accounts.length) { setStatus(t('billing.needAccount'), 'error'); return; }
  openDialog({
    heading: t('billing.addReading'),
    body: [
      selectField(t('billing.fieldAccount'), 'accountId', accounts, accounts[0].value),
      inputField(t('billing.fieldCurrency'), 'currency', (controller?.getState().model?.accounts[0]?.walletCurrency) || 'USD'),
      inputField(t('billing.fieldTotal'), 'totalBalance'),
      inputField(t('billing.granted'), 'grantedBalance'),
      inputField(t('billing.toppedUp'), 'toppedUpBalance'),
      selectField(t('billing.fieldAvailability'), 'isAvailable', [
        { value: 'unknown', label: t('billing.availUnknown') }, { value: 'yes', label: t('billing.availYes') }, { value: 'no', label: t('billing.availNo') },
      ], 'unknown'),
      selectField(t('billing.fieldCompleteness'), 'completeness', [
        { value: 'unknown', label: t('billing.completenessUnknown') }, { value: 'complete', label: t('billing.completenessComplete') }, { value: 'partial', label: t('billing.completenessPartial') },
      ], 'unknown'),
      inputField(t('billing.fieldObservedAt'), 'observedAt', nowIso(), t('billing.fieldMomentHint')),
      inputField(t('billing.fieldSource'), 'source', 'manual'),
    ],
    onSave: (v) => ensureController().saveSnapshot(v),
  });
}

/** Reloads the subscriptions block; a failure leaves the rest of billing intact. */
async function refreshSubscriptions() {
  const host = byId('usage-billing-subscriptions');
  if (!host) return;
  try {
    const data = await getCreditSubscriptions();
    if (!data?.ok) return;
    subscriptionRevision = Number(data.revision) || 0;
    renderUsage(host, renderSubscriptionsView(data, { t }));
  } catch {
    clearUsageContent(host);
  }
}

/**
 * @param {{ ok: boolean, errors?: string[], error?: string }} result
 * @returns {Promise<{ ok: boolean }>}
 */
async function settleSubscription(result) {
  if (result?.ok) {
    setStatus(t('billing.saved'), 'success');
    await refreshSubscriptions();
    return { ok: true };
  }
  setStatus(billingErrorText(result?.error || 'unknown', t), 'error');
  if (result?.error === 'revision_conflict' || result?.error === 'if_match_required') await refreshSubscriptions();
  return { ok: false };
}

/** @param {Record<string, string>} v */
async function saveSubscription(v) {
  const built = buildSubscriptionInput(v);
  if (!built.ok) { setStatus(billingErrorText(built.errors[0], t), 'error'); return { ok: false }; }
  return settleSubscription(await saveCreditSubscriptions('POST', '', subscriptionRevision, { ...built.input, idempotencyKey: `ui-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }));
}

function openSubscriptionDialog() {
  openDialog({
    heading: t('billing.subAdd'),
    body: [
      inputField(t('billing.subName'), 'label'),
      inputField(t('billing.subProvider'), 'provider', '', t('billing.subProviderHint')),
      inputField(t('billing.subPlan'), 'plan'),
      inputField(t('billing.subPrice'), 'amount'),
      inputField(t('billing.fieldCurrency'), 'currency', 'USD'),
      selectField(t('billing.subCycle'), 'interval', [{ value: 'month', label: t('billing.subInterval_month') }, { value: 'year', label: t('billing.subInterval_year') }], 'month'),
      inputField(t('billing.subAnchor'), 'anchorDate', '', t('billing.subAnchorHint')),
      inputField(t('billing.subHarness'), 'harness', '', t('billing.subHarnessHint')),
    ],
    onSave: saveSubscription,
  });
}

/** @param {string} subId */
function openPaymentDialog(subId) {
  openDialog({
    heading: t('billing.subConfirmPayment'),
    body: [
      html`<p class="cr-hint">${t('billing.subConfirmHint')}</p>`,
      inputField(t('billing.subDueDate'), 'dueDate'),
      inputField(t('billing.subPaidAt'), 'paidAt'),
      inputField(t('billing.subPaidAmount'), 'amount'),
      inputField(t('billing.fieldCurrency'), 'currency', 'USD'),
      inputField(t('billing.subReceipt'), 'providerTransactionId'),
    ],
    onSave: async (v) => {
      const built = buildPaymentInput(v);
      if (!built.ok) { setStatus(billingErrorText(built.errors[0], t), 'error'); return { ok: false }; }
      return settleSubscription(await saveCreditSubscriptions('POST', `/${encodeURIComponent(subId)}/payments`, subscriptionRevision, built.input));
    },
  });
}

/** @param {string} subId */
function openStateDialog(subId) {
  openDialog({
    heading: t('billing.subRecordState'),
    body: html`<p class="cr-hint">${t('billing.subStateHint')}</p>${selectField(t('billing.fieldState'), 'state',
      SUBSCRIPTION_STATES.map((state) => ({ value: state, label: t(`billing.subState_${state}`) })), 'active')}`,
    onSave: async (v) => settleSubscription(await saveCreditSubscriptions('POST', `/${encodeURIComponent(subId)}/state`, subscriptionRevision, { state: v.state })),
  });
}

/** Reloads the billing section (no page reload). */
export async function refreshBillingPanel() {
  harnessBillingCache.invalidate();
  if (!byId('usage-billing')) return;
  await Promise.all([ensureController().refresh(), refreshSubscriptions()]);
}

/** Wires buttons and delegated actions once. */
export function initBillingPanel() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  byId('usage-billing-add-account')?.addEventListener('click', openAccountDialog);
  byId('usage-billing-add-subscription')?.addEventListener('click', openSubscriptionDialog);
  byId('usage-billing-subscriptions')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-billing-action]') : null;
    const subId = target?.getAttribute('data-sub-id') || '';
    if (!subId) return;
    if (target.getAttribute('data-billing-action') === 'sub-confirm') openPaymentDialog(subId);
    else if (target.getAttribute('data-billing-action') === 'sub-state') openStateDialog(subId);
  });
  byId('usage-billing-add-tx')?.addEventListener('click', () => openTransactionDialog());
  byId('usage-billing-add-reading')?.addEventListener('click', openSnapshotDialog);
  byId('usage-billing-reload')?.addEventListener('click', () => { void refreshBillingPanel(); });
  byId('usage-billing-provider-refresh')?.addEventListener('click', async () => {
    const result = await refreshDeepSeekBalanceReading();
    harnessBillingCache.invalidate();
    if (!result?.ok) setStatus(billingErrorText(result?.error || 'unknown', t), 'error');
    await refreshBillingPanel();
  });
  byId('usage-billing')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-billing-action]') : null;
    if (!target) return;
    const txId = target.getAttribute('data-tx-id') || '';
    if (target.getAttribute('data-billing-action') === 'correct') openTransactionDialog({ txId });
    else if (target.getAttribute('data-billing-action') === 'withdraw') void ensureController().withdrawDuplicate(txId);
  });
}

/**
 * Fills a harness card slot with the linked wallet(s). Failures leave the slot
 * empty: the harness card must not depend on the billing endpoints.
 *
 * @param {string} harnessId
 * @param {HTMLElement} slot
 * @returns {Promise<void>}
 */
export async function paintHarnessBilling(harnessId, slot) {
  try {
    const [{ ledger, forecast, links }, provider] = await Promise.all([
      harnessBillingCache.get(),
      harnessId === 'deepseek' ? getDeepSeekBalanceStatus().catch(() => null) : null,
    ]);
    if (!ledger?.ok || !links?.ok) return;
    const model = buildBillingViewModel({ ledger, forecast, links: links.links, providerAttempt: provider?.ok ? provider.lastAttempt : null });
    renderUsage(slot, renderHarnessBillingView(harnessId, model, { t, lang: getCurrentLang() }));
  } catch {
    clearUsageContent(slot);
  }
}
