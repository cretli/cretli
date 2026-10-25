import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { getSidebarArchiveGroupRegistration } from './sidebarArchiveGroupPass.js';
import { stashSidebarChatRowPayloadOnHost } from './sidebarChatRowMount.js';
import {
  applyArchiveScrollAnchor,
  buildArchiveRowIndexById,
  computeArchiveListScrollTopForAnchor,
  computeSidebarArchiveMountedRowLimit,
  selectArchiveVisibleWindow,
  shouldArchiveScrollAnchorCompensate,
  SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX,
  SIDEBAR_ARCHIVE_OVERSCAN_ROWS,
} from './sidebarArchiveVirtualizer.js';
import {
  getSidebarArchiveVirtualWindow,
  setSidebarArchiveVirtualWindow,
} from './sidebarArchiveVirtualState.js';
import { registerArchiveChatRowSliceDirect } from './sidebarArchiveChatRows.js';
import {
  getSidebarArchiveVirtualFocus,
  isSidebarArchiveGestureActive,
  reconcileArchiveFocusAfterWindowChange,
  setSidebarArchiveVirtualFocus,
  shouldRestoreArchiveFocusAfterGesture,
} from './sidebarArchiveVirtualFocus.js';
import { resolveArchiveStoredLogicalIndex } from './sidebarArchiveVirtualNavigation.js';
import { t } from '../../i18n/index.js';
import './cr-sidebar-chat-row.js';

/** @type {WeakMap<Element, import('./sidebarArchiveGroupPass.js').SidebarArchiveGroupRegistration>} */
const hostPayload = new WeakMap();

/**
 * @param {Element} host
 * @returns {import('./sidebarArchiveGroupPass.js').SidebarArchiveGroupRegistration | null}
 */
function readPayload(host) {
  const sidebarKey = String(host.getAttribute?.('sidebar-key') || '').trim();
  if (sidebarKey) {
    const reg = getSidebarArchiveGroupRegistration(sidebarKey);
    if (reg) return reg;
  }
  return hostPayload.get(host) || null;
}

/**
 * @param {Element} listEl
 * @returns {Element | null}
 */
function resolveArchiveScrollContainer(listEl) {
  if (!listEl) return null;
  const body = listEl.closest('.sidebar-body');
  return body || listEl;
}

/**
 * @param {Element} listEl
 * @param {Element} scrollContainer
 * @returns {{ scrollTopPx: number, viewportHeightPx: number }}
 */
/**
 * @param {Element} el
 * @param {Element} ancestor
 * @returns {number}
 */
function offsetTopWithin(el, ancestor) {
  let y = 0;
  let node = el;
  while (node && node !== ancestor) {
    y += node.offsetTop;
    const parent = node.offsetParent;
    if (!(parent instanceof Element) || !ancestor.contains(parent)) break;
    node = parent;
  }
  return y;
}

function readArchiveScrollMetrics(listEl, scrollContainer) {
  if (!listEl || !scrollContainer) {
    return { scrollTopPx: 0, viewportHeightPx: 400 };
  }
  const viewportHeightPx = Math.max(1, scrollContainer.clientHeight);
  const listTop = offsetTopWithin(listEl, scrollContainer);
  const scrollTopPx = Math.max(0, scrollContainer.scrollTop - listTop);
  return { scrollTopPx, viewportHeightPx };
}

class CrSidebarArchiveGroup extends LitElement {
  static properties = {
    sidebarKey: { type: String, attribute: 'sidebar-key' },
    /** @internal */
    _windowStart: { type: Number, state: true },
    /** @internal */
    _windowEnd: { type: Number, state: true },
    /** @internal */
    _topSpacerPx: { type: Number, state: true },
    /** @internal */
    _bottomSpacerPx: { type: Number, state: true },
  };

