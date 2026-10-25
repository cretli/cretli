/** Incremental in-place patches: active-row markers, transient visuals, changed rows. */

import { probeSync } from '../../../lib/perfProbe.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import { setRenderedSidebarChatIds, getRenderedSidebarChatIds } from '../sidebarVisibleChats.js';
import { formatSubchatParentBadge, formatSubchatSummary } from '../sidebarSubchatGroups.js';
import { filterWorkspacesByActiveWorkspace, readSidebarOnlyActiveWorkspaceFlag } from '../sidebarOnlyActiveFilter.js';
import { readWorkspaceOrder } from '../sidebarWorkspaceOrder.js';
import { sortSidebarWorkspaces } from '../sidebarWorkspaceSort.js';
import { readPinActiveWorkspaceFlag } from '../state/sidebarPersistence.js';
import { setSidebarChatRowsActiveChatId } from '../sidebarChatRowPass.js';
import { setSingleBindingText } from './sidebarLitText.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarPatch(ctx) {
  const { getWorkspaces, getActiveWorkspaceFile, getActiveWorkspaceFolder, getActiveChatId, getPreferredWorkspaceFolder, state } = ctx;
  const getContainer = (...args) => ctx.getContainer(...args);
  const workspaceModel = (...args) => ctx.workspaceModel(...args);
  const cssEscape = (...args) => ctx.cssEscape(...args);
  const registerWorkspaceGroupEntry = (...args) => ctx.registerWorkspaceGroupEntry(...args);
  const collectRenderableChatIds = (...args) => ctx.collectRenderableChatIds(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const visibleChatsForWorkspace = (...args) => ctx.visibleChatsForWorkspace(...args);

  /**
   * When the top-level structural signature is unchanged, reconcile skips DOM
   * rebuild but Lit workspace/row hosts still need fresh pass registrations.
   * @param {Element} body
   */
  function refreshLitWorkspaceHostsOnSignatureMatch(body) {
    const ul = body.querySelector('.sidebar-workspaces');
    if (!ul) return;
    const wsList = getWorkspaces();
    if (!wsList.length) return;
    const activeWorkspaceFile = getActiveWorkspaceFile();
    const activeWorkspaceFolder = getActiveWorkspaceFolder();
    const activeChatId = getActiveChatId();
    const ordered = sortSidebarWorkspaces(wsList, {
      pinActiveOnTop: readPinActiveWorkspaceFlag(),
      activeWorkspaceFile,
      activeWorkspaceFolder,
      getPreferredWorkspaceFolder,
      locale: getCurrentLang(),
      order: readWorkspaceOrder(),
    });
    const searching = isSearchActive();
    setRenderedSidebarChatIds(collectRenderableChatIds());
    state.settledGroupsByParent = new Map();
    const chatsByKey = new Map();
    for (const workspace of /** @type {any[]} */ (ordered)) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      chatsByKey.set(sidebarKey, visibleChatsForWorkspace(workspace));
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) state.settledGroupsByParent.set(group.parentId, group);
    }
    const activeFilterEarly = filterWorkspacesByActiveWorkspace(ordered, {
      activeWorkspaceFolder,
      searching,
      enabled: readSidebarOnlyActiveWorkspaceFlag(),
      getPreferredWorkspaceFolder,
    });
    const visibleWorkspaces = /** @type {any[]} */ (activeFilterEarly.workspaces).filter((workspace) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      return !(searching && (chatsByKey.get(sidebarKey) || []).length === 0);
    });
    const renderedIds = new Set();
    for (const workspace of /** @type {any[]} */ (visibleWorkspaces)) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      registerWorkspaceGroupEntry(
        workspace,
        activeWorkspaceFile,
        activeWorkspaceFolder,
        activeChatId,
        chatsByKey.get(sidebarKey) || [],
        renderedIds,
      );
    }
    // Registrations refreshed above; row status is patched via the status bus, not
    // by re-rendering Lit hosts (unsafeHTML would replace `<li>` nodes).
  }

  /**
   * Writes the active marker only on rows whose state differs, so a chat switch
   * touches the old and the new row instead of every mounted row.
   * @param {Element} body
   * @param {string} activeChatId
   */
  function patchActiveRowMarkers(body, activeChatId) {
    const setRowActive = (el, active) => {
      if (el.classList?.contains('is-active') !== active) el.classList?.toggle('is-active', active);
      const aria = active ? 'true' : 'false';
      if (el.getAttribute?.('aria-selected') !== aria) el.setAttribute?.('aria-selected', aria);
    };
    body.querySelectorAll('.sidebar-chat-item, .sidebar-pinned-chat').forEach((/** @type {any} */ el) => {
      const id = el.dataset?.chatId || el.dataset?.pinnedChatId || '';
      setRowActive(el, !!id && id === activeChatId);
    });
    state.lastPatchedActiveChatId = activeChatId;
  }

  /**
   * Selection-only update: when the active chat changes and nothing else does, flip
   * the active marker on the mounted rows instead of running a full render pass
   * (signature + registration refresh). Returns false whenever it cannot prove the
   * structure is unchanged; the caller then runs the normal `render()`.
   *
   * The structure depends on the active chat only through (a) the per-workspace
   * visible-row cap that always keeps the active chat and (b) settled subchat
   * groups that stay expanded around the active chat. Both are checked here.
   * @returns {boolean}
   */
  function applyActiveChatOnly() {
    if (state.lastRenderSignature === '' || isSearchActive()) return false;
    if (state.workspaceDrag.isDragging() || state.chatDrag.isDragging() || state.swipe.isSwiping()) return false;
    const aside = getContainer();
    const body = aside?.querySelector('.sidebar-body');
    if (!aside || !body || !body.querySelector('.sidebar-workspaces')) return false;
    const nextActive = getActiveChatId() || '';
    const prevActive = state.lastPatchedActiveChatId;
    if (prevActive === null) return false;
    if (nextActive === prevActive) return true;
    const rendered = getRenderedSidebarChatIds();
    // A new active chat that is not already a mounted row would change the structure.
    if (nextActive && !rendered.has(nextActive)) return false;
    if (prevActive && rendered.has(prevActive)) {
      // The previous active chat may only be mounted because the cap / a group kept it.
      if (state.lastPassCappedWorkspaces > 0 && !state.lastNaturalVisibleIds.has(prevActive)) return false;
      for (const group of state.settledGroupsByParent.values()) {
        if (group.allChildIds?.includes(prevActive)) return false;
      }
    }
    probeSync('sidebar.activeOnly', () => {
      patchActiveRowMarkers(body, nextActive);
      setSidebarChatRowsActiveChatId(nextActive);
    });
    state.lastPatchedActiveChatId = nextActive;
    return true;
  }

  /**
   * In-place repaint of the visuals that deliberately live OUTSIDE the structural
   * signature: the active-chat class/ARIA, the settled-subchat group summary, and
   * the collapsed parent badge. Reads the memoised per-pass tree, so calling this
   * on a signature-skip costs one bounded DOM walk — no markup rebuild.
   * Runs inside a render pass (`renderPass` is set).
   */
  function patchTransientVisualStates() {
    const aside = getContainer();
    if (!aside || aside.hidden) return;
    const body = aside.querySelector('.sidebar-body');
    if (!body) return;
    const activeChatId = state.renderPass ? state.renderPass.activeChatId : getActiveChatId();

    patchActiveRowMarkers(body, activeChatId);

    // Settled-group summaries only repaint when a group is actually on screen.
    const groupEls = body.querySelectorAll('.sidebar-subchat-group');
    if (!groupEls || !groupEls.length) return;
    const groupByKey = new Map();
    const badgeByKey = new Map();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) {
        const key = sidebarKey + '\u0000' + group.parentId;
        groupByKey.set(key, group);
        if (group.expanded !== true) {
          badgeByKey.set(sidebarKey + '\u0000' + group.parentId, formatSubchatParentBadge(group.summary, t));
        }
      }
    }

    groupEls.forEach((el) => {
      const sidebarKey = el.getAttribute('data-sidebar-key') || '';
      const parentId = el.getAttribute('data-parent-id') || '';
      const group = groupByKey.get(sidebarKey + '\u0000' + parentId);
      if (!group) return;
      const summaryLabel = formatSubchatSummary(group.summary);
      if ((el.getAttribute('data-group-summary') || '') === summaryLabel) return;
      el.setAttribute('data-group-summary', summaryLabel);
      const summaryEl = el.querySelector('.sidebar-subchat-group-summary');
      const summaryTitle = summaryLabel ? t('sidebar.subchatSummary', { summary: summaryLabel }) : '';
      if (summaryEl) {
        // Lit owns this span's text binding; textContent= would drop its part markers.
        setSingleBindingText(summaryEl, summaryLabel);
        if (summaryTitle) summaryEl.setAttribute('title', summaryTitle);
        summaryEl.toggleAttribute?.('hidden', !summaryLabel);
      }
      const toggleEl = el.querySelector('.sidebar-subchat-group-toggle');
      if (toggleEl && summaryTitle) toggleEl.setAttribute('aria-description', summaryTitle);
    });

    badgeByKey.forEach((badge, key) => {
      if (!badge) return;
      const parentId = key.split('\u0000')[1];
      const row = body.querySelector(`.sidebar-chat-item[data-chat-id="${cssEscape(parentId)}"]`);
      if (!row) return;
      const badgeEl = row.querySelector('.sidebar-chat-item-subchat-summary');
      if (!badgeEl) return;
      if ((badgeEl.getAttribute('data-summary-label') || '') === badge.label) return;
      badgeEl.setAttribute('data-summary-label', badge.label);
      badgeEl.textContent = badge.label;
      badgeEl.setAttribute('title', badge.title);
      badgeEl.setAttribute('aria-label', badge.title);
    });
  }

  /**
   * Repaints only the rows whose field signature changed. Returns false (caller does
   * the full rebuild) when it cannot prove the patch is complete: nothing changed in
   * the store, searching, a changed row heads a settled group, or its host is not mounted.
   * @param {HTMLElement} body
   * @param {string[]} changedIds
   */
  function tryPatchChangedRows(body, changedIds) {
    if (!changedIds.length || isSearchActive() || !body.querySelector('.sidebar-workspaces')) return false;
    const hosts = [];
    for (const id of changedIds) {
      // Only rows currently shown matter; other chats (hidden/archived) are not in the DOM.
      if (!getRenderedSidebarChatIds().has(id)) continue;
      if (state.settledGroupsByParent.has(id)) return false;
      const host = [...body.querySelectorAll('cr-sidebar-chat-row')].find((el) => /** @type {any} */ (el).chatId === id);
      if (!host) return false;
      hosts.push(host);
    }
    refreshLitWorkspaceHostsOnSignatureMatch(body);
    for (const host of hosts) host.requestUpdate();
    return true;
  }

  return { refreshLitWorkspaceHostsOnSignatureMatch, patchActiveRowMarkers, applyActiveChatOnly, patchTransientVisualStates, tryPatchChangedRows };
}
