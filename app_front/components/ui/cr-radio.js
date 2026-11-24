import { LitElement, css, html } from 'lit';
import { choiceControlStyles } from './cr-choice-control.styles.js';

/**
 * Radio option, the single-choice sibling of `cr-checkbox`: same API (`checked`, `disabled`,
 * label as slotted content, `change` / `cr-change` events). Radios sharing a `name` inside the
 * same root are mutually exclusive.
 */
class CrRadio extends LitElement {
  static properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    name: { type: String, reflect: true },
    value: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
  };

  static styles = [choiceControlStyles, css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--cr-space-2, 0.5rem);
      font-family: inherit;
      font-size: var(--cr-font-size-sm, 0.8rem);
      color: var(--cr-text);
      vertical-align: middle;
    }
    ::slotted(*) {
      cursor: pointer;
    }
    :host([disabled]) {
      opacity: 0.55;
    }
    :host([disabled]) ::slotted(*) {
      cursor: not-allowed;
    }
  `];

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.name = '';
    this.value = '';
    this.ariaLabel = '';
    this._onHostClick = this._onHostClick.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onHostClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onHostClick);
    super.disconnectedCallback();
  }

  /** @param {Event} event */
  _onChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || this.disabled || !input.checked) return;
    this.checked = true;
    if (this.name) {
      const root = this.getRootNode();
      const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;
      for (const other of /** @type {NodeListOf<CrRadio>} */ (scope.querySelectorAll('cr-radio'))) {
        if (other !== this && other.name === this.name) other.checked = false;
      }
    }
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent('cr-change', {
      detail: { checked: true, value: this.value },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <input
        class="control"
        part="control"
        type="radio"
        name=${this.name || ''}
        .checked=${this.checked}
        ?disabled=${this.disabled}
        aria-label=${this.ariaLabel || ''}
        @change=${this._onChange}
      />
      <slot></slot>
    `;
  }

  /** @param {Event} event */
  _onHostClick(event) {
    if (this.disabled) return;
    const input = this.shadowRoot?.querySelector('.control');
    if (!(input instanceof HTMLInputElement)) return;
    if (event.composedPath().includes(input)) return;
    input.click();
  }
}

if (!customElements.get('cr-radio')) {
  customElements.define('cr-radio', CrRadio);
}

export { CrRadio };
