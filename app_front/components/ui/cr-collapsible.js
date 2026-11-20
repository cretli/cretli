import { LitElement, css, html } from 'lit';

/**
 * Collapsible section: a header row (heading + right-aligned meta) that toggles
 * a body. The body stays in the DOM while closed so form controls inside it are
 * still readable.
 *
 * Slots: `heading`, `meta`, default (body). Fires `cr-collapsible-toggle`.
 */
class CrCollapsible extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: block;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm, 4px);
      font-family: inherit;
    }

    .header {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: var(--cr-space-2, 0.5rem);
      width: 100%;
      padding: var(--cr-space-2, 0.5rem) var(--cr-space-3, 0.75rem);
      border: 0;
      background: transparent;
      color: var(--cr-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .header:focus-visible {
      outline: 1px solid var(--cr-field-focus-border);
      outline-offset: -1px;
    }

    .chevron {
      flex: 0 0 auto;
      width: 1rem;
      height: 1rem;
      color: var(--cr-text-muted);
      transition: transform var(--cr-transition, 120ms ease);
    }

    :host([open]) .chevron {
      transform: rotate(90deg);
    }

    .heading {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--cr-space-2, 0.5rem);
      min-width: 0;
    }

    .meta {
      margin-left: auto;
    }

    .body {
      padding: 0 var(--cr-space-3, 0.75rem) var(--cr-space-2, 0.5rem);
    }

    .body[hidden] {
      display: none;
    }
  `;

  constructor() {
    super();
    this.open = false;
  }

  _toggle() {
    this.open = !this.open;
    this.dispatchEvent(
      new CustomEvent('cr-collapsible-toggle', {
        detail: { open: this.open },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <button type="button" class="header" part="header" aria-expanded=${this.open ? 'true' : 'false'} @click=${this._toggle}>
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="heading"><slot name="heading"></slot></span>
        <span class="meta"><slot name="meta"></slot></span>
      </button>
      <div class="body" ?hidden=${!this.open}><slot></slot></div>
    `;
  }
}

if (!customElements.get('cr-collapsible')) {
  customElements.define('cr-collapsible', CrCollapsible);
}

export { CrCollapsible };
