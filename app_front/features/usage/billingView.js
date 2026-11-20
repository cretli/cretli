/**
 * Settings → Usage: DOM-free billing view (credit ledger accounts, balances,
 * forecast scenarios, history and entry forms).
 *
 * Money is shown as the ledger's decimal strings with the currency code; it is
 * never converted, rounded or summed across currencies. A wallet that several
 * harness bindings point at is rendered once with the harnesses listed on it.
 * An exhaustion date is shown only when the forecast has a verified basis
 * (fresh endpoint, no reconciliation reason, a measured spend rate).
 *
 * The caller owns translation via `t()`.
 */

import { html, nothing } from 'lit';

/** Primary states a balance row can be in, in priority order. */
export const BILLING_STATES = Object.freeze(['inconsistent', 'unavailable', 'unknown', 'stale', 'zero', 'ok']);

/** Forecast statuses for which an exhaustion date has a measured basis. */
const VERIFIED_FORECAST_STATUSES = new Set(['ok', 'rate_change']);

/** Transaction types the manual form can write. */
export const BILLING_TX_TYPES = Object.freeze(['topup', 'grant', 'refund', 'adjustment', 'expiry']);

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z0-9_]{2,16}$/;
const MOMENT_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d{1,3})?)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isZeroAmount(value) {
  return typeof value === 'string' && AMOUNT_RE.test(value) && /^-?0+(\.0+)?$/.test(value);
}

/**
 * @param {unknown} value
 * @param {string} lang
 * @returns {string}
 */
