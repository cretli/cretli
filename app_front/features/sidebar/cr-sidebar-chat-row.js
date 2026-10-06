import { LitElement, html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { getSidebarChatRowRegistration } from './sidebarChatRowPass.js';
import {
  clearSidebarChatRowPayloadFromHost,
  readSidebarChatRowPayloadFromHost,
  stashSidebarChatRowPayloadOnHost,
} from './sidebarChatRowMount.js';
import { buildSidebarChatRowHtml } from './sidebarChatRowModel.js';
import { subscribeSidebarChatRowStatusPatch } from './sidebarChatRowRefreshBus.js';
import { patchSidebarChatRowVisualState } from './sidebarChatRowVisualPatch.js';
import { t } from '../../i18n/index.js';

/**
 * Sidebar row deps historically expose `getTerminalStateMeta`; Lit patch path expects
 * `getSidebarChatStateMeta` (same contract as chat.js bus patches).
 *
 * @param {object | null | undefined} deps
 * @returns {((chat: object) => object) | undefined}
 */
function resolveSidebarChatStateMetaGetter(deps) {
  if (!deps || typeof deps !== 'object') return undefined;
  if (typeof deps.getSidebarChatStateMeta === 'function') return deps.getSidebarChatStateMeta;
  if (typeof deps.getTerminalStateMeta === 'function') return deps.getTerminalStateMeta;
  return undefined;
}

class CrSidebarChatRow extends LitElement {
  static properties = {
    chatId: { type: String, attribute: 'chat-id' },
  };

  constructor() {
    super();
    /** @type {string} */
    this.chatId = '';
    /** @type {(() => void) | null} */
    this._statusUnsub = null;
    /** @type {object | null} */
    this._patchCtx = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';
    stashSidebarChatRowPayloadOnHost(this);
    this._statusUnsub = subscribeSidebarChatRowStatusPatch((event) => {
      const id = String(this.chatId || '').trim();
      if (!id) return;
      if (!event.all && !event.dirty.has(id)) return;
      const li = this.getRowElement();
      if (!li) return;
      const getMeta = typeof event.getSidebarChatStateMeta === 'function'
        ? event.getSidebarChatStateMeta
        : resolveSidebarChatStateMetaGetter(this._patchCtx);
      patchSidebarChatRowVisualState(li, event.chatById.get(id) || null, {
        t,
        escapeHtml: this._patchCtx?.escapeHtml,
        getSidebarChatStateMeta: getMeta,
      });
    });
  }

  disconnectedCallback() {
    if (this._statusUnsub) {
      this._statusUnsub();
      this._statusUnsub = null;
    }
    clearSidebarChatRowPayloadFromHost(this);
    super.disconnectedCallback();
  }

  /**
   * @returns {HTMLLIElement | null}
   */
  getRowElement() {
    const li = this.querySelector('li.sidebar-chat-item');
    return li instanceof HTMLLIElement ? li : null;
  }

  /**
   * Status tone/label/visual-key are patched in place after Lit commits structural HTML.
   */
  async applyRowVisualPatchFromRegistration() {
    await this.updateComplete;
    const id = String(this.chatId || '').trim();
    if (!id) return;
    const reg = getSidebarChatRowRegistration(id) || readSidebarChatRowPayloadFromHost(this);
    if (!reg) return;
    const li = this.getRowElement();
    if (!li) return;
    patchSidebarChatRowVisualState(li, reg.chat, {
      t: reg.deps.t,
      escapeHtml: reg.deps.escapeHtml,
      getSidebarChatStateMeta: resolveSidebarChatStateMetaGetter(reg.deps),
    });
  }

  updated() {
    void this.applyRowVisualPatchFromRegistration();
  }

  render() {
    const id = String(this.chatId || '').trim();
    if (!id) return nothing;
    const reg = getSidebarChatRowRegistration(id) || readSidebarChatRowPayloadFromHost(this);
    if (!reg) return nothing;
    stashSidebarChatRowPayloadOnHost(this);
    this._patchCtx = {
      t: reg.deps.t,
      escapeHtml: reg.deps.escapeHtml,
      getSidebarChatStateMeta: resolveSidebarChatStateMetaGetter(reg.deps),
    };
    const rowHtml = buildSidebarChatRowHtml(reg.chat, reg.activeChatId, reg.opts, reg.deps);
    if (!rowHtml) return nothing;
    return html`${unsafeHTML(rowHtml)}`;
  }
}

if (!customElements.get('cr-sidebar-chat-row')) {
  customElements.define('cr-sidebar-chat-row', CrSidebarChatRow);
}

export { CrSidebarChatRow };
