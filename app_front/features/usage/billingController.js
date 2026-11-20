/**
 * Settings → Usage: billing controller. Loads the ledger, forecast and harness
 * links, repaints on every change and runs the save/correct/withdraw flows.
 *
 * All I/O is injected so the flows are testable without a DOM. A write sends
 * the last seen ledger revision; a conflict reloads the view instead of
 * overwriting, and every successful write repaints without a page reload.
 */

import {
  billingErrorText,
  buildBillingViewModel,
  buildSnapshotInput,
  buildTransactionInput,
  renderBillingView,
} from './billingView.js';

// Same shape as the currency check used for transactions in billingView.js.
const WALLET_CURRENCY_RE = /^[A-Z0-9_]{2,16}$/;

/**
 * @param {{
 *   api: {
 *     getLedger: () => Promise<any>,
 *     getForecast: () => Promise<any>,
 *     getLinks: () => Promise<any>,
 *     getProviderStatus?: () => Promise<any>,
 *     mutate: (method: string, path: string, revision: number, body?: any) => Promise<any>,
 *   },
 *   t: (key: string, vars?: any) => string,
 *   getLang?: () => string,
 *   paint: (view: import('lit').TemplateResult, model: any) => void,
 *   setStatus?: (message: string, tone: 'error'|'success'|'') => void,
 *   newKey?: () => string,
 * }} deps
 */
export function createBillingController(deps) {
  const { api, t } = deps;
  const lang = () => (deps.getLang ? deps.getLang() : 'en');
  const setStatus = deps.setStatus || (() => {});
  const newKey = deps.newKey || (() => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const state = { revision: 0, model: null, loading: false, token: 0 };

  /** Reloads all three sources; the ledger is required, the rest degrade. */
  async function refresh() {
    const token = ++state.token;
    state.loading = true;
    const [ledger, forecast, links] = await Promise.allSettled([api.getLedger(), api.getForecast(), api.getLinks()]);
    const providerStatus = await Promise.resolve(api.getProviderStatus?.()).catch(() => null);
    // A slower older refresh must not overwrite a newer one.
    if (token !== state.token) return state.model;
    state.loading = false;
    const ledgerValue = ledger.status === 'fulfilled' ? ledger.value : null;
    const ledgerBody = ledgerValue?.ok ? ledgerValue : null;
    if (!ledgerBody) {
      setStatus(billingErrorText(ledgerValue?.error || 'load_failed', t), 'error');
      return state.model;
    }
    state.revision = Number(ledgerBody.revision) || 0;
    state.model = buildBillingViewModel({
      ledger: ledgerBody,
      forecast: forecast.status === 'fulfilled' ? forecast.value : null,
      links: links.status === 'fulfilled' && links.value?.ok ? links.value.links : [],
      providerAttempt: providerStatus?.ok ? providerStatus.lastAttempt : null,
    });
    deps.paint(renderBillingView(state.model, { t, lang: lang() }), state.model);
    return state.model;
  }

  /**
   * @param {{ ok: boolean, error?: string }} result
   * @returns {Promise<boolean>}
   */
  async function settle(result) {
    if (result?.ok) {
      setStatus(t('billing.saved'), 'success');
      await refresh();
      return true;
    }
    const code = result?.error || 'unknown';
    setStatus(billingErrorText(code, t), 'error');
    // Stale or missing revision: show what the ledger looks like now.
    if (code === 'revision_conflict' || code === 'if_match_required') await refresh();
    return false;
  }

  /**
   * @param {'create'|'correct'} mode
   * @param {Record<string, string>} form
   * @param {string} [txId] transaction being corrected
   * @returns {Promise<{ ok: boolean, errors?: string[] }>}
   */
  async function saveTransaction(mode, form, txId = '') {
    const built = buildTransactionInput(form);
    if (!built.ok) {
      setStatus(billingErrorText(built.errors[0], t), 'error');
      return { ok: false, errors: built.errors };
    }
    const result = mode === 'correct'
      ? await api.mutate('PUT', `/transactions/${encodeURIComponent(txId)}`, state.revision, built.input)
      : await api.mutate('POST', '/transactions', state.revision, { ...built.input, idempotencyKey: form.idempotencyKey || newKey() });
    return { ok: await settle(result) };
  }

  /**
   * @param {Record<string, string>} form
   * @returns {Promise<{ ok: boolean, errors?: string[] }>}
   */
  async function saveSnapshot(form) {
    const built = buildSnapshotInput(form);
    if (!built.ok) {
      setStatus(billingErrorText(built.errors[0], t), 'error');
      return { ok: false, errors: built.errors };
    }
    return { ok: await settle(await api.mutate('POST', '/snapshots', state.revision, { ...built.input, idempotencyKey: form.idempotencyKey || newKey() })) };
  }

  /**
   * @param {{ label?: string, walletCurrency?: string }} form
   * @returns {Promise<{ ok: boolean }>}
   */
  async function saveAccount(form) {
    const label = String(form.label || '').trim();
    const walletCurrency = String(form.walletCurrency || '').trim().toUpperCase();
    if (!label) {
      setStatus(billingErrorText('label_required', t), 'error');
      return { ok: false };
    }
    if (!WALLET_CURRENCY_RE.test(walletCurrency)) {
      setStatus(billingErrorText('wallet_currency_invalid', t), 'error');
      return { ok: false };
    }
    return { ok: await settle(await api.mutate('POST', '/accounts', state.revision, { label, walletCurrency, idempotencyKey: newKey() })) };
  }

  /**
   * Withdraws one entry of a possible-duplicate pair (history is kept).
   *
   * @param {string} txId
   * @returns {Promise<boolean>}
   */
  async function withdrawDuplicate(txId) {
    return settle(await api.mutate('DELETE', `/transactions/${encodeURIComponent(txId)}`, state.revision, { reason: 'duplicate' }));
  }

  return {
    refresh,
    saveTransaction,
    saveSnapshot,
    saveAccount,
    withdrawDuplicate,
    getState: () => state,
  };
}
