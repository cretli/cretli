/**
 * Normalizes page URLs for widget pin matching (ignores hash, trailing slashes).
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizePageUrlForCompare(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    let pathname = url.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const host = url.hostname.toLowerCase();
    const protocol = url.protocol.toLowerCase();
    const defaultPort = protocol === 'https:' ? '443' : '80';
    const port = url.port || defaultPort;
    const portPart = port === defaultPort ? '' : `:${port}`;
    const search = url.search || '';
    return `${protocol}//${host}${portPart}${pathname}${search}`;
  } catch {
    const trimmed = text.replace(/\/+$/, '');
    return trimmed || text;
  }
}

/**
 * @param {string | null | undefined} left
 * @param {string | null | undefined} right
 * @returns {boolean}
 */
export function isSamePageUrl(left, right) {
  const normalizedLeft = normalizePageUrlForCompare(left);
  const normalizedRight = normalizePageUrlForCompare(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
}

/**
 * @param {Array<{ id?: string, widgetPinnedUrl?: string }>} chats
 * @param {string} pageUrl
 * @returns {{ id?: string, widgetPinnedUrl?: string } | null}
 */
export function findChatPinnedToPageUrl(chats, pageUrl) {
  if (!Array.isArray(chats) || !pageUrl) return null;
  return chats.find((chat) => {
    const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
    return pinnedUrl && isSamePageUrl(pinnedUrl, pageUrl);
  }) || null;
}
