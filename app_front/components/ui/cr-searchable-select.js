import { LitElement, css, html } from 'lit';
import { initDropdown } from '../../lib/dropdown.js';

/**
 * Searchable select styled for Cretli dropdowns.
 * API: options = [{ value, label, keywords? }], value, disabled, displayLabel.
 * displayLabel, when set, is the closed-trigger text (dropdown items still use option labels).
 * Events: cr-change { detail: { value } }.
 */
class CrSearchableSelect extends LitElement {
  static properties = {
    value: { type: String, reflect: true },
    size: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    placeholder: { type: String },
    ariaLabel: { type: String, attribute: 'aria-label' },
    options: { type: Array },
    searchPlaceholder: { type: String, attribute: 'search-placeholder' },
    emptyLabel: { type: String, attribute: 'empty-label' },
    searchThreshold: { type: Number, attribute: 'search-threshold' },
    displayLabel: { type: String, attribute: 'display-label' },
  };

  static styles = css`
    :host {
      display: inline-block;
      max-width: 100%;
      width: 100%;
      font-family: inherit;
      --cr-searchable-select-height: 2rem;
      --cr-searchable-select-padding-x: 0.5rem;
      --cr-searchable-select-font-size: 0.9rem;
      --cr-searchable-select-min-width: 8rem;
    }
    :host([disabled]) {
      opacity: 0.55;
      pointer-events: none;
    }
    .trigger {
      box-sizing: border-box;
      width: 100%;
      min-width: var(--cr-searchable-select-min-width);
      min-height: var(--cr-searchable-select-height);
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0 var(--cr-searchable-select-padding-x);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm, 4px);
      font-size: var(--cr-searchable-select-font-size);
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
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      width: 0.65rem;
      height: 0.65rem;
      opacity: 0.8;
      line-height: 1;
    }
    .arrow svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    :host([size='sm']) {
      --cr-searchable-select-height: 1.5rem;
      --cr-searchable-select-padding-x: 0.4rem;
      --cr-searchable-select-font-size: 0.75rem;
      --cr-searchable-select-min-width: 6.5rem;
    }
    :host([size='lg']) {
      --cr-searchable-select-height: 2rem;
      --cr-searchable-select-padding-x: 0.55rem;
      --cr-searchable-select-font-size: 0.9rem;
      --cr-searchable-select-min-width: 10rem;
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
    this.searchPlaceholder = 'Search...';
    this.emptyLabel = 'No matches';
    this.searchThreshold = 10;
    this.displayLabel = '';
    this._dropdownApi = null;
    this._triggerEl = null;
    this._panelEl = null;
    this._listEl = null;
    this._searchWrapEl = null;
    this._searchInputEl = null;
    this._searchQuery = '';
  }

  disconnectedCallback() {
    this._destroyDropdown();
    super.disconnectedCallback();
  }

  firstUpdated() {
    this._ensureDropdown();
  }

  updated(changedProperties) {
    if (
      changedProperties.has('value') ||
      changedProperties.has('options') ||
      changedProperties.has('placeholder') ||
      changedProperties.has('displayLabel')
    ) {
      this._syncTriggerLabel();
      this._renderPanelItems();
    }
    if (changedProperties.has('disabled') && this._triggerEl) {
      this._triggerEl.disabled = !!this.disabled;
    }
    if (changedProperties.has('searchPlaceholder') && this._searchInputEl) {
      this._searchInputEl.placeholder = this.searchPlaceholder || 'Search...';
      this._searchInputEl.setAttribute('aria-label', this.searchPlaceholder || 'Search...');
    }
    if (changedProperties.has('searchThreshold') || changedProperties.has('options')) {
      this._syncSearchVisibility();
    }
  }

  _normalizeOptions() {
    const rows = Array.isArray(this.options) ? this.options : [];
    return rows
      .map((row) => {
        const value = row?.value == null ? '' : String(row.value);
        const label = row?.label == null ? value : String(row.label);
        const keywords = row?.keywords == null ? '' : String(row.keywords);
        return { value, label, keywords };
      })
      .filter((row) => row.value || row.label);
  }

  _escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _labelForValue() {
    const override = String(this.displayLabel || '').trim();
    if (override) return override;
    const selectedValue = String(this.value || '');
    const selected = this._normalizeOptions().find((row) => row.value === selectedValue);
    if (selected?.label) return selected.label;
    if (selectedValue) return selectedValue;
    return this.placeholder || '—';
  }

  _syncTriggerLabel() {
    const label = this._labelForValue();
    if (this._triggerEl) this._triggerEl.title = label;
  }

  _isSearchEnabled(options = null) {
    const rows = options || this._normalizeOptions();
    const threshold = Number.isFinite(this.searchThreshold) ? Math.max(0, this.searchThreshold) : 10;
    return rows.length >= threshold;
  }

  _syncSearchVisibility() {
    if (!this._searchWrapEl || !this._searchInputEl) return;
    const enabled = this._isSearchEnabled();
    this._searchWrapEl.hidden = !enabled;
    if (!enabled) {
      this._searchQuery = '';
      this._searchInputEl.value = '';
    }
  }

  _getVisibleOptions() {
    const options = this._normalizeOptions();
    const query = String(this._searchQuery || '').trim().toLowerCase();
    if (!query) return options;
    return options.filter((row) => {
      const haystack = [row.label, row.value, row.keywords]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  _renderPanelItems() {
    if (!this._listEl) return;
    this._syncSearchVisibility();
    const selectedValue = String(this.value || '');
    const visible = this._getVisibleOptions();
    if (visible.length === 0) {
      this._listEl.innerHTML =
        '<li class="chat-list-item cr-searchable-select-item-empty" role="presentation">' +
        this._escapeHtml(this.emptyLabel || 'No matches') +
        '</li>';
      return;
    }
    this._listEl.innerHTML = visible
      .map((row) => {
        const selected = row.value === selectedValue;
        return (
          '<li class="chat-list-item cr-searchable-select-item' +
          (selected ? ' is-active' : '') +
          '" role="option" tabindex="-1" data-value="' +
          this._escapeHtml(row.value) +
          '" aria-selected="' +
          (selected ? 'true' : 'false') +
          '">' +
          '<span class="chat-list-item-title">' +
          this._escapeHtml(row.label || row.value) +
          '</span>' +
          '</li>'
        );
      })
      .join('');
    this._listEl.querySelectorAll('.cr-searchable-select-item[data-value]').forEach((item) => {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextValue = item.getAttribute('data-value') || '';
        this._selectValue(nextValue);
      });
    });
  }

  _selectValue(nextValue) {
    if (this.disabled) return;
    const normalized = String(nextValue || '');
    const currentValue = String(this.value || '');
    if (normalized !== currentValue) this.value = normalized;
    const changeEvent = new CustomEvent('cr-change', {
      detail: { value: normalized, alreadySelected: normalized === currentValue },
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.dispatchEvent(changeEvent);
    if (changeEvent.defaultPrevented) return;
    this.closeDropdown();
  }

  _focusSearchInput() {
    if (!this._searchInputEl || this._searchWrapEl?.hidden) return;
    window.requestAnimationFrame(() => {
      this._searchInputEl?.focus();
      this._searchInputEl?.select();
    });
  }

  _createPanelTemplate() {
    this._panelEl = document.createElement('div');
    this._panelEl.className = 'chat-list-modal cr-searchable-select-modal';
    this._panelEl.hidden = true;
    this._panelEl.innerHTML =
      '<div class="chat-list-panel dropdown-panel--compact">' +
      '<div class="cr-searchable-select-search-wrap" hidden>' +
      '<input type="text" class="cr-searchable-select-search-input" autocomplete="off" />' +
      '</div>' +
      '<ul class="chat-list-items cr-searchable-select-items" role="listbox"></ul>' +
      '</div>';
    document.body.appendChild(this._panelEl);
    this._listEl = this._panelEl.querySelector('.cr-searchable-select-items');
    this._searchWrapEl = this._panelEl.querySelector('.cr-searchable-select-search-wrap');
    this._searchInputEl = this._panelEl.querySelector('.cr-searchable-select-search-input');
    if (this._searchInputEl) {
      this._searchInputEl.placeholder = this.searchPlaceholder || 'Search...';
      this._searchInputEl.setAttribute('aria-label', this.searchPlaceholder || 'Search...');
      this._searchInputEl.addEventListener('input', () => {
        this._searchQuery = this._searchInputEl?.value || '';
        this._renderPanelItems();
      });
      this._searchInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.closeDropdown();
          return;
        }
        // Arrows must reach the panel handler so the user can move from the
        // search field into the results; everything else stays local so typing
        // does not trigger global shortcuts.
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return;
        event.stopPropagation();
      });
    }
  }

  _ensureDropdown() {
    if (this._dropdownApi) return;
    this._triggerEl = this.shadowRoot?.querySelector('.trigger');
    if (!this._triggerEl) return;
    this._createPanelTemplate();
    this._dropdownApi = initDropdown({
      triggerEl: this._triggerEl,
      floatingEl: this._panelEl,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 180,
      maxHeightPx: 320,
      onOpen: () => {
        this._renderPanelItems();
        this._focusSearchInput();
      },
      onClose: () => {
        this._searchQuery = '';
        if (this._searchInputEl) this._searchInputEl.value = '';
        this._renderPanelItems();
      },
    });
    this._triggerEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.disabled) return;
      this.toggleDropdown();
    });
    this._triggerEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (this.disabled) return;
      this.toggleDropdown();
    });
    this._syncTriggerLabel();
    this._renderPanelItems();
  }

  _destroyDropdown() {
    if (this._dropdownApi) {
      this._dropdownApi.destroy();
      this._dropdownApi = null;
    }
    if (this._panelEl) {
      this._panelEl.remove();
      this._panelEl = null;
    }
    this._triggerEl = null;
    this._listEl = null;
    this._searchWrapEl = null;
    this._searchInputEl = null;
    this._searchQuery = '';
  }

  refreshOptions() {
    this._syncTriggerLabel();
    this._renderPanelItems();
  }

  openDropdown() {
    this._ensureDropdown();
    this._dropdownApi?.open?.();
  }

  closeDropdown() {
    this._dropdownApi?.close?.();
  }

  toggleDropdown() {
    this._ensureDropdown();
    this._dropdownApi?.toggle?.();
  }

  isDropdownOpen() {
    return this._dropdownApi?.isOpen?.() === true;
  }

  render() {
    return html`
      <button
        type="button"
        class="trigger"
        part="control"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label=${this.ariaLabel || this._labelForValue()}
        ?disabled=${this.disabled}
      >
        <span class="label">${this._labelForValue()}</span>
        <span class="arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path fill="currentColor" d="M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6-6-6z" />
          </svg>
        </span>
      </button>
    `;
  }
}

if (!customElements.get('cr-searchable-select')) {
  customElements.define('cr-searchable-select', CrSearchableSelect);
}

export { CrSearchableSelect };