  constructor() {
    super();
    /** @type {string} */
    this.sidebarKey = '';
    this._windowStart = 0;
    this._windowEnd = 0;
    this._topSpacerPx = 0;
    this._bottomSpacerPx = 0;
    /** @type {(() => void) | null} */
    this._onScroll = null;
    /** @type {Element | null} */
    this._scrollContainer = null;
    /** @type {number[]} */
    this._rowHeightsPx = [];
    /** @type {number} */
    this._previousTopSpacerPx = 0;
    /** @type {number} */
    this._previousStartIndex = 0;
    /** @type {boolean} */
    this._scrollListenerAttached = false;
    /** @type {boolean} */
    this._ignoringScroll = false;
    /** @type {boolean} */
    this._skipNextScrollSync = false;
    /** @type {number} */
    this._suppressScrollSyncUntilMs = 0;
    /** @type {ResizeObserver | null} */
    this._resizeObserver = null;
    /** @type {number} */
    this._lastArchiveTreeLength = 0;
  }

  createRenderRoot() {
    return this;
  }

  /**
   * @returns {string}
   */
  _resolveSidebarKey() {
    return String(this.sidebarKey || this.getAttribute('sidebar-key') || '').trim();
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';
  }

  disconnectedCallback() {
    this._detachScrollListener();
    this._detachResizeObserver();
    hostPayload.delete(this);
    super.disconnectedCallback();
  }

  _detachScrollListener() {
    if (this._scrollContainer && this._onScroll) {
      this._scrollContainer.removeEventListener('scroll', this._onScroll, { passive: true });
    }
    this._scrollListenerAttached = false;
    this._scrollContainer = null;
    this._onScroll = null;
  }

