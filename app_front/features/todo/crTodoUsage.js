/**
 * `<cr-todo-usage>` — TODO usage statistics section.
 *
 * Two modes, one component:
 *  - `todo-id` set  -> one TODO: `own` and `consolidated` side by side (never
 *    summed, the backend deliberately has no combined total);
 *  - `todo-id` empty -> workspace view: summary, model x role and a TODO table.
 *
 * Light DOM (global tokens + `.todo-usage-*` styles in css/features/todo/_todo-usage.scss). Data loading
 * is delegated to `createTodoUsageController`, which aborts and ignores stale
 * responses. Nothing is fetched until `active` is true.
 */

import { LitElement, html, nothing } from 'lit';
import { getCurrentLang, t } from '../../i18n/index.js';
import { createTodoUsageController } from './todoUsageController.js';
import {
  TODO_USAGE_DEFAULT_RANGE,
  TODO_USAGE_RANGES,
  TODO_USAGE_STATUSES,
  collectUsageModels,
  formatTodoUsageCost,
  formatTodoUsageCount,
  formatTodoUsageDuration,
  formatTodoUsageTokens,
  resolveAggregateState,
  resolveUsageViewState,
} from './todoUsageView.js';
import '../../components/ui/cr-bar-select.js';
import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-checkbox.js';

const STATUS_LABEL_KEYS = {
  idea: 'todo.statusIdea',
  ready: 'todo.statusReady',
  doing: 'todo.statusDoing',
  done: 'todo.statusDone',
};

const RANGE_LABEL_KEYS = {
  '24h': 'todo.usageRange24h',
  '7d': 'todo.usageRange7d',
  '30d': 'todo.usageRange30d',
  month: 'todo.usageRangeMonth',
};

class CrTodoUsage extends LitElement {
  static properties = {
    todoId: { type: String, attribute: 'todo-id' },
    active: { type: Boolean },
    range: { state: true },
    status: { state: true },
    model: { state: true },
    onlyWithUsage: { state: true },
    view: { state: true },
    knownModels: { state: true },
  };

