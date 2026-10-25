/**
 * cr-fs-picker — server-side folder/file path picker (Lit, light DOM).
 *
 * Browses the host disk through GET /api/fs/entries and can create a folder
 * with POST /api/fs/mkdir. Used by workspace management (Settings → Workspace,
 * first run, Cursor context dirs) so paths do not have to be typed by hand on
 * a phone.
 *
 * Usage:
 *   const path = await CrFsPicker.pick({ mode: 'folder', title: '…' });
 *   // or the convenience wrapper openFsPicker(...)
 */
import { LitElement, html } from 'lit';
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import './cr-fs-picker.scss';

const FILE_ACCEPT_MODE = 'file';

/**
 * @param {string} pathValue
 * @returns {string} normalized non-empty path
 */
function normalizeStartPath(pathValue) {
  const value = String(pathValue || '').trim();
  return value || '~';
}

/**
 * @param {string} name
 * @param {string|null} accept - e.g. '.code-workspace'
 * @returns {boolean}
 */
function matchesAccept(name, accept) {
  if (!accept) return true;
  return String(name || '').toLowerCase().endsWith(String(accept).toLowerCase());
}

export class CrFsPicker extends LitElement {
  static properties = {
    mode: { type: String },
    heading: { type: String },
    accept: { type: String },
    startPath: { type: String },
    includeHidden: { type: Boolean },
    open: { type: Boolean, reflect: true },
    _path: { state: true },
    _parent: { state: true },
    _home: { state: true },
    _canGoUp: { state: true },
    _entries: { state: true },
    _selected: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _creating: { state: true },
    _newFolderName: { state: true },
    _creatingBusy: { state: true },
  };

  constructor() {
    super();
    this.mode = 'folder';
    this.heading = '';
    this.accept = '';
    this.startPath = '~';
    this.includeHidden = false;
    this.open = false;
    /** @type {((value: string|null) => void)|null} */
    this._resolvePick = null;
    this._path = '';
    this._parent = '';
    this._home = '';
    this._canGoUp = false;
    this._entries = [];
    this._selected = '';
    this._loading = false;
    this._error = '';
    this._creating = false;
    this._newFolderName = '';
    this._creatingBusy = false;
    this._booted = false;
    this._loadGen = 0;
  }

  createRenderRoot() {
    return this;
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
    if (!this.open) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (this._creating) {
      this._cancelCreateFolder();
      return;
    }
    this._cancel();
  };

  updated(changed) {
    if (!changed.has('_creating') || !this._creating) return;
    const input = this.querySelector('.cr-fs-create-input');
    if (input instanceof HTMLInputElement) input.focus();
  }

  /** Opens the picker; resolves with the chosen path or null when cancelled. */
  openPicker() {
    this.open = true;
    if (!this._booted) {
      this._booted = true;
      void this._load(normalizeStartPath(this.startPath));
    }
  }

  _resetCreateFolder() {
    this._creating = false;
    this._newFolderName = '';
    this._creatingBusy = false;
  }

  async _load(pathValue) {
    const gen = ++this._loadGen;
    this._resetCreateFolder();
    this._loading = true;
    this._error = '';
    this._selected = '';
    try {
      const data = await api.getFsEntries(pathValue, this.includeHidden);
      if (gen !== this._loadGen) return;
      if (!data?.ok) {
        this._error = data?.error || t('fsPicker.error');
        return;
      }
      this._path = data.path || normalizeStartPath(pathValue);
      this._parent = data.parent || '';
      this._home = data.home || '';
      this._canGoUp = !!data.canGoUp;
      this._entries = Array.isArray(data.entries) ? data.entries : [];
      if (data.truncated) this._error = t('fsPicker.truncated');
    } catch (err) {
      if (gen !== this._loadGen) return;
      this._error = err?.message || t('fsPicker.error');
    } finally {
      if (gen === this._loadGen) this._loading = false;
    }
  }

  _toggleHidden() {
    this.includeHidden = !this.includeHidden;
    if (this._path) void this._load(this._path);
  }

  _onRowClick(entry) {
    if (!entry) return;
    if (entry.isDir) {
      void this._load(entry.path);
      return;
    }
    if (this.mode === FILE_ACCEPT_MODE && !matchesAccept(entry.name, this.accept)) return;
    this._selected = this._selected === entry.path ? '' : entry.path;
  }

  _goUp() {
    if (this._canGoUp && this._parent) void this._load(this._parent);
  }