export function formatBillingTime(value, lang = 'en') {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat(lang === 'pl' ? 'pl-PL' : 'en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(ms));
}

/**
 * Moment stored by the ledger: `{ at }` for instants, `{ date, precision }` otherwise.
 *
 * @param {{ at?: string|null, date?: string|null }|null|undefined} moment
 * @param {string} lang
 * @returns {string}
 */
export function formatLedgerMoment(moment, lang = 'en') {
  if (!moment) return '—';
  if (moment.at) return formatBillingTime(moment.at, lang);
  return moment.date ? String(moment.date) : '—';
}

/**
 * @param {unknown} amount
 * @param {unknown} currency
 * @returns {string}
 */
export function formatMoney(amount, currency) {
  if (amount == null || amount === '') return '—';
  return `${amount} ${currency || ''}`.trim();
}

/**
 * Duration → short text (`3 d 4 h`).
 *
 * @param {number|null} ms
 * @returns {string}
 */
function formatRunway(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const hours = Math.floor(ms / 3600000);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/**
 * Primary display state of one balance row.
 *
 * @param {{ status: string, balance: string|null, available: boolean|null, stale: boolean }} row
 * @returns {'inconsistent'|'unavailable'|'unknown'|'stale'|'zero'|'ok'}
 */
export function classifyBalanceState(row) {
  if (row.status === 'inconsistent') return 'inconsistent';
  if (row.available === false) return 'unavailable';
  if (row.balance == null) return 'unknown';
  if (row.stale) return 'stale';
  if (row.status === 'no_funds' || isZeroAmount(row.balance)) return 'zero';
  return 'ok';
}

/**
 * @param {any} forecast
 * @returns {{ spendPerDay: number, windowId: string, exhaustsAt: string, remainingMs: number|null }|null}
 */
function verifiedExhaustion(forecast) {
  const ex = forecast?.exhaustion;
  if (!ex || !ex.exhaustsAt) return null;
  if (!VERIFIED_FORECAST_STATUSES.has(forecast.status) || forecast.stale) return null;
  return ex;
}

/**
 * One account/currency/series row from a forecast entry and the ledger view.
 *
 * @param {any} forecast
 * @param {any|undefined} snapshot latest active snapshot of the series
 * @param {{ posted?: string, pending?: string }|undefined} booked
 * @returns {any}
 */
function buildBalanceRow(forecast, snapshot, booked) {
  const reasons = Array.isArray(forecast.reasons) ? forecast.reasons : [];
  const windows = forecast.windows || {};
  const measured = Object.values(windows).filter((w) => w && w.spend != null);
  const expiries = Array.isArray(forecast.expiries) ? forecast.expiries : [];
  const row = {
    currency: forecast.currency,
    series: forecast.series,
    status: forecast.status,
    reasons,
    balance: forecast.latestBalance ?? null,
    granted: forecast.latestGrantedBalance ?? null,
    toppedUp: forecast.latestToppedUpBalance ?? null,
    available: typeof forecast.isAvailable === 'boolean' ? forecast.isAvailable : null,
    stale: forecast.stale === true,
    source: snapshot?.source || null,
    observedAt: forecast.latestObservedAt || snapshot?.observedAt?.at || snapshot?.observedAt?.date || null,
    recordedAt: snapshot?.recordedAt || null,
    completeness: snapshot?.completeness || null,
    booked: booked && typeof booked === 'object' ? booked : null,
    windows,
    expiries,
    rateChange: forecast.rateChange || null,
  };
  row.state = classifyBalanceState(row);
  // A date needs a trustworthy balance: only a row in the plain ok state may show one.
  const exhaustion = row.state === 'ok' ? verifiedExhaustion(forecast) : null;
  row.exhaustion = exhaustion;
  row.flags = {
    // Spend comes from balance differences; there is no local price table.
    noLocalPricing: true,
    incompleteHistory: reasons.includes('incomplete_snapshot')
      || measured.length === 0
      || (snapshot ? snapshot.completeness !== 'complete' : false),
    staleBalance: row.stale && row.balance != null,
    uncertainExpiry: forecast.balanceDropUncertain === true
      || reasons.includes('unknown_expiry')
      || expiries.some((e) => e.precision !== 'instant'),
    needsReconciliation: forecast.status === 'needs_reconciliation',
    noExhaustionBasis: exhaustion == null,
  };
  return row;
}

/**
 * Active transactions with duplicate hints; superseded and withdrawn versions
 * are counted, not listed.
 *
 * @param {any[]} transactions all ledger rows
 * @returns {{ active: any[], withdrawn: number, corrected: number, duplicateGroups: string[][] }}
 */
export function buildHistory(transactions) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const dead = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const active = rows.filter((r) => !dead.has(r.id) && !r.tombstone);
  const activeIds = new Set(active.map((r) => r.id));
  // Built once: rebuilding per transaction made the history quadratic.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chainDepth = (tx) => {
    let depth = 0;
    let cur = tx;
    while (cur?.supersedes && depth < 50) {
      depth += 1;
      cur = byId.get(cur.supersedes);
    }
    return depth;
  };
  const sorted = active
    .map((tx) => ({
      ...tx,
      revisions: chainDepth(tx),
      duplicateOf: (tx.possibleDuplicateOf || []).filter((id) => activeIds.has(id)),
    }))
    .sort((a, b) => String(b.occurredAt?.at || b.occurredAt?.date || '')
      .localeCompare(String(a.occurredAt?.at || a.occurredAt?.date || '')));
  // A hint is one-directional on the server (the later row points at the
  // earlier one), so groups are rebuilt from both ends.
  const groups = [];
  const seen = new Set();
  for (const tx of sorted) {
    if (tx.duplicateOf.length === 0 || seen.has(tx.id)) continue;
    const group = [...new Set([tx.id, ...tx.duplicateOf])];
    group.forEach((id) => seen.add(id));
    groups.push(group);
  }
  const inGroup = new Set(groups.flat());
  const withDup = sorted.map((tx) => ({ ...tx, isPossibleDuplicate: inGroup.has(tx.id) }));
  return {
    active: withDup,
    withdrawn: rows.filter((r) => r.tombstone).length,
    corrected: rows.filter((r) => !r.tombstone && r.supersedes).length,
    duplicateGroups: groups,
  };
}

/**
 * Builds the whole billing view model.
 *
 * @param {{ ledger?: any|null, forecast?: any|null, links?: any[], providerAttempt?: { at: string, ok: boolean, kind: string }|null }} input
 * @returns {{ accounts: any[], revision: number, forecastMissing: boolean, orphanLinks: any[], history: { withdrawn: number, corrected: number, duplicateGroups: string[][] }, providerAttempt: ReturnType<typeof normalizeAttempt> }}
 */
