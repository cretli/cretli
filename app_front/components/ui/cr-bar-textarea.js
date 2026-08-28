import { LitElement, css, html } from 'lit';

class CrBarTextarea extends LitElement {
  static properties = {
    value: { type: String },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    disabled: { type: Boolean, reflect: true },
    rows: { type: Number },
  };

  static styles = css`
    :host {
      display: inline-block;
      width: 100%;
      max-width: 100%;
      font-family: inherit;
      vertical-align: middle;
    }

    .control {
      box-sizing: border-box;
      width: 100%;
      min-height: var(--cr-toolbar-control-height);
      padding: 0.25rem 0.5rem;
      border: 1px solid var(--cr-border-control);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-input-bg);
      color: var(--cr-text);
      font-size: 0.8rem;
      font-family: inherit;
      line-height: 1.3;
      resize: vertical;
      transition:
        border-color var(--cr-transition, 120ms ease),
        background var(--cr-transition, 120ms ease);
    }

    .control::placeholder {
      color: var(--cr-text-muted);
    }

    .control:hover {
      border-color: var(--cr-border-strong);
    }

    .control:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
      background: var(--cr-surface-2);
    }

    :host([disabled]) .control {
      opacity: 0.55;
      cursor: not-allowed;
    }

  `;

  constructor() {
    super();
    this.value = '';
    this.placeholder = '';
    this.ariaLabel = '';
    this.disabled = false;
    this.rows = 2;
  }

  focus() {
    this.shadowRoot?.querySelector('.control')?.focus();
  }

  blur() {
    this.shadowRoot?.querySelector('.control')?.blur();
  }

  _onInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    this.value = el.value;
  }

  _onChange(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    this.value = el.value;
  }

  _onBlur() {
    this.dispatchEvent(new Event('blur'));
  }

  render() {
    return html`
      <textarea
        class="control"
        .value=${this.value || ''}
        .placeholder=${this.placeholder || ''}
        .rows=${Number.isFinite(this.rows) && this.rows > 0 ? this.rows : 2}
        ?disabled=${this.disabled}
        aria-label=${this.ariaLabel || this.placeholder || 'Pole tekstowe'}
        @input=${this._onInput}
        @change=${this._onChange}
        @blur=${this._onBlur}
      ></textarea>
    `;
  }
}

if (!customElements.get('cr-bar-textarea')) {
  customElements.define('cr-bar-textarea', CrBarTextarea);
}

export { CrBarTextarea };
