/**
 * Normalizes page URLs for widget pin matching (ignores hash, trailing slashes).
 * @param raw
 */
export function normalizePageUrlForCompare(raw: string | null | undefined): string {
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
 * @param left
 * @param right
 */
export function isSamePageUrl(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizePageUrlForCompare(left);
  const normalizedRight = normalizePageUrlForCompare(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
}

type PinnedChat = { id?: string; widgetPinnedUrl?: string; updatedAt?: string; createdAt?: string };

function readChatRecencyStamp(chat: PinnedChat | null | undefined): number {
  const updated = Date.parse(chat?.updatedAt || '');
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(chat?.createdAt || '');
  return Number.isFinite(created) ? created : 0;
}

/**
 * Latest chat pinned to the page URL (newer updatedAt/createdAt wins).
 * @param chats
 * @param pageUrl
 */
export function findChatPinnedToPageUrl(chats: PinnedChat[], pageUrl: string): PinnedChat | null {
  if (!Array.isArray(chats) || !pageUrl) return null;
  let linked: PinnedChat | null = null;
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
