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
 * @param {object | null | undefined} chat
 * @returns {number}
 */
function readChatRecencyStamp(chat) {
  const updated = Date.parse(chat?.updatedAt || '');
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(chat?.createdAt || '');
  return Number.isFinite(created) ? created : 0;
}

/**
 * Latest chat pinned to the page URL (newer updatedAt/createdAt wins).
 * @param {Array<{ id?: string, widgetPinnedUrl?: string, updatedAt?: string, createdAt?: string }>} chats
 * @param {string} pageUrl
 * @returns {{ id?: string, widgetPinnedUrl?: string } | null}
 */
export function findChatPinnedToPageUrl(chats, pageUrl) {
  if (!Array.isArray(chats) || !pageUrl) return null;
  let linked = null;
  let linkedAt = Number.NEGATIVE_INFINITY;
  for (const chat of chats) {
    const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
    if (!pinnedUrl || !isSamePageUrl(pinnedUrl, pageUrl)) continue;
    const stamp = readChatRecencyStamp(chat);
    if (!linked || stamp >= linkedAt) {
      linked = chat;
      linkedAt = stamp;
    }
  }
  return linked;
}
