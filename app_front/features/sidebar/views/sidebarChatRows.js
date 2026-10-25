/** Chat-row and settled-subchat-group payload registration and row action buttons. */

import { getCurrentLang, t } from '../../../i18n/index.js';
import { writeSubchatExpandedSet } from '../state/sidebarPersistence.js';
import { registerSidebarChatRow } from '../sidebarChatRowPass.js';
import { registerSidebarSubchatGroup } from '../sidebarSubchatGroupPass.js';
import { resolveSidebarHarnessIcon } from './sidebarHarnessIcon.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarChatRows(ctx) {
  const { chatFavorites, resolveChatState, getTerminalStateMeta, canPinChatToUrl, escapeHtml, onArchiveSettled, subchatExpanded, archivingGroupParents } = ctx;
  const isChatForkArchiveBlocked = (...args) => ctx.isChatForkArchiveBlocked(...args);
  const render = (...args) => ctx.render(...args);

  function sidebarChatRowDeps() {
    return {
      t,
      escapeHtml,
      resolveChatState,
      getTerminalStateMeta,
      getSidebarChatStateMeta: getTerminalStateMeta,
      canPinChatToUrl,
      resolveSidebarHarnessIcon,
      renderChatActionButtonsHtml,
    };
  }

  /**
   * @param {import('../sidebarSubchatGroups.js').SubchatGroupNode} group
   * @param {string} sidebarKey
   * @param {string} parentTitle
   * @returns {string}
   */
  function registerSubchatGroupEntry(group, sidebarKey, parentTitle, continuationLevels = []) {
    const parentId = String(group?.parentId || '').trim();
    if (!parentId) return;
    registerSidebarSubchatGroup(parentId, {
      group,
      sidebarKey,
      parentTitle,
      continuationLevels,
      deps: {
        t,
        escapeHtml,
        lang: getCurrentLang(),
        canArchive: typeof onArchiveSettled === 'function',
        canPin: canPinChatToUrl(),
      },
    });
  }

  /**
   * @param {string} parentId
   * @param {string[]} chatIds
   */
  async function archiveSettledGroup(parentId, chatIds) {
    const key = String(parentId || '').trim();
    const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!key || !ids.length || typeof onArchiveSettled !== 'function') return;
    // A slow confirm + reload must not let a second click archive the same
    // group twice or race the reload.
    if (archivingGroupParents.has(key)) return;
    archivingGroupParents.add(key);
    try {
      let confirmed = false;
      try {
        confirmed = await onArchiveSettled(ids, { parentId: key });
      } catch (_) {
        confirmed = false;
      }
      if (confirmed === false) return;
      subchatExpanded.delete(key);
      writeSubchatExpandedSet(subchatExpanded);
      render();
    } finally {
      archivingGroupParents.delete(key);
    }
  }

  /**
   * Action buttons for a chat row, emitted as HTML so the single delegated
   * `.sidebar-body` listener can dispatch them by class. Previously these were
   * created with `document.createElement` + one listener pair per button inside
   * `wireBodyEvents()`, which ran on every rebuild.
   *
   * @param {any} chat
   * @param {{ archived?: boolean }} [opts]
   * @returns {string}
   */
  function renderChatActionButtonsHtml(chat, opts = {}) {
    const chatId = String(chat?.id || '');
    if (!chatId) return '';
    const archived = opts.archived === true;
    // A pinned URL is only meaningful for live chats; archived rows reserve the
    // slot for the delete action instead (mirrors `hasPinAction` in the row model).
    const showPin = !archived && canPinChatToUrl();
    const pieces = [];

    if (showPin) {
      const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
      const isPinned = !!pinnedUrl;
      const title = isPinned ? t('sidebar.unpinChatFromUrl', { url: pinnedUrl }) : t('sidebar.pinChatToUrl');
      pieces.push(
        '<button type="button" class="sidebar-chat-action sidebar-chat-action-first sidebar-chat-pin-btn'
        + (isPinned ? ' sidebar-chat-pin-btn--active' : '')
        + '" title="' + escapeHtml(title)
        + '" aria-label="' + escapeHtml(title)
        + '" aria-pressed="' + (isPinned ? 'true' : 'false') + '">'
        + '<span class="mdi ' + (isPinned ? 'mdi-link-variant-off' : 'mdi-link-variant')
        + '" aria-hidden="true"></span>'
        + '</button>',
      );
    }

    const archiveBlocked = !archived && isChatForkArchiveBlocked(chatId);
    const archiveTitle = t(
      archived ? 'sidebar.restoreChat' : (archiveBlocked ? 'sidebar.archiveBusy' : 'sidebar.archiveChat'),
    );
    pieces.push(
      '<button type="button" class="sidebar-chat-action'
      + (showPin ? '' : ' sidebar-chat-action-first')
      + ' ' + (archived ? 'sidebar-chat-restore-btn' : 'sidebar-chat-archive-btn')
      + (archiveBlocked ? ' disabled' : '')
      + '" title="' + escapeHtml(archiveTitle)
      + '" aria-label="' + escapeHtml(archiveTitle) + '">'
      + '<span class="mdi '
      + (archived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-arrow-down-outline')
      + '" aria-hidden="true"></span>'
      + '</button>',
    );

    const favActive = chatFavorites.isFavorite(chatId);
    const favTitle = favActive ? t('sidebar.removeFavorite') : t('sidebar.addFavorite');
    pieces.push(
      '<button type="button" class="sidebar-chat-action sidebar-chat-fav-btn'
      + '" title="' + escapeHtml(favTitle)
      + '" aria-label="' + escapeHtml(favTitle)
      + '" aria-pressed="' + (favActive ? 'true' : 'false') + '">'
      + '<span class="mdi '
      + (favActive ? 'mdi-star sidebar-chat-fav-btn--active' : 'mdi-star-outline')
      + '" aria-hidden="true"></span>'
      + '</button>',
    );

    // Archived chats get a permanent-delete action next to restore; live chats
    // keep delete in the chat list / actions menu only, so an accidental tap in
    // the tree cannot destroy active work.
    if (archived) {
      const deleteTitle = t('sidebar.deleteChat');
      pieces.push(
        '<button type="button" class="sidebar-chat-action sidebar-chat-delete-btn'
        + '" title="' + escapeHtml(deleteTitle)
        + '" aria-label="' + escapeHtml(deleteTitle) + '">'
        + '<span class="mdi mdi-trash-can-outline" aria-hidden="true"></span>'
        + '</button>',
      );
    }

    return pieces.join('');
  }

  function registerChatRowEntry(chat, activeChatId, opts = {}) {
    if (!chat?.id) return;
    registerSidebarChatRow(chat.id, {
      chat,
      activeChatId,
      opts,
      deps: sidebarChatRowDeps(),
    });
  }

  return { sidebarChatRowDeps, registerSubchatGroupEntry, archiveSettledGroup, renderChatActionButtonsHtml, registerChatRowEntry };
}
