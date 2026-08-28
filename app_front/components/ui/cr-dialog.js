import { LitElement, css, html } from 'lit';

/**
 * Shared modal/dialog component (Shadow DOM).
 * Palette and geometry from --cr-* tokens (app_front/css/tokens.scss).
 * Theme values are inherited through CSS custom properties.
 * Reusable pre-auth (no dependency on app state).
 */
class CrDialog extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
    variant: { type: String, reflect: true },
    persistent: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: contents;
    }
    :host(:not([open])) .backdrop,
    :host(:not([open])) .dialog {
      display: none;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      background: var(--cr-overlay);
      z-index: 20100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--cr-space-3);
      padding-top: max(var(--cr-space-3), env(safe-area-inset-top));
      padding-bottom: max(var(--cr-space-3), env(safe-area-inset-bottom));
    }
    .dialog {
      box-sizing: border-box;
      width: 100%;
      max-width: var(--cr-dialog-max-width, 22rem);
      background: var(--cr-surface);
      color: var(--cr-text);
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-lg);
      box-shadow: 0 12px 40px var(--cr-shadow);
      font-family: var(--cr-font-ui);
      padding: var(--cr-space-4);
    }
    .heading {
      display: flex;
      align-items: center;
      gap: var(--cr-space-2);
      margin: 0 0 var(--cr-space-1);
      font-size: 1.05rem;
      font-weight: 600;
    }
    .heading ::slotted(.mdi) {
      font-size: 1.25rem;
      line-height: 1;
    }
    .subheading {
      margin: 0 0 var(--cr-space-3);
      color: var(--cr-text-muted);
      font-size: 0.85rem;
    }
    .body {
      margin: 0 0 var(--cr-space-3);
    }
    .actions {
      display: flex;
      gap: var(--cr-space-2);
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .actions ::slotted(cr-bar-button),
    .actions ::slotted(button) {
      flex: 1 1 auto;
    }
    .message {
      box-sizing: border-box;
      margin: 0 0 var(--cr-space-3);
      padding: var(--cr-space-2) var(--cr-space-3);
      border-radius: var(--cr-radius-sm);
      font-size: 0.85rem;
      border: 1px solid transparent;
    }
    .message[data-tone='error'] {
      background: var(--cr-error-bg);
      color: var(--cr-error);
      border-color: var(--cr-error-border);
    }
    .message[data-tone='success'] {
      background: var(--cr-success-bg);
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.heading = '';
    this.variant = 'info';
    this.persistent = false;
    this._lastFocused = null;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKeyDown);
    super.disconnectedCallback();
  }

  _onKeyDown = (e) => {
    if (!this.open || this.persistent) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
    }
  };

  show() {
    this.open = true;
    this._lastFocused = document.activeElement;
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('cr-dialog-close', { bubbles: true, composed: true }));
    if (this._lastFocused && typeof this._lastFocused.focus === 'function') {
      this._lastFocused.focus();
    }
  }

  _onBackdropClick(e) {
    if (this.persistent) return;
    if (e.target === e.currentTarget) this.hide();
  }

  render() {
    return html`
      <div class="backdrop" @click=${this._onBackdropClick}>
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cr-dialog-heading">
          ${this.heading
            ? html`<h2 class="heading" id="cr-dialog-heading"><slot name="icon"></slot> ${this.heading}</h2>`
            : html`<h2 class="heading" id="cr-dialog-heading"><slot name="icon"></slot></h2>`}
          <slot name="subheading"></slot>
          <div class="body">
            <slot></slot>
          </div>
          <slot name="actions"></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('cr-dialog')) {
  customElements.define('cr-dialog', CrDialog);
}

export { CrDialog };
