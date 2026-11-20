/**
 * Pure auto-archive countdown model for one sidebar chat row.
 *
 * Mirrors the server sweep window (`lib/chat-auto-archive.js`): a chat becomes
 * eligible once `updatedAt + idleMs` has passed. With `skipUnread` the window
 * starts at the later of `updatedAt` and `lastSeenAt`, and an unread result hides
 * the chip altogether. "Postpone archiving" (`autoArchivePostponedAt`) restarts
 * the window from the chat banner. The server re-checks liveness and pins at sweep time, so this is only an estimate, and it is shown only for
 * rows that currently look idle (no live run, no pending question).
 *
 * Archiving a parent cascades over its fork subtree, and the server refuses the
 * whole family while any member is busy, pinned, starred or unread. So a parent
 * row is judged together with its descendants: any blocking descendant hides
 * the chip, and the deadline is the latest one across the family.
 *
 * The countdown has two visual tones so the icon can animate faster as the
 * deadline gets close: `archive-soon` while inside the warning window and
 * `archive-imminent` for the final slice of it.
 */

export const ARCHIVE_COUNTDOWN_SOON_TONE = 'archive-soon';
export const ARCHIVE_COUNTDOWN_IMMINENT_TONE = 'archive-imminent';

/** Keep in sync with `TECHNICAL_TITLE_RE` in lib/chat-retention.js. */
const TECHNICAL_TITLE_RE = /^\s*\[(?:Watcher|Merge|Todo plan|Scout)\]/i;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The warning window never starts earlier than two minutes before the deadline. */
const MIN_WARN_MS = 2 * MINUTE_MS;
/** ... and never looks further ahead than three days, however long the window. */
const MAX_WARN_MS = 3 * DAY_MS;
/** The "imminent" tone holds for at least a minute ... */
const MIN_IMMINENT_MS = MINUTE_MS;
/** ... and at most an hour. */
const MAX_IMMINENT_MS = HOUR_MS;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * How long before the deadline the countdown starts showing, scaled to the idle
 * window (last ~10%) but clamped so a one-minute window still warns at all and a
 * 365-day window does not warn for weeks.
 *
 * @param {number} idleMs
 * @returns {number}
 */
