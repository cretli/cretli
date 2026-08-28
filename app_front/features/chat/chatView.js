import { sortChatsByDate } from './chatListSort.js';
import { resolveChatListDotState } from './chatStatusMeta.js';
import { t } from '../../i18n/index.js';

export function createChatView(deps) {
  const {
    initDropdown,
    chatFavorites,
    getChatsForCurrentWorkspace,
    getArchivedChatsForCurrentWorkspace = () => [],
    getActiveChatId,
    getTerminalStateMeta,
    escapeHtml,
    selectChat,
    requestDeleteChat,
    requestArchiveChat = async () => false,
    requestRestoreChat = async () => false,
    refreshModelSelectLabels,
    onFavoritesChanged = () => {},
    isEmbedMode = () => false,
    canPinChatToUrl = () => false,
    toggleChatUrlPinById = async () => {},
    openNewChatModal = () => {},
    hasPendingRemoteHistory = () => false,
    getPendingRemoteHistoryLabel = () => 'New activity',
  } = deps;

  let chatListDropdownApi = null;
  let embedChatListDropdownApi = null;
  let chatActionsDropdownApi = null;

  function resolveChatListTrigger() {
    if (isEmbedMode()) {
      const embedTrigger = document.getElementById('embed-chat-switcher');
      if (embedTrigger) return embedTrigger;
    }
    return document.getElementById('chat-bar-trigger');
  }

  function resolveActiveChat() {
    const filtered = getChatsForCurrentWorkspace();
    const activeChatId = getActiveChatId();
    if (activeChatId && filtered.some((c) => c.id === activeChatId)) {
      return filtered.find((c) => c.id === activeChatId) || null;
    }
    return filtered[0] || null;
  }

  function updateChatBarSelect() {
    const current = resolveActiveChat();
    const title = current ? current.title : '—';
    const label = document.getElementById('chat-bar-trigger-label');
    if (label) label.textContent = title;
    const embedLabel = document.getElementById('embed-chat-switcher-label');
    if (embedLabel) embedLabel.textContent = title;
  }

  function resolveChatListAgentState(chat) {
    if (!chat) return 'disconnected';
    return resolveChatListDotState(getTerminalStateMeta(chat).tone);
  }

  function isChatListOpen() {
    if (chatListDropdownApi?.isOpen?.()) return true;
    if (embedChatListDropdownApi?.isOpen?.()) return true;
    const modal = document.getElementById('chat-list-modal');
    return !!(modal && !modal.hidden);
  }

  function openChatListModal() {
    const modal = document.getElementById('chat-list-modal');
    const trigger = resolveChatListTrigger();
    const listEl = document.getElementById('chat-list-items');
    if (!modal || !listEl || !trigger) return;
    const activeChatId = getActiveChatId();
    const filtered = getChatsForCurrentWorkspace();
    const ordered = sortChatsByDate(filtered);
    const archivedOrdered = sortChatsByDate(getArchivedChatsForCurrentWorkspace());
    const allChats = [...ordered, ...archivedOrdered];
    const embedNewChatRow = isEmbedMode()
      ? '<li class="chat-list-item chat-list-item-header chat-list-item-action" role="option" data-action="new-chat" tabindex="-1">' +
        '<span class="mdi mdi-plus" aria-hidden="true"></span>' +
        '<span class="chat-list-item-title">' + escapeHtml(t('chat.new')) + '</span>' +
        '</li>'
      : '';
    const archivedHeader = archivedOrdered.length > 0
      ? '<li class="chat-list-item chat-list-item-header" role="presentation" data-section="archived">' +
        '<span class="mdi mdi-archive-outline" aria-hidden="true"></span>' +
        '<span class="chat-list-item-title">' + escapeHtml(t('chatUi.archiveSection')) + '</span>' +
        '</li>'
      : '';
    listEl.innerHTML = embedNewChatRow + ordered
      .map((c) => {
        const state = resolveChatListAgentState(c);
        const meta = getTerminalStateMeta(c);
        const showMeta = meta.tone !== 'idle';
        return (
          '<li class="chat-list-item' +
          (c.id === activeChatId ? ' is-active' : '') +
          '" role="option" data-chat-id="' +
          escapeHtml(c.id) +
          '" tabindex="-1">' +
          '<span class="chat-list-item-state chat-list-item-state--' +
          state +
          '" title="' +
          escapeHtml(meta.label) +
          '" aria-hidden="true"></span>' +
          '<span class="chat-list-item-title">' +
          escapeHtml(c.title) +
          (c.isTemporary
            ? '<span class="chat-list-item-temp-badge" title="' +
              escapeHtml(t('chatUi.temporaryAgent')) +
              '">' +
              escapeHtml(t('chatUi.temporaryBadge')) +
              '</span>'
            : '') +
          (c.todoId
            ? '<span class="chat-list-item-todo-badge" title="' +
              escapeHtml(t('chatUi.linkedTodo')) +
              '">Todo</span>'
            : '') +
          (hasPendingRemoteHistory(c)
            ? '<span class="chat-list-item-sync-badge" title="' +
              escapeHtml(getPendingRemoteHistoryLabel()) +
              '">●</span>'
            : '') +
          '</span>' +
          '<span class="chat-list-item-awaiting chat-list-item-awaiting--' +
          escapeHtml(meta.tone) +
          '" title="' +
          escapeHtml(t('chatUi.stateTitle', { label: meta.label })) +
          '"' +
          (showMeta ? '' : ' hidden') +
          '>' +
          escapeHtml(meta.label) +
          '</span>' +
          '</li>'
        );
      })
      .join('') + archivedHeader + archivedOrdered
      .map((chat) => (
        '<li class="chat-list-item chat-list-item-archived" role="option" data-chat-id="' +
        escapeHtml(chat.id) +
        '" data-archived="1" tabindex="-1">' +
        '<span class="chat-list-item-state chat-list-item-state--disconnected" aria-hidden="true"></span>' +
        '<span class="chat-list-item-title">' +
        escapeHtml(chat.title || chat.id) +
        '<span class="chat-list-item-temp-badge" title="' +
        escapeHtml(t('chatUi.archivedChat')) +
        '">' +
        escapeHtml(t('chatUi.archivedBadge')) +
        '</span>' +
        '</span>' +
        '<span class="chat-list-item-awaiting chat-list-item-awaiting--disconnected">' +
        escapeHtml(t('chatUi.archivedState')) +
        '</span>' +
        '</li>'
      ))
      .join('');
    listEl.querySelectorAll('.chat-list-item[data-action="new-chat"]').forEach((el) => {
      el.addEventListener('click', () => {
        closeChatListModal();
        openNewChatModal();
      });
    });
    listEl.querySelectorAll('.chat-list-item').forEach((el) => {
      if (el.dataset.action === 'new-chat') return;
      const chatId = el.dataset.chatId || '';
      if (chatId) {
        const chat = allChats.find((item) => item.id === chatId);
        const isArchived = el.dataset.archived === '1';
        const showPin = canPinChatToUrl();
        let firstActionBtn = null;

        if (showPin && !isArchived) {
          const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
          const pinned = !!pinnedUrl;
          const pinBtn = document.createElement('button');
          pinBtn.type = 'button';
          pinBtn.className = 'dropdown-fav-btn dropdown-pin-btn' + (pinned ? ' dropdown-pin-btn--active' : '');
          pinBtn.title = pinned
            ? t('chatUi.unpinChatFromUrl', { url: pinnedUrl })
            : t('chatUi.pinChatToCurrentUrl');
          pinBtn.setAttribute('aria-label', pinBtn.title);
          pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
          pinBtn.innerHTML =
            '<span class="mdi ' +
            (pinned ? 'mdi-link-variant-off' : 'mdi-link-variant') +
            '" aria-hidden="true"></span>';
          pinBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void toggleChatUrlPinById(chatId, document.getElementById('chat-toolbar-status-hint'));
          });
          el.appendChild(pinBtn);
          firstActionBtn = pinBtn;
        }

        if (!isArchived) {
          const archiveBtn = document.createElement('button');
          archiveBtn.type = 'button';
          archiveBtn.className = 'dropdown-fav-btn dropdown-archive-btn';
          archiveBtn.title = t('chatUi.archiveChat');
          archiveBtn.setAttribute('aria-label', archiveBtn.title);
          archiveBtn.innerHTML = '<span class="mdi mdi-archive-arrow-down-outline" aria-hidden="true"></span>';
          archiveBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void requestArchiveChat(chatId, { preserveListOpen: true });
          });
          el.appendChild(archiveBtn);
          if (!firstActionBtn) firstActionBtn = archiveBtn;
        } else {
          const restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.className = 'dropdown-fav-btn dropdown-restore-btn';
          restoreBtn.title = t('chatUi.restoreChat');
          restoreBtn.setAttribute('aria-label', restoreBtn.title);
          restoreBtn.innerHTML = '<span class="mdi mdi-archive-arrow-up-outline" aria-hidden="true"></span>';
          restoreBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void requestRestoreChat(chatId);
          });
          el.appendChild(restoreBtn);
          if (!firstActionBtn) firstActionBtn = restoreBtn;
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'dropdown-fav-btn dropdown-delete-btn';
        deleteBtn.title = t('chat.delete');
        deleteBtn.setAttribute('aria-label', deleteBtn.title);
        deleteBtn.innerHTML = '<span class="mdi mdi-trash-can-outline" aria-hidden="true"></span>';
        deleteBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          requestDeleteChat(chatId, { skipConfirm: true, preserveListOpen: true });
        });
        el.appendChild(deleteBtn);
        if (!firstActionBtn) firstActionBtn = deleteBtn;

        if (!isArchived) {
          const favActive = chatFavorites.isFavorite(chatId);
          const favBtn = document.createElement('button');
          favBtn.type = 'button';
          favBtn.className = 'dropdown-fav-btn';
          favBtn.title = favActive
            ? t('chatUi.removeFromFavorites')
            : t('chatUi.addToFavorites');
          favBtn.setAttribute('aria-label', favBtn.title);
          favBtn.setAttribute('aria-pressed', favActive ? 'true' : 'false');
          favBtn.innerHTML =
            '<span class="mdi ' +
            (favActive ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
            '" aria-hidden="true"></span>';
          favBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const active = chatFavorites.toggleFavorite(chatId);
            favBtn.title = active
              ? t('chatUi.removeFromFavorites')
              : t('chatUi.addToFavorites');
            favBtn.setAttribute('aria-label', favBtn.title);
            favBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
            favBtn.innerHTML =
              '<span class="mdi ' +
              (active ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
              '" aria-hidden="true"></span>';
            onFavoritesChanged();
          });
          el.appendChild(favBtn);
        }

        if (firstActionBtn) {
          firstActionBtn.classList.add('dropdown-chat-action-first');
        }
      }
      el.addEventListener('click', (ev) => {
        if (ev.target instanceof Element && ev.target.closest('.dropdown-fav-btn, .dropdown-pin-btn, .dropdown-delete-btn')) {
          return;
        }
        if (el.dataset.archived === '1') return;
        const id = el.dataset.chatId;
        if (id) selectChat(id);
        closeChatListModal();
      });
    });
    if (chatListDropdownApi) {
      chatActionsDropdownApi?.close?.();
      chatListDropdownApi.open();
      return;
    }
    if (embedChatListDropdownApi) {
      chatActionsDropdownApi?.close?.();
      embedChatListDropdownApi.open();
      return;
    }
    modal.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function closeChatListModal() {
    const trigger = resolveChatListTrigger();
    if (chatListDropdownApi) {
      chatListDropdownApi.close();
      return;
    }
    if (embedChatListDropdownApi) {
      embedChatListDropdownApi.close();
      return;
    }
    const modal = document.getElementById('chat-list-modal');
    if (modal) modal.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function closeChatActionsModal() {
    chatActionsDropdownApi?.close?.();
  }

  function renderChatList() {
    updateChatBarSelect();
    refreshModelSelectLabels();
    if (!isChatListOpen()) return;
    openChatListModal();
  }

  function initDropdownWiring() {
    const chatBarTrigger = document.getElementById('chat-bar-trigger');
    const embedChatSwitcher = document.getElementById('embed-chat-switcher');
    const chatListModal = document.getElementById('chat-list-modal');
    const dropdownOptions = {
      floatingEl: chatListModal,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 220,
      maxHeightPx: 420,
    };
    const wireChatListTrigger = (triggerEl, storeApi) => {
      if (!triggerEl || !chatListModal) return;
      const api = initDropdown({ ...dropdownOptions, triggerEl });
      storeApi(api);
      triggerEl.addEventListener('click', () => {
        if (!api.isOpen()) openChatListModal();
        else closeChatListModal();
      });
      triggerEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!api.isOpen()) openChatListModal();
        else closeChatListModal();
      });
    };
    if (isEmbedMode() && embedChatSwitcher) {
      wireChatListTrigger(embedChatSwitcher, (api) => {
        embedChatListDropdownApi = api;
      });
    } else if (chatBarTrigger) {
      wireChatListTrigger(chatBarTrigger, (api) => {
        chatListDropdownApi = api;
      });
    }
    const chatToolbarMoreBtn = document.getElementById('chat-toolbar-more-btn');
    const chatToolbarActionsModal = document.getElementById('chat-toolbar-actions-modal');
    if (!chatToolbarMoreBtn || !chatToolbarActionsModal) return;
    chatActionsDropdownApi = initDropdown({
      triggerEl: chatToolbarMoreBtn,
      floatingEl: chatToolbarActionsModal,
      compact: true,
      placement: 'bottom-end',
      matchTriggerWidth: false,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 0,
      maxHeightPx: 220,
    });
    chatToolbarMoreBtn.addEventListener('click', () => {
      if (chatActionsDropdownApi?.isOpen()) {
        chatActionsDropdownApi.close();
        return;
      }
      chatListDropdownApi?.close?.();
      embedChatListDropdownApi?.close?.();
      chatActionsDropdownApi?.open();
    });
    chatToolbarMoreBtn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (chatActionsDropdownApi?.isOpen()) {
        chatActionsDropdownApi.close();
        return;
      }
      chatListDropdownApi?.close?.();
      embedChatListDropdownApi?.close?.();
      chatActionsDropdownApi?.open();
    });
  }

  function isChatListDropdownOpen() {
    return !!chatListDropdownApi?.isOpen?.() || !!embedChatListDropdownApi?.isOpen?.();
  }

  function isChatActionsDropdownOpen() {
    return !!chatActionsDropdownApi?.isOpen?.();
  }

  return {
    updateChatBarSelect,
    isChatListOpen,
    openChatListModal,
    closeChatListModal,
    closeChatActionsModal,
    renderChatList,
    initDropdownWiring,
    isChatListDropdownOpen,
    isChatActionsDropdownOpen,
  };
}

