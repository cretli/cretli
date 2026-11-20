import { LitElement, html, nothing } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { getCurrentLang, t } from '../../../i18n/index.js';
import { formatUsd } from '../../../../lib/usage/usage-rates.js';
import { addDaysIso, formatCompactNumber, formatInteger, formatPercent, sumDayWindow } from '../usageCharts.js';

/** Reactive KPI cards. It uses light DOM to keep the existing settings skin. */
export class CrUsageKpis extends SignalWatcher(LitElement) {
  state = null;

  createRenderRoot() { return this; }

  _cost(data) {
    const usd = Number(data?.usd);
    if (Number.isFinite(usd) && usd > 0) return formatUsd(usd);
    if (Number(data?.estimatedUsd) > 0) return '—';
    if (Number(data?.unpricedEvents) > 0) return t('usage.unpriced');
    return '$0.00';
  }

  _card(labelKey, data, key, lang) {
    const runs = Number(data?.runs) || 0;
    const meta = [t('usage.kpiTokens', { value: formatCompactNumber(data?.tokens, lang) })];
    if (runs > 0) {
      meta.push(t('usage.kpiRuns', { value: formatInteger(runs, lang) }));
      meta.push(t('usage.kpiSuccess', { value: formatPercent(data?.successRate, lang) }));
    } else meta.push(t('usage.kpiNoRunData'));
    const estimate = Number(data?.estimatedUsd) > 0
      ? t('usage.estimated', { usd: formatUsd(data.estimatedUsd) })
      : '';
    return html`<div class="settings-usage-kpi">
      <span class="settings-usage-kpi-label">${t(labelKey)}</span>
      <span class="settings-usage-kpi-cost" id="usage-kpi-${key}-cost">${this._cost(data)}</span>
      ${estimate ? html`<span class="settings-usage-kpi-est" id="usage-kpi-${key}-est">${estimate}</span>` : nothing}
      <span class="settings-usage-kpi-meta" id="usage-kpi-${key}-meta">${meta.join(' · ')}</span>
    </div>`;
  }

  render() {
    const summary = this.state?.summary.get() || {};
    const day = this.state?.zoneDay.get() || new Date().toISOString().slice(0, 10);
    const days = summary.byZoneDay || summary.byDay || {};
    const kpi = summary.kpi || {};
    const lang = this.state?.language.get() || getCurrentLang();
    const today = kpi.today || sumDayWindow(days, day, day);
    const week = kpi.week || sumDayWindow(days, addDaysIso(day, -6), day);
    const month = kpi.month || sumDayWindow(days, `${day.slice(0, 7)}-01`, day);
    return html`${this._card('usage.kpiToday', today, 'today', lang)}
      ${this._card('usage.kpi7d', week, 'week', lang)}
      ${this._card('usage.kpiMonth', month, 'month', lang)}`;
  }
}

if (!customElements.get('cr-usage-kpis')) customElements.define('cr-usage-kpis', CrUsageKpis);
