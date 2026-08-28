import { LitElement, css, html } from 'lit';
import { initDropdown } from '../../lib/dropdown.js';

/**
 * Select styled like the chat-bar-trigger (e.g. chat picker). Variants: sm | md | lg.
 * API: options = [{ value, label }], value, disabled; event cr-change { detail.value }.
 */
class CrBarSelect extends LitElement {
  static properties = {
    value: { type: String, reflect: true },
    size: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    options: { type: Array },
  };

  static styles = css`
    :host {
      display: inline-block;
      max-width: 100%;
      font-family: inherit;
      vertical-align: middle;
    }

    :host([disabled]) {
      opacity: 0.55;
      pointer-events: none;
    }

    .trigger {
      box-sizing: border-box;
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0 0.5rem;
      background: var(--cr-input-bg);
      color: var(--cr-text);
      border: 1px solid var(--cr-border-control);
      border-radius: var(--cr-radius-sm, 4px);
      font-size: 0.8rem;
      line-height: 1.2;
      cursor: pointer;
      font-family: inherit;
    }

    .trigger:hover {
      border-color: var(--cr-border-strong);
    }

    .trigger:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }

    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      text-align: left;
    }

    .arrow {
      flex-shrink: 0;
      font-size: 0.65rem;
      opacity: 0.8;
      line-height: 1;
    }

    :host([size='sm']) .trigger {
      height: 1.5rem;
      min-width: 6.5rem;
      font-size: 0.75rem;
      padding: 0 0.4rem;
    }

    :host([size='md']) .trigger,
    :host(:not([size])) .trigger {
      height: 1.75rem;
      min-width: 8rem;
      font-size: 0.8rem;
    }

    :host([size='lg']) .trigger {
      height: 2rem;
      min-width: 10rem;
      font-size: 0.9rem;
      padding: 0 0.55rem;
    }

  `;

  constructor() {
    super();
    this.value = '';
    this.size = 'md';
    this.disabled = false;
    this.placeholder = '—';
    this.ariaLabel = '';
    this.options = [];
    this._dropdownApi = null;
    this._panel = null;
    this._listEl = null;
    this._triggerEl = null;
    this._dropdownReady = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this.size) this.size = 'md';
  }

  disconnectedCallback() {
    this._destroyDropdown();
    super.disconnectedCallback();
  }

  firstUpdated() {
    this._ensureDropdown();
  }

  updated(changed) {
    if (!this._dropdownReady) return;
    if (changed.has('value')) {
      this._syncTriggerLabel();
      this._renderPanelItems();
    }
    if (changed.has('options')) {
      this._syncTriggerLabel();
      this._renderPanelItems();
    }
    if (changed.has('disabled') && this._triggerEl) {
      this._triggerEl.disabled = !!this.disabled;
    }
  }

  _labelForValue() {
    const opts = Array.isArray(this.options) ? this.options : [];
    const hit = opts.find((o) => o && String(o.value) === String(this.value));
    if (hit && hit.label) return String(hit.label);
    if (this.value) return String(this.value);
    return this.placeholder || '—';
  }

  _syncTriggerLabel() {
    // `.label` holds a Lit binding: writing its textContent here ejects the
    // part's marker nodes, and every later render throws instead of updating.
    // `value` and `options` are reactive, so Lit renders the text itself.
    if (this._triggerEl) this._triggerEl.title = this._labelForValue();
  }

  _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _renderPanelItems() {
    if (!this._listEl) return;
    const opts = Array.isArray(this.options) ? this.options : [];
    this._listEl.innerHTML = opts
      .map((opt) => {
        const val = opt?.value != null ? String(opt.value) : '';
        const label = opt?.label != null ? String(opt.label) : val;
        const selected = val === String(this.value);
        return (
          '<li class="chat-list-item cr-bar-select-item' +
          (selected ? ' is-active' : '') +
          '" role="option" tabindex="-1" data-value="' +
          this._escapeHtml(val) +
          '" aria-selected="' +
          (selected ? 'true' : 'false') +
          '">' +
          '<span class="chat-list-item-title">' +
          this._escapeHtml(label) +
          '</span></li>'
        );
      })
      .join('');

    this._listEl.querySelectorAll('.cr-bar-select-item').forEach((item) => {
      item.addEventListener('click', () => {
        const next = item.getAttribute('data-value') || '';
        this._selectValue(next);
      });
    });
  }

  _selectValue(nextValue) {
    if (this.disabled) return;
    const normalized = nextValue != null ? String(nextValue) : '';
    if (normalized === String(this.value)) {
      this._dropdownApi?.close();
      return;
    }
    this.value = normalized;
    this._syncTriggerLabel();
    this._renderPanelItems();
    this._dropdownApi?.close();
    this.dispatchEvent(
      new CustomEvent('cr-change', {
        detail: { value: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  _destroyDropdown() {
    if (this._dropdownApi) {
      this._dropdownApi.destroy();
      this._dropdownApi = null;
    }
    if (this._panel) {
      this._panel.remove();
      this._panel = null;
    }
    this._listEl = null;
    this._triggerEl = null;
    this._dropdownReady = false;
  }

  _ensureDropdown() {
    if (this._dropdownReady) return;
    this._triggerEl = this.shadowRoot?.querySelector('.trigger');
    if (!this._triggerEl) return;

    this._panel = document.createElement('div');
    this._panel.className = 'chat-list-modal cr-bar-select-modal';
    this._panel.hidden = true;
    this._panel.innerHTML =
      '<div class="chat-list-panel dropdown-panel--compact">' +
      '<ul class="chat-list-items cr-bar-select-items" role="listbox"></ul>' +
      '</div>';
    document.body.appendChild(this._panel);
    this._listEl = this._panel.querySelector('.cr-bar-select-items');

    this._dropdownApi = initDropdown({
      triggerEl: this._triggerEl,
      floatingEl: this._panel,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 140,
      maxHeightPx: 280,
      onOpen: () => this._renderPanelItems(),
    });

    this._triggerEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.disabled) return;
      this._dropdownApi.toggle();
    });
    this._triggerEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (this.disabled) return;
      this._dropdownApi.toggle();
    });

    this._dropdownReady = true;
    this._syncTriggerLabel();
    this._renderPanelItems();
  }

  render() {
    return html`
      <button
        type="button"
        class="trigger"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label=${this.ariaLabel || this._labelForValue()}
        ?disabled=${this.disabled}
      >
        <span class="label">${this._labelForValue()}</span>
        <span class="arrow" aria-hidden="true">▾</span>
      </button>
    `;
  }
}

if (!customElements.get('cr-bar-select')) {
  customElements.define('cr-bar-select', CrBarSelect);
}

export { CrBarSelect };
