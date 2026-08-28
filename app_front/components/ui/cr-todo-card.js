import { LitElement, html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { t } from '../../i18n/index.js';
import { resolveHarnessDisplayLabel } from '../../features/chat/sdk-transport-labels.js';
import { renderMarkdownHtml } from '../../lib/render-markdown.js';
import './cr-bar-select.js';
import './cr-bar-input.js';
import './cr-bar-textarea.js';
import './cr-bar-button.js';

function getTodoStatusOptions() {
  return [
    { value: 'idea', label: t('todo.statusIdea') },
    { value: 'ready', label: t('todo.statusReady') },
    { value: 'doing', label: t('todo.statusDoing') },
    { value: 'done', label: t('todo.statusDone') },
  ];
}

class CrTodoCard extends LitElement {
  static properties = {
    item: { type: Object },
    planExpanded: { type: Boolean },
    historyExpanded: { type: Boolean },
  };

  constructor() {
    super();
    this.item = null;
    this.planExpanded = false;
    this.historyExpanded = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this._onLangChanged);
    super.disconnectedCallback();
  }

  _emit(name, detail) {
    this.dispatchEvent(
      new CustomEvent(name, {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  _onStatusChange(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    const status = e?.detail?.value ? String(e.detail.value) : '';
    if (!id || !status) return;
    this.item = { ...this.item, status };
    this._emit('todo-status-change', { id, status });
  }

  _onTitleBlur(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    const title = e?.target && 'value' in e.target ? String(e.target.value || '') : '';
    if (!id) return;
    this._emit('todo-title-save', { id, title });
  }

  _onTitleKeydown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    target.blur();
  }

  _onBodyBlur(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    const body = e?.target && 'value' in e.target ? String(e.target.value || '') : '';
    if (!id) return;
    this._emit('todo-body-save', { id, body });
  }

  _onStartAgent() {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-start-agent', { id });
  }

  _resolveSourceHarness() {
    const source = this.item?.sourceChat;
    return String(source?.agentTransport || this.item?.sourceHarness || '').trim();
  }

  _onOpenSourceChat(event) {
    event.preventDefault();
    const id = this.item?.id ? String(this.item.id) : '';
    const chatId = this._resolveSourceChatId();
    if (!id || !chatId) return;
    const agentTransport = this._resolveSourceHarness();
    this._emit('todo-open-chat', agentTransport ? { id, chatId, agentTransport } : { id, chatId });
  }

  _onDelete() {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-delete', { id });
  }

  _togglePlanExpanded = (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.planExpanded = !this.planExpanded;
  };

  _toggleHistoryExpanded = (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.historyExpanded = !this.historyExpanded;
  };

  _formatChangelogKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase();
    if (normalized === 'plan') return t('todo.changelogPlan');
    if (normalized === 'implement') return t('todo.changelogImplement');
    return t('todo.changelogNote');
  }

  _resolveSourceChatId() {
    const source = this.item?.sourceChat;
    if (source?.id) return String(source.id).trim();
    return String(this.item?.chatId || '').trim();
  }

  _renderSourceChat(item) {
    const source = item?.sourceChat && typeof item.sourceChat === 'object' ? item.sourceChat : null;
    const chatId = source?.id ? String(source.id).trim() : this._resolveSourceChatId();
    if (!chatId) return '';
    const harness = resolveHarnessDisplayLabel(source?.agentTransport || item?.sourceHarness);
    const title = String(source?.title || '').trim() || t('todo.untitledChat');
    return html`
      <a
        class="todo-item-source"
        href=${`/?panel=chat&chat=${encodeURIComponent(chatId)}`}
        @click=${this._onOpenSourceChat}
      >
        <span class="mdi mdi-robot-outline" aria-hidden="true"></span>
        <span>${t('todo.sourceChat', { harness, title })}</span>
      </a>
    `;
  }

  _renderPlanSection(item) {
    const planMarkdown =
      item?.plan && typeof item.plan === 'object' && typeof item.plan.markdown === 'string'
        ? item.plan.markdown.trim()
        : '';
    if (!planMarkdown) return '';
    const updatedAt =
      item?.plan && typeof item.plan.updatedAt === 'string' ? item.plan.updatedAt.slice(0, 10) : '';
    return html`
      <div class="todo-item-plan">
        <button
          type="button"
          class="todo-item-section-toggle"
          aria-expanded=${this.planExpanded ? 'true' : 'false'}
          @click=${this._togglePlanExpanded}
        >
          <span class="mdi mdi-file-document-outline" aria-hidden="true"></span>
          <span>${t('todo.plan')}${updatedAt ? html` <span class="todo-item-meta">(${updatedAt})</span>` : ''}</span>
          <span class="mdi ${this.planExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'}" aria-hidden="true"></span>
        </button>
        ${this.planExpanded
          ? html`<div class="todo-item-plan-body files-preview-markdown">${unsafeHTML(renderMarkdownHtml(planMarkdown))}</div>`
          : ''}
      </div>
    `;
  }

  _renderHistorySection(item) {
    const entries = Array.isArray(item?.changelog) ? item.changelog : [];
    if (!entries.length) return '';
    const visible = this.historyExpanded ? entries.slice().reverse() : [];
    return html`
      <div class="todo-item-history">
        <button
          type="button"
          class="todo-item-section-toggle"
          aria-expanded=${this.historyExpanded ? 'true' : 'false'}
          @click=${this._toggleHistoryExpanded}
        >
          <span class="mdi mdi-history" aria-hidden="true"></span>
          <span>${t('todo.history')} (${entries.length})</span>
          <span class="mdi ${this.historyExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'}" aria-hidden="true"></span>
        </button>
        ${this.historyExpanded
          ? html`<ul class="todo-item-history-list">${visible.map((entry) => this._renderHistoryEntry(entry))}</ul>`
          : ''}
      </div>
    `;
  }

  _renderHistoryEntry(entry) {
    const chatId = String(entry?.chatId || '').trim();
    const text = String(entry?.text || '').slice(0, this.historyExpanded ? 2000 : 180);
    const kind = this._formatChangelogKind(entry?.kind);
    if (!chatId) {
      return html`
        <li class="todo-item-history-entry todo-item-history-entry--${entry.kind || 'note'}">
          <span class="todo-item-history-kind">${kind}</span>
          <span class="todo-item-history-text">${text}</span>
        </li>
      `;
    }
    return html`
      <li class="todo-item-history-entry todo-item-history-entry--${entry.kind || 'note'}">
        <span class="todo-item-history-kind">${kind}</span>
        <a
          class="todo-item-history-text todo-item-history-link"
          href=${`/?panel=chat&chat=${encodeURIComponent(chatId)}`}
          @click=${(event) => {
            event.preventDefault();
            const id = this.item?.id ? String(this.item.id) : '';
            if (!id) return;
            const agentTransport = this._resolveSourceHarness();
            this._emit('todo-open-chat', agentTransport ? { id, chatId, agentTransport } : { id, chatId });
          }}
        >${text}</a>
      </li>
    `;
  }

  render() {
    const item = this.item || {};
    const id = item.id ? String(item.id) : '';
    const title = item.title ? String(item.title) : '';
    const body = item.body != null ? String(item.body) : '';
    const status = item.status ? String(item.status) : 'idea';
    const hasChat = !!this._resolveSourceChatId();
    const hasPlan = !!(
      item?.plan &&
      typeof item.plan === 'object' &&
      String(item.plan.markdown || '').trim()
    );
    const agentBtnLabel = hasChat
      ? t('todo.openChat')
      : hasPlan
        ? t('todo.newSession')
        : t('todo.runAgent');
    const agentBtnIcon = hasChat ? 'mdi-chat' : 'mdi-robot';

    return html`
      <article class="todo-item todo-item--${status}" data-id=${id} data-status=${status}>
        <div class="todo-item-head">
          <div class="todo-item-status-wrap">
            <span class="todo-item-status-dot" aria-hidden="true"></span>
            <cr-bar-select
              class="todo-item-status-select"
              size="md"
              aria-label="Status"
              data-id=${id}
              .value=${status}
              .options=${getTodoStatusOptions()}
              @cr-change=${this._onStatusChange}
            ></cr-bar-select>
          </div>
          <cr-bar-input
            class="todo-field-input todo-item-title"
            data-id=${id}
            aria-label=${t('todo.title')}
            maxlength="500"
            .value=${title}
            @blur=${this._onTitleBlur}
            @keydown=${this._onTitleKeydown}
          ></cr-bar-input>
        </div>
        ${this._renderSourceChat(item)}
        <cr-bar-textarea
          class="todo-field-input todo-item-body-edit"
          data-id=${id}
          rows="2"
          placeholder=${t('todo.notesPlaceholder')}
          aria-label=${t('todo.notes')}
          .value=${body}
          @blur=${this._onBodyBlur}
        ></cr-bar-textarea>
        ${this._renderPlanSection(item)}
        ${this._renderHistorySection(item)}
        <div class="todo-item-actions">
          <cr-bar-button
            class="todo-item-agent"
            data-id=${id}
            title=${agentBtnLabel}
            @click=${this._onStartAgent}
          >
            <span class="mdi ${agentBtnIcon}" aria-hidden="true"></span>
            <span>${agentBtnLabel}</span>
          </cr-bar-button>
          <cr-bar-button
            class="todo-item-delete"
            data-id=${id}
            title=${t('todo.deleteTitle')}
            @click=${this._onDelete}
          >
            <span class="mdi mdi-delete-outline" aria-hidden="true"></span>
            <span>${t('todo.delete')}</span>
          </cr-bar-button>
        </div>
      </article>
    `;
  }
}

if (!customElements.get('cr-todo-card')) {
  customElements.define('cr-todo-card', CrTodoCard);
}

export { CrTodoCard };
