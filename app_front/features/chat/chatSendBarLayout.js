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
 * Distance from the top of a fixed send bar to the bottom of its pane.
 *
 * @param {HTMLElement | null} pane
 * @param {HTMLElement | null} bar
 * @returns {number}
 */
function measureSendBarReserve(pane, bar) {
  if (!(pane instanceof HTMLElement) || !(bar instanceof HTMLElement)) return 0;
  const reserve = pane.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
  if (!Number.isFinite(reserve)) return 0;
  return Math.max(0, Math.round(reserve));
}

/**
 * Reserve space below the active pane for the fixed send bar.
 * Uses distance from bar top to pane bottom (not bar height alone).
 *
 * @returns {number}
 */
export function getActiveChatSendBarReserve() {
  if (typeof document === 'undefined') return 0;
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel?.classList.contains('active') && !chatPanel.classList.contains('hide-send-field')) {
    const activePane = chatPanel.querySelector('.chat-tab-pane.active');
    const bar = activePane instanceof HTMLElement
      ? activePane.querySelector('.chat-pane-toolbar.chat-send-bar')
      : null;
    return measureSendBarReserve(activePane, bar instanceof HTMLElement ? bar : null);
  }
  const terminalPanel = document.getElementById('terminal-panel');
  if (terminalPanel?.classList.contains('active')) {
    const activePane = terminalPanel.querySelector('.terminal-tab-pane.active');
    const bar = terminalPanel.querySelector('.terminal-send-bar-wrap');
    return measureSendBarReserve(
      activePane instanceof HTMLElement ? activePane : null,
      bar instanceof HTMLElement ? bar : null
    );
  }
  return 0;
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
