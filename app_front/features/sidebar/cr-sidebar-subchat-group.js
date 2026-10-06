import { LitElement, html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderSubchatGroupHtml } from './sidebarSubchatGroups.js';
import {
  getSidebarSubchatGroupRegistration,
} from './sidebarSubchatGroupPass.js';

/** @type {WeakMap<Element, import('./sidebarSubchatGroupPass.js').SidebarSubchatGroupRegistration>} */
const hostPayload = new WeakMap();

/**
 * @param {Element} host
 * @returns {import('./sidebarSubchatGroupPass.js').SidebarSubchatGroupRegistration | null}
 */
function readPayload(host) {
  const parentId = String(host.getAttribute?.('parent-id') || '').trim();
  if (parentId) {
    const reg = getSidebarSubchatGroupRegistration(parentId);
    if (reg) return reg;
  }
  return hostPayload.get(host) || null;
}

class CrSidebarSubchatGroup extends LitElement {
  static properties = {
    parentId: { type: String, attribute: 'parent-id' },
  };

  constructor() {
    super();
    /** @type {string} */
    this.parentId = '';
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';
  }

  disconnectedCallback() {
    hostPayload.delete(this);
    super.disconnectedCallback();
  }

  render() {
    const id = String(this.parentId || '').trim();
    if (!id) return nothing;
    const reg = readPayload(this);
    if (!reg?.group) return nothing;
    hostPayload.set(this, reg);
    const rowHtml = renderSubchatGroupHtml(reg.group, {
      sidebarKey: reg.sidebarKey,
      lang: reg.deps?.lang,
      translate: reg.deps?.t,
      escapeHtml: reg.deps?.escapeHtml,
      canArchive: reg.deps?.canArchive,
      canPin: reg.deps?.canPin,
      parentTitle: reg.parentTitle,
      continuationLevels: reg.continuationLevels,
    });
    if (!rowHtml) return nothing;
    return html`${unsafeHTML(rowHtml)}`;
  }
}

if (!customElements.get('cr-sidebar-subchat-group')) {
  customElements.define('cr-sidebar-subchat-group', CrSidebarSubchatGroup);
}

export { CrSidebarSubchatGroup };
