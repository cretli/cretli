import { LitElement, html, nothing } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { t } from '../../i18n/index.js';
import { commandHandlers } from '../voice/commandHandlers.js';
import { ORCHESTRATOR_PAGE_SIZE, dragIntent } from './orchestratorModel.js';
import { carCards } from './carDecisions.js';
import { carPresence, carScreen, loadAgentRows } from './carService.js';

const TICK_MS = 1500;

/**
 * Agents screen: every agent of every workspace, the ones that need the driver
 * first. Switching is a big button, a horizontal drag on the row, or a spoken
 * command (`switch_agent`); all three call the same `commandHandlers.switchAgent`.
 * Light DOM; styles in `css/features/car/_car-view.scss`.
 */
export class CrCarAgents extends SignalWatcher(LitElement) {
  static properties = {
    rows: { state: true },
    notice: { state: true },
    dragId: { state: true },
    dragDx: { state: true },
    visible: { state: true },
  };

  constructor() {
    super();
    /** @type {import('./orchestratorModel.js').AgentRow[]} */
    this.rows = [];
    this.notice = '';
    this.dragId = '';
    this.dragDx = 0;
    this.visible = ORCHESTRATOR_PAGE_SIZE;
    this.timer = null;
    this.pointerStart = null;
    this.seen = '';
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#reload();
    this.timer = setInterval(() => void this.#reload(), TICK_MS);
  }

  disconnectedCallback() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  async #reload() {
    try {
      const rows = await loadAgentRows({ refresh: false });
      const key = JSON.stringify(rows.map((row) => [row.chatId, row.title, row.status, row.active, row.workspaceLabel]));
      if (key !== this.seen) {
        this.seen = key;
        this.rows = rows;
      }
    } catch {
      // Keep the last list.
    }
  }

  async #switch(row) {
    if (row.active) {
      carScreen.set('choice');
      return;
    }
    const result = await commandHandlers.switchAgent({ chat_id: row.chatId });
    this.notice = result.ok === false ? String(result.error || t('car.err.generic')) : '';
    if (result.ok !== false) carScreen.set('choice');
  }

  #down(event, row) {
    if (event.target.closest('button')) return;
    this.pointerStart = { id: row.chatId, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.dragId = row.chatId;
    this.dragDx = 0;
  }

  #move(event) {
    const start = this.pointerStart;
    if (!start || start.pointerId !== event.pointerId) return;
    this.dragDx = Math.max(-160, Math.min(160, event.clientX - start.x));
  }

  #up(event, row) {
    const start = this.pointerStart;
    this.pointerStart = null;
    this.dragId = '';
    this.dragDx = 0;
    if (!start || start.id !== row.chatId || start.pointerId !== event.pointerId) return;
    if (dragIntent(start, { x: event.clientX, y: event.clientY }) === 'switch') void this.#switch(row);
  }

  #cancel() {
    this.pointerStart = null;
    this.dragId = '';
    this.dragDx = 0;
  }

  render() {
    // Reading the signals subscribes this view to presence and card changes.
    const stamp = `${carPresence.get().at}:${carCards.get().length}`;
    if (stamp !== this.lastStamp) {
      this.lastStamp = stamp;
      void this.#reload();
    }
    return html`<section class="cr-car-agents" data-testid="car-agents">
      <h2 class="cr-car__card-title">${t('car.agents')}</h2>
      <p class="cr-car__more">${t('car.dragHint')}</p>
      ${this.rows.length === 0 ? html`<p class="cr-car__empty">${t('car.noAgents')}</p>` : nothing}
      <ul class="cr-car-agents__list">
        ${this.rows.slice(0, this.visible).map((row) => html`<li
          class="cr-car-agents__row ${row.active ? 'is-active' : ''}"
          data-testid="car-agent-row"
          data-chat-id=${row.chatId}
          data-status=${row.status}
          style=${this.dragId === row.chatId ? `transform: translateX(${this.dragDx}px)` : ''}
          @pointerdown=${(event) => this.#down(event, row)}
          @pointermove=${(event) => this.#move(event)}
          @pointerup=${(event) => this.#up(event, row)}
          @pointercancel=${() => this.#cancel()}>
          <span class="cr-car__status cr-car-agents__status" data-status=${row.status}>${t(`car.status.${row.status}`)}</span>
          <span class="cr-car-agents__text">
            <span class="cr-car-agents__title">${row.title}</span>
            ${row.workspaceLabel ? html`<span class="cr-car-agents__ws">${row.workspaceLabel}</span>` : nothing}
          </span>
          <button type="button" class="cr-car__btn cr-car-agents__switch" data-testid="car-agent-switch"
            aria-label=${t('car.switchToAgent', { title: row.title })}
            @click=${() => this.#switch(row)}>${row.active ? t('car.activeAgent') : t('car.switchTo')}</button>
        </li>`)}
      </ul>
      ${this.rows.length > this.visible ? html`<button type="button" class="cr-car__btn" data-testid="car-agents-more"
        @click=${() => { this.visible += ORCHESTRATOR_PAGE_SIZE; }}>${t('car.agentsMore', { count: this.rows.length - this.visible })}</button>` : nothing}
      ${this.notice ? html`<p class="cr-car__notice" data-kind="error" role="status">${this.notice}</p>` : nothing}
    </section>`;
  }
}

if (!customElements.get('cr-car-agents')) customElements.define('cr-car-agents', CrCarAgents);
