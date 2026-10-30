export const CHAT_SEND_BAR_RESERVE_CSS_VAR = '--chat-send-bar-reserve';

let chatSendBarReserveRaf = 0;
/** @type {ResizeObserver|null} */
let chatSendBarResizeObserver = null;

/** @param {number} px @param {number} [contextPx] */
export function setChatSendBarReserve(px, contextPx = 0) {
  if (typeof document === 'undefined') return;
  const reservePx = Math.max(0, Math.round(px || 0));
  document.documentElement.style.setProperty(CHAT_SEND_BAR_RESERVE_CSS_VAR, `${reservePx}px`);
  document.documentElement.style.setProperty('--chat-send-context-reserve', `${Math.max(0, Math.ceil(contextPx || 0))}px`);
}

/**
 * Distance from the top of a fixed send bar to the bottom of its pane.
 *
 * @param {HTMLElement | null} pane
 * @param {HTMLElement | null} bar
 * @param {boolean} [contextOnly] measure only the stack outside the bar
 * @returns {number}
 */
export function measureSendBarReserve(pane, bar, contextOnly = false) {
  if (!(pane instanceof HTMLElement) || !(bar instanceof HTMLElement)) return 0;
  const barRect = bar.getBoundingClientRect();
  let top = barRect.top;
  const stack = bar.querySelector('.send-keys-context-stack');
  if (stack instanceof HTMLElement && !stack.hidden) {
    const stackTop = stack.getBoundingClientRect().top;
    if (Number.isFinite(stackTop)) top = Math.min(top, stackTop);
  }
  const reserve = (contextOnly ? barRect.top : pane.getBoundingClientRect().bottom) - top;
  if (!Number.isFinite(reserve)) return 0;
  return Math.max(0, Math.ceil(reserve));
}

/**
 * Reserve space below the active pane for the fixed send bar.
 * Uses distance from bar top to pane bottom (not bar height alone).
 *
 * @param {{ contextOnly?: boolean }} [options]
 * @returns {number}
 */
export function getActiveChatSendBarReserve({ contextOnly = false } = {}) {
  if (typeof document === 'undefined') return 0;
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel?.classList.contains('active') && !chatPanel.classList.contains('hide-send-field')) {
    const activePane = chatPanel.querySelector('.chat-tab-pane.active');
    const bar = activePane instanceof HTMLElement
      ? activePane.querySelector('.chat-pane-toolbar.chat-send-bar')
      : null;
    return measureSendBarReserve(activePane, bar instanceof HTMLElement ? bar : null, contextOnly);
  }
  const terminalPanel = document.getElementById('terminal-panel');
  if (terminalPanel?.classList.contains('active')) {
    const activePane = terminalPanel.querySelector('.terminal-tab-pane.active');
    const bar = terminalPanel.querySelector('.terminal-send-bar-wrap');
    return measureSendBarReserve(
      activePane instanceof HTMLElement ? activePane : null,
      bar instanceof HTMLElement ? bar : null,
      contextOnly
    );
  }
  return 0;
}

export function syncChatSendBarReserveNow() {
  setChatSendBarReserve(
    getActiveChatSendBarReserve(),
    getActiveChatSendBarReserve({ contextOnly: true })
  );
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