export function buildBillingViewModel(input = {}) {
  const ledger = input.ledger || {};
  const accounts = Array.isArray(ledger.accounts) ? ledger.accounts : [];
  const forecasts = Array.isArray(input.forecast?.forecasts) ? input.forecast.forecasts : [];
  const links = Array.isArray(input.links) ? input.links : [];
  const viewAccounts = Array.isArray(ledger.views?.accounts) ? ledger.views.accounts : [];
  const history = buildHistory(ledger.transactions);
  const linkedIds = new Set();
  const out = accounts.map((account) => {
    const view = viewAccounts.find((a) => a.id === account.id) || {};
    const latest = view.latestSnapshots || {};
    const rows = forecasts
      .filter((f) => f.accountId === account.id)
      .map((f) => buildBalanceRow(f, latest[`${f.currency}/${f.series}`], view.creditBalances?.[f.currency]));
    // A wallet is listed once however many harness bindings point at it.
    const harnesses = links
      .filter((l) => l.ledgerAccountId === account.id)
      .map((l) => ({ harness: l.harness, profileKey: l.profileKey }));
    if (harnesses.length) linkedIds.add(account.id);
    const txs = history.active.filter((tx) => tx.accountId === account.id);
    return {
      id: account.id,
      label: account.label,
      walletCurrency: account.walletCurrency,
      rows,
      harnesses,
      transactions: txs,
      payments: view.paymentTotals || {},
      chart: buildBalanceSeries(ledger.snapshots, account.id),
    };
  });
  return {
    accounts: out,
    revision: Number(ledger.revision) || 0,
    forecastMissing: !input.forecast || input.forecast.ok === false,
    history: { withdrawn: history.withdrawn, corrected: history.corrected, duplicateGroups: history.duplicateGroups },
    orphanLinks: links.filter((l) => !l.ledgerAccountId),
    providerAttempt: normalizeAttempt(input.providerAttempt),
  };
}

/**
 * @param {any} raw
 * @returns {{ at: string, ok: boolean, kind: string }|null}
 */
