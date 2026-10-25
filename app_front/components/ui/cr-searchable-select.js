import { LitElement, css, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { initDropdown } from '../../lib/dropdown.js';

/** Git branch glyph used for worktree filter and the closed-trigger indicator. */
const GIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 3a3 3 0 0 1 1 5.83v6.34a3 3 0 1 1-2 0V8.83A3 3 0 0 1 6 3zm12 5a3 3 0 0 1 1 5.83V14a4 4 0 0 1-4 4h-3.17a3 3 0 1 1 0-2H15a2 2 0 0 0 2-2v-.17A3 3 0 0 1 18 8z"/></svg>';

/**
 * Searchable select styled for Cretli dropdowns.
 * API: options = [{ value, label, keywords?, group?, description?, status?, disabled?, worktree? }], value, disabled, displayLabel.
 * Rows may also carry name (list title instead of label), tag (small pill after the title) and
 * meta (muted monospace line, e.g. a raw id); label stays the full text for aria and the trigger.
 * Rows sharing variantOf collapse into one row with a chip per variant (variantLabel, ordered by
 * variantRank); the row itself stands for the selected, isDefault or first available variant.
 * displayLabel, when set, is the closed-trigger text (dropdown items still use option labels).
 * Slots `start` / `end` place decorations (icon, badge) around the closed-trigger label.
 * Optional favoritesEnabled shows per-option stars; options may include favorite and favoriteable.
 * Events: cr-change { detail: { value } }, cr-open, cr-favorite-toggle { detail: { value } }.
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
    displayDescription: { type: String, attribute: 'display-description' },
    // Closed-trigger tooltip; defaults to the label (plus description).
    displayTitle: { type: String, attribute: 'display-title' },
    favoritesEnabled: { type: Boolean, attribute: 'favorites-enabled' },
    addFavoriteLabel: { type: String },
    removeFavoriteLabel: { type: String },
    favoritesFilterEnabled: { type: Boolean },
    favoritesOnly: { type: Boolean },
    allOptionsLabel: { type: String },
    favoriteOptionsLabel: { type: String },
    emptyFavoritesLabel: { type: String },
    availableFilterEnabled: { type: Boolean },
    availableOnly: { type: Boolean },
    availableOptionsLabel: { type: String },
    panelMinWidth: { type: Number, attribute: 'panel-min-width' },
    worktreeFilterEnabled: { type: Boolean },
    worktreeFilter: { type: String },
    worktreeOptionsLabel: { type: String },
    plainOptionsLabel: { type: String },
    // Reflected: `:host([clearable])` makes room for the clear button.
    clearable: { type: Boolean, reflect: true },
    clearLabel: { type: String },
  };

  static styles = css`
    :host {
      display: inline-block;
      max-width: 100%;
      width: 100%;
      font-family: inherit;
      --cr-searchable-select-height: var(--cr-control-height);
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
      background: var(--cr-field-bg);
      color: var(--cr-text);
      border: 1px solid var(--cr-field-border);
      border-radius: var(--cr-radius-sm, 4px);
      font-size: var(--cr-searchable-select-font-size);
      line-height: 1.2;
      cursor: pointer;
      font-family: inherit;
    }
    .trigger:hover {
      border-color: var(--cr-field-border-hover);
    }
    .trigger:focus {
      outline: none;
      border-color: var(--cr-field-focus-border);
    }
    .label {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      text-align: left;
    }
    .selection { flex: 1; min-width: 0; text-align: left; }
    ::slotted([slot='start']),
    ::slotted([slot='end']) { flex-shrink: 0; }
    .favorite-indicator { color: var(--cr-favorite); flex-shrink: 0; }
    .worktree-indicator { flex-shrink: 0; width: 0.9rem; height: 0.9rem; color: var(--cr-text-muted); }
    .worktree-indicator svg { display: block; width: 100%; height: 100%; }
    .description {
      display: block;
      font-size: 0.75rem;
      line-height: 1.4;
      color: var(--cr-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .wrap {
      position: relative;
      display: block;
      width: 100%;
    }
    :host([clearable]) .trigger {
      padding-right: 2rem;
    }
    .clear {
      position: absolute;
      top: 50%;
      right: 1.6rem;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.2rem;
      height: 1.2rem;
      padding: 0;
      border: 0;
      border-radius: var(--cr-radius-sm, 4px);
      background: transparent;
      color: var(--cr-text-muted);
      font: inherit;
      line-height: 1;
      cursor: pointer;
    }
    .clear:hover,
    .clear:focus-visible {
      color: var(--cr-text);
      background: var(--cr-control-hover-bg, rgba(255, 255, 255, 0.08));
    }
    .clear svg {
      display: block;
      width: 0.8rem;
      height: 0.8rem;
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
    this.displayDescription = '';
    this.displayTitle = '';
    this.favoritesEnabled = false;
    this.addFavoriteLabel = 'Add to favorites';
    this.removeFavoriteLabel = 'Remove from favorites';
    this.favoritesFilterEnabled = false;
    this.favoritesOnly = false;
    this.allOptionsLabel = 'All models';
    this.favoriteOptionsLabel = 'Favorites';
    this.emptyFavoritesLabel = 'No favorites yet';
    this.availableFilterEnabled = false;
    this.availableOnly = false;
    this.worktreeFilter = '';
    this.clearable = false;
    this.clearLabel = '';
    this.availableOptionsLabel = 'Available models';
    this._dropdownApi = null;
    this._triggerEl = null;
    this._panelEl = null;
    this._listEl = null;
    this._searchWrapEl = null;
    this._searchInputEl = null;
    this._searchQuery = '';
    this._lastVariantByGroup = new Map();
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) void this.updateComplete.then(() => this._ensureDropdown());
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
      changedProperties.has('displayLabel') ||
      changedProperties.has('displayDescription') ||
      changedProperties.has('displayTitle') ||
      changedProperties.has('emptyLabel') ||
      changedProperties.has('favoritesEnabled') ||
      changedProperties.has('addFavoriteLabel') ||
      changedProperties.has('removeFavoriteLabel')
      || changedProperties.has('favoritesFilterEnabled') || changedProperties.has('favoritesOnly')
      || changedProperties.has('allOptionsLabel') || changedProperties.has('favoriteOptionsLabel')
      || changedProperties.has('emptyFavoritesLabel') || changedProperties.has('availableFilterEnabled')
      || changedProperties.has('availableOnly') || changedProperties.has('availableOptionsLabel')
    ) {
      this._syncTriggerLabel();
      this._renderPanelItems();
    }
    if (changedProperties.has('disabled') && this._triggerEl) {
      this._triggerEl.disabled = !!this.disabled;
      if (this.disabled) this.closeDropdown();
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
        return { value, label, keywords, group: String(row?.group || ''),
          name: String(row?.name || ''), tag: String(row?.tag || ''), meta: String(row?.meta || ''),
          variantOf: String(row?.variantOf || ''), variantLabel: String(row?.variantLabel || ''),
          variantRank: Number.isFinite(row?.variantRank) ? row.variantRank : 0, isDefault: row?.isDefault === true,
          description: String(row?.description || ''), status: String(row?.status || ''), disabled: row?.disabled === true,
          favorite: row?.favorite === true, worktree: row?.worktree === true, favoriteable: row?.favoriteable !== false };
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
    if (this._triggerEl) {
      this._triggerEl.title = String(this.displayTitle || '').trim()
        || [label, this.displayDescription].filter(Boolean).join(' · ');
    }
  }

  _isSearchEnabled(options = null) {
    const rows = options || this._normalizeOptions();
    const threshold = Number.isFinite(this.searchThreshold) ? Math.max(0, this.searchThreshold) : 10;
    return rows.length >= threshold;
  }

  _syncSearchVisibility() {
    if (!this._searchWrapEl || !this._searchInputEl) return;
    const enabled = this.favoritesFilterEnabled || this.availableFilterEnabled || this.worktreeFilterEnabled || this._isSearchEnabled();
    this._searchWrapEl.hidden = !enabled;
    if (!enabled) {
      this._searchQuery = '';
      this._searchInputEl.value = '';
    }
  }

  _getVisibleOptions() {
    const options = this._normalizeOptions().filter((row) => (
      (!this.favoritesFilterEnabled || !this.favoritesOnly || row.favorite)
      && (!this.availableFilterEnabled || !this.availableOnly || !row.disabled)
      && (!this.worktreeFilterEnabled || !this.worktreeFilter
        || (this.worktreeFilter === 'worktree' ? row.worktree : !row.worktree))
    ));
    const query = String(this._searchQuery || '').trim().toLowerCase();
    if (!query) return options;
    return options.filter((row) => {
      const haystack = [row.label, row.name, row.tag, row.meta, row.value, row.keywords, row.group, row.description, row.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  _renderPanelItems() {
    if (!this._listEl) return;
    this._syncSearchVisibility();
    const filters = [
      { kind: 'all', enabled: this.favoritesFilterEnabled || this.availableFilterEnabled || this.worktreeFilterEnabled,
        active: !this.favoritesOnly && !this.availableOnly && !this.worktreeFilter, label: this.allOptionsLabel },
      { kind: 'worktree', enabled: this.worktreeFilterEnabled, active: this.worktreeFilter === 'worktree', label: this.worktreeOptionsLabel },
      { kind: 'plain', enabled: this.worktreeFilterEnabled, active: this.worktreeFilter === 'plain', label: this.plainOptionsLabel },
      { kind: 'favorites', enabled: this.favoritesFilterEnabled, active: this.favoritesOnly, label: this.favoriteOptionsLabel },
      { kind: 'available', enabled: this.availableFilterEnabled, active: this.availableOnly, label: this.availableOptionsLabel },
    ];
    for (const filter of filters) {
      const button = this._panelEl?.querySelector(`[data-filter="${filter.kind}"]`);
      if (!button) continue;
      button.hidden = !filter.enabled;
      button.setAttribute('aria-pressed', String(filter.active));
      button.setAttribute('aria-label', filter.label);
      button.title = filter.label;
    }
    const selectedValue = String(this.value || '');
    const visible = this._getVisibleOptions();
    if (visible.length === 0) {
      this._listEl.innerHTML =
        '<li class="chat-list-item cr-searchable-select-item-empty" role="presentation">' +
        this._escapeHtml(this.favoritesFilterEnabled && this.favoritesOnly && !this.availableOnly && !this._searchQuery
          ? this.emptyFavoritesLabel : this.emptyLabel || 'No matches') +
        '</li>';
      return;
    }
    const focusAttributes = ['data-favorite-value', 'data-variant-value', 'data-value'];
    const focusedAttribute = this._listEl.contains(document.activeElement)
      ? focusAttributes.find((name) => document.activeElement?.hasAttribute(name)) : null;
    const focusedValue = focusedAttribute ? document.activeElement.getAttribute(focusedAttribute) : null;
    let previousGroup = '';
    this._listEl.innerHTML = this._groupVariants(visible, selectedValue).map(({ row, variants }) => {
      const selected = row.value === selectedValue;
      const escape = (value) => this._escapeHtml(value);
      const groupHeading = row.group && row.group !== previousGroup
        ? `<li class="cr-searchable-select-group" role="presentation">${escape(row.group)}</li>` : '';
      previousGroup = row.group;
      const name = [row.group, row.label, row.status, row.description].filter(Boolean).join(' · ');
      const collapsed = variants.length > 1;
      const tag = this.favoritesEnabled || collapsed ? 'div' : 'li';
      // A collapsed row names its variants in the chips below, so the title skips the tag.
      const titleTag = row.tag && !collapsed ? ` <span class="cr-searchable-select-tag">${escape(row.tag)}</span>` : '';
      const option = `<${tag} class="chat-list-item cr-searchable-select-item${selected ? ' is-active' : ''}"
        role="option" tabindex="-1" data-value="${escape(row.value)}" aria-selected="${selected}"
        aria-disabled="${row.disabled}" aria-label="${escape(name)}">
        <div class="cr-searchable-select-option-text"><span class="chat-list-item-title">${escape(row.name || row.label || row.value)}${titleTag}</span>
        ${row.meta ? `<span class="cr-searchable-select-meta">${escape(row.meta)}</span>` : ''}
        ${row.description ? `<span class="cr-searchable-select-description">${escape(row.description)}</span>` : ''}</div>
        ${row.status ? `<span class="cr-searchable-select-status">${escape(row.status)}</span>` : ''}</${tag}>`;
      // All variants sit in one row of square chips.
      const chips = collapsed ? `<div class="cr-searchable-select-variants" role="group" aria-label="${escape(row.name || row.label)}"
        style="--cr-variant-cols: ${variants.length}">${
        variants.map((variant) => {
          const isSelected = variant.value === selectedValue;
          const isPrimary = variant.value === row.value;
          return `<button type="button" class="cr-searchable-select-variant${isSelected ? ' is-selected' : ''}${
            isPrimary ? ' is-primary' : ''}" data-variant-value="${escape(variant.value)}" aria-pressed="${isSelected}"
            aria-label="${escape(variant.label)}" title="${escape([variant.label, variant.description].filter(Boolean).join(' · '))}"
            ${variant.disabled ? 'disabled' : ''}>${escape(variant.variantLabel || variant.tag || variant.label)}</button>`;
        }).join('')}</div>` : '';
      if (!this.favoritesEnabled && !collapsed) return groupHeading + option;
      // The star acts on the row's primary variant (selected, default or first available).
      const actionLabel = `${row.favorite ? this.removeFavoriteLabel : this.addFavoriteLabel}: ${row.group} · ${row.label}`;
      const star = this.favoritesEnabled && row.favoriteable ? `<button type="button" class="cr-searchable-select-favorite"
        data-favorite-value="${escape(row.value)}" aria-pressed="${row.favorite}" aria-label="${escape(actionLabel)}"
        title="${escape(actionLabel)}"><span aria-hidden="true">${row.favorite ? '★' : '☆'}</span></button>` : '';
      return groupHeading + `<li class="cr-searchable-select-option-row${collapsed ? ' has-variants' : ''}" role="presentation">${option}${star}${chips}</li>`;
    }).join('');
    if (focusedValue !== null) {
      const attribute = focusedAttribute;
      const item = Array.from(this._listEl.querySelectorAll(`[${attribute}]`))
        .find((row) => row.getAttribute(attribute) === focusedValue && row.getAttribute('aria-disabled') !== 'true');
      if (item) item.focus({ preventScroll: true });
      else this._searchInputEl?.focus({ preventScroll: true });
    }
    this._listEl.querySelectorAll('.cr-searchable-select-item[data-value]').forEach((item) => {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextValue = item.getAttribute('data-value') || '';
        this._selectValue(nextValue);
      });
    });
    this._listEl.querySelectorAll('[data-variant-value]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._selectValue(button.getAttribute('data-variant-value') || '');
      });
    });
    this._listEl.querySelectorAll('[data-favorite-value]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.disabled) return;
        this.dispatchEvent(new CustomEvent('cr-favorite-toggle', {
          detail: { value: button.getAttribute('data-favorite-value') }, bubbles: true, composed: true,
        }));
      });
    });
  }

  /**
   * Collapse rows sharing a `variantOf` key into one entry at the first member's
   * position. The primary row is selected, previously used for that model, marked
   * default, or the first enabled variant, in that order; chips keep `variantRank` order.
   *
   * @param {ReturnType<CrSearchableSelect['_normalizeOptions']>} rows
   * @param {string} selectedValue
   */
  _groupVariants(rows, selectedValue) {
    const entries = [];
    const byKey = new Map();
    for (const row of rows) {
      if (!row.variantOf) {
        entries.push({ row, variants: [row] });
        continue;
      }
      const existing = byKey.get(row.variantOf);
      if (existing) {
        existing.variants.push(row);
        continue;
      }
      const entry = { row, variants: [row] };
      byKey.set(row.variantOf, entry);
      entries.push(entry);
    }
    for (const entry of byKey.values()) {
      entry.variants.sort((a, b) => a.variantRank - b.variantRank);
      const selected = entry.variants.find((row) => row.value === selectedValue && !row.disabled);
      if (selected) this._lastVariantByGroup.set(entry.row.variantOf, selected.value);
      const rememberedValue = this._lastVariantByGroup.get(entry.row.variantOf);
      entry.row = selected
        || entry.variants.find((row) => row.value === rememberedValue && !row.disabled)
        || entry.variants.find((row) => row.isDefault && !row.disabled)
        || entry.variants.find((row) => !row.disabled)
        || entry.variants[0];
    }
    return entries;
  }

  _selectValue(nextValue) {
    if (this.disabled) return;
    const normalized = String(nextValue || '');
    const option = this._normalizeOptions().find((row) => row.value === normalized);
    if (!option || option.disabled) return;
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
      if (!this.isDropdownOpen()) return;
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
      '<button type="button" class="cr-searchable-select-filter" data-filter="all" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h3v3H3zm5 0h13v3H8zM3 10h3v3H3zm5 0h13v3H8zM3 16h3v3H3zm5 0h13v3H8z"/></svg></button>' +
      '<button type="button" class="cr-searchable-select-filter" data-filter="favorites" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8l-6.2 3.3L7 14.2 2 9.3l6.9-1z"/></svg></button>' +
      '<button type="button" class="cr-searchable-select-filter" data-filter="worktree" hidden>' + GIT_ICON + '</button>' +
      '<button type="button" class="cr-searchable-select-filter" data-filter="plain" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>' +
      '<button type="button" class="cr-searchable-select-filter" data-filter="available" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8z"/></svg></button>' +
      '</div>' +
      '<ul class="chat-list-items cr-searchable-select-items" role="listbox"></ul>' +
      '</div>';
    document.body.appendChild(this._panelEl);
    this._listEl = this._panelEl.querySelector('.cr-searchable-select-items');
    this._searchWrapEl = this._panelEl.querySelector('.cr-searchable-select-search-wrap');
    this._searchInputEl = this._panelEl.querySelector('.cr-searchable-select-search-input');
    this._panelEl.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.filter === 'all') {
          this.favoritesOnly = false;
          this.availableOnly = false;
          this.worktreeFilter = '';
        } else if (button.dataset.filter === 'worktree' || button.dataset.filter === 'plain') {
          this.worktreeFilter = this.worktreeFilter === button.dataset.filter ? '' : button.dataset.filter;
        } else if (button.dataset.filter === 'favorites') {
          this.favoritesOnly = !this.favoritesOnly;
        } else {
          this.availableOnly = !this.availableOnly;
        }
        this._renderPanelItems();
      });
    });
    if (this._searchInputEl) {
      this._searchInputEl.placeholder = this.searchPlaceholder || 'Search...';
      this._searchInputEl.setAttribute('aria-label', this.searchPlaceholder || 'Search...');
      this._searchInputEl.addEventListener('input', () => {
        this._searchQuery = this._searchInputEl?.value || '';
        this._renderPanelItems();
      });
      this._searchInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          const first = this._getVisibleOptions().find((row) => !row.disabled);
          if (first) this._selectValue(first.value);
          return;
        }
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
      minWidthPx: () => (Number.isFinite(this.panelMinWidth) && this.panelMinWidth > 0 ? this.panelMinWidth : 180),
      maxHeightPx: 320,
      optionSelector: '[role="option"]',
      onOpen: () => {
        this.dispatchEvent(new CustomEvent('cr-open', { bubbles: true, composed: true }));
        this._renderPanelItems();
        this._focusSearchInput();
      },
      onClose: () => {
        this._searchQuery = '';
        if (this._searchInputEl) this._searchInputEl.value = '';
        this._renderPanelItems();
      },
    });
    this._syncTriggerLabel();
    this._renderPanelItems();
  }

  // Lit owns these listeners so reconnecting the host never duplicates them.
  _handleTriggerClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.disabled) this.toggleDropdown();
  }

  _handleClear(event) {
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent('cr-clear', { bubbles: true, composed: true }));
  }

  _handleTriggerKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.disabled) this.toggleDropdown();
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
      <div class="wrap">
      <button
        type="button"
        class="trigger"
        part="control"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label=${this.ariaLabel ? `${this.ariaLabel}: ${this._labelForValue()}` : this._labelForValue()}
        aria-describedby=${this.displayDescription ? 'selection-description' : ''}
        ?disabled=${this.disabled}
        @click=${this._handleTriggerClick}
        @keydown=${this._handleTriggerKeydown}
      >
        <slot name="start"></slot>
        ${this._normalizeOptions().some((row) => row.value === this.value && row.worktree)
          ? html`<span class="worktree-indicator" aria-hidden="true">${unsafeSVG(GIT_ICON)}</span>` : null}
        ${this.favoritesEnabled && this._normalizeOptions().some((row) => row.value === this.value && row.favorite)
          ? html`<span class="favorite-indicator" aria-hidden="true">★</span>` : null}
        <span class="selection"><span class="label">${this._labelForValue()}</span>
          ${this.displayDescription ? html`<span id="selection-description" class="description">${this.displayDescription}</span>` : null}</span>
        <slot name="end"></slot>
        <span class="arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path fill="currentColor" d="M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6-6-6z" />
          </svg>
        </span>
      </button>
      ${this.clearable && !this.disabled ? html`
        <button type="button" class="clear" aria-label=${this.clearLabel || 'Clear'} title=${this.clearLabel || 'Clear'}
          @click=${this._handleClear}>
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>` : null}
      </div>
    `;
  }
}

if (!customElements.get('cr-searchable-select')) {
  customElements.define('cr-searchable-select', CrSearchableSelect);
}

export { CrSearchableSelect };
