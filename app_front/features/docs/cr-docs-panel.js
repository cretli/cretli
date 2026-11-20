import './cr-doc-proposals.js';
import { LitElement, html, nothing } from 'lit';
import '../../components/ui/index.js';
import { t } from '../../i18n/index.js';
import { createDocsApi } from '../../core/api/docs.js';
import { conflictKind, directoryTree, reviewedSave } from './docsLogic.js';
import { completedRenameSteps, linkKindKey, skippedReasonKey } from './docsLabels.js';
import { renderDocMarkdown } from './docsMarkdownView.js';

export class CrDocsPanel extends LitElement {
  static properties = {
    items: { state: true }, skipped: { state: true }, results: { state: true }, query: { state: true },
    note: { state: true }, draft: { state: true }, editing: { state: true }, remote: { state: true },
    message: { state: true }, conflict: { state: true }, busy: { state: true }, loading: { state: true },
    proposalVersion: { state: true }, dialog: { state: true }, name: { state: true }, config: { state: true },
  };
  createRenderRoot() { return this; }
  constructor() {
    super();
    this.items = []; this.skipped = []; this.results = []; this.query = '';
    this.note = null; this.draft = ''; this.editing = false; this.remote = null;
    this.message = ''; this.conflict = ''; this.dialog = ''; this.name = '';
    this.proposalVersion = 0; this.busy = false; this.loading = false; this.config = null;
    this.scopeDrafts = new Map();
    this.scopeSaves = new Set();
    this.epoch = 0; this.selection = 0; this.searchVersion = 0; this.scopeKey = ''; this.api = null;
  }
  setScope(scope) {
    const key = JSON.stringify(scope);
    if (this.api && key === this.scopeKey) return;
    if (this.scopeKey) {
      if (this.dirty) this.scopeDrafts.set(this.scopeKey, { note: this.note, draft: this.draft, editing: this.editing, remote: this.remote, conflict: this.conflict });
      else this.scopeDrafts.delete(this.scopeKey);
    }
    this.cancelSearch();
    this.epoch += 1; this.scopeKey = key; this.api = createDocsApi(scope);
    this.items = []; this.skipped = []; this.results = []; this.query = '';
    this.note = null; this.draft = ''; this.editing = false; this.remote = null;
    this.message = ''; this.conflict = ''; this.dialog = ''; this.config = null; this.busy = false; this.loading = false; this.pendingPath = null;
    const saved = this.scopeDrafts.get(key);
    if (saved) Object.assign(this, saved);
    this.busy = this.scopeSaves.has(key);
  }
  get dirty() { return !!this.note && this.draft !== this.note.text; }
  async reload() {
    if (!this.api || this.busy) return;
    const epoch = this.epoch;
    const api = this.api;
    this.loading = true;
    try {
      const config = await api.config();
      if (epoch !== this.epoch) return;
      this.config = config; this.proposalVersion += 1;
      if (!config.root || (config.root.external && !config.root.consented)) {
        this.items = []; this.note = null;
        this.message = t('docs.configure');
        return;
      }
      const tree = await api.tree();
      if (epoch !== this.epoch) return;
      this.items = tree.items; this.skipped = tree.skipped || []; this.message = '';
      if (this.note) await this.read(this.note.path, true);
      if (this.query) await this.search(this.query);
    } catch (error) { if (epoch === this.epoch) this.showError(error); }
    finally { if (epoch === this.epoch) this.loading = false; }
  }
  showError(error) {
    this.message = `${t('docs.error')} (${error.code || error.status || t('docs.connection')})`;
    if (error.code === 'docs-rename-partial') {
      const steps = completedRenameSteps(error.details?.completed).map((step) => t(step.key, { path: step.path }));
      this.message = `${t('docs.partial')} ${steps.join('; ') || t('docs.renameStep.none')}`;
    }
  }
  async read(path, preserve = false) {
    const epoch = this.epoch;
    const selection = ++this.selection;
    try {
      const { note } = await this.api.note(path);
      if (epoch !== this.epoch || selection !== this.selection) return;
      if (preserve && (this.editing || this.dirty)) {
        if (note.sha256 !== this.note.sha256) { this.remote = note; this.conflict = 'conflict'; }
        return;
      }
      this.note = note; this.draft = note.text; this.editing = false; this.remote = null; this.conflict = ''; this.message = '';
    } catch (error) { if (epoch === this.epoch && selection === this.selection) this.showError(error); }
  }
  open(path) {
    if (this.busy) return;
    if (this.dirty) { this.pendingPath = path; this.dialog = 'discard'; return; }
    void this.read(path);
  }
  cancelSearch() {
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.searchVersion += 1;
  }
  disconnectedCallback() {
    this.cancelSearch();
    super.disconnectedCallback();
  }
  scheduleSearch(query, immediate = false) {
    this.cancelSearch();
    this.query = query;
    if (!query.trim()) { this.results = []; return; }
    if (immediate) return this.search(query);
    this.searchTimer = setTimeout(() => { void this.search(query); }, 250);
  }
  async search(query) {
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.query = query;
    const epoch = this.epoch;
    const version = ++this.searchVersion;
    if (!query.trim()) { this.results = []; return; }
    try {
      const { items } = await this.api.search(query);
      if (epoch === this.epoch && version === this.searchVersion) this.results = items;
    } catch (error) { if (epoch === this.epoch && version === this.searchVersion) this.showError(error); }
  }
  async save(reviewed = false) {
    if (this.busy || !this.note) return;
    const payload = reviewed ? reviewedSave(this.note, this.draft, this.remote) : { path: this.note.path, text: this.draft, expectedSha256: this.note.sha256 };
    await this.mutate(async (api) => {
      await api.save(payload.path, payload.text, payload.expectedSha256);
      return payload.path;
    }, { savesDraft: true });
  }
  async mutate(operation, { savesDraft = false } = {}) {
    // Every non-save mutation must preserve an existing draft, including stale dialog actions.
    if (this.busy || (this.dirty && !savesDraft)) return;
    let epoch = this.epoch;
    const scopeKey = this.scopeKey;
    const savedDraft = this.draft;
    const api = this.api;
    if (savesDraft) this.scopeSaves.add(scopeKey);
    this.cancelSearch();
    this.busy = true; this.message = '';
    try {
      const path = await operation(api);
      if (savesDraft) {
        // Only a confirmed save retires the draft kept for its original scope.
        const stashed = this.scopeDrafts.get(scopeKey);
        if (stashed?.draft === savedDraft && stashed.note?.path === path) this.scopeDrafts.delete(scopeKey);
        if (scopeKey === this.scopeKey) epoch = this.epoch;
      }
      if (epoch !== this.epoch) return;
      this.dialog = ''; this.editing = false; this.remote = null; this.conflict = '';
      this.note = null;
      if (path) await this.read(path);
      if (epoch !== this.epoch) return;
      const tree = await api.tree();
      if (epoch !== this.epoch) return;
      this.items = tree.items; this.skipped = tree.skipped || []; this.query = ''; this.results = [];
      this.message = t('docs.saved');
    } catch (error) {
      if (savesDraft && scopeKey === this.scopeKey) epoch = this.epoch;
      if (epoch !== this.epoch) return;
      const kind = conflictKind(error);
      if ((kind === 'conflict' || kind === 'precondition') && this.note) {
        this.conflict = kind; this.dialog = '';
        try {
          const { note } = await api.note(this.note.path);
          if (epoch === this.epoch) this.remote = note;
        } catch (readError) { if (epoch === this.epoch) this.showError(readError); }
      } else if (kind === 'partial') await this.recoverPartialRename(error, api, epoch);
      else this.showError(error);
    } finally {
      if (savesDraft) this.scopeSaves.delete(scopeKey);
      if (epoch === this.epoch || (savesDraft && scopeKey === this.scopeKey)) this.busy = false;
    }
  }
  async recoverPartialRename(error, api, epoch) {
    this.dialog = '';
    this.showError(error);
    try {
      const tree = await api.tree();
      if (epoch !== this.epoch) return;
      this.items = tree.items; this.skipped = tree.skipped || []; this.query = ''; this.results = [];
      if (this.note && tree.items.some((item) => item.path === this.note.path)) await this.read(this.note.path);
      else {
        this.note = null; this.draft = ''; this.editing = false; this.remote = null; this.conflict = '';
      }
      if (epoch === this.epoch) this.showError(error);
    } catch {
      if (epoch === this.epoch) { this.showError(error); this.message += ` ${t('docs.partialRefreshFailed')}`; }
    }
  }
  showDialog(kind) {
    if (this.busy || (this.dirty && ['create', 'rename', 'trash'].includes(kind))) return;
    this.dialog = kind; this.name = kind === 'rename' ? this.note.path : '';
  }
  cancelDialog() { if (!this.busy) this.dialog = ''; }
  confirmDialog() {
    if (this.busy) return;
    if (this.dialog === 'discard') { this.dialog = ''; void this.read(this.pendingPath); return; }
    if (this.dialog === 'reload') { const path = this.note.path; this.dialog = ''; void this.read(path); return; }
    if (this.dialog === 'review') { void this.save(true); return; }
    if (this.dirty && ['create', 'rename', 'trash'].includes(this.dialog)) return;
    const note = this.note;
    if (this.dialog === 'create') {
      const name = this.name.trim();
      if (!name) return;
      return this.mutate(async (api) => { await api.create(name, ''); return name; });
    } else if (this.dialog === 'rename') {
      const name = this.name.trim();
      if (!name) return;
      return this.mutate(async (api) => { await api.rename(note.path, name, note.sha256); return name; });
    } else if (this.dialog === 'trash') {
      return this.mutate(async (api) => { await api.trash(note.path, note.sha256); return null; });
    }
  }
  renderTree(node) {
    return html`${[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => html`<details open><summary>${name}</summary>${this.renderTree(folder)}</details>`)}
      ${node.notes.map((item) => this.noteButton(item, true))}`;
  }
  noteButton(item, inTree = false) {
    return html`<cr-bar-button class="docs-note-button" aria-current=${inTree && this.note?.path === item.path ? 'page' : nothing} ?disabled=${this.busy} title=${item.path} @click=${() => this.open(item.path)}>${item.title || item.path}</cr-bar-button>`;
  }
  renderDialog() {
    if (!this.dialog) return nothing;
    const nameRequired = ['create', 'rename'].includes(this.dialog);
    return html`<cr-dialog open .heading=${t(`docs.dialog.${this.dialog}`)} @cr-dialog-close=${() => this.cancelDialog()}>
      ${this.message ? html`<p role="alert">${this.message}</p>` : nothing}
      ${nameRequired ? html`<label class="cr-field"><span class="cr-field-label">${t('docs.path')}</span><cr-bar-input data-docs-name ?disabled=${this.busy} .value=${this.name} @input=${(e) => { this.name = e.target.value; }}></cr-bar-input></label>` : nothing}
      ${this.dialog === 'trash' ? html`<p>${t('docs.trashHint')}</p>` : nothing}
      ${['discard', 'reload'].includes(this.dialog) ? html`<p>${t('docs.discardHint')}</p>` : nothing}
      ${this.dialog === 'review' ? html`<p>${t('docs.reviewHint')}</p><div class="docs-review"><section><h3>${t('docs.disk')}</h3><pre>${this.remote?.text}</pre></section><section><h3>${t('docs.draft')}</h3><pre>${this.draft}</pre></section></div>` : nothing}
      <cr-bar-button slot="actions" ?disabled=${this.busy} @click=${() => this.cancelDialog()}>${t('docs.cancel')}</cr-bar-button>
      <cr-bar-button slot="actions" variant="primary" ?disabled=${this.busy || (nameRequired && !this.name.trim()) || (this.dialog === 'review' && !this.remote)} @click=${() => this.confirmDialog()}>${t(this.dialog === 'review' ? 'docs.overwrite' : 'docs.confirm')}</cr-bar-button>
    </cr-dialog>`;
  }
  render() {
    return html`<div class="docs-page cr-page">
      <header class="docs-toolbar"><h2>${t('docs.title')}</h2>
        <cr-bar-input data-docs-search ?disabled=${this.busy} .value=${this.query} .placeholder=${t('docs.search')} aria-label=${t('docs.search')} @input=${(e) => this.scheduleSearch(e.target.value)} @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); void this.scheduleSearch(e.target.value, true); } }}></cr-bar-input>
        <cr-bar-button ?disabled=${this.busy || this.loading} @click=${() => void this.reload()}>${t('docs.refresh')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || this.dirty || !this.config?.root || (this.config.root.external && !this.config.root.consented)} @click=${() => this.showDialog('create')}>${t('docs.create')}</cr-bar-button>
      </header>
      <p class="cr-status" role="status" aria-live="polite" aria-atomic="true">${this.message} ${this.loading ? t('docs.loading') : ''}</p>
      ${this.conflict ? html`<div class="docs-conflict" role="alert"><p>${t(this.conflict === 'precondition' ? 'docs.precondition' : 'docs.conflict')}</p>
        <cr-bar-button ?disabled=${this.busy} @click=${() => this.showDialog('reload')}>${t('docs.reload')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.remote || !this.editing} @click=${() => this.showDialog('review')}>${t('docs.review')}</cr-bar-button>
      </div>` : nothing}
      <cr-doc-proposals .api=${this.api} .human=${!!this.config?.root && Object.hasOwn(this.config.root, 'path')} .version=${this.proposalVersion} @docs-proposal-resolved=${() => void this.reload()}></cr-doc-proposals>
      <div class="docs-layout cr-page-body">
        <nav class="docs-tree" aria-label=${t('docs.tree')}><details open><summary>${t('docs.tree')}</summary>
          ${this.query ? this.results.map((item) => this.noteButton(item, true)) : this.renderTree(directoryTree(this.items))}
          ${!(this.query ? this.results.length : this.items.length) ? html`<p>${t('docs.empty')}</p>` : nothing}
        </details>
        ${this.skipped.length ? html`<details class="docs-skipped"><summary>${t('docs.skipped')} (${this.skipped.length})</summary><ul>${this.skipped.map((entry) => html`<li>${entry.path}: ${t(skippedReasonKey(entry.reason))}</li>`)}</ul></details>` : nothing}</nav>
        <main class="docs-note">${this.note ? html`
          <h2>${this.note.title || this.note.path}</h2><p class="cr-hint">${this.note.path}</p>
          <div class="docs-toolbar">
          <cr-bar-button ?disabled=${this.busy} @click=${() => { this.editing = !this.editing; }}>${t(this.editing ? 'docs.preview' : 'docs.edit')}</cr-bar-button>
          ${this.editing ? html`<cr-bar-button variant="primary" ?disabled=${this.busy || !!this.conflict} @click=${() => void this.save()}>${t('docs.save')}</cr-bar-button>` : nothing}
          <cr-bar-button ?disabled=${this.busy || this.dirty} @click=${() => this.showDialog('rename')}>${t('docs.rename')}</cr-bar-button>
          <cr-bar-button ?disabled=${this.busy || this.dirty} @click=${() => this.showDialog('trash')}>${t('docs.trash')}</cr-bar-button></div>
          ${this.editing ? html`<label class="cr-field"><span class="cr-field-label">${t('docs.draft')}</span><cr-bar-textarea data-docs-editor ?disabled=${this.busy} .value=${this.draft} @input=${(e) => { this.draft = e.target.value; }}></cr-bar-textarea></label>`
            : html`<article class="docs-markdown">${renderDocMarkdown(this.draft, this.note.path, this.items, (path) => this.open(path))}</article>`}
        ` : html`<p>${t('docs.select')}</p>`}</main>
        <aside class="docs-links"><h3>${t('docs.backlinks')}</h3>${(this.note?.backlinks || []).map((item) => this.noteButton(item))}
          <h3>${t('docs.links')}</h3><ul>${(this.note?.links || []).map((link) => html`<li><span>${t(linkKindKey(link.kind))}: ${link.title || link.targetId}</span>
            <span class="cr-hint"> (${t(link.source === 'mention' ? 'docs.mention' : 'docs.managed')})</span>
            ${link.state === 'dangling' ? html`<strong class="docs-missing"> ${t('docs.dangling')}</strong>` : nothing}
            ${link.suggestedPath ? html`<span>${t('docs.suggested')}: ${link.suggestedPath}</span>` : nothing}</li>`)}</ul>
          ${(this.note?.linkHints || []).filter((hint) => hint.conflict).map((hint) => html`<p class="docs-missing">${t('docs.hintConflict')} ${t(linkKindKey(hint.kind))}: ${hint.targetId}</p>`)}
        </aside>
      </div>${this.renderDialog()}
    </div>`;
  }
}
if (!customElements.get('cr-docs-panel')) customElements.define('cr-docs-panel', CrDocsPanel);
