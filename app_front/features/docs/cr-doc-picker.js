import { LitElement, css, html } from 'lit';
import '../../components/ui/cr-dialog.js';
import '../../components/ui/cr-bar-input.js';
import '../../components/ui/cr-bar-button.js';
import { t } from '../../i18n/index.js';
import { createDocsApi } from '../../core/api/docs.js';
import { loadDocChoices } from './docsLinkLogic.js';

class CrDocPicker extends LitElement {
  static properties = { opened: { state: true }, query: { state: true }, items: { state: true }, message: { state: true }, loading: { state: true } };
  static styles = css`
    :host { font: var(--cr-font-size-sm) var(--cr-font-ui); color: var(--cr-text); }
    .list { display: flex; flex-direction: column; gap: var(--cr-space-2); max-height: 24rem; overflow: auto; margin-top: var(--cr-space-3); }
    .path { color: var(--cr-text-muted); overflow-wrap: anywhere; }
    [role=status] { color: var(--cr-text-muted); }
  `;
  constructor() {
    super(); this.opened = false; this.query = ''; this.items = []; this.message = ''; this.loading = false; this.version = 0;
  }
  disconnectedCallback() { this.version += 1; clearTimeout(this.timer); super.disconnectedCallback(); }
  async show(scope, query = '', agentOnly = false) {
    this.api = createDocsApi(scope); this.agentOnly = agentOnly; this.query = query; this.items = []; this.opened = true;
    await this.search();
    await this.updateComplete;
    if (this.opened) this.renderRoot.querySelector('cr-bar-input')?.focus();
  }
  hide() { this.opened = false; this.version += 1; clearTimeout(this.timer); }
  async search() {
    clearTimeout(this.timer);
    const version = ++this.version;
    this.loading = true; this.message = ''; this.items = [];
    try {
      const items = await loadDocChoices(this.api, this.query, this.agentOnly);
      if (version === this.version) this.items = items;
    } catch (error) {
      if (version === this.version) this.message = t(error.code === 'docs-agent-read-denied' ? 'docs.agentDenied' : 'docs.error');
    } finally { if (version === this.version) this.loading = false; }
  }
  choose(item) {
    this.hide();
    this.dispatchEvent(new CustomEvent('cr-doc-select', { detail: item, bubbles: true, composed: true }));
  }
  listKey(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...this.renderRoot.querySelectorAll('.list cr-bar-button')];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.composedPath().find((node) => buttons.includes(node)));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  render() {
    return html`<cr-dialog ?open=${this.opened} closable .closeLabel=${t('docs.cancel')} .heading=${t('docs.pickerTitle')}
      @keydown=${(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); this.renderRoot.querySelector('cr-dialog').hide(); }
      }} @cr-dialog-close=${(event) => {
      event.stopPropagation(); this.hide(); this.dispatchEvent(new CustomEvent('cr-doc-picker-close'));
    }}>
      <cr-bar-input type="search" .value=${this.query} .placeholder=${t('docs.search')} aria-label=${t('docs.search')}
        @input=${(e) => { this.query = e.target.value; this.version += 1; clearTimeout(this.timer); this.timer = setTimeout(() => this.search(), 250); }}
        @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); void this.search(); } }}></cr-bar-input>
      <p role="status">${this.message || (this.loading ? t('docs.loading') : this.items.length ? '' : t('docs.noChoices'))}</p>
      <div class="list" role="list" @keydown=${(e) => this.listKey(e)}>${this.items.map((item) => html`
        <div role="listitem"><cr-bar-button @click=${() => this.choose(item)}>${item.title}</cr-bar-button><div class="path">${item.path}</div></div>`)}</div>
    </cr-dialog>`;
  }
}
if (!customElements.get('cr-doc-picker')) customElements.define('cr-doc-picker', CrDocPicker);
export { CrDocPicker };

/** Same lifecycle as the todo mention picker; scope is captured before each open. */
export function createDocMentionPicker({ getScope, onSelect, onClose }) {
  let element;
  let generation = 0;
  let opened = false;
  return {
    isOpen: () => opened,
    async open(query) {
      const current = ++generation; opened = true;
      if (!element) {
        element = document.createElement('cr-doc-picker'); document.body.appendChild(element);
        element.addEventListener('cr-doc-select', (e) => { opened = false; onSelect(e.detail); });
        element.addEventListener('cr-doc-picker-close', () => { opened = false; onClose?.(); });
      }
      try {
        const scope = await getScope();
        if (current === generation && opened) await element.show(scope, query, true);
      } catch {
        if (current === generation) { opened = false; onClose?.(); }
      }
    },
    setQuery(query) { if (element && opened && element.query !== query) { element.query = query; void element.search(); } },
    close() { opened = false; generation += 1; element?.hide(); },
  };
}
