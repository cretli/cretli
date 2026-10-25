/** Collapsed / archive-open / subchat-expanded sets and the synced layout snapshot. */

import { setSidebarArchiveSectionOpen } from '../sidebarVisibleChats.js';
import { readChatOrder, writeChatOrder } from '../sidebarChatOrder.js';
import { publishSidebarLayout, sidebarLayoutListsEqual } from '../sidebarLayoutSync.js';
import { readWorkspaceOrder, writeWorkspaceOrder } from '../sidebarWorkspaceOrder.js';
import { readCollapsedSet, readArchiveOpenSet, readSubchatExpandedSet, writeCollapsedSet, writeArchiveOpenSet, writeSubchatExpandedSet, normalizePath } from './sidebarPersistence.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarLayoutState(ctx) {
  const render = (...args) => ctx.render(...args);
  const collapsed = readCollapsedSet();
  const archiveOpen = readArchiveOpenSet();
  const subchatExpanded = readSubchatExpandedSet();
  setSidebarArchiveSectionOpen(archiveOpen.size > 0);

  function isWorkspaceCollapsed(sidebarKey) {
    return collapsed.has(normalizePath(sidebarKey));
  }

  function setWorkspaceCollapsed(sidebarKey, value) {
    const key = normalizePath(sidebarKey);
    if (!key) return;
    const had = collapsed.has(key);
    if (value === had) return;
    if (value) collapsed.add(key);
    else collapsed.delete(key);
    writeCollapsedSet(collapsed);
    publishSidebarLayout({ collapsedWorkspaces: [...collapsed] });
  }

  function toggleWorkspaceCollapsed(sidebarKey) {
    setWorkspaceCollapsed(sidebarKey, !isWorkspaceCollapsed(sidebarKey));
    render();
  }

  function isArchiveSectionOpen(sidebarKey) {
    return archiveOpen.has(String(sidebarKey || '').trim());
  }

  function setArchiveSectionOpen(sidebarKey, value) {
    const key = String(sidebarKey || '').trim();
    if (!key) return;
    const had = archiveOpen.has(key);
    if (value === had) return;
    if (value) archiveOpen.add(key);
    else archiveOpen.delete(key);
    writeArchiveOpenSet(archiveOpen);
    setSidebarArchiveSectionOpen(archiveOpen.size > 0);
    publishSidebarLayout({ archiveOpen: [...archiveOpen] });
  }

  function isSubchatGroupExpanded(parentId) {
    return subchatExpanded.has(String(parentId || '').trim());
  }

  function setSubchatGroupExpanded(parentId, value) {
    const key = String(parentId || '').trim();
    if (!key) return;
    const had = subchatExpanded.has(key);
    if (value === had) return;
    if (value) subchatExpanded.add(key);
    else subchatExpanded.delete(key);
    writeSubchatExpandedSet(subchatExpanded);
    publishSidebarLayout({ subchatExpanded: [...subchatExpanded] });
  }

  /**
   * @param {Iterable<string>} values
   * @param {(value: string) => string} normalize
   * @returns {Set<string>}
   */
  function replaceSet(values, normalize) {
    const next = new Set();
    (Array.isArray(values) ? values : [...values]).forEach((item) => {
      const value = normalize(String(item || ''));
      if (value) next.add(value);
    });
    return next;
  }

  /**
   * @returns {{
   *   chatOrder: string[],
   *   workspaceOrder: string[],
   *   collapsedWorkspaces: string[],
   *   subchatExpanded: string[],
   *   archiveOpen: string[],
   * }}
   */
  function readLayoutSnapshot() {
    return {
      chatOrder: readChatOrder(),
      workspaceOrder: readWorkspaceOrder(),
      collapsedWorkspaces: [...collapsed],
      subchatExpanded: [...subchatExpanded],
      archiveOpen: [...archiveOpen],
    };
  }

  /**
   * Apply a server layout into the local cache without publishing it back.
   *
   * @param {any} layout
   * @returns {boolean} true when any persisted layout field changed
   */
  function applyLayoutSnapshot(layout) {
    if (!layout || typeof layout !== 'object') return false;
    let changed = false;
    if (Array.isArray(layout.chatOrder)) {
      if (!sidebarLayoutListsEqual('chatOrder', layout.chatOrder, readChatOrder())) {
        writeChatOrder(layout.chatOrder);
        changed = true;
      }
    }
    if (Array.isArray(layout.workspaceOrder)) {
      if (!sidebarLayoutListsEqual('workspaceOrder', layout.workspaceOrder, readWorkspaceOrder())) {
        writeWorkspaceOrder(layout.workspaceOrder);
        changed = true;
      }
    }
    if (Array.isArray(layout.collapsedWorkspaces)) {
      if (!sidebarLayoutListsEqual('collapsedWorkspaces', layout.collapsedWorkspaces, [...collapsed])) {
        collapsed.clear();
        replaceSet(layout.collapsedWorkspaces, normalizePath).forEach((key) => collapsed.add(key));
        writeCollapsedSet(collapsed);
        changed = true;
      }
    }
    if (Array.isArray(layout.subchatExpanded)) {
      if (!sidebarLayoutListsEqual('subchatExpanded', layout.subchatExpanded, [...subchatExpanded])) {
        subchatExpanded.clear();
        replaceSet(layout.subchatExpanded, (value) => value.trim()).forEach((key) => subchatExpanded.add(key));
        writeSubchatExpandedSet(subchatExpanded);
        changed = true;
      }
    }
    if (Array.isArray(layout.archiveOpen)) {
      if (!sidebarLayoutListsEqual('archiveOpen', layout.archiveOpen, [...archiveOpen])) {
        archiveOpen.clear();
        replaceSet(layout.archiveOpen, (value) => value.trim()).forEach((key) => archiveOpen.add(key));
        writeArchiveOpenSet(archiveOpen);
        setSidebarArchiveSectionOpen(archiveOpen.size > 0);
        changed = true;
      }
    }
    return changed;
  }

  return { collapsed, archiveOpen, subchatExpanded, isWorkspaceCollapsed, setWorkspaceCollapsed, toggleWorkspaceCollapsed, isArchiveSectionOpen, setArchiveSectionOpen, isSubchatGroupExpanded, setSubchatGroupExpanded, replaceSet, readLayoutSnapshot, applyLayoutSnapshot };
}
