import { getWidgetHostPort } from './widgetHostScreenshot.js';

export { findChatPinnedToPageUrl, isSamePageUrl } from './pageUrlCompare.js';

/** @typedef {{ url: string }} HostUrlResult */

const pendingUrl = new Map();
const pendingNavigate = new Map();

/**
 * @param {string} message
 */
function rejectAllPending(message) {
  for (const [, entry] of pendingUrl.entries()) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error(message));
  }
  pendingUrl.clear();
  for (const [, entry] of pendingNavigate.entries()) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error(message));
  }
  pendingNavigate.clear();
}

export function cancelWidgetHostNavigationPending() {
  rejectAllPending('Connection to the host page was closed');
}

/**
 * @param {MessageEvent} event
 * @returns {boolean}
 */
export function handleWidgetHostNavigationMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return false;

  if (data.type === 'cretli-widget-get-url-result') {
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id || !pendingUrl.has(id)) return true;
    const entry = pendingUrl.get(id);
    pendingUrl.delete(id);
    clearTimeout(entry.timeoutId);
    if (data.ok && typeof data.url === 'string' && data.url.trim()) {
      entry.resolve({ url: data.url.trim() });
      return true;
    }
    entry.reject(new Error(String(data.error || 'Failed to read the host page URL')));
    return true;
  }

  if (data.type === 'cretli-widget-navigate-result') {
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id || !pendingNavigate.has(id)) return true;
    const entry = pendingNavigate.get(id);
    pendingNavigate.delete(id);
    clearTimeout(entry.timeoutId);
    if (data.ok) {
      entry.resolve({
        url: typeof data.url === 'string' ? data.url : entry.targetUrl,
        skipped: data.skipped === true,
      });
      return true;
    }
    entry.reject(new Error(String(data.error || 'Failed to navigate the host page')));
    return true;
  }

  return false;
}

export function isWidgetHostNavigationAvailable() {
  return !!getWidgetHostPort();
}

/**
 * @returns {Promise<HostUrlResult>}
 */
export function requestWidgetHostUrl() {
  const hostPort = getWidgetHostPort();
  if (!hostPort) {
    return Promise.reject(new Error('Reading the host page URL requires an embedded widget'));
  }
  const id = `url-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingUrl.delete(id);
      reject(new Error('Timed out waiting for the host page URL'));
    }, 15_000);
    pendingUrl.set(id, { resolve, reject, timeoutId });
    try {
      hostPort.postMessage({
        type: 'cretli-widget-get-url',
        id,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingUrl.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * @param {string} url
 * @returns {Promise<{ url: string, skipped?: boolean }>}
 */
export function navigateWidgetHost(url) {
  const hostPort = getWidgetHostPort();
  const targetUrl = String(url || '').trim();
  if (!hostPort) {
    return Promise.reject(new Error('Host page navigation requires an embedded widget'));
  }
  if (!targetUrl) {
    return Promise.reject(new Error('No URL to navigate to'));
  }
  const id = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingNavigate.delete(id);
      reject(new Error('Timed out waiting for host page navigation'));
    }, 30_000);
    pendingNavigate.set(id, { resolve, reject, timeoutId, targetUrl });
    try {
      hostPort.postMessage({
        type: 'cretli-widget-navigate',
        id,
        url: targetUrl,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingNavigate.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const PENDING_CHAT_PREFIX = 'cr-widget-pending-chat:v1:';

function getEmbedInstallationId() {
  if (typeof window === 'undefined') return '';
  return window.location.pathname.split('/').filter(Boolean)[1] || '';
}

/**
 * @param {string} chatId
 */
export function markPendingWidgetChatSelection(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const installationId = getEmbedInstallationId();
  if (!installationId) return;
  try {
    sessionStorage.setItem(`${PENDING_CHAT_PREFIX}${installationId}`, id);
  } catch {
    // sessionStorage may be unavailable.
  }
}

/**
 * @returns {string|null}
 */
export function consumePendingWidgetChatSelection() {
  const installationId = getEmbedInstallationId();
  if (!installationId) return null;
  const key = `${PENDING_CHAT_PREFIX}${installationId}`;
  try {
    const value = sessionStorage.getItem(key)?.trim() || '';
    sessionStorage.removeItem(key);
    return value || null;
  } catch {
    return null;
  }
}

export function clearPendingWidgetChatSelection() {
  consumePendingWidgetChatSelection();
}
