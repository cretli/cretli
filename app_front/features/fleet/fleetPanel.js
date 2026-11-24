import { LitElement, css, html } from 'lit';
import { t } from '../../i18n/index.js';
import '../fleet/cr-fleet-tile.js';
import '../../components/ui/cr-dialog.js';
import '../../components/ui/cr-bar-input.js';
import '../../components/ui/cr-bar-button.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';

const headers = { 'Content-Type': 'application/json' };

class CrFleetPanel extends LitElement {
  static properties = { rows: { state: true }, error: { state: true }, editing: { state: true } };
  static styles = css`
    :host { display:block; height:100%; overflow:auto; color:var(--cr-text); font-family:var(--cr-font-ui); }
    .wrap { padding:var(--cr-space-3); }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--cr-space-2); margin-bottom:var(--cr-space-3); }
    h2 { margin:0; font-size:var(--cr-font-size-xl); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(18rem,1fr)); gap:var(--cr-space-3); }
    .message { color:var(--cr-error); }
    .form { display:grid; gap:var(--cr-space-2); }
    label { display:grid; gap:var(--cr-space-1); color:var(--cr-text-muted); font-size:var(--cr-font-size-sm); }
  `;
  constructor() { super(); this.rows = []; this.error = ''; this.editing = null; this.onLanguage = () => this.requestUpdate(); }
  connectedCallback() { super.connectedCallback(); this.refresh(); this.refreshTimer = setInterval(() => { if (this.isConnected) this.refresh(); }, 5000); window.addEventListener('cr-lang-changed', this.onLanguage); }
  disconnectedCallback() { clearInterval(this.refreshTimer); window.removeEventListener('cr-lang-changed', this.onLanguage); super.disconnectedCallback(); }
  async refresh() {
    try {
      const [instances, status] = await Promise.all([cretliApiFetch('/api/fleet/instances'), cretliApiFetch('/api/fleet/status')]);
      if (!instances.ok || !status.ok) throw new Error();
      const a = await instances.json(); const b = await status.json();
      const byId = new Map(b.instances.map((row) => [row.id, row]));
      this.rows = a.instances.map((row) => ({ ...row, status: byId.get(row.id) || { state: 'offline' } })); this.error = '';
    } catch { this.error = t('fleet.loadError'); }
  }
  open(row = null) {
    this.editing = row ? { ...row, token: '' } : { name: '', ownerLabel: '', url: '', token: '' };
    this.updateComplete.then(() => this.dialog()?.show());
  }
  /** @returns {any} */
  dialog() { return this.renderRoot.querySelector('cr-dialog'); }
  /** @param {string} key */
  value(key) {
    /** @type {any} */
    const el = this.renderRoot.querySelector(`[data-field="${key}"]`);
    return el?.getLiveValue?.() ?? el?.value ?? '';
  }
  async save() {
    const data = Object.fromEntries(['name', 'ownerLabel', 'url', 'token'].map((key) => [key, this.value(key)]));
    if (this.editing.id && !data.token) delete data.token;
    try {
      const res = await cretliApiFetch(this.editing.id ? `/api/fleet/instances/${this.editing.id}` : '/api/fleet/instances', { method: this.editing.id ? 'PATCH' : 'POST', headers, body: JSON.stringify(data) });
      if (!res.ok) throw new Error();
      this.dialog()?.hide(); await this.refresh();
    } catch { this.error = t('fleet.saveError'); }
  }
  async remove(row) {
    if (!window.confirm(t('fleet.removeConfirm'))) return;
    await cretliApiFetch(`/api/fleet/instances/${row.id}`, { method: 'DELETE' }); await this.refresh();
  }
  render() {
    const edit = this.editing;
    return html`<div class="wrap"><header class="toolbar"><h2>${t('fleet.title')}</h2><cr-bar-button variant="primary" @click=${() => this.open()}>${t('fleet.add')}</cr-bar-button></header>
      ${this.error ? html`<p class="message" role="alert">${this.error}</p>` : ''}
      ${this.rows.length ? html`<div class="grid">${this.rows.map((row) => html`<cr-fleet-tile .instance=${row} @fleet-edit=${() => this.open(row)} @fleet-remove=${() => this.remove(row)}></cr-fleet-tile>`)}</div>` : html`<p>${t('fleet.empty')}</p>`}
      <cr-dialog .heading=${edit?.id ? t('fleet.edit') : t('fleet.add')}>
        ${edit ? html`<div class="form">
          ${[['name','name'],['ownerLabel','owner'],['url','url']].map(([key,label]) => html`<label>${t(`fleet.${label}`)}<cr-bar-input data-field=${key} .value=${edit[key] || ''}></cr-bar-input></label>`)}
          <label>${t('fleet.token')}<cr-bar-input type="password" autocomplete="new-password" data-field="token" value=""></cr-bar-input><span>${t('fleet.tokenHint')}</span></label>
        </div><div slot="actions"><cr-bar-button @click=${() => this.dialog()?.hide()}>${t('fleet.cancel')}</cr-bar-button><cr-bar-button variant="primary" @click=${() => this.save()}>${t('fleet.save')}</cr-bar-button></div>` : ''}
      </cr-dialog></div>`;
  }
}
if (!customElements.get('cr-fleet-panel')) customElements.define('cr-fleet-panel', CrFleetPanel);

export function initFleetPanel() { /** @type {any} */ (document.querySelector('cr-fleet-panel'))?.refresh(); }
