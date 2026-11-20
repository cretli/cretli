import { LitElement, css, html } from 'lit';
import { readBarInputLiveValue } from './read-bar-input-live-value.js';

class CrBarInput extends LitElement {
  static properties = {
    value: { type: String },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    disabled: { type: Boolean, reflect: true },
    readOnly: { type: Boolean, reflect: true, attribute: 'readonly' },
    maxLength: { type: Number, attribute: 'maxlength' },
    type: { type: String },
    min: { type: String },
    max: { type: String },
    step: { type: String },
    autocomplete: { type: String },
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
      border: 1px solid var(--cr-field-border);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-field-bg);
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
      border-color: var(--cr-field-border-hover);
    }

    .control:focus {
      outline: none;
      border-color: var(--cr-field-focus-border);
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
    this.readOnly = false;
    this.maxLength = 0;
    this.type = 'text';
    this.min = '';
    this.max = '';
    this.step = '';
    this.autocomplete = '';
  }

  /**
   * Value currently shown in the inner control (autofill-safe).
   * @returns {string}
   */
  getLiveValue() {
    return readBarInputLiveValue(this);
  }

  focus() {
    /** @type {HTMLInputElement | null} */
    const control = this.shadowRoot?.querySelector('.control');
    control?.focus();
  }

  blur() {
    /** @type {HTMLInputElement | null} */
    const control = this.shadowRoot?.querySelector('.control');
    control?.blur();
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
        ?readonly=${this.readOnly}
        .type=${this.type || 'text'}
        .maxLength=${this.maxLength > 0 ? this.maxLength : 524288}
        min=${this.min || ''}
        max=${this.max || ''}
        step=${this.step || ''}
        autocomplete=${this.autocomplete || 'off'}
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
