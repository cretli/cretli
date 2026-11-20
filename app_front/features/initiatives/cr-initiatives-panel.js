import '../docs/cr-doc-links.js';
import { LitElement, css, html, nothing } from 'lit';
import '../../components/ui/index.js';
import { t } from '../../i18n/index.js';
import './cr-initiatives-map.js';
import { createInitiativesApi } from './initiativesApi.js';
import {
  HORIZONS, MAP_MAX_NODES, PRIORITIES, RESEARCH_KINDS, SCOPE_SIZES, STATUSES, classifyError, clearDraft, conflictingFields, draftFromInitiative, draftKey, draftPatch,
  buildMapModel, createLatestGuard, filterForMap, groupByHorizon, linkRows, linkableTodos, loadDraft, parseSources, partitionResearch, saveDraft, sourcesToText,
} from './initiativeLogic.js';

const TABS = Object.freeze(['edit', 'research', 'history', 'links']);
const newKey = () => (globalThis.crypto?.randomUUID?.() || `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Development plans panel: initiatives grouped by now / next / later with a detail view (edit, research, history,
 * links). Status, horizon and priority are independent fields. The editor state is owned here, not derived from the
 * list, so a refresh triggered by a WebSocket event never overwrites a draft.
 */
class CrInitiativesPanel extends LitElement {
  static properties = {
    items: { state: true }, loading: { state: true }, offline: { state: true }, notice: { state: true }, showArchived: { state: true },
    selectedId: { state: true }, record: { state: true }, draft: { state: true }, conflict: { state: true }, remoteChanged: { state: true },
    tab: { state: true }, research: { state: true }, history: { state: true }, links: { state: true }, todos: { state: true }, busy: { state: true },
    todoFilter: { state: true }, todoDialog: { state: true }, archiveDialog: { state: true }, researchDraft: { state: true }, truncated: { state: true },
    mode: { state: true }, relations: { state: true }, edgesPartial: { state: true }, mapFilter: { state: true },
  };

  static styles = css`
    :host { display:block; height:100%; overflow:auto; color:var(--cr-text); font-family:var(--cr-font-ui); font-size:var(--cr-font-size-md); }
    .wrap { max-width:60rem; margin:0 auto; padding:var(--cr-space-4); box-sizing:border-box; }
    h2 { font-size:var(--cr-font-size-xl); margin:0; }
    h3 { font-size:var(--cr-font-size-lg); margin:0 0 var(--cr-space-2); }
    h4 { margin:var(--cr-space-3) 0 var(--cr-space-1); font-size:var(--cr-font-size-md); }
    .bar, .row, .actions, .chips { display:flex; flex-wrap:wrap; gap:var(--cr-space-2); align-items:center; }
    .bar { justify-content:space-between; margin-bottom:var(--cr-space-3); }
    .banner { border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-sm); padding:var(--cr-space-2) var(--cr-space-3); margin-bottom:var(--cr-space-3); background:var(--cr-surface); }
    .banner[data-tone='error'] { color:var(--cr-error); border-color:var(--cr-error-border); background:var(--cr-error-bg); }
    .banner[data-tone='success'] { color:var(--cr-success); border-color:var(--cr-success-border); background:var(--cr-success-bg); }
    .group, .card, .panel { background:var(--cr-surface); border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-lg); padding:var(--cr-space-3); margin-bottom:var(--cr-space-3); }
    .card { margin-bottom:var(--cr-space-2); background:var(--cr-bg); }
    .card[data-done='true'] .title { text-decoration:none; }
    .title { font-weight:600; overflow-wrap:anywhere; }
    .meta, .hint, .empty { color:var(--cr-text-muted); font-size:var(--cr-font-size-sm); }
    .chip { border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-sm); padding:0 var(--cr-space-2); font-size:var(--cr-font-size-xs); color:var(--cr-text); white-space:nowrap; }
    .chip[data-kind='observed'] { border-color:var(--cr-success); color:var(--cr-success); }
    .chip[data-kind='hypothesis'] { border-color:var(--cr-accent); color:var(--cr-accent); border-style:dashed; }
    .chip[data-kind='unknown'] { color:var(--cr-text-muted); border-style:dotted; }
    .chip[data-warn] { border-color:var(--cr-error); color:var(--cr-error); }
    button, select, input, textarea { font:inherit; color:var(--cr-text); box-sizing:border-box; max-width:100%; }
    button { min-height:var(--cr-control-height); min-width:2.5rem; border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-sm); background:var(--cr-bg); padding:var(--cr-space-1) var(--cr-space-3); cursor:pointer; }
    button.primary { background:var(--cr-primary); border-color:var(--cr-primary); }
    button.link { border:0; background:none; padding:0; text-align:left; color:var(--cr-accent); }
    button:disabled { opacity:.55; cursor:default; }
    select, input, textarea { background:var(--cr-field-bg); border:1px solid var(--cr-field-border); border-radius:var(--cr-radius-sm); padding:var(--cr-space-1) var(--cr-space-2); min-height:var(--cr-control-height); }
    textarea { width:100%; min-height:4.5rem; resize:vertical; }
    input[type='text'], input[type='date'], input:not([type]) { width:100%; }
    select:hover, input:hover, textarea:hover { border-color:var(--cr-field-border-hover); }
    select:focus, input:focus, textarea:focus { border-color:var(--cr-field-focus-border); }
    button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline:2px solid var(--cr-accent); outline-offset:2px; }
    label { display:block; margin-bottom:var(--cr-space-2); font-size:var(--cr-font-size-sm); }
    label > span { display:block; color:var(--cr-text-muted); margin-bottom:var(--cr-space-1); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(9rem, 1fr)); gap:var(--cr-space-2); }
    .tabs { display:flex; gap:var(--cr-space-1); overflow-x:auto; border-bottom:1px solid var(--cr-border-strong); margin-bottom:var(--cr-space-3); }
    .tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; background:none; }
    .tabs button[aria-selected='true'] { border-bottom-color:var(--cr-accent); }
    .entry { border-left:3px solid var(--cr-border-strong); padding-left:var(--cr-space-2); margin-bottom:var(--cr-space-2); overflow-wrap:anywhere; }
    .entry[data-kind='observed'] { border-left-color:var(--cr-success); }
    .entry[data-kind='hypothesis'] { border-left-color:var(--cr-accent); border-left-style:dashed; }
    .entry p { margin:var(--cr-space-1) 0; white-space:pre-wrap; }
    ul { margin:0; padding-left:var(--cr-space-4); }
    li { overflow-wrap:anywhere; }
    @media (max-width: 480px) {
      .wrap { padding:var(--cr-space-2); }
      .actions button, .bar button { flex:1 1 auto; }
    }
  `;

  constructor() {
    super();
    this.items = [];
    this.loading = false;
    this.offline = false;
    this.notice = null;
    this.showArchived = false;
    this.selectedId = '';
    this.record = null;
    this.draft = draftFromInitiative({});
    this.conflict = null;
    this.remoteChanged = false;
    this.tab = 'edit';
    this.research = [];
    this.history = { items: [], nextCursor: '' };
    this.links = [];
    this.todos = [];
    this.busy = false;
    this.todoFilter = '';
    this.todoDialog = null;
    this.archiveDialog = false;
    this.researchDraft = null;
    this.truncated = false;
    this.mode = 'list';
    this.relations = [];
    this.edgesPartial = false;
    this.relationsKey = '';
    this.relationsGuard = createLatestGuard();
    this.mapFilter = { query: '', horizon: '', status: '', hideClosed: false };
    this.scope = { viewQuery: '', scopeKey: 'default', workspaceUuid: '' };
    this.base = null;
    this.createKey = '';
    this.todoOps = new Map();
    this.reloadQueued = false;
    this.onLanguage = () => this.requestUpdate();
    this.onOnline = () => { if (this.offline) void this.reload(); };
    this.onOffline = () => { this.offline = true; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('cr-lang-changed', this.onLanguage);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this.onLanguage);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    super.disconnectedCallback();
  }

  get api() { return createInitiativesApi(this.scope); }
  get storage() { try { return globalThis.sessionStorage; } catch { return null; } }
  get dirty() { return this.base ? Object.keys(draftPatch(this.draft, this.base)).length > 0 : this.selectedId === 'new' && Boolean(this.draft.title || this.draft.desiredOutcome); }

  /** Called by the panel glue when the per-tab view context changes. Drafts are keyed by scope, so they survive. */
  setScope({ viewQuery, scopeKey }) {
    if (scopeKey === this.scope.scopeKey && viewQuery === this.scope.viewQuery) return;
    this.scope = { viewQuery, scopeKey, workspaceUuid: '' };
    this.items = [];
    this.closeDetail();
  }

  say(tone, text) { this.notice = text ? { tone, text } : null; }

  /** Maps a failed request to a message; offline keeps the draft and offers a retry. */
  fail(error, fallbackKey = 'plans.errors.generic') {
    const c = classifyError(error);
    this.offline = c.kind === 'offline';
    const key = { offline: 'plans.errors.offline', conflict: 'plans.errors.conflict', validation: 'plans.errors.validation', forbidden: 'plans.errors.forbidden',
      not_found: 'plans.errors.notFound', workspace: 'plans.errors.workspace', unavailable: 'plans.errors.unavailable', cycle: 'plans.errors.cycle' }[c.kind] || fallbackKey;
    this.say('error', t(key, { detail: c.details?.field || c.message || '' }));
    return c;
  }

  async reload() {
    if (this.loading) { this.reloadQueued = true; return; }
    this.loading = true;
    try {
      const { items, truncated } = await this.api.listAll({ includeArchived: this.showArchived });
      this.items = items;
      this.truncated = truncated;
      this.relationsKey = ''; // force a relations re-read: edges can change without an initiative revision bump
      if (items[0]?.workspaceUuid) this.scope = { ...this.scope, workspaceUuid: items[0].workspaceUuid };
      this.offline = false;
      if (this.notice?.tone === 'error') this.say('', '');
      if (this.selectedId && this.selectedId !== 'new') this.syncSelected();
    } catch (error) {
      this.fail(error, 'plans.errors.load');
    } finally {
      this.loading = false;
      if (this.reloadQueued) { this.reloadQueued = false; void this.reload(); }
    }
  }

  /** Records the map would draw for the current filter; also the set whose complete relations are fetched. */
  mapNodes() {
    const matched = filterForMap(this.items.filter((i) => this.showArchived || !i.archivedAt), this.mapFilter);
    return { matched, model: buildMapModel(matched, this.relations) };
  }

  willUpdate() {
    if (this.mode !== 'map' || this.selectedId) return;
    const ids = this.mapNodes().model.nodes.map((n) => n.id);
    const key = ids.map((id) => `${id}:${this.items.find((i) => i.id === id)?.revision}`).join('|');
    if (key !== this.relationsKey) { this.relationsKey = key; void this.loadRelations(ids); }
  }

  /**
   * Fetches the full relations of the drawn records, so a relation between two records on different graph-slice pages
   * appears once both are visible. A failed read keeps the last edges and shows the "may be missing" note.
   */
  async loadRelations(ids) {
    // Every started fetch supersedes the earlier ones, even for the same node set (refresh, filter A -> B -> A).
    const seq = this.relationsGuard.begin();
    try {
      const { relations, complete } = await this.api.relationsOfAll(ids);
      if (!this.relationsGuard.isLatest(seq)) return;
      this.relations = relations;
      this.edgesPartial = !complete;
    } catch {
      if (this.relationsGuard.isLatest(seq)) this.edgesPartial = true;
    }
  }

  /** The list changed under an open editor: refresh the base, never the draft. */
  syncSelected() {
    const fresh = this.items.find((item) => item.id === this.selectedId);
    if (!fresh || !this.record || fresh.revision === this.record.revision) return;
    if (this.dirty) { this.remoteChanged = true; return; }
    this.record = fresh;
    this.base = fresh;
    this.draft = draftFromInitiative(fresh);
    void this.loadTab(this.tab);
  }

  // ---- navigation -------------------------------------------------------------------------------------------------

  async open(id) {
    this.selectedId = id;
    this.tab = 'edit';
    this.conflict = null;
    this.remoteChanged = false;
    this.say('', '');
    this.createKey = '';
    if (id === 'new') {
      this.record = null;
      this.base = null;
      const stored = loadDraft(this.storage, draftKey(this.scope.scopeKey, 'new'));
      this.draft = stored?.draft || draftFromInitiative({});
      this.focusHeading();
      return;
    }
    const item = this.items.find((i) => i.id === id);
    this.record = item || null;
    this.base = item || null;
    const stored = loadDraft(this.storage, draftKey(this.scope.scopeKey, id));
    this.draft = stored?.draft || draftFromInitiative(item);
    if (stored && item && stored.baseRevision && stored.baseRevision < item.revision) this.remoteChanged = true;
    this.focusHeading();
    void this.loadTab('edit');
    void this.loadTab('links');
  }

  closeDetail() {
    const id = this.selectedId;
    this.selectedId = '';
    this.record = null;
    this.base = null;
    this.conflict = null;
    this.remoteChanged = false;
    this.research = [];
    this.links = [];
    this.history = { items: [], nextCursor: '' };
    if (id) this.updateComplete.then(() => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(`[data-open="${id}"]`))?.focus?.());
  }

  focusHeading() { this.updateComplete.then(() => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('#detail-heading'))?.focus?.()); }

  async loadTab(tab) {
    const id = this.selectedId;
    if (!id || id === 'new') return;
    try {
      if (tab === 'research') this.research = (await this.api.research(id)).items;
      if (tab === 'history') this.history = await this.api.history(id).then((d) => ({ items: d.items, nextCursor: d.nextCursor || '' }));
      if (tab === 'links' || tab === 'edit') {
        this.links = (await this.api.links(id)).items;
        this.todos = await this.api.todos().catch(() => this.todos);
      }
    } catch (error) {
      const c = classifyError(error);
      if (c.kind === 'stale_cursor') return this.loadTab(tab);
      this.fail(error);
    }
  }

  setTab(tab) { this.tab = tab; void this.loadTab(tab); }

  async moreHistory() {
    try {
      const data = await this.api.history(this.selectedId, this.history.nextCursor);
      this.history = { items: [...this.history.items, ...data.items], nextCursor: data.nextCursor || '' };
    } catch (error) {
      if (classifyError(error).kind === 'stale_cursor') return this.loadTab('history');
      this.fail(error);
    }
  }

  // ---- editing ----------------------------------------------------------------------------------------------------

  setField(key, value) {
    this.draft = { ...this.draft, [key]: value };
    saveDraft(this.storage, draftKey(this.scope.scopeKey, this.selectedId), this.draft, this.base?.revision || 0);
  }

  async save() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.selectedId === 'new') {
        if (!this.createKey) this.createKey = newKey();
        const data = await this.api.create(this.draft, this.createKey);
        clearDraft(this.storage, draftKey(this.scope.scopeKey, 'new'));
        this.createKey = '';
        this.scope = { ...this.scope, workspaceUuid: data.initiative.workspaceUuid || this.scope.workspaceUuid };
        this.say('success', t('plans.saved'));
        await this.reload();
        await this.open(data.initiative.id);
        return;
      }
      const patch = draftPatch(this.draft, this.base);
      if (!Object.keys(patch).length) { this.say('success', t('plans.noChanges')); return; }
      const data = await this.api.update(this.selectedId, patch, this.base.revision);
      clearDraft(this.storage, draftKey(this.scope.scopeKey, this.selectedId));
      this.record = data.initiative;
      this.base = data.initiative;
      this.draft = draftFromInitiative(data.initiative);
      this.conflict = null;
      this.remoteChanged = false;
      this.say('success', t('plans.saved'));
      void this.reload();
    } catch (error) {
      const c = this.fail(error);
      if (c.kind === 'conflict') await this.openConflict(c);
    } finally {
      this.busy = false;
    }
  }

  async openConflict(c) {
    let remote = c.details?.current;
    if (!remote) { try { remote = (await this.api.get(this.selectedId)).initiative; } catch { /* keep the generic message */ } }
    if (remote) this.conflict = { remote, fields: conflictingFields(this.draft, this.base, remote) };
  }

  /** Keeps the draft and re-bases it on the latest revision; the user then saves explicitly. */
  rebase() {
    if (!this.conflict) return;
    this.record = this.conflict.remote;
    this.base = this.conflict.remote;
    this.conflict = null;
    this.remoteChanged = false;
    saveDraft(this.storage, draftKey(this.scope.scopeKey, this.selectedId), this.draft, this.base.revision);
    this.say('success', t('plans.rebased'));
  }

  discardDraft() {
    clearDraft(this.storage, draftKey(this.scope.scopeKey, this.selectedId));
    const latest = this.conflict?.remote || this.items.find((i) => i.id === this.selectedId) || this.base;
    this.record = latest;
    this.base = latest;
    this.draft = draftFromInitiative(latest);
    this.conflict = null;
    this.remoteChanged = false;
  }

  async quickHorizon(item, horizon) {
    try {
      await this.api.update(item.id, { horizon }, item.revision);
      this.say('success', t('plans.saved'));
    } catch (error) {
      this.fail(error);
    }
    void this.reload();
  }

  async archive(archived) {
    this.archiveDialog = false;
    try {
      const data = await this.api.archive(this.selectedId, this.base.revision, archived);
      this.record = data.initiative;
      this.base = data.initiative;
      this.say('success', t(archived ? 'plans.archivedDone' : 'plans.unarchivedDone'));
      void this.reload();
    } catch (error) {
      const c = this.fail(error);
      if (c.kind === 'conflict') await this.openConflict(c);
    }
  }

  // ---- research, links and Todos ----------------------------------------------------------------------------------

  startResearch(entry) {
    this.researchDraft = entry
      ? { kind: entry.kind, claim: entry.claim, sources: sourcesToText(entry.sources), limitations: entry.limitations || '', supersedesId: entry.id }
      : { kind: 'observed', claim: '', sources: '', limitations: '', supersedesId: '' };
  }

  async saveResearch() {
    const d = this.researchDraft;
    if (!d || !d.claim.trim()) { this.say('error', t('plans.errors.claimRequired')); return; }
    try {
      await this.api.addResearch(this.selectedId, {
        kind: d.kind, claim: d.claim, sources: parseSources(d.sources), limitations: d.limitations,
        observedAt: d.kind === 'observed' ? new Date().toISOString() : '',
      }, d.supersedesId || undefined);
      this.researchDraft = null;
      this.say('success', t('plans.saved'));
      await this.loadTab('research');
      void this.reload();
    } catch (error) {
      this.fail(error);
    }
  }

  async linkTodo(todo) {
    try {
      await this.api.addLink(this.selectedId, { kind: 'todo', targetId: todo.id });
      this.say('success', t('plans.linked'));
      await this.loadTab('links');
    } catch (error) {
      this.fail(error);
    }
  }

  async unlink(link) {
    try {
      await this.api.removeLink(this.selectedId, link.id);
      await this.loadTab('links');
    } catch (error) {
      this.fail(error);
    }
  }

  openTodoDialog() {
    const base = this.base || {};
    this.todoDialog = { title: base.title || '', body: `Outcome: ${base.desiredOutcome || ''}` };
  }

  /** One operation id per initiative until it succeeds, so a retry after a lost answer replays instead of duplicating. */
  async createTodo() {
    const d = this.todoDialog;
    if (!d || !d.title.trim()) return;
    const id = this.selectedId;
    if (!this.todoOps.has(id)) this.todoOps.set(id, newKey());
    try {
      await this.api.createTodo(id, { operationId: this.todoOps.get(id), title: d.title, body: d.body });
      this.todoOps.delete(id);
      this.todoDialog = null;
      this.say('success', t('plans.todoCreated'));
      await this.loadTab('links');
    } catch (error) {
      const c = this.fail(error);
      if (c.kind === 'conflict') this.todoOps.delete(id);
    }
  }

  // ---- rendering --------------------------------------------------------------------------------------------------

  fieldLabel(group, value) { return t(`plans.${group}.${value}`); }

  chips(item) {
    return html`<span class="chips">
      <span class="chip">${t('plans.statusLabel')}: ${this.fieldLabel('status', item.status)}</span>
      <span class="chip">${t('plans.horizonLabel')}: ${this.fieldLabel('horizon', item.horizon)}</span>
      <span class="chip">${t('plans.priorityLabel')}: ${this.fieldLabel('priority', item.priority)}</span>
      ${item.archivedAt ? html`<span class="chip" data-warn>${t('plans.archived')}</span>` : nothing}</span>`;
  }

  renderBanner() {
    return html`
      ${this.offline ? html`<div class="banner" data-tone="error" role="alert">${t('plans.errors.offline')}
        <button @click=${() => this.reload()}>${t('plans.retry')}</button></div>` : nothing}
      ${this.notice && !(this.offline && this.notice.tone === 'error') ? html`<div class="banner" data-tone=${this.notice.tone} role=${this.notice.tone === 'error' ? 'alert' : 'status'}>${this.notice.text}</div>` : nothing}`;
  }

  renderCard(item) {
    return html`<article class="card" data-done=${item.status === 'achieved'}>
      <div class="row"><button class="link title" data-open=${item.id} @click=${() => this.open(item.id)}>${item.title}</button></div>
      <p class="meta">${item.desiredOutcome}</p>
      ${this.chips(item)}
      <div class="row" style="margin-top:var(--cr-space-2)">
        <label style="margin:0"><span class="hint">${t('plans.moveHorizon')}</span>
          <select aria-label=${`${t('plans.moveHorizon')}: ${item.title}`} .value=${item.horizon} ?disabled=${Boolean(item.archivedAt)}
            @change=${(e) => this.quickHorizon(item, e.target.value)}>
            ${HORIZONS.map((h) => html`<option value=${h} ?selected=${h === item.horizon}>${this.fieldLabel('horizon', h)}</option>`)}
          </select></label>
      </div>
    </article>`;
  }

  renderList() {
    const groups = groupByHorizon(this.items, { includeArchived: this.showArchived });
    return html`
      <div class="bar"><h2>${t('plans.title')}</h2>
        <div class="actions">
          <label style="margin:0"><input type="checkbox" .checked=${this.showArchived} @change=${(e) => { this.showArchived = e.target.checked; void this.reload(); }}> ${t('plans.showArchived')}</label>
          <button @click=${() => this.reload()} ?disabled=${this.loading}>${t('plans.refresh')}</button>
          <button class="primary" @click=${() => this.open('new')}>${t('plans.new')}</button></div></div>
      ${this.renderBanner()}
      ${this.truncated ? html`<p class="hint">${t('plans.truncated')}</p>` : nothing}
      <div class="tabs" role="group" aria-label=${t('plans.map.viewLabel')}>
        ${['list', 'map'].map((m) => html`<button aria-pressed=${this.mode === m} @click=${() => { this.mode = m; }}>${t(`plans.map.view.${m}`)}</button>`)}</div>
      ${this.mode === 'map' ? this.renderMap() : this.renderGroups(groups)}`;
  }

  renderGroups(groups) {
    return html`${HORIZONS.map((h) => html`<section class="group" aria-labelledby=${`h-${h}`}>
        <h3 id=${`h-${h}`}>${this.fieldLabel('horizon', h)} <span class="meta">(${groups[h].length})</span></h3>
        ${groups[h].length ? groups[h].map((item) => this.renderCard(item)) : html`<p class="empty">${this.loading ? t('plans.loading') : t('plans.emptyGroup')}</p>`}
      </section>`)}`;
  }

  setMapFilter(key, value) { this.mapFilter = { ...this.mapFilter, [key]: value }; }

  renderMap() {
    const { matched, model } = this.mapNodes();
    const f = this.mapFilter;
    return html`
      <div class="grid" role="search" aria-label=${t('plans.map.filter')}>
        <label><span>${t('plans.map.search')}</span><input type="text" .value=${f.query} @input=${(e) => this.setMapFilter('query', e.target.value)}></label>
        <label><span>${t('plans.horizonLabel')}</span><select @change=${(e) => this.setMapFilter('horizon', e.target.value)}>
          <option value="" ?selected=${!f.horizon}>${t('plans.map.any')}</option>
          ${HORIZONS.map((h) => html`<option value=${h} ?selected=${f.horizon === h}>${this.fieldLabel('horizon', h)}</option>`)}</select></label>
        <label><span>${t('plans.statusLabel')}</span><select @change=${(e) => this.setMapFilter('status', e.target.value)}>
          <option value="" ?selected=${!f.status}>${t('plans.map.any')}</option>
          ${STATUSES.map((s) => html`<option value=${s} ?selected=${f.status === s}>${this.fieldLabel('status', s)}</option>`)}</select></label>
        <label><span>&nbsp;</span><span><input type="checkbox" .checked=${f.hideClosed} @change=${(e) => this.setMapFilter('hideClosed', e.target.checked)}> ${t('plans.map.hideClosed')}</span></label>
      </div>
      <p class="hint" role="status">${t('plans.map.count', { shown: model.nodes.length, total: matched.length })}</p>
      ${model.hiddenNodes > 0 ? html`<div class="banner" role="status">${t('plans.map.limited', { max: MAP_MAX_NODES, hidden: model.hiddenNodes })}</div>` : nothing}
      ${model.hiddenEdges > 0 ? html`<p class="hint" role="status">${t('plans.map.hiddenEdges', { count: model.hiddenEdges })}</p>` : nothing}
      ${this.edgesPartial ? html`<p class="hint" role="status">${t('plans.map.partialEdges')}</p>` : nothing}
      ${model.nodes.length ? html`<cr-initiatives-map .model=${model} .relations=${this.relations} @cr-initiative-open=${(e) => this.open(e.detail.id)}></cr-initiatives-map>`
    : html`<p class="empty">${this.loading ? t('plans.loading') : t('plans.map.empty')}</p>`}
      <p class="hint">${t('plans.map.listEquivalent')}</p>
      ${this.renderRelationList(model)}`;
  }

  /** Text equivalent of the drawn edges: the same relations, readable without the picture. */
  renderRelationList(model) {
    if (!model.edges.length) return html`<p class="empty">${t('plans.map.noRelations')}</p>`;
    return html`<h4>${t('plans.map.relationsHeading')}</h4><ul>${model.edges.map((e) => html`<li>${e.from.item.title} <span class="chip">${t(`plans.map.type.${e.type}`)}</span> ${e.to.item.title}</li>`)}</ul>`;
  }

  select(key, values, group, disabled = false) {
    return html`<label><span>${t(`plans.${key}Label`)}</span>
      <select .value=${this.draft[key]} ?disabled=${disabled} @change=${(e) => this.setField(key, e.target.value)}>
        ${values.map((v) => html`<option value=${v} ?selected=${v === this.draft[key]}>${group ? this.fieldLabel(group, v) : v}</option>`)}
      </select></label>`;
  }

  textField(key, rows = 3) {
    return html`<label><span>${t(`plans.field.${key}`)}</span>
      <textarea rows=${rows} .value=${this.draft[key]} @input=${(e) => this.setField(key, e.target.value)}></textarea></label>`;
  }

  listField(key) {
    return html`<label><span>${t(`plans.field.${key}`)} <span class="hint">(${t('plans.onePerLine')})</span></span>
      <textarea rows="3" .value=${this.draft[key].join('\n')} @input=${(e) => this.setField(key, lines(e.target.value))}></textarea></label>`;
  }

  renderConflict() {
    const fields = this.conflict.fields.map((f) => t(`plans.field.${f}`, {})).join(', ');
    return html`<div class="banner" data-tone="error" role="alert"><strong>${t('plans.conflictTitle')}</strong>
      <p>${t('plans.conflictBody', { revision: this.conflict.remote.revision })}${fields ? ` ${t('plans.conflictFields', { fields })}` : ''}</p>
      <div class="actions"><button class="primary" @click=${() => this.rebase()}>${t('plans.keepMine')}</button>
        <button @click=${() => this.discardDraft()}>${t('plans.takeLatest')}</button></div></div>`;
  }

  renderEdit() {
    const archived = Boolean(this.base?.archivedAt);
    return html`
      ${this.conflict ? this.renderConflict() : nothing}
      ${this.remoteChanged && !this.conflict ? html`<div class="banner" role="status">${t('plans.remoteChanged')}
        <div class="actions"><button @click=${() => this.discardDraft()}>${t('plans.takeLatest')}</button></div></div>` : nothing}
      ${this.dirty ? html`<p class="hint" role="status">${t('plans.draftKept')}</p>` : nothing}
      <label><span>${t('plans.field.title')}</span><input type="text" .value=${this.draft.title} @input=${(e) => this.setField('title', e.target.value)}></label>
      ${this.textField('desiredOutcome')}
      <div class="grid">
        ${this.select('status', STATUSES, 'status')}${this.select('horizon', HORIZONS, 'horizon')}${this.select('priority', PRIORITIES, 'priority')}
        ${this.select('scopeSize', SCOPE_SIZES, '')}
        <label><span>${t('plans.field.targetDate')}</span><input type="date" .value=${(this.draft.targetDate || '').slice(0, 10)} @input=${(e) => this.setField('targetDate', e.target.value)}></label>
      </div>
      ${this.textField('rationale')}${this.textField('baseline')}${this.listField('successCriteria')}${this.listField('openQuestions')}
      <div class="actions">
        <button class="primary" @click=${() => this.save()} ?disabled=${this.busy || archived}>${t('plans.save')}</button>
        ${this.selectedId !== 'new' ? html`<button @click=${() => this.discardDraft()} ?disabled=${!this.dirty}>${t('plans.discard')}</button>
          <button @click=${() => (archived ? this.archive(false) : (this.archiveDialog = true))}>${t(archived ? 'plans.unarchive' : 'plans.archive')}</button>` : nothing}
      </div>`;
  }

  renderEntry(entry) {
    return html`<div class="entry" data-kind=${entry.kind}>
      <span class="chip" data-kind=${entry.kind}>${t(`plans.research.${entry.kind}`)}</span>
      ${entry.revisions > 1 ? html`<span class="meta"> ${t('plans.revisions', { count: entry.revisions })}</span>` : nothing}
      <p>${entry.claim}</p>
      ${entry.sources?.length ? html`<ul>${entry.sources.map((s) => html`<li>${s.type === 'url' && /^https?:\/\//i.test(s.ref) ? html`<a href=${s.ref} target="_blank" rel="noopener noreferrer">${s.ref}</a>` : s.ref}</li>`)}</ul>` : html`<p class="meta">${t('plans.noSources')}</p>`}
      ${entry.limitations ? html`<p class="meta">${t('plans.limitations')}: ${entry.limitations}</p>` : nothing}
      <button @click=${() => this.startResearch(entry)}>${t('plans.reviseEntry')}</button>
    </div>`;
  }

  renderResearch() {
    const parts = partitionResearch(this.research);
    const d = this.researchDraft;
    return html`
      <div class="actions"><button class="primary" @click=${() => this.startResearch(null)}>${t('plans.addResearch')}</button></div>
      ${d ? html`<div class="panel"><h4>${t(d.supersedesId ? 'plans.reviseEntry' : 'plans.addResearch')}</h4>
        <label><span>${t('plans.research.kind')}</span><select @change=${(e) => { this.researchDraft = { ...d, kind: e.target.value }; }}>
          ${RESEARCH_KINDS.map((k) => html`<option value=${k} ?selected=${k === d.kind}>${t(`plans.research.${k}`)}</option>`)}</select></label>
        <p class="hint">${t(`plans.research.${d.kind}Hint`)}</p>
        <label><span>${t('plans.research.claim')}</span><textarea .value=${d.claim} @input=${(e) => { this.researchDraft = { ...d, claim: e.target.value }; }}></textarea></label>
        <label><span>${t('plans.research.sources')} <span class="hint">(${t('plans.onePerLine')})</span></span><textarea .value=${d.sources} @input=${(e) => { this.researchDraft = { ...d, sources: e.target.value }; }}></textarea></label>
        <label><span>${t('plans.limitations')}</span><textarea .value=${d.limitations} @input=${(e) => { this.researchDraft = { ...d, limitations: e.target.value }; }}></textarea></label>
        <div class="actions"><button class="primary" @click=${() => this.saveResearch()}>${t('plans.save')}</button><button @click=${() => { this.researchDraft = null; }}>${t('plans.cancel')}</button></div></div>` : nothing}
      ${RESEARCH_KINDS.map((k) => html`<section><h4>${t(`plans.research.${k}Group`)} (${parts[k].length})</h4>
        ${parts[k].length ? parts[k].map((e) => this.renderEntry(e)) : html`<p class="empty">${t('plans.research.none')}</p>`}</section>`)}`;
  }

  renderHistory() {
    const { items, nextCursor } = this.history;
    return html`${items.length ? html`<ul>${items.map((e) => html`<li><strong>${e.type}</strong> · ${e.actor} · ${new Date(e.at).toLocaleString()} · r${e.revision}
      ${e.payload?.changed ? html`<div class="meta">${Object.keys(e.payload.changed).map((k) => t(`plans.field.${k}`, {})).join(', ')}</div>` : nothing}
      ${e.payload?.reason ? html`<div class="meta">${e.payload.reason}</div>` : nothing}</li>`)}</ul>` : html`<p class="empty">${t('plans.noHistory')}</p>`}
      ${nextCursor ? html`<div class="actions"><button @click=${() => this.moreHistory()}>${t('plans.loadMore')}</button></div>` : nothing}`;
  }

  renderLinks() {
    const rows = linkRows(this.links, this.todos);
    const candidates = linkableTodos(this.todos, this.links, this.todoFilter);
    return html`
      <h4>${t('plans.linkedWork')}</h4>
      ${rows.length ? html`<ul>${rows.map((l) => html`<li>${l.name} <span class="chip">${l.kind}</span>
        ${l.todoStatus ? html`<span class="chip">${t('plans.todoStatus')}: ${l.todoStatus}</span>` : nothing}
        ${l.todoMissing ? html`<span class="chip" data-warn>${t('plans.todoUnavailable')}</span>` : nothing}
        <button @click=${() => this.unlink(l)} aria-label=${`${t('plans.unlink')}: ${l.name}`}>${t('plans.unlink')}</button></li>`)}</ul>`
    : html`<p class="empty">${t('plans.noLinks')}</p>`}
      <p class="hint">${t('plans.doneHint')}</p>
      <h4>${t('plans.linkTodo')}</h4>
      <label><span>${t('plans.filterTodos')}</span><input type="text" .value=${this.todoFilter} @input=${(e) => { this.todoFilter = e.target.value; }}></label>
      ${candidates.length ? html`<ul>${candidates.map((todo) => html`<li>${todo.title} <span class="chip">${todo.status}</span>
        <button @click=${() => this.linkTodo(todo)} aria-label=${`${t('plans.link')}: ${todo.title}`}>${t('plans.link')}</button></li>`)}</ul>` : html`<p class="empty">${t('plans.noTodos')}</p>`}
      <h4>${t('plans.createTodo')}</h4>
      <p class="hint">${t('plans.createTodoHint')}</p>
      <button @click=${() => this.openTodoDialog()}>${t('plans.createTodo')}</button>`;
  }

  renderDetail() {
    const isNew = this.selectedId === 'new';
    const panes = { edit: () => this.renderEdit(), research: () => this.renderResearch(), history: () => this.renderHistory(), links: () => this.renderLinks() };
    return html`
      <div class="bar"><button @click=${() => this.closeDetail()} aria-label=${t('plans.back')}>← ${t('plans.back')}</button></div>
      <h2 id="detail-heading" tabindex="-1">${isNew ? t('plans.new') : (this.record?.title || '')}</h2>
      ${this.record ? this.chips(this.record) : nothing}
      ${this.renderBanner()}
      ${!isNew ? html`<cr-doc-links kind="initiative" .targetId=${this.selectedId}></cr-doc-links>` : nothing}
      ${isNew ? this.renderEdit() : html`
        <div class="tabs" role="tablist" aria-label=${t('plans.tabsLabel')}>
          ${TABS.map((tab) => html`<button role="tab" id=${`tab-${tab}`} aria-selected=${this.tab === tab} aria-controls="pane" tabindex=${this.tab === tab ? 0 : -1}
            @click=${() => this.setTab(tab)} @keydown=${(e) => this.tabKey(e, tab)}>${t(`plans.tab.${tab}`)}</button>`)}
        </div>
        <div id="pane" role="tabpanel" aria-labelledby=${`tab-${this.tab}`}>${panes[this.tab]()}</div>`}
      <cr-dialog ?open=${this.archiveDialog} heading=${t('plans.archive')} @cr-dialog-close=${() => { this.archiveDialog = false; }}>
        <p>${t('plans.archiveConfirm')}</p>
        <div slot="actions"><cr-bar-button @click=${() => { this.archiveDialog = false; }}>${t('plans.cancel')}</cr-bar-button>
          <cr-bar-button variant="primary" @click=${() => this.archive(true)}>${t('plans.archive')}</cr-bar-button></div>
      </cr-dialog>
      <cr-dialog ?open=${Boolean(this.todoDialog)} heading=${t('plans.createTodo')} @cr-dialog-close=${() => { this.todoDialog = null; }}>
        ${this.todoDialog ? html`<p class="hint">${t('plans.createTodoHint')}</p>
          <label><span>${t('plans.field.title')}</span><input type="text" .value=${this.todoDialog.title} @input=${(e) => { this.todoDialog = { ...this.todoDialog, title: e.target.value }; }}></label>
          <label><span>${t('plans.todoBody')}</span><textarea .value=${this.todoDialog.body} @input=${(e) => { this.todoDialog = { ...this.todoDialog, body: e.target.value }; }}></textarea></label>` : nothing}
        <div slot="actions"><cr-bar-button @click=${() => { this.todoDialog = null; }}>${t('plans.cancel')}</cr-bar-button>
          <cr-bar-button variant="primary" @click=${() => this.createTodo()}>${t('plans.createTodoIdea')}</cr-bar-button></div>
      </cr-dialog>`;
  }

  /** Arrow keys move between tabs (roving tabindex). */
  tabKey(event, tab) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    this.setTab(next);
    this.updateComplete.then(() => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(`#tab-${next}`))?.focus());
  }

  onKeyDown(event) {
    if (event.key === 'Escape' && this.selectedId && !this.archiveDialog && !this.todoDialog) {
      const tag = event.composedPath()[0]?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.closeDetail();
    }
  }

  render() {
    return html`<div class="wrap" @keydown=${(e) => this.onKeyDown(e)}>${this.selectedId ? this.renderDetail() : this.renderList()}</div>`;
  }
}

if (!customElements.get('cr-initiatives-panel')) customElements.define('cr-initiatives-panel', CrInitiativesPanel);
export { CrInitiativesPanel };
