import { LitElement, html, nothing } from 'lit';
import { formatSubchatCount, formatSubchatSummary } from './sidebarSubchatGroups.js';
import { MAX_SIDEBAR_NEST_INDENT } from './sidebarChatDragBlock.js';
import {
  getSidebarSubchatGroupRegistration,
} from './sidebarSubchatGroupPass.js';

// The registry types `group` and `deps` as bare objects; narrow them to what the renderer takes.
type Registration = {
  group: any;
  sidebarKey: string;
  parentTitle: string;
  continuationLevels: number[];
  deps?: {
    lang?: string;
    t?: (key: string, vars?: Record<string, string | number>) => string;
    escapeHtml?: (value: unknown) => string;
    canArchive?: boolean;
    canPin?: boolean;
  };
};

const hostPayload = new WeakMap<Element, Registration>();

function readPayload(host: Element): Registration | null {
  const parentId = String(host.getAttribute?.('parent-id') || '').trim();
  if (parentId) {
    const reg = getSidebarSubchatGroupRegistration(parentId);
    if (reg) return reg as unknown as Registration;
  }
  return hostPayload.get(host) || null;
}

class CrSidebarSubchatGroup extends LitElement {
  static properties = {
    parentId: { type: String, attribute: 'parent-id' },
  };

  declare parentId: string;

  constructor() {
    super();
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
    const group = reg.group;
    const expanded = group.expanded === true;
    const count = Number(group.summary?.total) || group.childIds?.length || 0;
    const summary = formatSubchatSummary(group.summary);
    const countLabel = formatSubchatCount(count, reg.deps?.lang || 'en', reg.deps?.t || ((key) => key));
    const labelledCount = reg.parentTitle
      ? (reg.deps?.t || ((key) => key))('sidebar.subchatGroupLabel', { label: countLabel, parent: reg.parentTitle })
      : countLabel;
    const label = expanded
      ? (reg.deps?.t || ((key) => key))('sidebar.collapseGroup', { label: labelledCount })
      : (reg.deps?.t || ((key) => key))('sidebar.expandGroup', { label: labelledCount });
    const translate = reg.deps?.t || ((key: string) => key);
    const summaryTitle = summary ? translate('sidebar.subchatSummary', { summary }) : '';
    const canArchive = reg.deps?.canArchive === true && (group.allChildIds?.length || 0) > 0;
    const level = Math.min(MAX_SIDEBAR_NEST_INDENT, Math.max(1, Number(group.level) || 1));
    return html`
      <li class="sidebar-subchat-group${reg.deps?.canPin === true ? ' has-pin-actions' : ''}${expanded ? ' is-expanded' : ''}${group.isLastChild === true ? ' is-last-child' : ''}"
        data-sidebar-key=${reg.sidebarKey} data-subchat-group="1" data-parent-id=${group.parentId}
        data-group-summary=${summary} style="--sidebar-nest-level:${level}">
        ${reg.continuationLevels.map((item) => html`<span class="sidebar-tree-continuation" aria-hidden="true" style=${`--sidebar-continuation-level:${Math.min(MAX_SIDEBAR_NEST_INDENT, Math.max(1, Number(item) || 1))}`}></span>`)}
        <div class="sidebar-subchat-group-header">
          <button type="button" class="sidebar-subchat-group-toggle" aria-expanded=${expanded ? 'true' : 'false'}
            aria-label=${label} aria-description=${summaryTitle || nothing} title=${label} data-parent-id=${group.parentId}>
            <span class="sidebar-subchat-group-chevron mdi mdi-chevron-${expanded ? 'down' : 'right'}" aria-hidden="true"></span>
            <span class="mdi mdi-check-circle-outline sidebar-subchat-group-icon" aria-hidden="true"></span>
            <span class="sidebar-subchat-group-title">${(reg.deps?.t || ((key) => key))('sidebar.settledSubchats')}</span>
          </button>
          <span class="sidebar-subchat-group-count" aria-hidden="true">${count}</span>
          ${summary ? html`<span class="sidebar-subchat-group-summary" aria-hidden="true" title=${summaryTitle}>${summary}</span>` : nothing}
          <span class="sidebar-subchat-group-pin-spacer" aria-hidden="true"></span>
          ${canArchive ? html`<button type="button" class="sidebar-chat-action sidebar-subchat-group-archive"
            title=${(reg.deps?.t || ((key) => key))('sidebar.archiveSettled')}
            aria-label=${(reg.deps?.t || ((key) => key))('sidebar.archiveSettled')} data-parent-id=${group.parentId}>
            <span class="mdi mdi-archive-arrow-down-outline" aria-hidden="true"></span>
          </button>` : nothing}
          <span class="sidebar-subchat-group-favorite-spacer" aria-hidden="true"></span>
        </div>
      </li>`;
  }
}

if (!customElements.get('cr-sidebar-subchat-group')) {
  customElements.define('cr-sidebar-subchat-group', CrSidebarSubchatGroup);
}

export { CrSidebarSubchatGroup };