function normalizeAttempt(raw) {
  if (!raw || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return null;
  return { at: raw.at, ok: raw.ok === true, kind: String(raw.kind || '') };
}

/**
 * "Last attempt: <time> — <result>" line; empty when no attempt was recorded.
 *
 * @param {{ at: string, ok: boolean, kind: string }|null|undefined} attempt
 * @param {(key: string, vars?: any) => string} t
 * @param {string} lang
 * @returns {import('lit').TemplateResult|typeof nothing}
 */
function renderAttemptLine(attempt, t, lang) {
  if (!attempt) return nothing;
  const when = new Date(attempt.at).toLocaleString(lang);
  const result = attempt.ok ? t('billing.attemptOk') : t('billing.attemptFailed', { kind: attempt.kind });
  return html`<div class="billing-meta" data-billing-last-attempt data-tone=${attempt.ok ? 'ok' : 'error'}>${t('billing.lastAttempt', { time: when, result })}</div>`;
}

/**
 * Per currency balance points for the optional chart (active snapshots only).
 *
 * @param {any[]} snapshots
 * @param {string} accountId
 * @returns {Record<string, { t: number, v: number }[]>}
 */
export function buildBalanceSeries(snapshots, accountId) {
  const rows = Array.isArray(snapshots) ? snapshots : [];
  const dead = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const byCurrency = {};
  for (const s of rows) {
    if (dead.has(s.id) || s.tombstone || s.accountId !== accountId) continue;
    const t = Date.parse(s.observedAt?.at || '');
    const v = Number(s.totalBalance?.value);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    (byCurrency[s.currency] ||= []).push({ t, v });
  }
  for (const points of Object.values(byCurrency)) points.sort((a, b) => a.t - b.t);
  return byCurrency;
}

/**
 * Tiny inline line chart; one currency per chart so scales never mix.
 *
 * @param {{ t: number, v: number }[]} points
 * @param {{ width?: number, height?: number, label?: string }} [options]
 * @returns {import('lit').TemplateResult|typeof nothing}
 */
export function renderBalanceLineSvg(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) return nothing;
  const width = options.width || 240;
  const height = options.height || 48;
  const pad = 4;
  const minT = points[0].t;
  const spanT = Math.max(1, points[points.length - 1].t - minT);
  const vs = points.map((p) => p.v);
  const minV = Math.min(...vs);
  const spanV = Math.max(1e-9, Math.max(...vs) - minV);
  const coords = points
    .map((p) => `${(pad + ((p.t - minT) / spanT) * (width - 2 * pad)).toFixed(1)},${(height - pad - ((p.v - minV) / spanV) * (height - 2 * pad)).toFixed(1)}`)
    .join(' ');
  return html`<svg class="billing-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label=${options.label || ''} preserveAspectRatio="none"><polyline points=${coords} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

/**
 * @param {string} text
 * @param {string} tone
 * @returns {import('lit').TemplateResult}
 */
function badge(text, tone = 'muted') {
  return html`<span class="billing-badge" data-tone=${tone}>${text}</span>`;
}

/**
 * @param {any} row
 * @param {(key: string, vars?: any) => string} t
 * @returns {import('lit').TemplateResult}
 */
function renderFlags(row, t) {
  const out = [badge(t('billing.flagNoLocalPricing'), 'warn')];
  if (row.flags.incompleteHistory) out.push(badge(t('billing.flagIncompleteHistory'), 'warn'));
  if (row.flags.staleBalance) out.push(badge(t('billing.flagStale'), 'warn'));
  if (row.flags.uncertainExpiry) out.push(badge(t('billing.flagUncertainExpiry'), 'warn'));
  if (row.flags.needsReconciliation) out.push(badge(t('billing.flagNeedsReconciliation'), 'warn'));
  return html`<div class="billing-flags">${out}</div>`;
}

/**
 * @param {any} row
 * @param {(key: string, vars?: any) => string} t
 * @param {string} lang
 * @returns {import('lit').TemplateResult}
 */
function renderScenarios(row, t, lang) {
  const cells = Object.values(row.windows || {}).filter(Boolean).map((w) => {
    const verified = w.status === 'ok' || w.status === 'zero_rate';
    const spend = w.spend == null ? t('billing.scenarioNoBasis') : `${formatMoney(w.spend, row.currency)} (${w.spendPerDay ?? '—'}/${t('billing.perDay')})`;
    const note = verified ? nothing : badge(t(`billing.window_${w.status}`) || w.status, 'warn');
    return html`<li class="billing-scenario"><span class="billing-scenario-label">${t('billing.scenarioWindow', { id: w.id })}</span>
      <span class="billing-scenario-value">${spend}</span>${note}</li>`;
  });
  const exhaustion = row.exhaustion
    ? html`<p class="cr-hint">${t('billing.exhaustsAt', {
      date: formatBillingTime(row.exhaustion.exhaustsAt, lang),
      runway: formatRunway(row.exhaustion.remainingMs),
      window: row.exhaustion.windowId,
    })}</p>`
    : html`<p class="cr-hint">${t('billing.noExhaustionBasis')}</p>`;
  return html`<ul class="billing-scenarios">${cells}</ul>${exhaustion}`;
}

/**
 * @param {any} row
 * @param {any} account
 * @param {(key: string, vars?: any) => string} t
 * @param {string} lang
 * @returns {import('lit').TemplateResult}
 */
function renderBalanceRow(row, account, t, lang) {
  const stateTone = row.state === 'ok' ? 'ok' : row.state === 'inconsistent' || row.state === 'unavailable' ? 'error' : 'warn';
  const parts = [];
  if (row.granted != null) parts.push(`${t('billing.granted')}: ${formatMoney(row.granted, row.currency)}`);
  if (row.toppedUp != null) parts.push(`${t('billing.toppedUp')}: ${formatMoney(row.toppedUp, row.currency)}`);
  const booked = row.booked
    ? html`<div class="billing-meta">${t('billing.booked', { posted: formatMoney(row.booked.posted, row.currency), pending: formatMoney(row.booked.pending, row.currency) })}</div>`
    : nothing;
  const reading = row.observedAt
    ? `${t('billing.lastReading', { time: formatLedgerMomentText(row.observedAt, lang) })}${row.recordedAt ? ` · ${t('billing.lastRecorded', { time: formatBillingTime(row.recordedAt, lang) })}` : ''}`
    : t('billing.noReading');
  const chart = renderBalanceLineSvg(account.chart?.[row.currency], { label: t('billing.chartLabel', { currency: row.currency }) });
  const expiries = row.expiries.length
    ? html`<div class="billing-meta">${t('billing.expiries', {
      list: row.expiries.map((e) => `${formatMoney(e.amount, e.currency)} → ${e.at ? formatBillingTime(e.at, lang) : e.date}${e.precision === 'instant' ? '' : ` (${t('billing.expiryApprox')})`}`).join('; '),
    })}</div>`
    : nothing;
  return html`<li class="billing-row" data-state=${row.state} data-currency=${row.currency}>
    <div class="billing-row-head">
      <span class="billing-currency">${row.currency}</span>
      <span class="billing-amount">${row.balance == null ? t('billing.balanceUnknown') : formatMoney(row.balance, row.currency)}</span>
      ${badge(t(`billing.state_${row.state}`), stateTone)}
    </div>
    <div class="billing-meta">${t('billing.source', { source: row.source || t('billing.sourceUnknown') })} · ${reading}</div>
    ${parts.length ? html`<div class="billing-meta">${parts.join(' · ')}</div>` : nothing}
    ${booked}
    ${renderFlags(row, t)}
    ${renderScenarios(row, t, lang)}
    ${chart === nothing ? nothing : html`<div class="billing-chart-wrap">${chart}</div>`}
    ${expiries}
  </li>`;
}

/**
 * @param {string} value ISO instant or day
 * @param {string} lang
 * @returns {string}
 */
function formatLedgerMomentText(value, lang) {
  return /T/.test(value) ? formatBillingTime(value, lang) : String(value);
}

/**
 * @param {any} tx
 * @param {(key: string, vars?: any) => string} t
 * @param {string} lang
 * @returns {import('lit').TemplateResult}
 */
function renderTransactionRow(tx, t, lang) {
  const rawValue = String(tx.credit.value ?? '');
  const isNegativeValue = rawValue.startsWith('-');
  const isOutflow = (tx.type === 'refund' || tx.type === 'expiry') !== isNegativeValue;
  const sign = isOutflow ? '−' : '+';
  const magnitude = isNegativeValue ? rawValue.slice(1) : rawValue;
  const payment = tx.payment ? ` · ${t('billing.paid', { amount: formatMoney(tx.payment.value, tx.payment.currency) })}` : '';
  const dup = tx.isPossibleDuplicate ? badge(t('billing.possibleDuplicate'), 'warn') : nothing;
  const pending = tx.state === 'pending' ? badge(t('billing.pending'), 'muted') : nothing;
  const corrected = tx.revisions > 0 ? badge(t('billing.corrected', { count: tx.revisions }), 'muted') : nothing;
  return html`<li class="billing-tx" data-tx-id=${tx.id}>
    <div class="billing-tx-main">
      <span class="billing-tx-type">${t(`billing.type_${tx.type}`)}</span>
      <span class="billing-amount">${sign}${formatMoney(magnitude, tx.credit.currency)}</span>${pending}${dup}${corrected}
    </div>
    <div class="billing-meta">${formatLedgerMoment(tx.occurredAt, lang)} · ${tx.source}${payment}</div>
    <div class="billing-tx-actions">
      <cr-bar-button data-billing-action="correct" data-tx-id=${tx.id}>${t('billing.correct')}</cr-bar-button>
      ${tx.isPossibleDuplicate ? html`<cr-bar-button data-billing-action="withdraw" data-tx-id=${tx.id}>${t('billing.withdrawDuplicate')}</cr-bar-button>` : nothing}
    </div>
  </li>`;
}

/**
 * Renders the accounts list.
 *
 * @param {ReturnType<typeof buildBillingViewModel>} model
 * @param {{ t: (key: string, vars?: any) => string, lang?: string }} options
 * @returns {import('lit').TemplateResult}
 */
export function renderBillingView(model, options = /** @type {any} */ ({})) {
  const t = options.t;
  const lang = options.lang || 'en';
  if (!model.accounts.length) {
    return html`<p class="cr-hint">${t('billing.empty')}</p>`;
  }
  const notice = model.forecastMissing
    ? html`<p class="billing-notice" data-tone="warn">${t('billing.forecastUnavailable')}</p>`
    : nothing;
  const dupNotice = model.history.duplicateGroups.length
    ? html`<p class="billing-notice" data-tone="warn">${t('billing.duplicatesFound', { count: model.history.duplicateGroups.length })}</p>`
    : nothing;
  const cards = model.accounts.map((account) => {
    const harnesses = account.harnesses.length
      ? html`<div class="billing-meta">${t('billing.sharedWallet')}: ${account.harnesses.map((h, i) => html`${i ? ', ' : nothing}<span class="billing-harness-name" data-billing-harness=${h.harness}>${h.harness}${h.profileKey && h.profileKey !== 'default' ? ` (${h.profileKey})` : ''}</span>`)}</div>`
      : nothing;
    const rows = account.rows.length
      ? html`<ul class="billing-rows">${account.rows.map((r) => renderBalanceRow(r, account, t, lang))}</ul>`
      : html`<p class="cr-hint">${t('billing.noReading')}</p>`;
    const txs = account.transactions.length
      ? html`<details class="billing-history"><summary>${t('billing.history', { count: account.transactions.length })}</summary><ul class="billing-txs">${account.transactions.map((tx) => renderTransactionRow(tx, t, lang))}</ul></details>`
      : html`<p class="cr-hint">${t('billing.noTransactions')}</p>`;
    const attempt = account.harnesses.some((h) => h.harness === 'deepseek')
      ? renderAttemptLine(model.providerAttempt, t, lang)
      : nothing;
    return html`<section class="cr-card billing-account" data-account-id=${account.id}>
      <header class="billing-account-head">
        <h5 class="billing-account-title">${account.label}</h5>
        <span class="billing-currency">${account.walletCurrency}</span>
      </header>
      ${harnesses}${attempt}${rows}${txs}
    </section>`;
  });
  const orphans = model.orphanLinks.length
    ? html`<p class="cr-hint">${t('billing.orphanLinks', { list: [...new Set(model.orphanLinks.map((l) => l.harness))].join(', ') })}</p>`
    : nothing;
  return html`${notice}${dupNotice}${cards}${orphans}`;
}

/**
 * Compact wallet block for a harness: the linked account(s) and a link to the
 * Usage billing view. A wallet shared by several bindings of this harness is
 * listed once and its balance is not repeated per binding.
 *
 * @param {string} harness
 * @param {ReturnType<typeof buildBillingViewModel>} model
 * @param {{ t: (key: string, vars?: any) => string, lang?: string }} options
 * @returns {import('lit').TemplateResult|typeof nothing} nothing when the harness has no linked wallet
 */
export function renderHarnessBillingView(harness, model, options = /** @type {any} */ ({})) {
  const t = options.t;
  const wallets = model.accounts.filter((a) => a.harnesses.some((h) => h.harness === harness));
  if (!wallets.length) return nothing;
  const items = wallets.map((a) => {
    const balances = a.rows.length
      ? a.rows.map((r) => html`${r.balance == null ? t('billing.balanceUnknown') : formatMoney(r.balance, r.currency)} ${badge(t(`billing.state_${r.state}`), r.state === 'ok' ? 'ok' : 'warn')} `)
      : t('billing.noReading');
    return html`<li>${a.label}: ${balances}</li>`;
  });
  return html`<div class="billing-harness"><span class="cr-field-label">${t('billing.harnessAccount')}</span>
    <ul class="billing-harness-list">${items}</ul>
    ${harness === 'deepseek' ? renderAttemptLine(model.providerAttempt, t, options.lang || 'en') : nothing}
    <a class="billing-link" href="#" data-billing-open>${t('billing.openBilling')}</a></div>`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return String(value ?? '').trim();
}

/**
 * Validates and shapes the transaction form into an API body.
 *
 * @param {Record<string, string>} form raw field values
 * @returns {{ ok: boolean, input?: any, errors?: string[] }}
 */
export function buildTransactionInput(form) {
  const errors = [];
  const type = trimmed(form.type);
  if (!BILLING_TX_TYPES.includes(type)) errors.push('type_invalid');
  const amount = trimmed(form.amount);
  if (!AMOUNT_RE.test(amount)) errors.push('credit_amount_invalid');
  else if (amount.startsWith('-') && type !== 'adjustment') errors.push('credit_amount_negative');
  const occurredAt = trimmed(form.occurredAt);
  if (!MOMENT_RE.test(occurredAt)) errors.push('occurred_at_invalid');
  const source = trimmed(form.source);
  if (!source) errors.push('source_required');
  const input = {
    accountId: trimmed(form.accountId),
    type,
    state: trimmed(form.state) === 'pending' ? 'pending' : 'posted',
    occurredAt,
    source,
    credit: { amount },
  };
  const paymentAmount = trimmed(form.paymentAmount);
  if (paymentAmount) {
    const currency = trimmed(form.paymentCurrency).toUpperCase();
    if (!AMOUNT_RE.test(paymentAmount) || paymentAmount.startsWith('-')) errors.push('payment_amount_invalid');
    if (!CURRENCY_RE.test(currency)) errors.push('payment_currency_invalid');
    input.payment = { amount: paymentAmount, currency };
  }
  const expiresAt = trimmed(form.expiresAt);
  if (expiresAt) {
    if (!MOMENT_RE.test(expiresAt)) errors.push('expires_at_invalid');
    input.expiresAt = expiresAt;
  }
  const providerId = trimmed(form.providerTransactionId);
  if (providerId) input.providerTransactionId = providerId;
  return errors.length ? { ok: false, errors } : { ok: true, input };
}

/**
 * Validates and shapes the manual balance reading form.
 *
 * @param {Record<string, string>} form
 * @returns {{ ok: boolean, input?: any, errors?: string[] }}
 */
export function buildSnapshotInput(form) {
  const errors = [];
  const total = trimmed(form.totalBalance);
  if (!AMOUNT_RE.test(total)) errors.push('total_balance_invalid');
  const currency = trimmed(form.currency).toUpperCase();
  if (!CURRENCY_RE.test(currency)) errors.push('currency_invalid');
  const observedAt = trimmed(form.observedAt);
  if (!MOMENT_RE.test(observedAt)) errors.push('observed_at_invalid');
  const input = {
    accountId: trimmed(form.accountId),
    currency,
    totalBalance: total,
    observedAt,
    source: trimmed(form.source) || 'manual',
    completeness: ['complete', 'partial', 'unknown'].includes(form.completeness) ? form.completeness : 'unknown',
  };
  for (const [field, key] of [['grantedBalance', 'granted_balance_invalid'], ['toppedUpBalance', 'topped_up_balance_invalid']]) {
    const value = trimmed(form[field]);
    if (!value) continue;
    if (!AMOUNT_RE.test(value)) errors.push(key);
    input[field] = value;
  }
  if (form.isAvailable === 'yes') input.isAvailable = true;
  else if (form.isAvailable === 'no') input.isAvailable = false;
  return errors.length ? { ok: false, errors } : { ok: true, input };
}

/**
 * Maps server/validation error codes onto an i18n key (generic fallback).
 *
 * @param {string} code
 * @param {(key: string, vars?: any) => string} t
 * @returns {string}
 */
export function billingErrorText(code, t) {
  const key = `billing.error_${String(code || 'unknown')}`;
  const text = t(key);
  return text && text !== key ? text : t('billing.error_unknown');
}
