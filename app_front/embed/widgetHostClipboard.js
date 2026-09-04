import { getWidgetHostPort } from './widgetHostScreenshot.js';

/** @typedef {{ resolve: (value: true) => void, reject: (reason?: unknown) => void, timeoutId: ReturnType<typeof setTimeout> }} PendingCopyEntry */

/** @type {Map<string, PendingCopyEntry>} */
const pendingCopy = new Map();

/**
 * @param {string} message
 */
function rejectAllPending(message) {
  for (const [, entry] of pendingCopy.entries()) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error(message));
  }
  pendingCopy.clear();
}

export function cancelWidgetHostClipboardPending() {
  rejectAllPending('Connection to the host page was closed');
}

/**
 * @param {MessageEvent} event
 * @returns {boolean}
 */
export function handleWidgetHostClipboardMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return false;
  if (data.type !== 'cretli-widget-copy-text-result') return false;

  const id = typeof data.id === 'string' ? data.id : '';
  if (!id || !pendingCopy.has(id)) return true;

  const entry = pendingCopy.get(id);
  pendingCopy.delete(id);
  clearTimeout(entry.timeoutId);

  if (data.ok) {
    entry.resolve(true);
    return true;
  }

  entry.reject(new Error(String(data.error || 'Failed to copy text on the host page')));
  return true;
}

export function isWidgetHostClipboardAvailable() {
  return !!getWidgetHostPort();
}

/**
 * @param {string} text
 * @returns {Promise<true>}
 */
export function requestWidgetHostCopyText(text) {
  const hostPort = getWidgetHostPort();
  const value = String(text ?? '');
  if (!hostPort) {
    return Promise.reject(new Error('Copying on the host page requires an embedded widget'));
  }
  if (!value) {
    return Promise.reject(new Error('No text to copy'));
  }

  const id = `copy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingCopy.delete(id);
      reject(new Error('Timed out waiting for the host page clipboard copy'));
    }, 10_000);
    pendingCopy.set(id, { resolve, reject, timeoutId });
    try {
      hostPort.postMessage({
        type: 'cretli-widget-copy-text',
        id,
        text: value,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingCopy.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
