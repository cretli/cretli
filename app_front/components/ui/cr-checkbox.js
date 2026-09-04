import { LitElement, css, html } from 'lit';

class CrCheckbox extends LitElement {
  static properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    ariaLabel: { type: String, attribute: 'aria-label' },
  };

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--cr-space-2, 0.5rem);
      font-family: inherit;
      font-size: 0.8rem;
      color: var(--cr-text);
      vertical-align: middle;
    }

    .control {
      width: 16px;
      height: 16px;
      min-width: 16px;
      min-height: 16px;
      margin: 0;
      accent-color: var(--cr-accent);
      cursor: pointer;
    }

    ::slotted(*) {
      cursor: pointer;
    }

    :host([disabled]) {
      opacity: 0.55;
    }

    :host([disabled]) .control,
    :host([disabled]) ::slotted(*) {
      cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
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

  /**
   * @param {Event} event
   */
  _onChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || this.disabled) return;
    this.checked = input.checked;
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    this.dispatchEvent(
      new CustomEvent('cr-change', {
        detail: { checked: this.checked },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <input
        class="control"
        part="control"
        type="checkbox"
        .checked=${this.checked}
        ?disabled=${this.disabled}
        aria-label=${this.ariaLabel || ''}
        @change=${this._onChange}
      />
      <slot></slot>
    `;
  }

  /**
   * @param {Event} event
   */
  _onHostClick(event) {
    if (this.disabled) return;
    const input = this.shadowRoot?.querySelector('.control');
    if (!(input instanceof HTMLInputElement)) return;
    if (event.composedPath().includes(input)) return;
    input.click();
  }
}

if (!customElements.get('cr-checkbox')) {
  customElements.define('cr-checkbox', CrCheckbox);
}

export { CrCheckbox };
