import { t } from '../../i18n/index.js';

/**
 * Widget URL pin UI helpers (embed mode).
 *
 * @param {boolean} embedMode
 * @param {() => boolean} isWidgetHostNavigationAvailable
 * @param {object|null} [chat]
 */
export function syncWidgetPinUrlUi(embedMode, isWidgetHostNavigationAvailable, chat = null) {
  if (typeof document === 'undefined') return;
  const pinMenuBtn = document.getElementById('chat-pin-url-menu-btn');
  const el = pinMenuBtn;
  if (!(el instanceof HTMLElement)) return;
  el.hidden = !embedMode || !isWidgetHostNavigationAvailable();
  if (el.hidden) return;
  const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  const pinned = !!pinnedUrl;
  el.dataset.pinned = pinned ? 'on' : 'off';
  el.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  el.title = pinned
    ? t('chatUi.unpinChatFromUrl', { url: pinnedUrl })
    : t('chatUi.pinChatToCurrentUrl');
  el.setAttribute('aria-label', el.title);
  const icon = el.querySelector('.mdi');
  if (icon) {
    icon.className = pinned ? 'mdi mdi-link-variant-off' : 'mdi mdi-link-variant';
  }
  const label = el.querySelector('.chat-toolbar-action-label');
  if (label) {
    label.textContent = pinned ? t('chatUi.unpinFromUrlShort') : t('chatUi.pinToUrlShort');
  }
}

/**
 * @param {object|null|undefined} chat
 * @returns {string|null}
 */
export function getChatWidgetPinnedUrl(chat) {
  const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  return pinnedUrl || null;
}

/** @param {boolean} embedMode */
export function notifyWidgetParentPagePinChanged(embedMode) {
  if (typeof window === 'undefined' || !embedMode) return;
  try {
    window.parent?.postMessage({ type: 'cretli-widget-page-pin-changed' }, '*');
  } catch {
    // ignore
  }
}
