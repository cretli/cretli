import { LitElement, css, html } from 'lit';
import '../../components/ui/cr-bar-button.js';
import './cr-doc-picker.js';
import { t } from '../../i18n/index.js';
import { createDocsApi } from '../../core/api/docs.js';
import { docsScope } from './docsScope.js';
import { linkedDocRows } from './docsLinkLogic.js';
import { openDocsNote } from './docsNavigation.js';

class CrDocLinks extends LitElement {
  static properties = { kind: {}, targetId: { attribute: 'target-id' }, rows: { state: true }, message: { state: true }, busy: { state: true } };
  static styles = css`
    :host { display: block; color: var(--cr-text); font: var(--cr-font-size-sm) var(--cr-font-ui); margin-block: var(--cr-space-3); }
    h4 { font-size: var(--cr-font-size-sm); margin-block: var(--cr-space-2); }
    ul { padding-inline-start: var(--cr-space-4); }
    li { margin-block: var(--cr-space-2); overflow-wrap: anywhere; }
    .path, .hint { color: var(--cr-text-muted); }
    .badge, [role=alert] { color: var(--cr-error); }
    .row { display: flex; flex-wrap: wrap; gap: var(--cr-space-2); align-items: center; }
  `;
  constructor() {
    super(); this.kind = 'todo'; this.targetId = ''; this.rows = []; this.message = ''; this.busy = false; this.epoch = 0;
    this.onScopeChange = () => { void this.reload(); };
  }
  connectedCallback() { super.connectedCallback(); window.addEventListener('cretli-view-context-changed', this.onScopeChange); }
  disconnectedCallback() { this.epoch += 1; window.removeEventListener('cretli-view-context-changed', this.onScopeChange); super.disconnectedCallback(); }
  updated(changed) { if (changed.has('targetId') || changed.has('kind')) void this.reload(); }
  async reload() {
    const epoch = ++this.epoch;
    this.rows = []; this.message = ''; this.busy = true; this.api = null;
    /** @type {any} */ (this.renderRoot.querySelector('cr-doc-picker'))?.hide();
    if (!this.targetId) { this.busy = false; return; }
    const kind = this.kind; const targetId = this.targetId;
    try {
      const scope = await docsScope();
      if (epoch !== this.epoch) return;
      const api = createDocsApi(scope);
      this.scope = scope; this.api = api;
      const [links, tree] = await Promise.all([api.targetLinks(kind, targetId), api.tree()]);
      if (epoch === this.epoch) this.rows = linkedDocRows(links.items, tree.items);
    } catch { if (epoch === this.epoch) this.message = t('docs.error'); }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  async mutate(action) {
    const epoch = this.epoch;
    this.busy = true; this.message = '';
    try { await action(); if (epoch === this.epoch) await this.reload(); }
    catch { if (epoch === this.epoch) this.message = t('docs.linkError'); }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  async openNote(path) {
    const epoch = this.epoch;
    this.dispatchEvent(new CustomEvent('cr-doc-open', { bubbles: true, composed: true }));
    try { await openDocsNote(path, this.scope); }
    catch { if (epoch === this.epoch) this.message = t('docs.error'); }
  }
  render() {
    return html`<section aria-label=${t('docs.title')}><h4>${t('docs.title')}</h4>
      <p role="alert">${this.message}</p>
      ${this.rows.length ? html`<ul>${this.rows.map((row) => html`<li>
        <div class="row"><strong>${row.title}</strong>${row.dangling ? html`<span class="badge">${t('docs.dangling')}</span>` : ''}</div>
        <div class="path">${row.note}</div><div class="row">
          <cr-bar-button data-doc-open ?disabled=${this.busy || row.noteMissing} @click=${() => this.openNote(row.note)}>${t('docs.openPanel')}</cr-bar-button>
          ${row.removable ? html`<cr-bar-button data-doc-unlink ?disabled=${this.busy} @click=${() => this.mutate(() => this.api.removeLink(row.id))}>${t('docs.unlinkNote')}</cr-bar-button>` : ''}
        </div></li>`)}</ul>` : html`<p class="hint">${t(this.busy ? 'docs.loading' : 'docs.noLinkedNotes')}</p>`}
      <cr-bar-button data-doc-link ?disabled=${this.busy || !this.api} @click=${() => /** @type {any} */ (this.renderRoot.querySelector('cr-doc-picker')).show(this.scope)}>${t('docs.linkNote')}</cr-bar-button>
      <cr-doc-picker @cr-doc-select=${(e) => this.mutate(() => this.api.addLink(e.detail.path, this.kind, this.targetId))}></cr-doc-picker>
    </section>`;
  }
}
if (!customElements.get('cr-doc-links')) customElements.define('cr-doc-links', CrDocLinks);
export { CrDocLinks };