  _goHome() {
    if (this._home) void this._load(this._home);
  }

  _startCreateFolder() {
    if (this._loading || this._creatingBusy) return;
    if (this._creating) {
      this._resetCreateFolder();
      return;
    }
    this._creating = true;
    this._newFolderName = '';
  }

  _cancelCreateFolder() {
    if (this._creatingBusy) return;
    this._resetCreateFolder();
  }

  _onCreateInput(e) {
    this._newFolderName = e.target?.value ?? '';
  }

  _onCreateKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void this._submitCreateFolder();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._cancelCreateFolder();
    }
  }

  async _submitCreateFolder() {
    const name = String(this._newFolderName || '').trim();
    if (!name || this._creatingBusy || !this._path) return;
    this._creatingBusy = true;
    this._error = '';
    try {
      const data = await api.createFsFolder(this._path, name);
      if (!data?.ok) {
        this._error = data?.error || t('fsPicker.createError');
        return;
      }
      this._resetCreateFolder();
      await this._load(data.path || this._path);
    } catch (err) {
      this._error = err?.message || t('fsPicker.createError');
    } finally {
      this._creatingBusy = false;
    }
  }

  _confirm() {
    if (this.mode === FILE_ACCEPT_MODE) {
      if (!this._selected) return;
      this._finish(this._selected);
      return;
    }
    this._finish(this._path || null);
  }

  _finish(value) {
    const resolve = this._resolvePick;
    this._resolvePick = null;
    this.open = false;
    this.remove();
    if (typeof resolve === 'function') resolve(value);
  }

  _cancel() {
    this._finish(null);
  }

  _onBackdropClick(e) {
    if (e.target === e.currentTarget) this._cancel();
  }

  _renderPathRow() {
    return html`
      <div class="cr-fs-location">
        <button
          type="button"
          class="cr-fs-nav-btn"
          title=${t('fsPicker.home')}
          aria-label=${t('fsPicker.home')}
          @click=${this._goHome}
        >
          <span class="mdi mdi-home" aria-hidden="true"></span>
        </button>
        ${this._canGoUp ? html`
          <button
            type="button"
            class="cr-fs-nav-btn"
            title=${t('fsPicker.up')}
            aria-label=${t('fsPicker.up')}
            @click=${this._goUp}
          >
            <span class="mdi mdi-arrow-up" aria-hidden="true"></span>
          </button>
        ` : null}
        <span class="cr-fs-path" title=${this._path}>${this._path || t('fsPicker.loading')}</span>
        <button
          type="button"
          class="cr-fs-nav-btn"
          ?data-active=${this._creating}
          ?disabled=${this._loading || this._creatingBusy}
          title=${t('fsPicker.newFolder')}
          aria-label=${t('fsPicker.newFolder')}
          @click=${this._startCreateFolder}
        >
          <span class="mdi mdi-folder-plus-outline" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="cr-fs-nav-btn cr-fs-hidden-btn"
          ?data-active=${this.includeHidden}
          @click=${this._toggleHidden}
          title=${this.includeHidden ? t('fsPicker.hideHidden') : t('fsPicker.showHidden')}
          aria-pressed=${this.includeHidden}
        >
          <span class="mdi mdi-dots-horizontal" aria-hidden="true"></span>
        </button>
      </div>
    `;
  }

  _renderCreateRow() {
    if (!this._creating) return null;
    const canSubmit = !!String(this._newFolderName || '').trim() && !this._creatingBusy;
    return html`
      <div class="cr-fs-create-row">
        <span class="mdi mdi-folder-plus-outline" aria-hidden="true"></span>
        <input
          class="cr-fs-create-input"
          type="text"
          .value=${this._newFolderName}
          placeholder=${t('fsPicker.newFolderPlaceholder')}
          aria-label=${t('fsPicker.newFolder')}
          maxlength="255"
          autocomplete="off"
          ?disabled=${this._creatingBusy}
          @input=${this._onCreateInput}
          @keydown=${this._onCreateKeyDown}
        />
        <button
          type="button"
          class="cr-fs-nav-btn"
          ?disabled=${!canSubmit}
          title=${t('fsPicker.createFolder')}
          aria-label=${t('fsPicker.createFolder')}
          @click=${this._submitCreateFolder}
        >
          <span class="mdi mdi-check" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="cr-fs-nav-btn"
          ?disabled=${this._creatingBusy}
          title=${t('fsPicker.cancel')}
          aria-label=${t('fsPicker.cancel')}
          @click=${this._cancelCreateFolder}
        >
          <span class="mdi mdi-close" aria-hidden="true"></span>
        </button>
      </div>
    `;
  }

  _renderRow(entry) {
    const selectable = entry.isDir || this.mode !== FILE_ACCEPT_MODE || matchesAccept(entry.name, this.accept);
    const selected = this.mode === FILE_ACCEPT_MODE && !entry.isDir && this._selected === entry.path;
    return html`
      <button
        type="button"
        class="cr-fs-row"
        ?data-selected=${selected}
        ?data-unselectable=${!selectable}
        @click=${() => this._onRowClick(entry)}
      >
        <span class="mdi ${entry.isDir ? 'mdi-folder' : 'mdi-file-outline'}" aria-hidden="true"></span>
        <span class="cr-fs-row-name">${entry.name}</span>
        ${entry.isDir ? html`<span class="cr-fs-row-chevron mdi mdi-chevron-right" aria-hidden="true"></span>` : ''}
      </button>
    `;
  }

  render() {
    if (!this.open) return html``;
    const message = this._error
      ? html`<div class="cr-fs-error">${this._error}</div>`
      : null;
    const list = html`
      ${this._loading ? html`<div class="cr-fs-hint">${t('fsPicker.loading')}</div>` : ''}
      ${!this._loading && !this._creating && this._entries.length === 0 ? html`<div class="cr-fs-hint">${t('fsPicker.empty')}</div>` : ''}
      ${this._entries.map((entry) => this._renderRow(entry))}
    `;
    const chooseLabel = this.mode === FILE_ACCEPT_MODE ? t('fsPicker.chooseFile') : t('fsPicker.useFolder');
    const canConfirm = this.mode !== FILE_ACCEPT_MODE || !!this._selected;
    return html`
      <div class="cr-fs-backdrop" @click=${this._onBackdropClick}>
        <div class="cr-fs-panel" role="dialog" aria-modal="true">
          <div class="cr-fs-heading">
            <span class="mdi mdi-folder-search-outline" aria-hidden="true"></span>
            <strong>${this.heading || t('fsPicker.title')}</strong>
            <button type="button" class="cr-fs-nav-btn" title=${t('fsPicker.cancel')} aria-label=${t('fsPicker.cancel')} @click=${this._cancel}>
              <span class="mdi mdi-close" aria-hidden="true"></span>
            </button>
          </div>
          ${this._renderPathRow()}
          ${message}
          <div class="cr-fs-list">
            ${this._canGoUp ? html`
              <button type="button" class="cr-fs-row" @click=${this._goUp}>
                <span class="mdi mdi-arrow-up" aria-hidden="true"></span>
                <span class="cr-fs-row-name">..</span>
              </button>
            ` : ''}
            ${this._renderCreateRow()}
            ${list}
          </div>
          <div class="cr-fs-actions">
            <button type="button" class="cr-fs-btn" @click=${this._cancel}>${t('fsPicker.cancel')}</button>
            <button
              type="button"
              class="cr-fs-btn cr-fs-btn-primary"
              ?disabled=${!canConfirm}
              @click=${this._confirm}
            >${chooseLabel}</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Shows the picker and resolves with the selected path (string) or null.
   *
   * @param {{ mode?: 'folder'|'file', title?: string, accept?: string|null, startPath?: string }} [options]
   * @returns {Promise<string|null>}
   */
  static pick(options = {}) {
    return new Promise((resolve) => {
      const el = document.createElement('cr-fs-picker');
      el.mode = options.mode === FILE_ACCEPT_MODE ? FILE_ACCEPT_MODE : 'folder';
      el.heading = String(options.title || '').trim();
      el.accept = options.accept ? String(options.accept).trim() : '';
      el.startPath = normalizeStartPath(options.startPath);
      el._resolvePick = resolve;
      document.body.appendChild(el);
      el.openPicker();
    });
  }
}

if (!customElements.get('cr-fs-picker')) {
  customElements.define('cr-fs-picker', CrFsPicker);
}

/**
 * Convenience wrapper around CrFsPicker.pick().
 *
 * @param {{ mode?: 'folder'|'file', title?: string, accept?: string|null, startPath?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function openFsPicker(options = {}) {
  return CrFsPicker.pick(options);
}
