import { LitElement, css, html } from 'lit';

class CrBarInput extends LitElement {
  static properties = {
    value: { type: String },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    disabled: { type: Boolean, reflect: true },
    maxLength: { type: Number, attribute: 'maxlength' },
    type: { type: String },
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
      height: var(--cr-toolbar-control-height);
      padding: 0 0.5rem;
      border: 1px solid var(--cr-border-control);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-input-bg);
      color: var(--cr-text);
      font-size: 0.8rem;
      font-family: inherit;
      line-height: 1.2;
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
    this.maxLength = 0;
    this.type = 'text';
  }

  focus() {
    this.shadowRoot?.querySelector('.control')?.focus();
  }

  blur() {
    this.shadowRoot?.querySelector('.control')?.blur();
  }

  _onInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    this.value = el.value;
  }

  _onChange(e) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    this.value = el.value;
  }

  _onBlur() {
    this.dispatchEvent(new Event('blur'));
  }

  render() {
    return html`
      <input
        class="control"
        part="control"
        .value=${this.value || ''}
        .placeholder=${this.placeholder || ''}
        ?disabled=${this.disabled}
        .type=${this.type || 'text'}
        .maxLength=${this.maxLength > 0 ? this.maxLength : 524288}
        aria-label=${this.ariaLabel || this.placeholder || 'Pole tekstowe'}
        @input=${this._onInput}
        @change=${this._onChange}
        @blur=${this._onBlur}
      />
    `;
  }
}

if (!customElements.get('cr-bar-input')) {
  customElements.define('cr-bar-input', CrBarInput);
}

export { CrBarInput };
