import { resolveTodoStatusIcon } from '../../features/todo/todoStatusIcon.js';
import { LitElement, html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { t } from '../../i18n/index.js';
import { VALID_TRANSPORTS } from '../../../lib/agent-transport.js';
import { resolveHarnessDisplayLabel } from '../../features/chat/sdk-transport-labels.js';
import {
  countActiveTodoChats,
  formatTodoRelativeTime,
  formatTodoShortId,
  resolveTodoStartHarness,
} from '../../features/todo/todoTreeView.js';
import {
  canManualRecoverWorkspaceTodo,
  todoRecoveryDetailText,
  todoRecoveryStateLabel,
  todoRecoveryUnknownHint,
} from '../../features/todo/todoRecoveryView.js';
import { renderMarkdownHtml } from '../../lib/render-markdown.js';
import { isWorkspaceWatcherRetryableBlockedTodo } from '../../../lib/workspace-watcher-blocked-reason.js';
import { isTodoAwaitingIntegration } from '../../../lib/todo-integration-state.js';
import './cr-bar-select.js';
import './cr-bar-input.js';
import './cr-bar-textarea.js';
import './cr-bar-button.js';

const TODO_TABS = ['description', 'chats', 'history', 'settings'];

function getTodoStatusOptions() {
  return [
    { value: 'idea', label: t('todo.statusIdea') },
    { value: 'ready', label: t('todo.statusReady') },
    { value: 'doing', label: t('todo.statusDoing') },
    { value: 'done', label: t('todo.statusDone') },
  ];
}

const ROLE_KEYS = {
  creator: 'todo.roleCreator',
  planner: 'todo.rolePlanner',
  executor: 'todo.roleExecutor',
  orchestrator: 'todo.roleOrchestrator',
  linked: 'todo.roleLinked',
  delegate: 'todo.roleDelegate',
};

class CrTodoCard extends LitElement {
  static properties = {
    item: { type: Object },
    hasChildren: { type: Boolean },
    planExpanded: { type: Boolean },
    bodyPreview: { type: Boolean },
    newChatHarness: { type: String },
    activeTab: { type: String },
    recoveryState: { type: Object },
    statusIcon: { type: Object },
  };

  constructor() {
    super();
    this.item = null;
    this.hasChildren = false;
    this.planExpanded = false;
    this.bodyPreview = false;
    this.newChatHarness = '';
    this.activeTab = 'description';
    this.recoveryState = null;
    this.statusIcon = null;
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
    if (this.hasChildren && status !== 'idea' && status !== 'ready') return;
    this.item = { ...this.item, status };
    this._emit('todo-status-change', { id, status });
  }

  _onTitleBlur(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    const raw = e?.target && 'value' in e.target ? String(e.target.value || '') : '';
    // The title is a one-line textarea; a paste can still carry newlines.
    const title = raw.replace(/\s*\n\s*/g, ' ');
    this._emit('todo-title-save', { id, title });
  }

  _onTitleKeydown(e) {
    // Let the IME confirm a composition; otherwise Enter would blur mid-word.
    if (e.key !== 'Enter' || e.isComposing) return;
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

  _onRetryBlocked() {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-retry-blocked', { id });
  }

  _onRecover() {
    const id = this.item?.id ? String(this.item.id) : '';
    const revision = this.item?.updatedAt ? String(this.item.updatedAt) : '';
    if (!id || !revision) return;
    this._emit('todo-recover', { id, revision });
  }

  _onIntegrationDecision(action) {
    const id = this.item?.id ? String(this.item.id) : '';
    const revision = this.item?.updatedAt ? String(this.item.updatedAt) : '';
    if (!id || !revision) return;
    this._emit('todo-integration', { id, revision, action });
  }

  /**
   * A manually started worktree tree is integrated from its ROOT: the root owns
   * the worktree, so only it can prepare the diff for a human decision.
   *
   * @param {object | null | undefined} item
   * @returns {boolean}
   */
  _canPrepareManualIntegration(item) {
    if (!item || item.parentId) return false;
    if (String(item.status || '') !== 'doing') return false;
    return String(item.executionMode || '').trim() === 'worktree';
  }

  _onOpenGit(event) {
    event?.preventDefault?.();
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-open-git', { id });
  }

  _onContinueNewChat() {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-start-agent', {
      id,
      forceNew: true,
      agentTransport: this._resolveNewChatHarness(),
    });
  }

  _onNewChatHarnessChange(e) {
    this.newChatHarness = String(e?.detail?.value || '').trim();
  }

  _resolveNewChatHarness() {
    const explicit = String(this.newChatHarness || '').trim();
    if (explicit && VALID_TRANSPORTS.includes(explicit)) return explicit;
    const fallback = resolveTodoStartHarness(this.item, 'sdk');
    return VALID_TRANSPORTS.includes(fallback) ? fallback : 'sdk';
  }

  _emitCopy(kind) {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-copy', { id, kind });
  }

  _ageLabel(iso) {
    const age = formatTodoRelativeTime(iso);
    if (!age) return '';
    if (age.unit === 'now') return t('todo.timeNow');
    if (age.unit === 'minutes') return t('todo.timeMinutes', { count: String(age.count) });
    if (age.unit === 'hours') return t('todo.timeHours', { count: String(age.count) });
    return t('todo.timeDays', { count: String(age.count) });
  }

  _formatRole(role) {
    const key = ROLE_KEYS[String(role || '').trim()];
    return key ? t(key) : String(role || '').trim();
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

  _setBodyPreview = (preview) => (event) => {
    event.preventDefault();
    if (this.bodyPreview === preview) return;
    this.bodyPreview = preview;
  };

  /* ---------------------------------------------------------------- tabs */

  _tabDefs() {
    const item = this.item || {};
    const chatsCount = countActiveTodoChats(item);
    const historyCount = Array.isArray(item.changelog) ? item.changelog.length : 0;
    return [
      { id: 'description', label: t('todo.tabDescription') },
      { id: 'chats', label: t('todo.tabChats', { count: String(chatsCount) }) },
      { id: 'history', label: t('todo.tabHistory', { count: String(historyCount) }) },
      { id: 'settings', label: t('todo.tabSettings') },
    ];
  }

  _selectTab(id, options = {}) {
    if (!TODO_TABS.includes(id)) return;
    const changed = this.activeTab !== id;
    if (changed) this.activeTab = id;
    if (options.focus === true || changed) {
      this.updateComplete.then(() => {
        if (options.focus === true) this._focusTab(id);
        // The description textarea was hidden while another tab was active,
        // so auto-grow saw a zero-height control.
        if (id === 'description') this._refreshBodyAutoGrow();
      });
    }
  }

  _focusTab(id) {
    const btn = this.querySelector(`#todo-tab-${id}`);
    if (btn instanceof HTMLElement) btn.focus();
  }

  _refreshBodyAutoGrow() {
    this.querySelectorAll('cr-bar-textarea').forEach((el) => {
      if (el instanceof HTMLElement && typeof el.refreshAutoGrow === 'function') {
        el.refreshAutoGrow();
      }
    });
  }

  _onTabClick = (event) => {
    const id = String(event.currentTarget?.dataset?.tab || '');
    this._selectTab(id);
  };

  _onTabKeydown = (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const tabs = this._tabDefs();
    const current = tabs.findIndex((tab) => tab.id === this.activeTab);
    const index = current < 0 ? 0 : current;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    this._selectTab(tabs[next].id, { focus: true });
  };

  /* ------------------------------------------------------ assignment */

  _emitAssignee(assignee) {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    this._emit('todo-assignee-change', { id, assignee });
  }

  /** Harness currently shown in the settings form (DOM wins over stale item). */
  _resolveAssigneeHarness() {
    const el = this.querySelector('.todo-editor-harness');
    if (el && 'value' in el && String(el.value || '').trim()) return String(el.value).trim();
    return String(this.item?.assignee?.harness || '').trim();
  }

  _resolveAssigneeRole() {
    const el = this.querySelector('.todo-editor-role');
    if (el && 'value' in el) return String(el.value || 'implement').trim() || 'implement';
    return String(this.item?.assignee?.role || 'implement');
  }

  _resolveAssigneeModel() {
    const el = this.querySelector('.todo-editor-model');
    if (el && 'value' in el) return String(el.value || '').trim();
    return String(this.item?.assignee?.model || '').trim();
  }

  /**
   * One snapshot of the whole settings form. Every field handler builds the
   * assignee from it, so saving one field never resets another to the stale
   * value still held in `item` (e.g. a model typed just before a harness change).
   *
   * @param {{ harness?: string, role?: string, model?: string }} [override]
   * @returns {{ harness: string, role: string, model?: string } | null}
   */
  _readAssigneeForm(override = {}) {
    const harness = override.harness ?? this._resolveAssigneeHarness();
    if (!harness) return null;
    const role = override.role ?? this._resolveAssigneeRole();
    const model = override.model ?? this._resolveAssigneeModel();
    return { harness, role, ...(model ? { model } : {}) };
  }

  _onAssigneeHarnessChange(e) {
    const harness = String(e?.detail?.value || '').trim();
    this._emitAssignee(harness ? this._readAssigneeForm({ harness }) : null);
  }

  _onAssigneeRoleChange(e) {
    const role = String(e?.detail?.value || 'implement').trim() || 'implement';
    const assignee = this._readAssigneeForm({ role });
    if (assignee) this._emitAssignee(assignee);
  }

  _onAssigneeModelBlur(e) {
    const model = e?.target && 'value' in e.target ? String(e.target.value || '').trim() : '';
    const assignee = this._readAssigneeForm({ model });
    if (assignee) this._emitAssignee(assignee);
  }

  _onRunModeChange(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    const runMode = String(e?.detail?.value || '') === 'sequential' ? 'sequential' : 'parallel';
    this._emit('todo-runmode-change', { id, runMode });
  }

  _onExecutionModeChange(e) {
    const id = this.item?.id ? String(this.item.id) : '';
    if (!id) return;
    const raw = String(e?.detail?.value || '').trim();
    const executionMode = raw === 'worktree' || raw === 'project' ? raw : 'inherit';
    this._emit('todo-executionmode-change', { id, executionMode });
  }

  /* ---------------------------------------------------------- render */

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

  _findChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const chats = Array.isArray(this.item?.chats) ? this.item.chats : [];
    return chats.find((chat) => String(chat?.id || '') === id) || null;
  }

  _chatTitle(chatId) {
    const chat = this._findChat(chatId);
    return String(chat?.title || '').trim();
  }

  /** ID bar: short id + copy ID / copy reference / copy markdown. */
  _renderIdBar(item) {
    const id = item?.id ? String(item.id) : '';
    if (!id) return '';
    const shortId = formatTodoShortId(id);
    return html`
      <div class="todo-item-idbar">
        <span class="todo-item-idbadge" title=${id}>#${shortId}</span>
        <button
          type="button"
          class="todo-item-copy"
          title=${t('todo.copyId')}
          aria-label=${t('todo.copyId')}
          @click=${() => this._emitCopy('id')}
        >
          <span class="mdi mdi-identifier" aria-hidden="true"></span>
          <span>${t('todo.copyId')}</span>
        </button>
        <button
          type="button"
          class="todo-item-copy"
          title=${t('todo.copyRef')}
          aria-label=${t('todo.copyRef')}
          @click=${() => this._emitCopy('ref')}
        >
          <span class="mdi mdi-link-variant" aria-hidden="true"></span>
          <span>${t('todo.copyRef')}</span>
        </button>
        <button
          type="button"
          class="todo-item-copy"
          title=${t('todo.copyMarkdown')}
          aria-label=${t('todo.copyMarkdown')}
          @click=${() => this._emitCopy('markdown')}
        >
          <span class="mdi mdi-language-markdown-outline" aria-hidden="true"></span>
          <span>${t('todo.copyMarkdown')}</span>
        </button>
      </div>
    `;
  }

  /** Created / updated / creator line. */
  _renderMeta(item) {
    const created = this._ageLabel(item?.createdAt);
    const updated = this._ageLabel(item?.updatedAt);
    const creatorId = String(item?.createdByChatId || '').trim();
    const creatorTitle = this._chatTitle(creatorId) || (creatorId ? `#${formatTodoShortId(creatorId)}` : '');
    const chips = [];
    if (created) chips.push(html`<span>${t('todo.created')}: ${created}</span>`);
    if (updated) chips.push(html`<span>${t('todo.updated')}: ${updated}</span>`);
    if (creatorTitle) chips.push(html`<span>${t('todo.creator')}: ${creatorTitle}</span>`);
    if (item?.executionMode === 'worktree' || item?.executionMode === 'project') {
      const modeKey = item.executionMode === 'worktree' ? 'todo.executionWorktree' : 'todo.executionProject';
      chips.push(html`<span class="todo-item-execution-chip">${t('todo.executionMode')}: ${t(modeKey)}</span>`);
    }
    const gitBranch = String(item?.integration?.branch || '').trim();
    if (item?.executionMode === 'worktree' || gitBranch) {
      chips.push(html`<button
        type="button"
        class="todo-item-git-chip"
        title=${t('todo.gitBadgeTitle')}
        aria-label=${t('todo.gitBadgeTitle')}
        @click=${this._onOpenGit}
      ><span class="mdi mdi-source-branch" aria-hidden="true"></span><span>${gitBranch || t('todo.gitBadgeGeneric')}</span></button>`);
    }
    if (isTodoAwaitingIntegration(item)) {
      chips.push(html`<span class="todo-item-integration-chip">${t('todo.integrationReady')}</span>`);
    }
    if (!chips.length) return '';
    return html`<div class="todo-item-meta-line">${chips.map((chip, index) => html`
      ${index > 0 ? html`<span class="todo-item-meta-sep" aria-hidden="true">·</span>` : ''}${chip}
    `)}</div>`;
  }

  /**
   * Manual starts resolve the execution mode from the tree root; a subtask's
   * own mode is ignored. Surface that so the field is not mistaken for an
   * effective override.
   *
   * @param {object | null | undefined} item
   * @returns {import('lit').TemplateResult | typeof nothing}
   */
  _renderManualModeHint(item) {
    if (!item || !item.parentId) return nothing;
    const mode = String(item.executionMode || '').trim();
    if (mode !== 'worktree' && mode !== 'project') return nothing;
    return html`<p class="cr-hint todo-manual-mode-hint">${t('todo.worktreeLeafModeIgnored')}</p>`;
  }

  /** Chats section: every chat that touched the todo, with roles. */
  _renderChatsSection(item) {
    const chats = Array.isArray(item?.chats) ? item.chats : [];
    if (!chats.length) {
      return html`<p class="todo-item-tab-empty">${t('todo.noChats')}</p>`;
    }
    return html`
      <div class="todo-item-chats">
        <p class="todo-item-chats-title">${t('todo.chats')} (${chats.length})</p>
        <ul class="todo-item-chats-list">
          ${chats.map((chat) => this._renderChatEntry(chat))}
        </ul>
      </div>
    `;
  }

  _renderChatEntry(chat) {
    const chatId = String(chat?.id || '').trim();
    const harness = resolveHarnessDisplayLabel(chat?.harness);
    const title = String(chat?.title || '').trim() || t('todo.untitledChat');
    const roles = (Array.isArray(chat?.roles) ? chat.roles : []).map((role) => this._formatRole(role));
    const age = this._ageLabel(chat?.lastAt);
    const subtitle = [roles.join(', '), age].filter(Boolean).join(' · ');
    if (chat?.deleted) {
      return html`
        <li class="todo-item-chat todo-item-chat--deleted">
          <span class="mdi mdi-robot-outline" aria-hidden="true"></span>
          <span class="todo-item-chat-body">
            <span class="todo-item-chat-title"
              >${harness} · #${formatTodoShortId(chatId)} · ${t('todo.chatUnavailable')}</span
            >
            ${subtitle ? html`<span class="todo-item-chat-sub">${subtitle}</span>` : ''}
          </span>
        </li>
      `;
    }
    return html`
      <li class="todo-item-chat">
        <a
          class="todo-item-chat-link"
          href=${`/?panel=chat&chat=${encodeURIComponent(chatId)}`}
          @click=${(event) => {
            event.preventDefault();
            const id = this.item?.id ? String(this.item.id) : '';
            if (!id || !chatId) return;
            this._emit(
              'todo-open-chat',
              chat?.harness ? { id, chatId, agentTransport: chat.harness } : { id, chatId }
            );
          }}
        >
          <span class="mdi mdi-robot-outline" aria-hidden="true"></span>
          <span class="todo-item-chat-body">
            <span class="todo-item-chat-title">${harness} · ${title}</span>
            ${subtitle ? html`<span class="todo-item-chat-sub">${subtitle}</span>` : ''}
          </span>
        </a>
      </li>
    `;
  }

  _renderBodyEditor(item) {
    const body = item?.body != null ? String(item.body) : '';
    return html`
      <div class="todo-item-body">
        <div class="todo-item-body-tabs" role="group" aria-label=${t('todo.notes')}>
          <button
            type="button"
            class="todo-item-body-tab"
            aria-pressed=${this.bodyPreview ? 'false' : 'true'}
            @click=${this._setBodyPreview(false)}
          >
            ${t('todo.editBody')}
          </button>
          <button
            type="button"
            class="todo-item-body-tab"
            aria-pressed=${this.bodyPreview ? 'true' : 'false'}
            @click=${this._setBodyPreview(true)}
          >
            ${t('todo.previewBody')}
          </button>
        </div>
        ${this.bodyPreview
          ? html`<div class="todo-item-body-preview files-preview-markdown"
              >${body.trim()
                ? unsafeHTML(renderMarkdownHtml(body))
                : html`<span class="todo-item-body-empty">${t('todo.notesPlaceholder')}</span>`}</div
            >`
          : html`<cr-bar-textarea
              class="todo-field-input todo-item-body-edit"
              data-id=${String(item?.id || '')}
              rows="6"
              autoGrow
              placeholder=${t('todo.notesPlaceholder')}
              aria-label=${t('todo.notes')}
              .value=${body}
              @blur=${this._onBodyBlur}
            ></cr-bar-textarea>`}
      </div>
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
    const approvedAt = item?.plan && typeof item.plan.approvedAt === 'string' ? item.plan.approvedAt.trim() : '';
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
          ${approvedAt ? html`<span class="mdi mdi-check-circle todo-item-plan-approved" title=${approvedAt} aria-label=${t('todo.planApproved')}></span>` : ''}
          <span class="mdi ${this.planExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'}" aria-hidden="true"></span>
        </button>
        ${this.planExpanded
          ? html`
            <div class="todo-item-plan-body files-preview-markdown">${unsafeHTML(renderMarkdownHtml(planMarkdown))}</div>
            ${!approvedAt ? html`
              <button
                type="button"
                class="todo-item-plan-approve-btn"
                @click=${() => this._emit('todo-plan-approve', { id: item.id, updatedAt: item.updatedAt })}
              >
                <span class="mdi mdi-check-circle-outline" aria-hidden="true"></span>
                ${t('todo.planApprove')}
              </button>
            ` : ''}
          `
          : ''}
      </div>
    `;
  }

  _renderHistoryEntry(entry) {
    const chatId = String(entry?.chatId || '').trim();
    const text = String(entry?.text || '').slice(0, 2000);
    const kind = this._formatChangelogKind(entry?.kind);
    const chatTitle = chatId ? this._chatTitle(chatId) : '';
    const chatLabel = chatTitle || (chatId ? `#${formatTodoShortId(chatId)}` : '');
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
        ${chatLabel ? html`<span class="todo-item-history-chat">${chatLabel}</span>` : ''}
        <a
          class="todo-item-history-text todo-item-history-link"
          href=${`/?panel=chat&chat=${encodeURIComponent(chatId)}`}
          @click=${(event) => {
            event.preventDefault();
            const id = this.item?.id ? String(this.item.id) : '';
            if (!id) return;
            const agentTransport = String(this._findChat(chatId)?.harness || '').trim()
              || this._resolveSourceHarness();
            this._emit('todo-open-chat', agentTransport ? { id, chatId, agentTransport } : { id, chatId });
          }}
        >${text}</a>
      </li>
    `;
  }

  /** Chaty tab actions: open / continue in a new chat + harness picker. */
  _renderChatActions(item) {
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
      <div class="todo-item-actions todo-item-chat-actions">
        <cr-bar-button
          class="todo-item-newchat"
          data-id=${String(item?.id || '')}
          title=${t('todo.continueNewChat')}
          @click=${this._onContinueNewChat}
        >
          <span class="mdi mdi-robot-outline" aria-hidden="true"></span>
          <span>${t('todo.continueNewChat')}</span>
        </cr-bar-button>
        <cr-bar-select
          class="todo-item-newchat-harness"
          size="sm"
          aria-label=${t('todo.newChatHarness')}
          title=${t('todo.newChatHarness')}
          .value=${this._resolveNewChatHarness()}
          .options=${VALID_TRANSPORTS.map((transport) => ({ value: transport, label: transport }))}
          @cr-change=${this._onNewChatHarnessChange}
        ></cr-bar-select>
        <cr-bar-button
          class="todo-item-agent"
          data-id=${String(item?.id || '')}
          title=${agentBtnLabel}
          @click=${this._onStartAgent}
        >
          <span class="mdi ${agentBtnIcon}" aria-hidden="true"></span>
          <span>${agentBtnLabel}</span>
        </cr-bar-button>
      </div>
    `;
  }

  _renderTabs() {
    const tabs = this._tabDefs();
    return html`
      <div class="cr-tabs todo-editor-tabs" role="tablist" aria-label=${t('todo.tabsAria')}>
        ${tabs.map(
          (tab) => html`
            <button
              type="button"
              class="cr-tab todo-editor-tab"
              id=${`todo-tab-${tab.id}`}
              role="tab"
              data-tab=${tab.id}
              aria-selected=${this.activeTab === tab.id ? 'true' : 'false'}
              aria-controls=${`todo-tabpanel-${tab.id}`}
              tabindex=${this.activeTab === tab.id ? '0' : '-1'}
              @click=${this._onTabClick}
              @keydown=${this._onTabKeydown}
            >
              ${tab.label}
            </button>
          `
        )}
      </div>
    `;
  }

  _renderDescriptionPanel(item) {
    return html`
      <section
        class="todo-item-tabpanel todo-item-tabpanel--description"
        id="todo-tabpanel-description"
        role="tabpanel"
        aria-labelledby="todo-tab-description"
        ?hidden=${this.activeTab !== 'description'}
      >
        ${this._renderBodyEditor(item)} ${this._renderPlanSection(item)}
      </section>
    `;
  }

  _renderChatsPanel(item) {
    return html`
      <section
        class="todo-item-tabpanel todo-item-tabpanel--chats"
        id="todo-tabpanel-chats"
        role="tabpanel"
        aria-labelledby="todo-tab-chats"
        ?hidden=${this.activeTab !== 'chats'}
      >
        ${this._renderChatsSection(item)} ${this._renderChatActions(item)}
      </section>
    `;
  }

  _renderHistoryPanel(item) {
    const entries = Array.isArray(item?.changelog) ? item.changelog : [];
    return html`
      <section
        class="todo-item-tabpanel todo-item-tabpanel--history"
        id="todo-tabpanel-history"
        role="tabpanel"
        aria-labelledby="todo-tab-history"
        ?hidden=${this.activeTab !== 'history'}
      >
        ${entries.length
          ? html`<ul class="todo-item-history-list">
              ${entries.slice().reverse().map((entry) => this._renderHistoryEntry(entry))}
            </ul>`
          : html`<p class="todo-item-tab-empty">${t('todo.noHistory')}</p>`}
      </section>
    `;
  }

  _renderSettingsPanel(item) {
    const assignee = item?.assignee && typeof item.assignee === 'object' ? item.assignee : null;
    const harnessOptions = [
      { value: '', label: t('todo.noAssignee') },
      ...VALID_TRANSPORTS.map((id) => ({ value: id, label: id })),
    ];
    const roleOptions = [
      { value: 'plan', label: t('todo.rolePlan') },
      { value: 'implement', label: t('todo.roleImplement') },
      { value: 'review', label: t('todo.roleReview') },
    ];
    const runOptions = [
      { value: 'parallel', label: t('todo.runParallel') },
      { value: 'sequential', label: t('todo.runSequential') },
    ];
    const executionOptions = [
      { value: 'inherit', label: t('todo.executionInherit') },
      { value: 'worktree', label: t('todo.executionWorktree') },
      { value: 'project', label: t('todo.executionProject') },
    ];
    return html`
      <section
        class="todo-item-tabpanel todo-item-tabpanel--settings"
        id="todo-tabpanel-settings"
        role="tabpanel"
        aria-labelledby="todo-tab-settings"
        ?hidden=${this.activeTab !== 'settings'}
      >
        <div class="todo-editor-assignee">
          <p class="todo-editor-label">${t('todo.assignee')}</p>
          <div class="todo-editor-grid">
            <label class="cr-field">
              <span class="cr-field-label">${t('todo.harness')}</span>
              <cr-bar-select
                class="todo-editor-harness"
                size="md"
                aria-label=${t('todo.harness')}
                .value=${String(assignee?.harness || '')}
                .options=${harnessOptions}
                @cr-change=${this._onAssigneeHarnessChange}
              ></cr-bar-select>
            </label>
            <label class="cr-field">
              <span class="cr-field-label">${t('todo.model')}</span>
              <cr-bar-input
                class="todo-editor-model"
                maxlength="200"
                placeholder=${t('todo.model')}
                aria-label=${t('todo.model')}
                .value=${String(assignee?.model || '')}
                @blur=${this._onAssigneeModelBlur}
              ></cr-bar-input>
            </label>
            <label class="cr-field">
              <span class="cr-field-label">${t('todo.role')}</span>
              <cr-bar-select
                class="todo-editor-role"
                size="md"
                aria-label=${t('todo.role')}
                .value=${String(assignee?.role || 'implement')}
                .options=${roleOptions}
                @cr-change=${this._onAssigneeRoleChange}
              ></cr-bar-select>
            </label>
            <label class="cr-field">
              <span class="cr-field-label">${t('todo.runMode')}</span>
              <cr-bar-select
                class="todo-editor-run"
                size="md"
                aria-label=${t('todo.runMode')}
                .value=${item?.runMode === 'parallel' ? 'parallel' : 'sequential'}
                .options=${runOptions}
                @cr-change=${this._onRunModeChange}
              ></cr-bar-select>
            </label>
            <label class="cr-field">
              <span class="cr-field-label">${t('todo.executionMode')}</span>
              <cr-bar-select
                class="todo-editor-execution"
                size="md"
                aria-label=${t('todo.executionMode')}
                .value=${item?.executionMode === 'worktree' || item?.executionMode === 'project' ? item.executionMode : 'inherit'}
                .options=${executionOptions}
                @cr-change=${this._onExecutionModeChange}
              ></cr-bar-select>
            </label>
          </div>
        </div>
        <div class="todo-item-settings-actions">
          <cr-bar-button
            class="todo-item-delete"
            data-id=${String(item?.id || '')}
            title=${t('todo.deleteTitle')}
            @click=${this._onDelete}
          >
            <span class="mdi mdi-delete-outline" aria-hidden="true"></span>
            <span>${t('todo.delete')}</span>
          </cr-bar-button>
        </div>
      </section>
    `;
  }

  render() {
    const item = this.item || {};
    const id = item.id ? String(item.id) : '';
    const title = item.title ? String(item.title) : '';
    const status = item.status ? String(item.status) : 'idea';
    const statusIcon = this.statusIcon || resolveTodoStatusIcon(item);
    const statusLocked = this.hasChildren && (status === 'doing' || status === 'done');
    const statusOptions = this.hasChildren
      ? getTodoStatusOptions().filter((option) => option.value === 'idea' || option.value === 'ready')
      : getTodoStatusOptions();

    return html`
      <article class="todo-item todo-item--${status}" data-id=${id} data-status=${status}>
        <div class="todo-item-head">
          <div class="todo-item-status-wrap">
            <span class="todo-item-status-icon mdi ${statusIcon.icon}${statusIcon.spinning ? ' mdi-spin' : ''}" title=${t(statusIcon.labelKey, { title: statusIcon.title })} aria-hidden="true"></span>
            <cr-bar-select
              class="todo-item-status-select"
              size="md"
              aria-label=${t('todo.statusLabel')}
              data-id=${id}
              .value=${status}
              .options=${statusOptions}
              .disabled=${statusLocked}
              title=${this.hasChildren ? t('todo.statusFromChildren') : t('todo.statusLabel')}
              @cr-change=${this._onStatusChange}
            ></cr-bar-select>
          </div>
          <cr-bar-textarea
            class="todo-field-input todo-item-title"
            data-id=${id}
            rows="1"
            autoGrow
            aria-label=${t('todo.title')}
            placeholder=${t('todo.title')}
            .value=${title}
            @blur=${this._onTitleBlur}
            @keydown=${this._onTitleKeydown}
          ></cr-bar-textarea>
        </div>
        ${this.hasChildren ? html`<p>${t('todo.statusFromChildren')}</p>` : nothing}
        <p class="todo-action-feedback" role="status" aria-live="polite" hidden></p>
        ${String(item.blockedReason || '').trim() ? html`
          <section class="todo-blocked-alert" role="alert" aria-live="polite">
            <div><strong>${t('todo.blocked')}</strong><p>${String(item.blockedReason)}</p></div>
            ${isWorkspaceWatcherRetryableBlockedTodo(item) ? html`
              <cr-bar-button class="todo-blocked-retry" data-id=${id} @click=${this._onRetryBlocked}>${t('todo.retryBlocked')}</cr-bar-button>
            ` : nothing}
          </section>
        ` : nothing}
        ${status === 'doing' && this.recoveryState ? html`
          <section class="todo-recovery-alert" role="status" aria-live="polite">
            <div><strong>${todoRecoveryStateLabel(this.recoveryState)}</strong>
              <p>${todoRecoveryDetailText(this.recoveryState)}</p>
              ${todoRecoveryUnknownHint(this.recoveryState) ? html`<p class="cr-hint">${todoRecoveryUnknownHint(this.recoveryState)}</p>` : nothing}
            </div>
            ${canManualRecoverWorkspaceTodo(this.recoveryState) ? html`
              <p class="cr-hint">${t('todo.recoveryResumeNewRun')}</p>
              <cr-bar-button class="todo-recovery-resume" data-id=${id} @click=${this._onRecover}>${t('todo.recoveryResume')}</cr-bar-button>
            ` : nothing}
          </section>
        ` : nothing}
        ${isTodoAwaitingIntegration(item) ? html`
          <section class="todo-integration-alert" role="status" aria-live="polite">
            <div>
              <strong>${t('todo.integrationReady')}</strong>
              <p>${t('todo.integrationReadyHint')}</p>
              ${String(item.integration?.resultPath || '').trim() ? html`
                <p class="cr-hint">${t('todo.integrationResult')}: ${String(item.integration.resultPath)}</p>
              ` : nothing}
            </div>
            <cr-bar-button class="todo-integration-confirm" data-id=${id} @click=${() => this._onIntegrationDecision('confirm')}>${t('todo.integrationConfirm')}</cr-bar-button>
            <cr-bar-button class="todo-integration-reject" data-id=${id} @click=${() => this._onIntegrationDecision('reject')}>${t('todo.integrationReject')}</cr-bar-button>
          </section>
        ` : nothing}
        ${!isTodoAwaitingIntegration(item) && this._canPrepareManualIntegration(item) ? html`
          <section class="todo-integration-alert todo-integration-prepare" role="status" aria-live="polite">
            <div>
              <strong>${t('todo.worktreeBadge')}</strong>
              <p>${t('todo.integrationPrepareHint')}</p>
              <p class="cr-hint">${t('todo.worktreeActiveHint')}</p>
            </div>
            <cr-bar-button class="todo-integration-prepare" data-id=${id} @click=${() => this._onIntegrationDecision('prepare')}>${t('todo.integrationPrepare')}</cr-bar-button>
          </section>
        ` : nothing}
        ${this._renderIdBar(item)} ${this._renderMeta(item)} ${this._renderManualModeHint(item)} ${this._renderTabs()}
        <div class="todo-editor-panels">
          ${this._renderDescriptionPanel(item)} ${this._renderChatsPanel(item)}
          ${this._renderHistoryPanel(item)} ${this._renderSettingsPanel(item)}
        </div>
      </article>
    `;
  }
}

if (!customElements.get('cr-todo-card')) {
  customElements.define('cr-todo-card', CrTodoCard);
}

export { CrTodoCard };
