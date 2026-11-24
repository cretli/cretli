import { LitElement, css, html } from 'lit';
import { t } from '../../i18n/index.js';
import '../../components/ui/cr-bar-button.js';

export class CrFleetTile extends LitElement {
  static properties = { instance: { attribute: false } };
  static styles = css`
    :host { display:block; color:var(--cr-text); font-family:var(--cr-font-ui); }
    article { border:1px solid var(--cr-border); border-radius:var(--cr-radius-lg); background:var(--cr-surface); padding:var(--cr-space-3); }
    header,.actions { display:flex; align-items:center; justify-content:space-between; gap:var(--cr-space-2); }
    h3 { margin:0; font-size:var(--cr-font-size-lg); overflow-wrap:anywhere; }
    .status { font-size:var(--cr-font-size-sm); }
    .online { color:var(--cr-success); } .stale { color:var(--cr-warn); } .offline { color:var(--cr-text-muted); }
    dl { display:grid; grid-template-columns:1fr auto; gap:var(--cr-space-1) var(--cr-space-2); margin:var(--cr-space-3) 0; font-size:var(--cr-font-size-sm); }
    dt { color:var(--cr-text-muted); } dd { margin:0; text-align:right; }
  `;
  constructor() { super(); this.instance = null; this.onLanguage = () => this.requestUpdate(); }
  connectedCallback() { super.connectedCallback(); window.addEventListener('cr-lang-changed', this.onLanguage); }
  disconnectedCallback() { window.removeEventListener('cr-lang-changed', this.onLanguage); super.disconnectedCallback(); }
  emit(name) { this.dispatchEvent(new CustomEvent(name, { bubbles:true, composed:true })); }
  render() {
    const i = this.instance || {}; const s = i.status || {}; const summary = s.summary || {};
    const state = ['online','stale'].includes(s.state) ? s.state : 'offline';
    const usage = Object.entries(summary.providerUsage || {}).map(([provider, row]) => `${provider}: ${row.utilizationPercent}% / ${row.limitPercent}%`);
    return html`<article><header><h3>${i.name || ''}</h3><span class="status ${state}">${t(`fleet.${state}`)}</span></header>
      <p>${i.ownerLabel || ''}</p><dl><dt>${t('fleet.lastSeen')}</dt><dd>${s.lastSeen ? new Date(s.lastSeen).toLocaleString() : t('fleet.never')}</dd>
      <dt>${t('fleet.cycles')}</dt><dd>${summary.activeWatcherCycles ?? 0}</dd><dt>${t('fleet.blocked')}</dt><dd>${summary.blockedTodos ?? 0}</dd>
      <dt>${t('fleet.plans')}</dt><dd>${summary.plansAwaitingApproval ?? 0}</dd><dt>${t('fleet.usage')}</dt><dd>${usage.length ? usage.join(', ') : '—'}</dd></dl>
      <footer class="actions"><cr-bar-button @click=${() => this.emit('fleet-edit')}>${t('fleet.edit')}</cr-bar-button><cr-bar-button @click=${() => this.emit('fleet-remove')}>${t('fleet.remove')}</cr-bar-button></footer></article>`;
  }
}
if (!customElements.get('cr-fleet-tile')) customElements.define('cr-fleet-tile', CrFleetTile);
