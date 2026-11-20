/** Reconnect modal of the Tasks panel (lazy: the DOM node may not exist until the shell renders). */
import { initModal } from '../../../lib/modal.js';

export function isTasksPanelActive() {
  if (typeof document === 'undefined') return false;
  return document.getElementById('tasks-panel')?.classList.contains('active') === true;
}

/** @param {{ onRetry: () => void }} options */
export function createTasksReconnectModal({ onRetry }) {
  let modalApi = null;

  function ensure() {
    if (modalApi) return modalApi;
    const modal = document.getElementById('tasks-reconnect-modal');
    if (!modal) return null;
    modalApi = initModal(modal);
    const retryBtn = document.getElementById('tasks-reconnect-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => onRetry());
    return modalApi;
  }

  return {
    show(message) {
      const api = ensure();
      if (!api) return;
      const text = document.getElementById('tasks-reconnect-text');
      if (text && message) text.textContent = message;
      api.open();
    },
    hide() {
      ensure()?.close();
    },
    close() {
      modalApi?.close?.();
    },
  };
}
