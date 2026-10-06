import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import {
  clearSidebarWorkspacePayloadFromHost,
  readSidebarWorkspacePayloadFromHost,
  stashSidebarWorkspacePayloadOnHost,
} from './sidebarWorkspaceMount.js';
import { stashSidebarChatRowPayloadOnHost } from './sidebarChatRowMount.js';
import { t } from '../../i18n/index.js';
import './cr-sidebar-subchat-group.js';
import './cr-sidebar-archive-group.js';
import './cr-sidebar-chat-row.js';

class CrSidebarWorkspace extends LitElement {
  static properties = {
    sidebarKey: { type: String, attribute: 'sidebar-key' },
  };

  constructor() {
    super();
    /** @type {string} */
    this.sidebarKey = '';
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';
  }

  disconnectedCallback() {
    clearSidebarWorkspacePayloadFromHost(this);
    super.disconnectedCallback();
  }

  updated() {
    stashSidebarWorkspacePayloadOnHost(this);
    this.querySelectorAll('cr-sidebar-chat-row').forEach((child) => {
      stashSidebarChatRowPayloadOnHost(child);
      if (typeof child.requestUpdate === 'function') child.requestUpdate();
    });
    this.querySelectorAll('cr-sidebar-subchat-group, cr-sidebar-archive-group').forEach((child) => {
      if (typeof child.requestUpdate === 'function') child.requestUpdate();
    });
  }

  /**
   * @param {import('./sidebarWorkspaceModel.js').SidebarListEntry} entry
   */
  renderListEntry(entry) {
    if (!entry?.key) return nothing;
    if (entry.kind === 'chat' && entry.chatId) {
      return html`<cr-sidebar-chat-row chat-id=${entry.chatId}></cr-sidebar-chat-row>`;
    }
    if (entry.kind === 'subchat-group' && entry.parentId) {
      return html`<cr-sidebar-subchat-group parent-id=${entry.parentId}></cr-sidebar-subchat-group>`;
    }
    if (entry.kind === 'archive' && entry.sidebarKey) {
      return html`<cr-sidebar-archive-group sidebar-key=${entry.sidebarKey}></cr-sidebar-archive-group>`;
    }
    if (entry.kind === 'more' && entry.sidebarKey) {
      const hidden = Number(entry.hiddenCount) || 0;
      if (!hidden) return nothing;
      return html`
        <li
          class="sidebar-chat-more"
          role="button"
          tabindex="0"
          data-sidebar-key=${entry.sidebarKey}
        >
          ${t('sidebar.showMoreChats', { count: String(hidden) })}
        </li>
      `;
    }
    if (entry.kind === 'empty') {
      return html`
        <li class="sidebar-chat-empty">${t('sidebar.noChats')}</li>
      `;
    }
    return nothing;
  }

  render() {
    const sidebarKey = String(this.sidebarKey || '').trim();
    if (!sidebarKey) return nothing;
    const reg = readSidebarWorkspacePayloadFromHost(this);
    if (!reg) return nothing;
    stashSidebarWorkspacePayloadOnHost(this);
    const translate = reg.deps?.t || t;
    const workspace = reg.workspace || {};
    const isCollapsed = reg.isCollapsed === true;
    const listEntries = Array.isArray(reg.listEntries) ? reg.listEntries : [];
    const wsFile = String(workspace.workspaceFile || '');
    const wsName = String(workspace.name || workspace.workspaceFile || '(workspace)');
    return html`
      <li
        class="sidebar-workspace${reg.isActive ? ' is-active' : ''}${workspace.isClone ? ' is-clone' : ''}${isCollapsed ? ' is-collapsed' : ''}"
        data-sidebar-key=${sidebarKey}
        data-workspace-file=${wsFile}
      >
        <div
          class="sidebar-workspace-header"
          role="button"
          tabindex="0"
          aria-expanded="${isCollapsed ? 'false' : 'true'}"
        >
          <span
            class="sidebar-workspace-chevron mdi mdi-chevron-${isCollapsed ? 'right' : 'down'}"
            aria-hidden="true"
          ></span>
          <span class="sidebar-workspace-title">${wsName}</span>
          <span class="sidebar-workspace-count">${reg.count ? String(reg.count) : ''}</span>
          ${reg.autopilotBadgeHtml ? unsafeHTML(reg.autopilotBadgeHtml) : nothing}
          <button
            type="button"
            class="sidebar-workspace-new-btn"
            title=${translate('sidebar.newChat')}
            aria-label=${translate('sidebar.newChat')}
            data-sidebar-key=${sidebarKey}
            data-workspace-file=${wsFile}
          >
            <span class="mdi mdi-plus" aria-hidden="true"></span>
          </button>
        </div>
        <ul class="sidebar-chat-list" role="listbox" ?hidden="${isCollapsed || !reg.serializeList}">
          ${repeat(
            listEntries,
            (entry) => entry.key,
            (entry) => this.renderListEntry(entry),
          )}
        </ul>
      </li>
    `;
  }
}

if (!customElements.get('cr-sidebar-workspace')) {
  customElements.define('cr-sidebar-workspace', CrSidebarWorkspace);
}

export { CrSidebarWorkspace };