  _detachResizeObserver() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  _ensureScrollListener() {
    const listEl = this.querySelector('.sidebar-archive-list');
    const container = resolveArchiveScrollContainer(listEl);
    if (!listEl || !container) return;
    if (this._scrollListenerAttached && this._scrollContainer === container) return;
    this._detachScrollListener();
    this._detachResizeObserver();
    this._scrollContainer = container;
    this._onScroll = () => {
      if (this._ignoringScroll) return;
      if (this._skipNextScrollSync) {
        this._skipNextScrollSync = false;
        return;
      }
      if (typeof performance !== 'undefined' && performance.now() < this._suppressScrollSyncUntilMs) {
        return;
      }
      if (isSidebarArchiveGestureActive()) return;
      this._syncVirtualWindow(false, { fromUserScroll: true });
    };
    container.addEventListener('scroll', this._onScroll, { passive: true });
    this._scrollListenerAttached = true;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (isSidebarArchiveGestureActive()) return;
        this._syncVirtualWindow(false);
      });
      this._resizeObserver.observe(container);
    }
  }

  /**
   * Scroll the archive list so `logicalIndex` is inside the mounted window and optionally focus it.
   *
   * @param {number} logicalIndex
   * @param {{ focus?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async revealLogicalIndex(logicalIndex, options = {}) {
    const sidebarKey = this._resolveSidebarKey();
    const reg = readPayload(this);
    if (!sidebarKey || !reg || reg.openSection !== true) return false;
    const rows = Array.isArray(reg.archiveTree) ? reg.archiveTree : [];
    const total = rows.length;
    if (!total) return false;
    const index = Math.max(0, Math.min(Math.round(Number(logicalIndex) || 0), total - 1));
    const chatId = String(rows[index]?.chat?.id || '').trim();
    setSidebarArchiveVirtualFocus(sidebarKey, { chatId, logicalIndex: index });
    const listEl = this.querySelector('.sidebar-archive-list');
    const container = resolveArchiveScrollContainer(listEl);
    if (!listEl || !container) return false;
    this._measureMountedRowHeights(rows, buildArchiveRowIndexById(rows));
    const viewportHeightPx = Math.max(1, container.clientHeight || 400);
    const scrollTopPx = computeArchiveListScrollTopForAnchor(
      total,
      index,
      viewportHeightPx,
      this._rowHeightsPx,
    );
    const listTop = offsetTopWithin(listEl, container);
    this._skipNextScrollSync = true;
    this._suppressScrollSyncUntilMs = typeof performance !== 'undefined'
      ? performance.now() + 120
      : 0;
    this._ignoringScroll = true;
    try {
      container.scrollTop = Math.max(0, listTop + scrollTopPx);
      this._syncVirtualWindow(false, { anchorIndex: index });
      await this.updateComplete;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } finally {
      this._ignoringScroll = false;
    }
    if (options.focus !== false && chatId) {
      this._focusArchiveChatId(chatId);
    }
    return true;
  }

  /**
   * @param {string} chatId
   */
  _focusArchiveChatId(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return;
    const host = this.querySelector(`cr-sidebar-chat-row[chat-id="${id}"]`);
    const li = host?.querySelector?.('.sidebar-chat-item');
    if (!(li instanceof HTMLElement)) return;
    const list = li.closest('.sidebar-archive-list');
    list?.querySelectorAll('.sidebar-chat-item').forEach((el) => el.setAttribute('tabindex', '-1'));
    li.setAttribute('tabindex', '0');
    try {
      li.focus({ preventScroll: true });
    } catch (_) {
      li.focus?.();
    }
  }

  /**
   * @param {boolean} forceDefault
   * @param {{ fromUserScroll?: boolean, anchorIndex?: number }} [syncOptions]
   */
  _syncVirtualWindow(forceDefault, syncOptions = {}) {
    const sidebarKey = this._resolveSidebarKey();
    const reg = readPayload(this);
    if (!sidebarKey || !reg || reg.openSection !== true) return;
    const rows = Array.isArray(reg.archiveTree) ? reg.archiveTree : [];
    const total = rows.length;
    if (!total) return;
    const listEl = this.querySelector('.sidebar-archive-list');
    const container = resolveArchiveScrollContainer(listEl);
    if (!listEl || !container) return;
    const indexById = buildArchiveRowIndexById(rows);
    this._measureMountedRowHeights(rows, indexById);
    const viewportHeightPx = Math.max(1, container.clientHeight || 400);
    let scrollTopPx = forceDefault
      ? 0
      : readArchiveScrollMetrics(listEl, container).scrollTopPx;
    const maxMounted = computeSidebarArchiveMountedRowLimit(viewportHeightPx);
    const explicitAnchor = Number.isFinite(Number(syncOptions.anchorIndex))
      ? Math.round(Number(syncOptions.anchorIndex))
      : -1;
    let anchorIndex = explicitAnchor;
    const activeId = String(reg.activeChatId || '').trim();
    if (anchorIndex < 0 && forceDefault && activeId) {
      const activeIndex = indexById.get(activeId);
      anchorIndex = activeIndex === undefined ? -1 : activeIndex;
    }
    const useAnchor = (forceDefault && anchorIndex >= 0) || explicitAnchor >= 0;
    if (useAnchor) {
      scrollTopPx = computeArchiveListScrollTopForAnchor(
        total,
        anchorIndex,
        viewportHeightPx,
        this._rowHeightsPx,
      );
    }
    const nextWindow = selectArchiveVisibleWindow(
      total,
      scrollTopPx,
      viewportHeightPx,
      this._rowHeightsPx,
      {
        overscanRows: SIDEBAR_ARCHIVE_OVERSCAN_ROWS,
        maxMounted,
        anchorIndex: useAnchor ? anchorIndex : -1,
      },
    );
    reconcileArchiveFocusAfterWindowChange({
      sidebarKey,
      archiveTree: rows,
      startIndex: nextWindow.startIndex,
      endIndex: nextWindow.endIndex,
      fromUserScroll: syncOptions.fromUserScroll === true,
      listEl,
    });
    let anchoredScroll = scrollTopPx;
    if (
      !forceDefault
      && shouldArchiveScrollAnchorCompensate(
        this._previousStartIndex,
        nextWindow.startIndex,
        this._previousTopSpacerPx,
        nextWindow.topSpacerPx,
      )
    ) {
      anchoredScroll = applyArchiveScrollAnchor(
        this._previousTopSpacerPx,
        nextWindow.topSpacerPx,
        scrollTopPx,
      );
    }
    this._previousTopSpacerPx = nextWindow.topSpacerPx;
    this._previousStartIndex = nextWindow.startIndex;
    if (useAnchor) {
      const listTop = offsetTopWithin(listEl, container);
      this._skipNextScrollSync = true;
      this._ignoringScroll = true;
      container.scrollTop = Math.max(0, listTop + scrollTopPx);
      this._ignoringScroll = false;
    } else if (!forceDefault && anchoredScroll !== scrollTopPx) {
      this._skipNextScrollSync = true;
      this._ignoringScroll = true;
      container.scrollTop = Math.max(0, container.scrollTop + (anchoredScroll - scrollTopPx));
      this._ignoringScroll = false;
    }
    setSidebarArchiveVirtualWindow(sidebarKey, {
      startIndex: nextWindow.startIndex,
      endIndex: nextWindow.endIndex,
      topSpacerPx: nextWindow.topSpacerPx,
      bottomSpacerPx: nextWindow.bottomSpacerPx,
      scrollTopPx: anchoredScroll,
    });
    registerArchiveChatRowSliceDirect(
      rows,
      nextWindow.startIndex,
      nextWindow.endIndex,
      activeId,
      reg.deps || { t },
    );
    this._windowStart = nextWindow.startIndex;
    this._windowEnd = nextWindow.endIndex;
    this._topSpacerPx = nextWindow.topSpacerPx;
    this._bottomSpacerPx = nextWindow.bottomSpacerPx;
  }

  /**
   * @param {Array<{ chat?: { id?: string } }>} rows
   * @param {Map<string, number>} [indexById] built once per sync by the caller;
   *   avoids one `rows.findIndex` per mounted host (was O(n · mountedRows)).
   */
  _measureMountedRowHeights(rows, indexById) {
    const total = rows.length;
    if (!this._rowHeightsPx.length) {
      this._rowHeightsPx = Array.from({ length: total }, () => SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX);
    } else if (this._rowHeightsPx.length < total) {
      const pad = Array.from(
        { length: total - this._rowHeightsPx.length },
        () => SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX,
      );
      this._rowHeightsPx = this._rowHeightsPx.concat(pad);
    }
    const lookup = indexById || buildArchiveRowIndexById(rows);
    const hosts = this.querySelectorAll('cr-sidebar-chat-row');
    hosts.forEach((host) => {
      const chatId = String(host.getAttribute('chat-id') || '').trim();
      if (!chatId) return;
      const index = lookup.get(chatId);
      if (index === undefined || index < 0) return;
      const li = host.querySelector('.sidebar-chat-item');
      const measured = li ? Math.round(li.getBoundingClientRect().height) : 0;
      if (measured > 0) this._rowHeightsPx[index] = measured;
    });
  }

  updated(changed) {
    this.querySelectorAll('cr-sidebar-chat-row').forEach((rowHost) => {
      stashSidebarChatRowPayloadOnHost(rowHost);
      if (typeof rowHost.requestUpdate === 'function') rowHost.requestUpdate();
    });
    if (changed.has('sidebarKey') || changed.has('_windowEnd')) {
      this._ensureScrollListener();
    }
    const reg = readPayload(this);
    const rowCount = reg?.openSection === true && Array.isArray(reg.archiveTree) ? reg.archiveTree.length : 0;
    if (rowCount !== this._lastArchiveTreeLength) {
      this._lastArchiveTreeLength = rowCount;
      if (rowCount > 0) {
        requestAnimationFrame(() => this._syncVirtualWindow(true));
      }
    }
  }

  firstUpdated() {
    const sidebarKey = this._resolveSidebarKey();
    const reg = readPayload(this);
    if (!sidebarKey || !reg || reg.openSection !== true) return;
    const stored = getSidebarArchiveVirtualWindow(sidebarKey);
    const rows = Array.isArray(reg.archiveTree) ? reg.archiveTree : [];
    const listEl = this.querySelector('.sidebar-archive-list');
    const container = resolveArchiveScrollContainer(listEl);
    const viewportHeightPx = Math.max(1, container?.clientHeight || 400);
    const maxMounted = computeSidebarArchiveMountedRowLimit(viewportHeightPx);
    if (stored && stored.endIndex > stored.startIndex && stored.endIndex <= rows.length) {
      const span = stored.endIndex - stored.startIndex;
      if (span > maxMounted) {
        if (container instanceof HTMLElement && listEl) {
          const listTop = offsetTopWithin(listEl, container);
          container.scrollTop = Math.max(0, listTop + (stored.scrollTopPx || 0));
        }
        this._syncVirtualWindow(false);
      } else {
        this._windowStart = stored.startIndex;
        this._windowEnd = stored.endIndex;
        this._topSpacerPx = stored.topSpacerPx;
        this._bottomSpacerPx = stored.bottomSpacerPx;
        this._previousTopSpacerPx = stored.topSpacerPx;
        this._previousStartIndex = stored.startIndex;
      }
    } else {
      this._syncVirtualWindow(true);
    }
    this._ensureScrollListener();
  }

  render() {
    const sidebarKey = this._resolveSidebarKey();
    if (!sidebarKey) return nothing;
    const reg = readPayload(this);
    if (!reg) return nothing;
    hostPayload.set(this, reg);
    const translate = reg.deps?.t || t;
    const openSection = reg.openSection === true;
    const count = Number(reg.count) || 0;
    if (!count) return nothing;
    const rows = openSection && Array.isArray(reg.archiveTree) ? reg.archiveTree : [];
    let start = Math.max(0, Math.min(this._windowStart, rows.length));
    let end = Math.max(start, Math.min(this._windowEnd, rows.length));
    let topSpacer = openSection ? Math.max(0, Math.round(this._topSpacerPx)) : 0;
    let bottomSpacer = openSection ? Math.max(0, Math.round(this._bottomSpacerPx)) : 0;
    if (openSection && rows.length > 0 && end <= start) {
      const maxMounted = computeSidebarArchiveMountedRowLimit(
        this._scrollContainer?.clientHeight || 400,
      );
      const fallback = selectArchiveVisibleWindow(rows.length, 0, 400, null, { maxMounted });
      start = fallback.startIndex;
      end = fallback.endIndex;
      topSpacer = fallback.topSpacerPx;
      bottomSpacer = fallback.bottomSpacerPx;
    }
    const slice = rows.slice(start, end);
    return html`
      <li class="sidebar-archive-group" data-sidebar-key=${sidebarKey}>
        <div
          class="sidebar-archive-header"
          role="button"
          tabindex="0"
          aria-expanded="${openSection ? 'true' : 'false'}"
        >
          <span
            class="sidebar-workspace-chevron mdi mdi-chevron-${openSection ? 'down' : 'right'}"
            aria-hidden="true"
          ></span>
          <span class="mdi mdi-archive-outline" aria-hidden="true"></span>
          <span class="sidebar-archive-title">${translate('sidebar.archiveSection')}</span>
          <span class="sidebar-workspace-count">${String(count)}</span>
        </div>
        <ul
          class="sidebar-archive-list"
          role="listbox"
          aria-label="${translate('sidebar.archiveSection')}"
          ?hidden="${!openSection}"
        >
          ${openSection && topSpacer > 0
            ? html`<li
                class="sidebar-archive-virtual-spacer"
                aria-hidden="true"
                style="height:${topSpacer}px"
              ></li>`
            : nothing}
          ${repeat(
            slice,
            (item) => String(item?.chat?.id || ''),
            (item) => html`
              <cr-sidebar-chat-row chat-id=${String(item.chat.id)}></cr-sidebar-chat-row>
            `,
          )}
          ${openSection && bottomSpacer > 0
            ? html`<li
                class="sidebar-archive-virtual-spacer"
                aria-hidden="true"
                style="height:${bottomSpacer}px"
              ></li>`
            : nothing}
        </ul>
      </li>
    `;
  }

  /**
   * Resync mounted window after sidebar drag/swipe; restore logical keyboard focus.
   */
  flushVirtualWindowAfterGesture() {
    const sidebarKey = this._resolveSidebarKey();
    const restoreFocus = sidebarKey ? shouldRestoreArchiveFocusAfterGesture(sidebarKey) : false;
    this._syncVirtualWindow(false, { fromUserScroll: false });
    if (!restoreFocus) return;
    const stored = getSidebarArchiveVirtualFocus(sidebarKey);
    if (!stored?.chatId) return;
    const reg = readPayload(this);
    const rows = Array.isArray(reg?.archiveTree) ? reg.archiveTree : [];
    const logicalIndex = resolveArchiveStoredLogicalIndex(stored, rows);
    if (logicalIndex < 0) return;
    void this.revealLogicalIndex(logicalIndex, { focus: true });
  }
}

if (!customElements.get('cr-sidebar-archive-group')) {
  customElements.define('cr-sidebar-archive-group', CrSidebarArchiveGroup);
}

export { CrSidebarArchiveGroup };
