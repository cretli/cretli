export const CHAT_SEND_BAR_RESERVE_CSS_VAR = '--chat-send-bar-reserve';

let chatSendBarReserveRaf = 0;
/** @type {ResizeObserver|null} */
let chatSendBarResizeObserver = null;

/** @param {number} px */
export function setChatSendBarReserve(px) {
  if (typeof document === 'undefined') return;
  const reservePx = Math.max(0, Math.round(px || 0));
  document.documentElement.style.setProperty(CHAT_SEND_BAR_RESERVE_CSS_VAR, `${reservePx}px`);
}

/**
 * Reserve space below chat for the fixed send bar on mobile.
 * Uses distance from bar top to pane bottom (not bar height alone).
 *
 * @returns {number}
 */
export function getActiveChatSendBarReserve() {
  if (typeof document === 'undefined') return 0;
  const panel = document.getElementById('chat-panel');
  if (!panel || !panel.classList.contains('active')) return 0;
  if (panel.classList.contains('hide-send-field')) return 0;
  const activePane = panel.querySelector('.chat-tab-pane.active');
  if (!(activePane instanceof HTMLElement)) return 0;
  const bar = activePane.querySelector('.chat-pane-toolbar.chat-send-bar');
  if (!(bar instanceof HTMLElement)) return 0;
  const barRect = bar.getBoundingClientRect();
  const paneRect = activePane.getBoundingClientRect();
  const reserve = paneRect.bottom - barRect.top;
  if (!Number.isFinite(reserve)) return 0;
  return Math.max(0, Math.round(reserve));
}

export function syncChatSendBarReserveNow() {
  setChatSendBarReserve(getActiveChatSendBarReserve());
}

export function scheduleChatSendBarReserveSync() {
  if (typeof window === 'undefined') return;
  if (chatSendBarReserveRaf) cancelAnimationFrame(chatSendBarReserveRaf);
  chatSendBarReserveRaf = requestAnimationFrame(() => {
    chatSendBarReserveRaf = 0;
    syncChatSendBarReserveNow();
  });
}

/** @returns {ResizeObserver|null} */
export function getChatSendBarResizeObserver() {
  return chatSendBarResizeObserver;
}

/** @param {ResizeObserver|null} observer */
export function setChatSendBarResizeObserver(observer) {
  chatSendBarResizeObserver = observer;
}
