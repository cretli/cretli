import { LitElement, css, html } from 'lit';

class CrStorageDonut extends LitElement {
  static properties = {
    label: { type: String },
    subtitle: { type: String },
    hint: { type: String },
    value: { type: Number },
    total: { type: Number },
    tone: { type: String, reflect: true },
    actionLabel: { type: String },
    actionDisabled: { type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      font-family: inherit;
    }

    .card {
      height: 100%;
      border: 1px solid var(--cr-border);
      border-radius: 10px;
      background: var(--cr-surface-alt);
      padding: 0.85rem 0.8rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      box-sizing: border-box;
    }

    .head {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-height: 2.35rem;
    }

    .label {
      font-size: 0.79rem;
      line-height: 1.25;
      font-weight: 600;
      color: var(--cr-text);
    }

    .subtitle {
      font-size: 0.73rem;
      line-height: 1.2;
      color: var(--cr-text-muted);
      word-break: break-word;
    }

    .donut-wrap {
      display: grid;
      place-items: center;
      margin: 0.15rem 0;
    }

    svg {
      width: 96px;
      height: 96px;
      display: block;
      overflow: visible;
    }

    .bg {
      fill: none;
      stroke: var(--cr-border);
      stroke-width: 11;
      opacity: 0.95;
    }

    .value {
      fill: none;
      stroke: var(--cr-primary);
      stroke-width: 11;
      stroke-linecap: round;
      transform: rotate(-90deg);
      transform-origin: 50% 50%;
      transition: stroke-dasharray 180ms ease;
    }

    :host([tone='success']) .value {
      stroke: var(--cr-success);
    }

    :host([tone='warn']) .value {
      stroke: var(--cr-warn);
    }

    :host([tone='danger']) .value {
      stroke: var(--cr-error);
    }

    .center {
      font-size: 0.86rem;
      font-weight: 700;
      fill: var(--cr-text);
      dominant-baseline: middle;
      text-anchor: middle;
    }

    .hint {
      margin-top: auto;
      font-size: 0.72rem;
      line-height: 1.25;
      color: var(--cr-text-muted);
      word-break: break-word;
      min-height: 1.8rem;
    }

    .actions {
      margin-top: 0.1rem;
      display: flex;
    }

    .clear-btn {
      width: 100%;
      padding: 0.4rem 0.6rem;
      background: var(--cr-error);
      color: var(--cr-text-inverse, #fff);
      border: none;
      border-radius: 6px;
      font-size: 0.78rem;
      font-family: inherit;
      cursor: pointer;
      transition: background 140ms ease, opacity 140ms ease;
    }

    .clear-btn:hover:not(:disabled) {
      background: var(--cr-error-hover, var(--cr-error));
    }

    .clear-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.label = '';
    this.subtitle = '';
    this.hint = '';
    this.value = 0;
    this.total = 0;
    this.tone = 'primary';
    this.actionLabel = '';
    this.actionDisabled = false;
  }

  get _safeValue() {
    const num = Number(this.value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return num;
  }

  get _safeTotal() {
    const num = Number(this.total);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num;
  }

  get _ratio() {
    const total = this._safeTotal;
    if (total <= 0) return 0;
    const raw = this._safeValue / total;
    return Math.max(0, Math.min(1, raw));
  }

  get _percentLabel() {
    const total = this._safeTotal;
    if (total <= 0) return '—';
    const percent = this._ratio * 100;
    if (percent >= 10) return `${Math.round(percent)}%`;
    return `${Math.round(percent * 10) / 10}%`;
  }

  _onClearClick() {
    this.dispatchEvent(new CustomEvent('cr-clear', { bubbles: true, composed: true }));
  }

  render() {
    const radius = 34;
    const circumference = 2 * Math.PI * radius;
    const used = circumference * this._ratio;
    return html`
      <div class="card">
        <div class="head">
          <div class="label">${this.label || '—'}</div>
          <div class="subtitle">${this.subtitle || ''}</div>
        </div>
        <div class="donut-wrap" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <circle class="bg" cx="50" cy="50" r="${radius}"></circle>
            <circle
              class="value"
              cx="50"
              cy="50"
              r="${radius}"
              stroke-dasharray="${used} ${circumference}"
            ></circle>
            <text class="center" x="50" y="51">${this._percentLabel}</text>
          </svg>
        </div>
        <div class="hint">${this.hint || ''}</div>
        ${this.actionLabel
          ? html`<div class="actions">
              <button
                type="button"
                class="clear-btn"
                ?disabled=${this.actionDisabled}
                @click=${this._onClearClick}
              >
                ${this.actionLabel}
              </button>
            </div>`
          : null}
      </div>
    `;
  }
}

if (!customElements.get('cr-storage-donut')) {
  customElements.define('cr-storage-donut', CrStorageDonut);
}

export { CrStorageDonut };
