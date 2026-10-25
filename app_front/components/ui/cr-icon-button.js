import { LitElement, css, html } from 'lit';

class CrIconButton extends LitElement {
  static properties = {
    variant: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    ariaLabel: { type: String, attribute: 'aria-label' },
    title: { type: String },
  };

  static styles = css`
    :host {
      display: inline-block;
      width: var(--cr-control-height, var(--cr-toolbar-control-height, 1.75rem));
      height: var(--cr-control-height, var(--cr-toolbar-control-height, 1.75rem));
      vertical-align: middle;
      font-family: inherit;
    }

    .control {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text-muted);
      cursor: pointer;
    }

    .control:hover {
      color: var(--cr-text);
      border-color: var(--cr-border-strong);
    }

    .control:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }

    :host([variant='danger']) .control:hover {
      color: var(--cr-error);
    }

    :host([disabled]) .control {
      opacity: 0.55;
      cursor: not-allowed;
    }

    ::slotted(.mdi) {
      font-size: 1rem;
      line-height: 1;
    }
  `;

  constructor() {
    super();
    this.variant = '';
    this.disabled = false;
    this.ariaLabel = '';
    this.title = '';
  }

  focus() {
    this.shadowRoot?.querySelector('.control')?.focus();
  }

  blur() {
    this.shadowRoot?.querySelector('.control')?.blur();
  }

  render() {
    return html`
      <button
        class="control"
        part="control"
        type="button"
        ?disabled=${this.disabled}
        aria-label=${this.ariaLabel || this.title || ''}
        title=${this.title || ''}
      >
        <slot></slot>
      </button>
    `;
  }
}

if (!customElements.get('cr-icon-button')) {
  customElements.define('cr-icon-button', CrIconButton);
}

export { CrIconButton };
