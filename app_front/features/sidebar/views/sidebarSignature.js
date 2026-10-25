/** Structural render signatures that decide rebuild versus patch. */

import { flattenChatsTree } from '../../../../lib/chat-tree.js';
import { capSidebarVisibleTreeChats, SIDEBAR_VISIBLE_CHAT_LIMIT, shouldSerializeWorkspaceChatList } from '../sidebarVisibleChats.js';
import { workspaceWatcherPresenceRevision } from '../workspaceAutopilotBadge.js';
import { workspaceWatcherRuntimeRevision } from '../workspaceWatcherToggle.js';
import { readChatOrder } from '../sidebarChatOrder.js';
import { readSidebarOnlyActiveWorkspaceFlag } from '../sidebarOnlyActiveFilter.js';
import { readWorkspaceOrder } from '../sidebarWorkspaceOrder.js';
import { readPinActiveWorkspaceFlag, readWatcherShowAllFlag, normalizePath } from '../state/sidebarPersistence.js';
import { archiveWindowChatIds } from '../sidebarArchiveVirtualizer.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarSignature(ctx) {
  const { getWorkspaces, getActiveWorkspaceFile, getActiveWorkspaceFolder, getActiveChatId, getPreferredWorkspaceFolder, chatFavorites, state, showAllChatsBySidebarKey, collapsed, archiveOpen, subchatExpanded } = ctx;
  const isWorkspaceCollapsed = (...args) => ctx.isWorkspaceCollapsed(...args);
  const isArchiveSectionOpen = (...args) => ctx.isArchiveSectionOpen(...args);
  const beginRenderPass = (...args) => ctx.beginRenderPass(...args);
  const endRenderPass = (...args) => ctx.endRenderPass(...args);
  const workspaceModel = (...args) => ctx.workspaceModel(...args);
  const resolveArchiveVirtualWindowForPass = (...args) => ctx.resolveArchiveVirtualWindowForPass(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const activeWorktreeFilterId = (...args) => ctx.activeWorktreeFilterId(...args);
  const archivedCountForWorkspace = (...args) => ctx.archivedCountForWorkspace(...args);

  /**
   * The chat ids the list currently renders (per-workspace cap + open archive
   * sections). Reused by the structural signature so membership changes — and
   * only membership changes — drive a rebuild. Reads the memoised per-pass tree.
   *
   * @returns {Set<string>}
   */
  function collectRenderableChatIds() {
    const ids = new Set();
    const searching = isSearchActive();
    const activeChatId = state.renderPass ? state.renderPass.activeChatId : getActiveChatId();
    if (activeChatId) ids.add(activeChatId);
    let cappedWorkspaces = 0;
    const naturalVisible = new Set();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { archived, grouped } = workspaceModel(workspace);
      const capped = capSidebarVisibleTreeChats(grouped.items, {
        limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
        activeChatId,
        showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
      });
      for (const item of capped.items) {
        if (item?.chat?.id) ids.add(item.chat.id);
      }
      if (capped.hidden > 0) {
        cappedWorkspaces += 1;
        for (const item of /** @type {any} */ (grouped).items.slice(0, SIDEBAR_VISIBLE_CHAT_LIMIT)) {
          if (item?.chat?.id) naturalVisible.add(item.chat.id);
        }
      }
      if (searching || isArchiveSectionOpen(sidebarKey)) {
        const archiveTree = flattenChatsTree(archived);
        const virtualWindow = resolveArchiveVirtualWindowForPass(sidebarKey, archiveTree);
        for (const id of archiveWindowChatIds(virtualWindow, archiveTree)) {
          ids.add(id);
        }
      }
    }
    state.lastPassCappedWorkspaces = cappedWorkspaces;
    state.lastNaturalVisibleIds = naturalVisible;
    return ids;
  }

  /**
   * Membership-only signature of the settled-subchat groups: the folded child id
   * set per parent. A status change that keeps the same members (e.g. completed →
   * interrupted) must NOT rebuild — the summary is repainted in place by
   * `patchTransientVisualStates`. Only a child entering/leaving the folded set
   * changes this string and forces a rebuild.
   *
   * @returns {string}
   */
  function collectSubchatGroupSignature() {
    const parts = [];
    const searching = isSearchActive();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) {
        const childIds = Array.isArray(group.childIds)
          ? [...group.childIds].sort().join(',')
          : '';
        parts.push(sidebarKey + ':' + group.parentId + ':' + childIds);
      }
    }
    return parts.join('|');
  }

  /**
   * Per-workspace structural signature: everything that changes the rendered
   * `<li class="sidebar-workspace">` subtree — name, clone marker, active /
   * collapsed state, chat titles / order / favorites / pins, capped membership,
   * settled-group membership and archive-section state. Transient visuals (row
   * status tone, active row class, group summary text) are intentionally
   * excluded because they are patched in place. The render pass shares these
   * strings with the per-group rebuild so a change in one workspace does not
   * recreate the other `<li>` nodes.
   *
   * @param {any} workspace
   * @param {string} activeChatId
   * @param {boolean} searching
   * @returns {string}
   */
  function computeWorkspaceStructureSignature(workspace, activeChatId, searching) {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspace.workspaceFile) === normalizePath(getActiveWorkspaceFile()) &&
      normalizePath(preferredFolder) === normalizePath(getActiveWorkspaceFolder());
    const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
    const { live, archived, grouped } = workspaceModel(workspace);
    const serializeList = shouldSerializeWorkspaceChatList(isCollapsed, searching);
    const capped = serializeList
      ? capSidebarVisibleTreeChats(grouped.items, {
        limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
        activeChatId,
        showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
      })
      : { items: [], hidden: 0 };
    const rows = serializeList
      ? capped.items
        .map((/** @type {any} */ item) => (item?.isGroup
          ? 'g:' + item.parentId + ':' + (item.childIds || []).join(',')
          : 'c:' + (item.chat?.id || '')))
        .join(',')
      : '';
    const groups = serializeList
      ? grouped.groups
        .map((group) => group.parentId + ':' + [...(group.childIds || [])].sort().join(','))
        .join(',')
      : '';
    // The mounted archive window is bounded, but its content is only registered
    // when this workspace subtree is rebuilt. Without the archive membership in
    // the signature, the async `includeArchived` load (which replaces the empty
    // hint-only archive tree) would be skipped as "unchanged" and the expanded
    // archive list would stay empty. Keep it scroll-independent (length + edges)
    // so virtual scrolling does not force workspace rebuilds.
    const archiveMembershipSig = serializeList && (searching || isArchiveSectionOpen(sidebarKey))
      ? [
        String(archived.length),
        String(archived[0]?.id || ''),
        String(archived.length > 0 ? archived[archived.length - 1]?.id || '' : ''),
      ].join(':')
      : '';
    return [
      workspace.name || '',
      workspace.workspaceFile || '',
      workspace.isClone ? '1' : '0',
      isActive ? 'A' : '',
      isCollapsed ? 'C' : 'O',
      serializeList ? 'S' : 'H',
      searching ? 'Q' : '',
      showAllChatsBySidebarKey.has(sidebarKey) ? '1' : '0',
      isArchiveSectionOpen(sidebarKey) ? '1' : '0',
      live
        .map((c) =>
          [
            c.id,
            c.title,
            chatFavorites.isFavorite(c.id) ? '1' : '0',
            c.forkParentChatId || '',
            c.todoId ? 'D' : '',
            c.onWorktree ? 'W' : '',
            c.widgetPinnedUrl || '',
          ].join(':'),
        )
        .join(','),
      String(archivedCountForWorkspace(workspace)),
      archiveMembershipSig,
      rows,
      groups,
    ].join('#');
  }

  /**
   * @param {{ layout?: string, structure?: string, status?: string, group?: string, watcher?: string, runtime?: string }} [partsOut]
   *   Optional out-param populated with the NAMED signature segments so the trace
   *   diff never has to slice the joined string on '||' (segment values can
   *   themselves contain '||'). `status` is intentionally left unset: per-row tone
   *   / active marker no longer affect the structural signature (they are applied
   *   by a targeted row patch), so status-only frames short-circuit here.
   * @returns {string}
   */
  function renderSignature(partsOut, skeleton = false) {
    const ownsPass = !state.renderPass;
    if (ownsPass) beginRenderPass();
    try {
      const wsList = getWorkspaces();
      const activeWs = normalizePath(getActiveWorkspaceFile());
      const collapsedKey = [...collapsed].sort().join('|');
      const visibleIds = collectRenderableChatIds();
      const groupSig = collectSubchatGroupSignature();
      const structureSig = wsList
        .map((workspace) => {
          const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
          const { live } = workspaceModel(workspace);
          return [
            sidebarKey,
            workspace.name || '',
            workspace.isClone ? '1' : '0',
            isWorkspaceCollapsed(sidebarKey) ? 'C' : 'O',
            live
              .map((c) =>
                // Skeleton mode drops the fields a single row repaints on its own
                // (title, badges, pinned URL) so a row-only change keeps the same skeleton.
                skeleton
                  ? [/** @type {any} */ (c).id, chatFavorites.isFavorite(/** @type {any} */ (c).id) ? '1' : '0', /** @type {any} */ (c).forkParentChatId || ''].join(':')
                  : [
                    c.id,
                    c.title,
                    chatFavorites.isFavorite(c.id) ? '1' : '0',
                    c.forkParentChatId || '',
                    c.todoId ? 'D' : '',
                    c.onWorktree ? 'W' : '',
                    c.widgetPinnedUrl || '',
                  ].join(':'),
              )
              .join(','),
            String(archivedCountForWorkspace(workspace)),
          ].join('#');
        })
        .join('||');
      const membershipSig = [...visibleIds].sort().join(',');
      const layoutSig =
        String(state.open) +
        '||' +
        String(state.pinned) +
        '||' +
        activeWs +
        '||' +
        String(state.searchQuery || '') +
        '||' +
        collapsedKey +
        '||' +
        [...showAllChatsBySidebarKey].sort().join('|') +
        '||' +
        [...archiveOpen].sort().join('|') +
        '||' +
        [...subchatExpanded].sort().join('|') +
        '||' +
        readWorkspaceOrder().join('\n') +
        '||' +
        readChatOrder().join('\n') +
        '||' +
        (readPinActiveWorkspaceFlag() ? '1' : '0') +
        '||' +
        (readWatcherShowAllFlag() ? '1' : '0') +
        '||' +
        (readSidebarOnlyActiveWorkspaceFlag() ? '1' : '0') +
        '||' +
        activeWorktreeFilterId();
      const watcherSig = String(workspaceWatcherPresenceRevision());
      // The master start gate is server-wide state, not part of the presence
      // frame, so its revision is tracked separately to repaint the header switch.
      const runtimeSig = String(workspaceWatcherRuntimeRevision());
      if (partsOut) {
        partsOut.layout = layoutSig;
        partsOut.structure = structureSig + '\n' + membershipSig;
        partsOut.group = groupSig;
        partsOut.watcher = watcherSig;
        partsOut.runtime = runtimeSig;
      }
      return (
        layoutSig +
        '||' +
        structureSig +
        '||' +
        membershipSig +
        '||' +
        groupSig +
        '||' +
        watcherSig +
        '||' +
        runtimeSig
      );
    } finally {
      if (ownsPass) endRenderPass();
    }
  }

  return { collectRenderableChatIds, collectSubchatGroupSignature, computeWorkspaceStructureSignature, renderSignature };
}