export function resolveArchiveCountdownWarnMs(idleMs) {
  const windowMs = Number(idleMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return Math.min(windowMs * 0.5, clamp(windowMs * 0.1, MIN_WARN_MS, MAX_WARN_MS));
}

/**
 * How long before the deadline the countdown switches to the urgent tone.
 *
 * @param {number} idleMs
 * @param {number} [warnMs]
 * @returns {number}
 */
export function resolveArchiveCountdownImminentMs(idleMs, warnMs = resolveArchiveCountdownWarnMs(idleMs)) {
  const windowMs = Number(idleMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return Math.min(warnMs, clamp(windowMs * 0.02, MIN_IMMINENT_MS, MAX_IMMINENT_MS));
}

/**
 * Compact remaining-time label for the row chip: `<1m`, `45m`, `3h20m`, `2d4h`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatArchiveCountdown(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < MINUTE_MS) return '<1m';
  if (total < HOUR_MS) return `${Math.floor(total / MINUTE_MS)}m`;
  if (total < DAY_MS) {
    const hours = Math.floor(total / HOUR_MS);
    const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
    return hours < 10 && minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  return days < 10 && hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Mirrors `isChatResultUnread` in lib/chat-auto-archive.js: technical chats are
 * normally never opened, so their unread results do not hold them back.
 *
 * @param {Record<string, any>} chat
 * @returns {boolean}
 */
function isChatResultUnread(chat) {
  if (TECHNICAL_TITLE_RE.test(String(chat.title || chat.name || ''))) return false;
  if (chat.delegationParentChatId || chat.delegationRootChatId) return false;
  const finishedMs = Date.parse(String(chat.lastFinishedAt || ''));
  if (!Number.isFinite(finishedMs)) return false;
  const seenMs = Date.parse(String(chat.lastSeenAt || ''));
  return !Number.isFinite(seenMs) || seenMs < finishedMs;
}

/**
 * Start of a chat's idle window, or `null` when the chat keeps its family out of
 * the sweep (pinned, starred, not idle, unread, or an unparseable `updatedAt`).
 *
 * @param {Record<string, any>} chat
 * @param {{ state?: string, isFavorite?: boolean }} member
 * @param {{ skipFavorites?: boolean, skipUnread?: boolean }} config
 * @returns {number | null}
 */
function memberActivityMs(chat, member, config) {
  if (!chat || typeof chat !== 'object') return null;
  if (chat.watcherPinned === true) return null;
  // The server sweep skips starred chats (and their families) by default.
  if (config.skipFavorites !== false && member.isFavorite === true) return null;
  // Only rows the sidebar paints as plain idle. A live run or a pending question
  // keeps the chat out of the sweep (and its own status chip takes priority),
  // while a disconnected chip stays a connection warning rather than a deadline.
  if (String(member.state || '') !== 'idle') return null;
  const updatedMs = Date.parse(String(chat.updatedAt || ''));
  if (!Number.isFinite(updatedMs)) return null;
  const skipUnread = config.skipUnread !== false;
  if (skipUnread && isChatResultUnread(chat)) return null;
  const seenMs = Date.parse(String(chat.lastSeenAt || ''));
  const postponedMs = Date.parse(String(chat.autoArchivePostponedAt || ''));
  let activityMs = skipUnread && Number.isFinite(seenMs) ? Math.max(updatedMs, seenMs) : updatedMs;
  if (Number.isFinite(postponedMs)) activityMs = Math.max(activityMs, postponedMs);
  return activityMs;
}

/**
 * Non-archived fork descendants of `chatId` (cycle-safe), for the family check.
 *
 * @param {string} chatId
 * @param {Iterable<Record<string, any>>} chats
 * @returns {Record<string, any>[]}
 */
export function collectChatForkDescendants(chatId, chats) {
  const rootId = String(chatId || '').trim();
  if (!rootId || !chats) return [];
  /** @type {Map<string, Record<string, any>[]>} */
  const byParent = new Map();
  for (const chat of chats) {
    const parentId = String(chat?.forkParentChatId || '').trim();
    if (!parentId) continue;
    if (chat.archived === true || String(chat.archivedAt || '').trim()) continue;
    const list = byParent.get(parentId);
    if (list) list.push(chat);
    else byParent.set(parentId, [chat]);
  }
  const out = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const children = byParent.get(/** @type {string} */ (queue.shift())) || [];
    for (const child of children) {
      const id = String(child?.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(child);
      queue.push(id);
    }
  }
  return out;
}

/**
 * Resolve the countdown chip for a chat, or `null` when it should stay hidden.
 *
 * @param {object | null | undefined} chat
 * @param {{
 *   now?: number,
 *   config?: { enabled?: boolean, idleMs?: number, skipFavorites?: boolean, skipUnread?: boolean } | null,
 *   state?: string,
 *   isFavorite?: boolean,
 *   descendants?: { chat: Record<string, any>, state?: string, isFavorite?: boolean }[],
 * }} [options]
 * @returns {{ remainingMs: number, warnMs: number, label: string, tone: string } | null}
 */
export function resolveChatArchiveCountdown(chat, options = {}) {
  const config = options.config;
  if (!config || config.enabled !== true) return null;
  const idleMs = Number(config.idleMs);
  if (!Number.isFinite(idleMs) || idleMs <= 0) return null;
  if (!chat || typeof chat !== 'object') return null;
  if (/** @type {any} */ (chat).archived === true || String(/** @type {any} */ (chat).archivedAt || '').trim()) return null;
  let activityMs = memberActivityMs(/** @type {Record<string, any>} */ (chat), options, config);
  if (activityMs === null) return null;
  // A busy, pinned, starred or unread descendant keeps the whole family (and so
  // this parent) out of the sweep; otherwise the family goes with its latest member.
  for (const member of Array.isArray(options.descendants) ? options.descendants : []) {
    const memberMs = memberActivityMs(member?.chat, member || {}, config);
    if (memberMs === null) return null;
    activityMs = Math.max(activityMs, memberMs);
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const remainingMs = Math.max(0, activityMs + idleMs - now);
  const warnMs = resolveArchiveCountdownWarnMs(idleMs);
  if (remainingMs > warnMs) return null;
  const imminentMs = resolveArchiveCountdownImminentMs(idleMs, warnMs);
  return {
    remainingMs,
    warnMs,
    label: formatArchiveCountdown(remainingMs),
    tone: remainingMs <= imminentMs
      ? ARCHIVE_COUNTDOWN_IMMINENT_TONE
      : ARCHIVE_COUNTDOWN_SOON_TONE,
  };
}
