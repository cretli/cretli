/** Search input, drag-and-drop, archive gesture guard and swipe wiring. */

import { t } from '../../../i18n/index.js';
import { confirmNotificationAction } from '../../notifications/notificationConfirm.js';
import { initSidebarChatDrag } from '../sidebarChatDrag.js';
import { initSidebarChatSwipeArchive } from '../sidebarChatSwipeArchive.js';
import { readChatOrder, writeChatOrderForList } from '../sidebarChatOrder.js';
import { publishSidebarLayout } from '../sidebarLayoutSync.js';
import { initSidebarWorkspaceDrag } from '../sidebarWorkspaceDrag.js';
import { readWorkspaceOrder, writeWorkspaceOrder } from '../sidebarWorkspaceOrder.js';
import { initSidebarSwipe } from '../sidebarSwipe.js';
import { readPinActiveWorkspaceFlag, writePinActiveWorkspaceFlag } from '../state/sidebarPersistence.js';
import { clearArchiveGestureFocusSnapshot, registerSidebarArchiveGestureEndFlush, registerSidebarArchiveGestureGuard, runSidebarArchiveGestureEndFlush, tickSidebarArchiveGestureFocusSnapshot } from '../sidebarArchiveVirtualFocus.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarGestures(ctx) {
  const { getChats, setChatForkParent, isMobileViewport, state, updateScheduler } = ctx;
  const getContainer = (...args) => ctx.getContainer(...args);
  const getBackdrop = (...args) => ctx.getBackdrop(...args);
  const revealDrawerPreview = (...args) => ctx.revealDrawerPreview(...args);
  const hideDrawerPreview = (...args) => ctx.hideDrawerPreview(...args);
  const openSidebar = (...args) => ctx.openSidebar(...args);
  const closeSidebar = (...args) => ctx.closeSidebar(...args);
  const forceRerender = (...args) => ctx.forceRerender(...args);
  const getSearchInput = (...args) => ctx.getSearchInput(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const setSearchQuery = (...args) => ctx.setSearchQuery(...args);

  function initSearchInput() {
    const el = getSearchInput();
    if (!el) return;
    el.addEventListener('input', () => {
      setSearchQuery(typeof el.value === 'string' ? el.value : '');
      forceRerender();
    });
  }

  function initPinActiveWorkspaceSetting() {
    const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById('sidebar-pin-active-workspace-checkbox'));
    if (!checkbox) return;
    checkbox.checked = readPinActiveWorkspaceFlag();
    checkbox.addEventListener('change', () => {
      writePinActiveWorkspaceFlag(!!checkbox.checked);
      forceRerender();
    });
  }

  function initChatSwipeArchive() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    state.chatSwipeArchive = initSidebarChatSwipeArchive({
      body,
      isEnabled: () => !isSearchActive() && !state.workspaceDrag.isDragging() && !state.chatDrag?.isDragging?.(),
      isBlocked: (chatId) => ctx.isChatForkArchiveBlocked(chatId),
      onDelete: (chatId) => {
        if (typeof ctx.requestDeleteChat === 'function') void ctx.requestDeleteChat(chatId, { preserveListOpen: true, forceConfirm: true });
      },
      onArchive: (chatId) => {
        if (typeof ctx.requestArchiveChat === 'function') void ctx.requestArchiveChat(chatId, { preserveListOpen: true });
      },
    });
  }

  function initChatDrag() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    state.chatDrag = initSidebarChatDrag({
      body,
      isEnabled: () => !isSearchActive() && !state.workspaceDrag.isDragging(),
      // Even a no-op drag (press-and-hold that never reordered) deferred
      // renders while it ran; flush the backlog once it releases.
      onSettled: () => afterSidebarGestureSettled(),
      onDrop: ({ orderedIds, draggedId, parentChatId }) => {
        const chat = getChats().find((item) => item.id === draggedId);
        const currentParent =
          typeof chat?.forkParentChatId === 'string' ? chat.forkParentChatId.trim() : '';
        const apply = () => {
          const previousOrder = readChatOrder();
          writeChatOrderForList(orderedIds);
          const nextOrder = readChatOrder();
          if (previousOrder.join('\n') !== nextOrder.join('\n')) {
            publishSidebarLayout({ chatOrder: nextOrder });
          }
          if (draggedId && currentParent !== parentChatId) {
            void setChatForkParent(draggedId, parentChatId);
          }
          forceRerender();
        };
        // A plain reorder that lands on the top level silently detaches a
        // nested chat, so ask first; declining restores the previous layout.
        if (currentParent && !parentChatId) {
          void confirmNotificationAction({
            heading: t('sidebar.unnestConfirmTitle'),
            body: t('sidebar.unnestConfirmBody', { title: chat?.title || draggedId }),
            confirmLabel: t('sidebar.unnestConfirmAction'),
            cancelLabel: t('sidebar.unnestConfirmCancel'),
          }).then((confirmed) => {
            if (confirmed) apply();
            else forceRerender();
          });
          return;
        }
        apply();
      },
    });
  }

  /**
   * Press-and-hold drag & drop for workspace groups. Listeners are delegated
   * on the static `.sidebar-body`, so a single init covers all re-renders.
   */
  function initWorkspaceDrag() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    state.workspaceDrag = initSidebarWorkspaceDrag({
      body,
      isEnabled: () => !isSearchActive(),
      // Flush any render deferred while a workspace group was dragging.
      onSettled: () => afterSidebarGestureSettled(),
      onOrderChange: (keys) => {
        const previousOrder = readWorkspaceOrder();
        writeWorkspaceOrder(keys);
        const nextOrder = readWorkspaceOrder();
        if (previousOrder.join('\n') !== nextOrder.join('\n')) {
          publishSidebarLayout({ workspaceOrder: nextOrder });
        }
        forceRerender();
      },
    });
  }

  function flushArchiveVirtualWindowsAfterGesture() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    body.querySelectorAll('cr-sidebar-archive-group').forEach((host) => {
      if (typeof host.flushVirtualWindowAfterGesture === 'function') {
        host.flushVirtualWindowAfterGesture();
      }
    });
    clearArchiveGestureFocusSnapshot();
  }

  function initArchiveVirtualGestureGuard() {
    registerSidebarArchiveGestureGuard(() => {
      const active = state.chatDrag.isDragging() || state.workspaceDrag.isDragging() || state.swipe.isSwiping();
      tickSidebarArchiveGestureFocusSnapshot(active);
      return active;
    });
    registerSidebarArchiveGestureEndFlush(flushArchiveVirtualWindowsAfterGesture);
  }

  function afterSidebarGestureSettled() {
    runSidebarArchiveGestureEndFlush();
    updateScheduler.schedule();
  }

  function initSwipe() {
    state.swipe = initSidebarSwipe({
      getSidebar: getContainer,
      getBackdrop,
      getEdgeOpen: () => document.getElementById('sidebar-edge-open'),
      isOpen: () => state.open,
      isMobile: isMobileViewport,
      isResizing: () => document.body?.classList.contains('sidebar-resizing') === true,
      isChatDragging: () => state.chatDrag.isDragging() || state.chatSwipeArchive?.isSwiping?.() === true,
      isWorkspaceDragging: () => state.workspaceDrag.isDragging(),
      onClose: closeSidebar,
      onOpen: openSidebar,
      onPreviewReveal: revealDrawerPreview,
      onPreviewHide: hideDrawerPreview,
      // A render requested while the drawer tracked/settled was deferred; flush
      // it on release so the list is never left stale after a swipe.
      onGestureEnd: () => afterSidebarGestureSettled(),
    });
  }

  return { initSearchInput, initPinActiveWorkspaceSetting, initChatDrag, initChatSwipeArchive, initWorkspaceDrag, flushArchiveVirtualWindowsAfterGesture, initArchiveVirtualGestureGuard, afterSidebarGestureSettled, initSwipe };
}