  constructor() {
    super();
    this.todoId = '';
    this.active = false;
    this.range = TODO_USAGE_DEFAULT_RANGE;
    this.status = [];
    this.model = '';
    this.onlyWithUsage = false;
    this.view = { loading: false, loadingMore: false, error: null, data: null };
    this.knownModels = [];
    this._loadedKey = '';
    this._controller = createTodoUsageController({
      onChange: (state) => {
        this.view = state;
        // Model options come from unfiltered data so the filter never shrinks
        // to the one model that is currently selected.
        if (!this.model && state.data) this.knownModels = this._modelsOf(state.data);
      },
    });
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
    this._controller.abort();
    this._loadedKey = '';
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has('todoId')) {
      // A different TODO must not show the previous one's numbers.
      this.model = '';
      this.knownModels = [];
      this._loadedKey = '';
      this._controller.abort();
      this.view = { loading: false, loadingMore: false, error: null, data: null };
    }
    if (this.active) this._loadIfNeeded();
    else if (changed.has('active')) this._controller.abort();
  }

  _modelsOf(data) {
    const sources = data.summary ? [data.summary] : [data.own, data.consolidated];
    const models = new Set();
    for (const aggregate of sources) collectUsageModels({ summary: aggregate }).forEach((model) => models.add(model));
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  _filters() {
    return { range: this.range, status: this.status, model: this.model, onlyWithUsage: this.onlyWithUsage };
  }

  _loadIfNeeded(force = false) {
    const key = JSON.stringify([this.todoId, this._filters()]);
    if (!force && key === this._loadedKey) return;
    this._loadedKey = key;
    void this._controller.load({ todoId: this.todoId || '', filters: this._filters() });
  }

  /** Re-fetch with the current filters. */
  refresh() {
    this._loadIfNeeded(true);
  }

  _setFilter(patch) {
    Object.assign(this, patch);
    this._loadIfNeeded();
  }

  _onRange = (e) => this._setFilter({ range: String(e?.detail?.value || TODO_USAGE_DEFAULT_RANGE) });

  _onModel = (e) => this._setFilter({ model: String(e?.detail?.value || '') });

  _onStatus(value, e) {
    const checked = e?.detail?.checked === true;
    const next = this.status.filter((entry) => entry !== value);
    if (checked) next.push(value);
    this._setFilter({ status: next });
  }

  _onOnlyWithUsage = (e) => this._setFilter({ onlyWithUsage: e?.detail?.checked === true });

  _onLoadMore = () => {
    void this._controller.loadMore({ todoId: this.todoId || '', filters: this._filters() });
  };

  /* ------------------------------------------------------------ cells */

  _cell(formatted, extraClass = '') {
    const cls = `todo-usage-value${formatted.missing ? ' todo-usage-value--missing' : ''}${extraClass ? ` ${extraClass}` : ''}`;
    const title = formatted.missing ? t('todo.usageNoDataTitle') : formatted.estimated ? t('todo.usageEstimatedTitle') : '';
    return html`<span class=${cls} title=${title}>${formatted.text}</span>`;
  }

  _cost(aggregate) {
    return this._cell(formatTodoUsageCost(aggregate?.usd, aggregate?.estimatedUsd, getCurrentLang()));
  }

  _tokens(aggregate) {
    return this._cell(formatTodoUsageTokens(aggregate?.billedTokens, getCurrentLang()));
  }

  _count(value) {
    return this._cell(formatTodoUsageCount(value, getCurrentLang()));
  }

  /* ---------------------------------------------------------- filters */

  _renderFilters() {
    const workspace = !this.todoId;
    const rangeOptions = TODO_USAGE_RANGES.map((value) => ({ value, label: t(RANGE_LABEL_KEYS[value]) }));
    const modelOptions = [
      { value: '', label: t('todo.usageAllModels') },
      ...[...new Set([...this.knownModels, ...(this.model ? [this.model] : [])])].map((value) => ({ value, label: value })),
    ];
    return html`
      <div class="todo-usage-filters" role="group" aria-label=${t('todo.usageFiltersAria')}>
        <label class="cr-field">
          <span class="cr-field-label">${t('todo.usageFilterRange')}</span>
          <cr-bar-select size="md" aria-label=${t('todo.usageFilterRange')} .value=${this.range} .options=${rangeOptions} @cr-change=${this._onRange}></cr-bar-select>
        </label>
        <label class="cr-field">
          <span class="cr-field-label">${t('todo.usageFilterModel')}</span>
          <cr-bar-select size="md" aria-label=${t('todo.usageFilterModel')} .value=${this.model} .options=${modelOptions} @cr-change=${this._onModel}></cr-bar-select>
        </label>
        ${workspace
          ? html`
              <div class="cr-field todo-usage-status-field">
                <span class="cr-field-label">${t('todo.usageFilterStatus')}</span>
                <div class="todo-usage-status-checks">
                  ${TODO_USAGE_STATUSES.map(
                    (value) => html`<cr-checkbox
                      .checked=${this.status.includes(value)}
                      aria-label=${t(STATUS_LABEL_KEYS[value])}
                      @cr-change=${(e) => this._onStatus(value, e)}
                    >${t(STATUS_LABEL_KEYS[value])}</cr-checkbox>`
                  )}
                </div>
              </div>
              <cr-checkbox
                class="todo-usage-only"
                .checked=${this.onlyWithUsage}
                @cr-change=${this._onOnlyWithUsage}
              >${t('todo.usageOnlyWithUsage')}</cr-checkbox>
            `
          : nothing}
        <cr-bar-button class="todo-usage-refresh" @click=${() => this.refresh()}>${t('todo.usageRefresh')}</cr-bar-button>
      </div>
    `;
  }

  /* ---------------------------------------------------------- blocks */

  _renderSummary(aggregate, heading) {
    if (!aggregate) return nothing;
    const lang = getCurrentLang();
    return html`
      <section class="todo-usage-summary" aria-label=${heading}>
        <h4 class="todo-usage-heading">${heading}</h4>
        <dl class="todo-usage-tiles">
          <div class="todo-usage-tile"><dt>${t('todo.usageAttempts')}</dt><dd>${this._count(aggregate.attempts)}</dd></div>
          <div class="todo-usage-tile"><dt>${t('todo.usageCost')}</dt><dd>${this._cost(aggregate)}</dd></div>
          <div class="todo-usage-tile"><dt>${t('todo.usageTokens')}</dt><dd>${this._tokens(aggregate)}</dd></div>
          <div class="todo-usage-tile"><dt>${t('todo.usageAttemptTime')}</dt><dd>${this._cell(formatTodoUsageDuration(aggregate.attemptsDurationMs))}</dd></div>
          <div class="todo-usage-tile"><dt>${t('todo.usageElapsed')}</dt><dd>${this._cell(formatTodoUsageDuration(aggregate.elapsedMs))}</dd></div>
        </dl>
        ${aggregate.coverage.subscriptionEvents > 0
          ? html`<p class="cr-hint">${t('todo.usageSubscriptionNote', { count: formatTodoUsageCount(aggregate.coverage.subscriptionEvents, lang).text })}</p>`
          : nothing}
        ${aggregate.coverage.unpricedEvents > 0
          ? html`<p class="cr-hint">${t('todo.usageUnpricedNote', { count: formatTodoUsageCount(aggregate.coverage.unpricedEvents, lang).text })}</p>`
          : nothing}
      </section>
    `;
  }

  _renderModelRoles(aggregate) {
    const rows = aggregate?.modelRoles || [];
    if (rows.length === 0) return nothing;
    const lang = getCurrentLang();
    return html`
      <div class="todo-usage-table-wrap">
        <table class="todo-usage-table">
          <caption class="todo-usage-caption">${t('todo.usageByModelRole')}</caption>
          <thead>
            <tr>
              <th scope="col">${t('todo.usageColModel')}</th>
              <th scope="col">${t('todo.usageColRole')}</th>
              <th scope="col" class="num">${t('todo.usageColEvents')}</th>
              <th scope="col" class="num">${t('todo.usageCost')}</th>
              <th scope="col" class="num">${t('todo.usageTokens')}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`<tr>
                <td data-label=${t('todo.usageColModel')}>${row.model}</td>
                <td data-label=${t('todo.usageColRole')}>${row.role}</td>
                <td class="num" data-label=${t('todo.usageColEvents')}>${this._count(row.events)}</td>
                <td class="num" data-label=${t('todo.usageCost')}>${this._cell(formatTodoUsageCost(row.usd, row.estimatedUsd, lang))}</td>
                <td class="num" data-label=${t('todo.usageTokens')}>${this._cell(formatTodoUsageTokens(row.tokens, lang))}</td>
              </tr>`
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  _renderTodoTable(data) {
    const rows = data.todos || [];
    if (rows.length === 0) return nothing;
    const lang = getCurrentLang();
    return html`
      <div class="todo-usage-table-wrap">
        <table class="todo-usage-table">
          <caption class="todo-usage-caption">${t('todo.usageByTodo', { count: String(data.total) })}</caption>
          <thead>
            <tr>
              <th scope="col">${t('todo.usageColTodo')}</th>
              <th scope="col">${t('todo.usageFilterStatus')}</th>
              <th scope="col" class="num">${t('todo.usageAttempts')}</th>
              <th scope="col" class="num">${t('todo.usageCost')}</th>
              <th scope="col" class="num">${t('todo.usageTokens')}</th>
              <th scope="col" class="num">${t('todo.usageColSubtasks')}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`<tr>
                <td class="todo-usage-title" data-label=${t('todo.usageColTodo')}>${row.title || row.todoId}</td>
                <td data-label=${t('todo.usageFilterStatus')}>${STATUS_LABEL_KEYS[row.status] ? t(STATUS_LABEL_KEYS[row.status]) : row.status}</td>
                <td class="num" data-label=${t('todo.usageAttempts')}>${this._count(row.own?.attempts)}</td>
                <td class="num" data-label=${t('todo.usageCost')}>${this._cost(row.own)}</td>
                <td class="num" data-label=${t('todo.usageTokens')}>${this._tokens(row.own)}</td>
                <td class="num" data-label=${t('todo.usageColSubtasks')}>${row.consolidated
                  ? html`${this._cost(row.consolidated)} <span class="todo-usage-sub">/ ${formatTodoUsageCount(row.consolidated.attempts, lang).text}</span>`
                  : html`<span class="todo-usage-value todo-usage-value--missing">${formatTodoUsageCost(null, null).text}</span>`}</td>
              </tr>`
            )}
          </tbody>
        </table>
      </div>
      ${data.nextCursor
        ? html`<cr-bar-button class="todo-usage-more" ?disabled=${this.view.loadingMore} @click=${this._onLoadMore}>${t('todo.usageLoadMore', { shown: String(data.todos.length), total: String(data.total) })}</cr-bar-button>`
        : nothing}
    `;
  }

  _renderState(state) {
    if (state === 'loading') return html`<p class="todo-usage-state" role="status" aria-live="polite">${t('todo.usageLoading')}</p>`;
    if (state === 'unavailable') return html`<p class="todo-usage-state todo-usage-state--warn" role="alert">${t('todo.usageUnavailable')}</p>`;
    if (state === 'error') {
      const message = this.view.error?.message;
      return html`<p class="todo-usage-state todo-usage-state--error" role="alert">${t('todo.usageError')}${message ? html` <span class="cr-hint">${message}</span>` : nothing}</p>`;
    }
    return nothing;
  }

  render() {
    const data = this.view.data;
    const workspace = !this.todoId;
    const aggregates = workspace ? [data?.summary] : [data?.own, data?.consolidated];
    const state = resolveUsageViewState({
      loading: this.view.loading && !data,
      error: this.view.error,
      aggregates: data ? aggregates : [],
    });
    const showData = data && (state === 'ready' || state === 'partial' || state === 'empty' || (state === 'loading' && data));
    return html`
      <div class="todo-usage" data-state=${state} aria-busy=${this.view.loading ? 'true' : 'false'}>
        ${this._renderFilters()}
        ${this._renderState(state)}
        ${state === 'empty' ? html`<p class="todo-usage-state">${t(workspace ? 'todo.usageEmptyWorkspace' : 'todo.usageEmptyTodo')}</p>` : nothing}
        ${state === 'partial' ? html`<p class="todo-usage-state todo-usage-state--warn" role="status">${t('todo.usagePartial')}</p>` : nothing}
        ${showData && state !== 'empty'
          ? workspace
            ? html`
                ${this._renderSummary(data.summary, t('todo.usageWorkspaceSummary'))}
                ${this._renderModelRoles(data.summary)}
                ${this._renderTodoTable(data)}
                ${data.unattributed.events > 0
                  ? html`<p class="cr-hint">${t('todo.usageUnattributed', { count: String(data.unattributed.events) })}</p>`
                  : nothing}
              `
            : html`
                <p class="cr-hint">${t('todo.usageOwnVsConsolidated')}</p>
                <div class="todo-usage-columns">
                  <div class="todo-usage-column" data-state=${resolveAggregateState(data.own)}>
                    ${this._renderSummary(data.own, t('todo.usageOwn'))} ${this._renderModelRoles(data.own)}
                  </div>
                  ${data.consolidated && data.descendantCount > 0
                    ? html`<div class="todo-usage-column" data-state=${resolveAggregateState(data.consolidated)}>
                        ${this._renderSummary(data.consolidated, t('todo.usageConsolidated', { count: String(data.descendantCount) }))}
                        ${this._renderModelRoles(data.consolidated)}
                      </div>`
                    : nothing}
                </div>
              `
          : nothing}
        ${data?.window?.from_day
          ? html`<p class="cr-hint todo-usage-window">${t('todo.usageWindow', { from: data.window.from_day, to: data.window.to_day || '' })}</p>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get('cr-todo-usage')) {
  customElements.define('cr-todo-usage', CrTodoUsage);
}

export { CrTodoUsage };
