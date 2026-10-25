import { LitElement, css, html, nothing } from 'lit';
import { getTodoHistory } from '../../core/api/index.js';
import { getCurrentLang, t } from '../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from './todoWorkspaceScope.js';
import '../../components/ui/cr-bar-button.js';

const PHASE_KEYS = {
  plan: 'stagePlanning', implement: 'stageImplementation', fix: 'historyPhaseFix',
  review_plan: 'historyPhaseReviewPlan', review_code: 'historyPhaseReviewCode', review_other: 'stageReview',
};
const STATUS_KEYS = { idea: 'statusIdea', ready: 'statusReady', doing: 'statusDoing', done: 'statusDone' };

/** Lazy timeline of persisted TODO milestones, delegation attempts and notes. */
class CrTodoHistory extends LitElement {
  static properties = {
    item: { type: Object }, active: { type: Boolean },
    entries: { state: true }, loading: { state: true }, error: { state: true },
  };

  static styles = css`
    :host { display: block; color: var(--cr-text); font-size: var(--cr-font-size-sm); }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: var(--cr-space-2); }
    .hint { color: var(--cr-text-muted); margin: 0; }
    .error { color: var(--cr-error); }
    ol { list-style: none; margin: var(--cr-space-3) 0 0 var(--cr-space-2); padding: 0; }
    li { position: relative; border-left: 1px solid var(--cr-border-strong); padding: 0 0 var(--cr-space-4) var(--cr-space-4); }
    li::before { content: ''; position: absolute; left: -0.25rem; top: 0.25rem; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--cr-accent); }
    li[data-tone='success']::before { background: var(--cr-success); }
    li[data-tone='error']::before { background: var(--cr-error); }
    time { display: block; color: var(--cr-text-muted); font-size: var(--cr-font-size-xs); margin-bottom: var(--cr-space-1); }
    .heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cr-space-1) var(--cr-space-2); }
    .phase, .details { color: var(--cr-text-muted); }
    .text, .details { margin: var(--cr-space-1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .result[data-tone='success'] { color: var(--cr-success); }
    .result[data-tone='error'] { color: var(--cr-error); }
    a { display: inline-block; color: var(--cr-accent); margin-top: var(--cr-space-1); }
    a:focus-visible { outline: 1px solid var(--cr-accent); outline-offset: 2px; }
  `;

  constructor() {
    super();
    this.item = null;
    this.active = false;
    this.entries = [];
    this.loading = false;
    this.error = false;
    this._loadedKey = '';
    this._requestId = 0;
    this._todoId = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this._onLangChanged);
    this._requestId += 1;
    this._loadedKey = '';
    super.disconnectedCallback();
  }

  updated() {
    if (this._todoId !== this.item?.id) {
      this._todoId = this.item?.id || '';
      this._requestId += 1;
      this._loadedKey = '';
      this.entries = [];
      this.error = false;
      this.loading = false;
    }
    if (this.active && this.item?.id) void this._load();
  }

  async _load(force = false) {
    const item = this.item;
    if (!item?.id) return;
    const folder = getTodoWorkspaceFolder();
    const key = JSON.stringify([folder, item.id, item.updatedAt, item.review?.generation]);
    if (!force && this._loadedKey === key) return;
    this._loadedKey = key;
    const requestId = ++this._requestId;
    this.loading = true;
    this.error = false;
    try {
      const result = await getTodoHistory(item.id, folder);
      if (requestId !== this._requestId || !todoWorkspaceMatches(folder) || this.item?.id !== item.id) return;
      if (!result?.ok || result.todoId !== item.id || !todoWorkspaceMatches(result.requestedFolder || result.cwd, folder)) throw new Error('history_load_failed');
      this.entries = Array.isArray(result.entries) ? result.entries : [];
      this.dispatchEvent(new CustomEvent('cr-todo-history-count', {
        detail: { id: item.id, count: this.entries.length }, bubbles: true, composed: true,
      }));
    } catch {
      if (requestId === this._requestId) this.error = true;
    } finally {
      if (requestId === this._requestId) this.loading = false;
    }
  }

  _tone(entry) {
    if (entry.status === 'failed' || entry.verdict === 'FAIL') return 'error';
    if (entry.status === 'passed' || entry.verdict === 'PASS') return 'success';
    return '';
  }

  _openChat(event, entry) {
    event.preventDefault();
    this.dispatchEvent(new CustomEvent('todo-open-chat', {
      detail: { id: this.item.id, chatId: entry.chatId, agentTransport: entry.harness || '' },
      bubbles: true, composed: true,
    }));
  }

  _renderEntry(entry) {
    const phaseKey = PHASE_KEYS[entry.phase];
    const result = [entry.status ? t(`todo.historyStatus_${entry.status}`) : '', entry.verdict].filter(Boolean).join(' · ');
    const statusChange = entry.kind === 'status_changed'
      ? [entry.from, entry.to].map((status) => STATUS_KEYS[status] ? t(`todo.${STATUS_KEYS[status]}`) : status).join(' → ')
      : entry.kind === 'integration_changed' ? `${entry.from || '—'} → ${entry.to || '—'}` : '';
    return html`<li data-tone=${this._tone(entry)}>
      <time datetime=${entry.at}>${new Date(entry.at).toLocaleString(getCurrentLang())}</time>
      <div class="heading">
        <strong>${t(`todo.historyEvent_${entry.kind}`)}</strong>
        ${phaseKey ? html`<span class="phase">${t(`todo.${phaseKey}`)}</span>` : nothing}
        ${entry.round ? html`<span class="phase">${t('todo.historyRound', { round: entry.round })}</span>` : nothing}
        ${result ? html`<span class="result" data-tone=${this._tone(entry)}>${result}</span>` : nothing}
      </div>
      ${entry.model || entry.harness ? html`<p class="details">${[entry.harness, entry.model].filter(Boolean).join(' · ')}</p>` : nothing}
      ${statusChange ? html`<p class="text">${statusChange}</p>` : nothing}
      ${entry.text ? html`<p class="text">${entry.text}</p>` : nothing}
      ${entry.reason ? html`<p class="text">${entry.reason}</p>` : nothing}
      ${entry.chatId ? html`<a href=${`/?panel=chat&chat=${encodeURIComponent(entry.chatId)}`} @click=${(event) => this._openChat(event, entry)}>${t('todo.historyOpenChat')}</a>` : nothing}
    </li>`;
  }

  render() {
    return html`
      <div class="toolbar">
        <p class="hint">${t('todo.historyCoverage')}</p>
        <cr-bar-button ?disabled=${this.loading} @click=${() => this._load(true)}>${t('todo.historyRefresh')}</cr-bar-button>
      </div>
      ${this.loading ? html`<p class="hint" role="status">${t('todo.historyLoading')}</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${t('todo.historyLoadFailed')}</p>` : nothing}
      ${this.entries.length ? html`<ol>${this.entries.map((entry) => this._renderEntry(entry))}</ol>`
        : !this.loading && !this.error ? html`<p class="hint">${t('todo.noHistory')}</p>` : nothing}
    `;
  }
}

if (!customElements.get('cr-todo-history')) customElements.define('cr-todo-history', CrTodoHistory);
export { CrTodoHistory };
