/**
 * Spoken announcements of agent status changes in car mode. Pure logic: the caller
 * passes agent rows (`buildAgentList`) and a clock; nothing here touches the DOM or speech.
 */

/** At most one spoken announcement per this many milliseconds; the rest is merged. */
export const ANNOUNCE_INTERVAL_MS = 5000;
/** How long the same event key stays suppressed. */
export const ANNOUNCE_REPEAT_TTL_MS = 60000;

/**
 * @typedef {import('./orchestratorModel.js').AgentRow & { cardKey?: string }} AnnounceRow
 * @typedef {{
 *   kind: 'waiting'|'finished'|'error', key: string, chatId: string, title: string,
 *   workspace: string, active: boolean,
 * }} AgentAnnouncement
 */

/** Most urgent first when several events are announced together. */
const KIND_PRIORITY = { waiting: 0, error: 1, finished: 2 };

/**
 * Event key: chat + kind + card, so a second card of the same chat is news again and a
 * re-detected transition is not.
 *
 * @param {string} kind
 * @param {AnnounceRow} row
 * @returns {string}
 */
function eventKey(kind, row) {
  return `${row.chatId}|${kind}|${row.cardKey || ''}`;
}

/**
 * A card that disappeared is not news; only an id that was not there before is.
 *
 * @param {string|undefined} prevKey
 * @param {string|undefined} nextKey comma-joined card ids
 * @returns {boolean}
 */
function hasNewCard(prevKey, nextKey) {
  const known = new Set(String(prevKey || '').split(',').filter(Boolean));
  return String(nextKey || '').split(',').filter(Boolean).some((id) => !known.has(id));
}

/**
 * Compares two consecutive agent lists. A missing `prevRows` is the initial snapshot and
 * announces nothing. The active chat finishing is not announced: its own spoken reply
 * covers it.
 *
 * @param {AnnounceRow[]|null|undefined} prevRows
 * @param {AnnounceRow[]} nextRows
 * @returns {AgentAnnouncement[]} most urgent first
 */
export function diffAgentAnnouncements(prevRows, nextRows) {
  if (!Array.isArray(prevRows)) return [];
  const before = new Map(prevRows.map((row) => [row.chatId, row]));
  /** @type {AgentAnnouncement[]} */
  const events = [];
  for (const row of Array.isArray(nextRows) ? nextRows : []) {
    const prev = before.get(row.chatId);
    /** @type {AgentAnnouncement['kind']|''} */
    let kind = '';
    if (row.status === 'needs_decision') {
      if (!prev || prev.status !== 'needs_decision' || hasNewCard(prev.cardKey, row.cardKey)) kind = 'waiting';
    } else if (row.status === 'error') {
      if (prev && prev.status !== 'error') kind = 'error';
    } else if (row.status === 'done') {
      if (prev && prev.status === 'working' && !row.active) kind = 'finished';
    }
    if (!kind) continue;
    events.push({
      kind, key: eventKey(kind, row), chatId: row.chatId, title: row.title,
      workspace: row.workspaceLabel, active: row.active === true,
    });
  }
  return events.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}

/**
 * Drops events whose key was announced within the TTL and records the survivors.
 *
 * @param {AgentAnnouncement[]} events
 * @param {Map<string, number>} recent key -> time announced (mutated)
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {AgentAnnouncement[]}
 */
export function dropRepeatedAnnouncements(events, recent, now, ttlMs = ANNOUNCE_REPEAT_TTL_MS) {
  for (const [key, at] of recent) {
    if (now - at > ttlMs) recent.delete(key);
  }
  const fresh = [];
  for (const event of events) {
    if (recent.has(event.key)) continue;
    recent.set(event.key, now);
    fresh.push(event);
  }
  return fresh;
}

/**
 * @param {AgentAnnouncement} event
 * @param {(key: string, vars?: object) => string} translate
 * @param {string} [shortReply] short `voice_reply` text of a finished chat
 * @returns {string}
 */
export function announcementText(event, translate, shortReply = '') {
  const vars = { workspace: event.workspace || '', chat: event.title };
  const reply = String(shortReply || '').trim();
  if (event.kind === 'finished' && reply) return `${translate('car.announce.replied', vars)} ${reply}`;
  const base = translate(`car.announce.${event.kind}`, vars);
  // Without a workspace the "<workspace>: " prefix would read as a dangling colon.
  return event.workspace ? base : base.replace(/^[:\s]+/, '');
}

/**
 * Rate-limited announcement queue. The first pending event is spoken when the interval
 * has passed; everything that piled up meanwhile becomes one "N more changes" sentence.
 *
 * @param {{
 *   speak: (event: AgentAnnouncement, more: number) => void,
 *   now?: () => number,
 *   intervalMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} options
 */
export function createAnnouncementScheduler(options) {
  const now = options.now || (() => Date.now());
  const intervalMs = options.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(/** @type {any} */ (id)));
  /** @type {AgentAnnouncement[]} */
  let pending = [];
  let lastSpokenAt = -Infinity;
  /** @type {unknown} */
  let timer = null;

  function flush() {
    timer = null;
    if (pending.length === 0) return;
    const wait = lastSpokenAt + intervalMs - now();
    if (wait > 0) {
      timer = setTimer(flush, wait);
      return;
    }
    const [first, ...rest] = pending.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
    pending = [];
    lastSpokenAt = now();
    options.speak(first, rest.length);
  }

  return {
    /** @param {AgentAnnouncement[]} events */
    push(events) {
      if (!events.length) return;
      pending.push(...events);
      if (timer === null) flush();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
      lastSpokenAt = -Infinity;
    },
    pendingCount: () => pending.length,
  };
}
