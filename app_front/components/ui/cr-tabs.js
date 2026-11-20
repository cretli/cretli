import { LitElement } from 'lit';

/** Shared accessible tablist primitive. Child buttons remain in light DOM. */
export class CrTabs extends LitElement {
  static properties = {
    storageKey: { attribute: 'storage-key' },
    workspaceKey: { attribute: 'workspace-key' },
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'tablist');
    this.addEventListener('click', this._onClick);
    this.addEventListener('keydown', this._onKeyDown);
    this._restore();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('keydown', this._onKeyDown);
    super.disconnectedCallback();
  }

  updated(changed) {
    // The workspace key is assigned after connectedCallback: re-read the saved
    // tab for the new key, otherwise the initial selection is never restored.
    if (changed?.has('workspaceKey') || changed?.has('storageKey')) this._restore();
    else this._sync(false);
  }

  /**
   * Shows a live counter in a tab label; `hideZero` hides the tab at n=0.
   * @param {string} value data-tab of the tab
   * @param {number} count
   * @param {string} label base label without the counter
   * @param {boolean} [hideZero]
   * @returns {boolean} true when the visible/selected state changed
   */
  setCount(value, count, label, hideZero = true) {
    const tab = [...this.querySelectorAll('[data-tab]')].find((el) => el.dataset.tab === value);
    if (!tab) return false;
    const n = Math.max(0, Number(count) || 0);
    tab.textContent = n ? `${label} (${n})` : label;
    const hidden = hideZero && n === 0;
    const changed = tab.hidden !== hidden;
    tab.hidden = hidden;
    return changed;
  }

  get _tabs() {
    return [...this.querySelectorAll('[role="tab"], button.cr-tab')].filter((tab) => !tab.hidden);
  }

  _key() {
    return `${this.storageKey || 'cretli-tabs'}:${this.workspaceKey || 'default'}`;
  }

  _restore() {
    let selected = '';
    try { selected = localStorage.getItem(this._key()) || ''; } catch { /* Storage is optional. */ }
    const tabs = this._tabs;
    const candidate = tabs.find((tab) => tab.dataset.tab === selected || tab.dataset.todoTab === selected);
    const current = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const target = candidate || current || tabs[0];
    // Emit only when the restored tab differs, so the owner can apply its content.
    this.select(target, target !== current, false);
  }

  restore() { this._restore(); }

  _sync(emit) {
    const tabs = this._tabs;
    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    if (selected) this.select(selected, emit);
  }

  select(tab, emit = true, persist = true) {
    if (!tab || !this._tabs.includes(tab)) return;
    const tabs = this._tabs;
    tabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      item.classList.toggle('active', active);
    });
    const value = tab.dataset.tab || tab.dataset.todoTab || '';
    if (persist) try { localStorage.setItem(this._key(), value); } catch { /* Storage is optional. */ }
    if (emit) this.dispatchEvent(new CustomEvent('cr-tabs-change', {
      bubbles: true, composed: true, detail: { value, tab },
    }));
  }

  _onClick = (event) => {
    const tab = event.target instanceof Element ? event.target.closest('[role="tab"], button.cr-tab') : null;
    if (tab && this._tabs.includes(tab)) this.select(tab);
  };

  _onKeyDown = (event) => {
    const tabs = this._tabs;
    const current = event.target instanceof Element ? event.target.closest('[role="tab"], button.cr-tab') : null;
    const index = tabs.indexOf(current);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    this.select(tabs[next]);
    tabs[next].focus();
  };
}

if (!customElements.get('cr-tabs')) customElements.define('cr-tabs', CrTabs);
