import { LitElement, css, html } from 'lit';

class CrBarButton extends LitElement {
  static properties = {
    variant: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    ariaLabel: { type: String, attribute: 'aria-label' },
    title: { type: String },
  };

  static styles = css`
    :host {
      display: inline-block;
      width: auto;
      max-width: 100%;
      font-family: inherit;
      vertical-align: middle;
    }

    .control {
      box-sizing: border-box;
      width: 100%;
      min-height: var(--cr-toolbar-control-height);
      padding: 0 0.85rem;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-size: 0.82rem;
      line-height: 1;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.3rem;
      white-space: nowrap;
    }

    .control:hover {
      background: var(--cr-hover);
      border-color: var(--cr-border-strong);
    }

    .control:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }

    :host([variant='primary']) .control {
      background: var(--cr-primary);
      color: var(--cr-text-inverse);
      border-color: var(--cr-primary-hover);
    }

    :host([variant='primary']) .control:hover {
      background: var(--cr-primary-hover);
    }

    :host([variant='danger']) .control {
      background: var(--cr-danger-bg);
      color: var(--cr-danger-text);
      border-color: var(--cr-danger-border);
    }

    :host([variant='danger']) .control:hover {
      background: var(--cr-danger-hover);
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
    this.variant = 'secondary';
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
        aria-label=${this.ariaLabel || ''}
        title=${this.title || ''}
      >
        <slot></slot>
      </button>
    `;
  }
}

if (!customElements.get('cr-bar-button')) {
  customElements.define('cr-bar-button', CrBarButton);
}

export { CrBarButton };
