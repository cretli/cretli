import { LitElement, css, html } from 'lit';

class CrBarTextarea extends LitElement {
  static properties = {
    value: { type: String },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    disabled: { type: Boolean, reflect: true },
    rows: { type: Number },
    autoGrow: { type: Boolean, reflect: true },
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
    this.autoGrow = false;
    /** @type {ResizeObserver | null} */
    this._resizeObserver = null;
    /** @type {number} */
    this._lastControlWidth = -1;
  }

  focus() {
    this.shadowRoot?.querySelector('.control')?.focus();
  }

  blur() {
    this.shadowRoot?.querySelector('.control')?.blur();
  }

  /**
   * Recomputes the auto-grow height. Public so a parent can call it right after
   * the control becomes visible (for example after `cr-dialog.show()`).
   */
  refreshAutoGrow() {
    this._applyAutoGrow();
  }

  firstUpdated() {
    this._observeControlWidth();
  }

  connectedCallback() {
    super.connectedCallback();
    // Re-attach after a disconnect/reconnect; firstUpdated only runs once.
    if (this.hasUpdated) this._observeControlWidth();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._lastControlWidth = -1;
  }

  /**
   * Watches the host width so a rotation/resize recomputes the height, but only
   * reacts to width changes: reacting to the height we just set would loop.
   */
  _observeControlWidth() {
    if (typeof ResizeObserver === 'undefined') return;
    if (this._resizeObserver) return;
    this._resizeObserver = new ResizeObserver((entries) => {
      const width = entries?.[0]?.contentRect?.width;
      if (!Number.isFinite(width) || width === this._lastControlWidth) return;
      this._lastControlWidth = width;
      this._applyAutoGrow();
    });
    this._resizeObserver.observe(this);
  }

  /**
   * Grows the inner textarea with its content, capped at ~60vh so a long body
   * scrolls inside the field instead of pushing the dialog actions off-screen.
   */
  _applyAutoGrow() {
    if (!this.autoGrow) return;
    const el = this.shadowRoot?.querySelector('.control');
    if (!(el instanceof HTMLTextAreaElement)) return;
    // A closed dialog hides the field: it is not rendered, so scrollHeight is 0
    // and it has no client rects. Stamping `height: 0` would collapse it, so
    // clear the inline height and let the `rows` attribute size the field until
    // it is visible again. getClientRects() is used instead of offsetParent
    // because it reports shadow-DOM visibility reliably.
    if (el.scrollHeight === 0 || el.getClientRects().length === 0) {
      el.style.height = '';
      el.style.overflowY = '';
      return;
    }
    el.style.height = 'auto';
    const viewport = typeof window !== 'undefined' ? window.innerHeight : 800;
    const maxPx = Math.max(120, Math.round(viewport * 0.6));
    const next = Math.min(el.scrollHeight, maxPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
  }

  updated() {
    this._applyAutoGrow();
  }

  _onInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    this.value = el.value;
    this._applyAutoGrow();
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
