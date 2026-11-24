import { LitElement, html, nothing } from 'lit';
import '../../components/ui/index.js';
import { t } from '../../i18n/index.js';
import { createDocsApi } from '../../core/api/docs.js';
import { docsScope } from './docsScope.js';

class CrDocsSettings extends LitElement {
  static properties = {
    config: { state: true }, root: { state: true }, agentRead: { state: true },
    busy: { state: true }, message: { state: true }, consentOpen: { state: true },
  };
  createRenderRoot() { return this; }
  constructor() {
    super();
    this.config = null; this.root = ''; this.agentRead = false; this.busy = false;
    this.message = ''; this.consentOpen = false; this.version = 0;
  }
  async refresh() {
    const version = ++this.version;
    try {
      const scope = await docsScope();
      if (version !== this.version) return;
      this.api = createDocsApi(scope);
      const config = await this.api.config();
      if (version !== this.version) return;
      this.apply(config); this.message = '';
    } catch (error) { if (version === this.version) this.message = `${t('docs.error')} (${error.code || error.status || t('docs.connection')})`; }
  }
  apply(config) {
    this.config = config; this.root = config.root?.path || ''; this.agentRead = config.agentRead === true;
  }
  async action(operation) {
    if (this.busy) return;
    const version = this.version;
    this.busy = true; this.message = '';
    try {
      const config = await operation(this.api);
      if (version !== this.version) return;
      this.apply(config); this.consentOpen = false; this.message = t('docs.saved');
    } catch (error) { if (version === this.version) this.message = `${t('docs.error')} (${error.code || error.status || t('docs.connection')})`; }
    finally { this.busy = false; }
  }
  render() {
    return html`<div class="cr-card docs-settings"><h3 class="cr-section-title">${t('docs.title')}</h3>
      <p class="cr-hint">${t('docs.rootHint')}</p>
      <label class="cr-field"><span class="cr-field-label">${t('docs.root')}</span><cr-bar-input .value=${this.root} ?disabled=${this.busy} @input=${(e) => { this.root = e.target.value; }}></cr-bar-input></label>
      <div class="docs-toolbar">
        <cr-bar-button ?disabled=${this.busy || !this.api || !this.root.trim()} @click=${() => { const root = this.root; void this.action((api) => api.setConfig(root)); }}>${t('docs.useRoot')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.api} @click=${() => void this.action((api) => api.setConfig('docs', true))}>${t('docs.defaultRoot')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.config?.root} @click=${() => void this.action((api) => api.setConfig(null))}>${t('docs.clearRoot')}</cr-bar-button>
      </div>
      ${this.config?.root?.external ? html`<p class="cr-hint">${t('docs.consentHint')}</p><p>${t('docs.canonical')}: ${this.config.root.realpath}</p>
        <cr-checkbox .checked=${this.agentRead} ?disabled=${this.busy} @change=${(e) => { this.agentRead = e.target.checked; }}>${t('docs.agentRead')}</cr-checkbox>
        <p class="cr-hint">${t('docs.agentHint')}</p>
        <div class="docs-toolbar"><cr-bar-button ?disabled=${this.busy} @click=${() => { this.consentOpen = true; }}>${t('docs.grant')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.config.root.consented} @click=${() => void this.action((api) => api.revoke())}>${t('docs.revoke')}</cr-bar-button></div>` : nothing}
      <p class="cr-status" role="status">${this.message}</p>
      <cr-dialog ?open=${this.consentOpen} .heading=${t('docs.grant')} @cr-dialog-close=${() => { if (!this.busy) this.consentOpen = false; }}>
        <p>${t('docs.consentHint')}</p><p>${this.config?.root?.realpath}</p><p>${this.agentRead ? t('docs.agentEnabled') : t('docs.agentDisabled')}</p>
        <cr-bar-button slot="actions" ?disabled=${this.busy} @click=${() => { this.consentOpen = false; }}>${t('docs.cancel')}</cr-bar-button>
        <cr-bar-button slot="actions" variant="primary" ?disabled=${this.busy} @click=${() => { const agentRead = this.agentRead; void this.action((api) => api.consent(agentRead)); }}>${t('docs.confirm')}</cr-bar-button>
      </cr-dialog>
    </div>`;
  }
}
if (!customElements.get('cr-docs-settings')) customElements.define('cr-docs-settings', CrDocsSettings);

export async function refreshDocsSettings() {
  let section = document.getElementById('settings-docs-section');
  if (!section) {
    const anchor = document.querySelector('.settings-section[data-settings-tab="workspace"]');
    if (!anchor) return;
    section = document.createElement('section');
    section.id = 'settings-docs-section'; section.className = 'settings-section'; section.dataset.settingsTab = 'workspace';
    section.append(document.createElement('cr-docs-settings'));
    anchor.after(section);
  }
  section.hidden = document.getElementById('settings-panel')?.dataset.activeSettingsTab !== 'workspace';
  await /** @type {any} */ (section.querySelector('cr-docs-settings')).refresh();
}
window.addEventListener('cretli-view-context-changed', () => {
  if (document.getElementById('settings-panel')?.classList.contains('active') && document.getElementById('settings-panel')?.dataset.activeSettingsTab === 'workspace') void refreshDocsSettings();
});
