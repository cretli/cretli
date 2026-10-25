/**
 * Lit views for the Agents panel (light DOM, so the existing global styles and ids keep working).
 * Both elements read signals through SignalWatcher; run labels use watch(), so a title change
 * updates one text node instead of re-rendering the list.
 */
import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { SignalWatcher, signal, watch } from '@lit-labs/signals';
import { t } from '../../i18n/index.js';
import { AGENT_VALUE_PREFIX } from './agentsState.js';

const SCHEDULE_CHUNK = 20;

/** Dropdown list of active runs and available agents. */
export class CrAgentsList extends SignalWatcher(LitElement) {
  /** @type {ReturnType<typeof import('./agentsState.js').createAgentsState> | null} */
  state = null;
  /** @type {(name: string) => boolean} */
  isFavorite = () => false;
  /** @type {(name: string) => boolean} */
  toggleFavorite = () => false;
  /** @type {(value: string) => void} */
  onPick = () => {};

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'block';
  }

  _favButton(name) {
    const active = this.isFavorite(name);
    const title = active ? t('agents.favoriteRemove') : t('agents.favoriteAdd');
    return html`<button
      type="button"
      class="dropdown-fav-btn"
      title=${title}
      aria-label=${title}
      @click=${(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleFavorite(name);
      }}
    >
      <span class="mdi ${active ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline'}" aria-hidden="true"></span>
    </button>`;
  }

  _item(value, name, stateClass, content, selected) {
    return html`<li
      class="chat-list-item ${selected === value ? 'is-active' : ''}"
      role="option"
      aria-selected=${selected === value ? 'true' : 'false'}
      data-agent-value=${value}
      data-agent-name=${name}
      tabindex="-1"
      @click=${() => this.onPick(value)}
    >
      <span class="chat-list-item-state ${stateClass}" aria-hidden="true"></span>
      <span class="chat-list-item-title">${content}</span>
      ${this._favButton(name)}
    </li>`;
  }

  render() {
    const s = this.state;
    if (!s) return nothing;
    const selected = s.selectedValue.get();
    const runs = s.orderedRuns.get();
    const available = s.orderedAvailable.get();
    return html`<ul id="agents-list-items" class="chat-list-items" role="listbox">
      ${runs.length
        ? html`<li class="chat-list-item chat-list-item-header">${t('agents.active')}</li>
            ${repeat(
              runs,
              (v) => v.id,
              (v) =>
                this._item(v.id, v.agentName, 'chat-list-item-state--active', watch(v.label), selected)
            )}`
        : nothing}
      ${available.length
        ? html`<li class="chat-list-item chat-list-item-header">${t('agents.available')}</li>
            ${repeat(
              available,
              (a) => a.name,
              (a) =>
                this._item(AGENT_VALUE_PREFIX + a.name, a.name, 'chat-list-item-state--idle', a.name, selected)
            )}`
        : nothing}
      ${!runs.length && !available.length
        ? html`<li class="chat-list-item agents-start-empty">${t('agents.none')}</li>`
        : nothing}
    </ul>`;
  }
}

/** Schedule rows, revealed in chunks so a long agent list does not become one long task. */
export class CrAgentsSchedule extends SignalWatcher(LitElement) {
  /** @type {ReturnType<typeof import('./agentsState.js').createAgentsState> | null} */
  state = null;
  _visible = signal(SCHEDULE_CHUNK);
  _raf = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'block';
  }

  /** Restarts chunked reveal for a freshly loaded agent list. */
  resetChunks() {
    this._visible.set(SCHEDULE_CHUNK);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  updated() {
    const total = this.state?.scheduleAgents.get().length ?? 0;
    if (this._visible.get() < total && !this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._visible.set(this._visible.get() + SCHEDULE_CHUNK);
      });
    }
  }

  _row(agent) {
    const v = this.state.scheduleRowValue(agent.name);
    return html`<div class="agents-schedule-row">
      <label class="agents-schedule-label">
        <input
          type="checkbox"
          data-agent-name=${agent.name}
          .checked=${live(!!v.enabled)}
          @change=${(e) => this.state.editSchedule(agent.name, { enabled: e.target.checked })}
        />
        ${' ' + agent.name + ' ' + t('agents.every') + ' '}<input
          type="number"
          min="1"
          max="1440"
          class="agents-schedule-interval"
          data-agent-name=${agent.name}
          .value=${live(String(v.intervalMinutes))}
          @input=${(e) => this.state.editSchedule(agent.name, { intervalMinutes: e.target.value })}
        />${' ' + t('agents.minutes')}
      </label>
    </div>`;
  }

  render() {
    const s = this.state;
    if (!s) return nothing;
    const rows = s.scheduleAgents.get().slice(0, this._visible.get());
    return html`<div id="agents-schedule-list" class="agents-schedule-list">
      ${repeat(rows, (a) => a.name, (a) => this._row(a))}
    </div>`;
  }
}

if (!customElements.get('cr-agents-list')) customElements.define('cr-agents-list', CrAgentsList);
if (!customElements.get('cr-agents-schedule')) customElements.define('cr-agents-schedule', CrAgentsSchedule);
