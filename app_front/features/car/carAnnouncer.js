/**
 * Car-mode announcer: turns the 4-second agent polling into spoken news. State and wiring
 * only; the diff, repeat filter and rate limit live in `carAnnouncements.js`.
 */

import {
  announcementText,
  createAnnouncementScheduler,
  diffAgentAnnouncements,
  dropRepeatedAnnouncements,
} from './carAnnouncements.js';

/**
 * Adds a card key (sorted ids of the open cards of the chat) to every row, so a new card
 * of an already waiting chat counts as news.
 *
 * @param {import('./orchestratorModel.js').AgentRow[]} rows
 * @param {Array<Record<string, any>>} cards
 * @returns {import('./carAnnouncements.js').AnnounceRow[]}
 */
export function withCardKeys(rows, cards) {
  const ids = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    const chatId = String(card?.subject?.chatId || '');
    if (!chatId || !card.id) continue;
    if (!ids.has(chatId)) ids.set(chatId, []);
    ids.get(chatId).push(String(card.id));
  }
  return rows.map((row) => ({ ...row, cardKey: (ids.get(row.chatId) || []).sort().join(',') }));
}

/**
 * @typedef {{ mark: number|null, ready: Promise<void> }} RunMark
 *   history position taken when a chat started working; `ready` settles once it is read
 */

/**
 * @param {{
 *   say: (text: string, isCurrent: () => boolean) => void,
 *   translate: (key: string, vars?: object) => string,
 *   isOpen?: () => boolean,
 *   readMark?: (chatId: string) => Promise<number|null>,
 *   readReplySince?: (chatId: string, mark: number|null) => Promise<string>,
 *   cancelSpeech?: () => void,
 *   now?: () => number,
 *   scheduler?: Parameters<typeof createAnnouncementScheduler>[0],
 * }} deps
 */
export function createCarAnnouncer(deps) {
  const now = deps.now || (() => Date.now());
  const isOpen = deps.isOpen || (() => true);
  /** Bumped by `reset`: anything started in an earlier car session must stay silent. */
  let generation = 0;
  /** @type {import('./carAnnouncements.js').AnnounceRow[]|null} */
  let prevRows = null;
  /** @type {Map<string, number>} */
  const recent = new Map();
  /** One entry per run of a chat; a new working period replaces it. @type {Map<string, RunMark>} */
  const runs = new Map();
  /** @type {{ chatId: string, text: string }|null} */
  let last = null;

  /** @param {number} gen */
  const isCurrent = (gen) => () => gen === generation && isOpen();

  /**
   * @param {import('./carAnnouncements.js').AgentAnnouncement & { run?: RunMark, gen: number }} event
   * @param {number} more
   */
  async function speak(event, more) {
    const current = isCurrent(event.gen);
    if (!current()) return;
    let reply = '';
    // Only a reply written after this run started counts; without a mark only the news is said.
    if (event.kind === 'finished' && event.run && deps.readReplySince) {
      try {
        await event.run.ready;
        if (event.run.mark !== null) reply = String((await deps.readReplySince(event.chatId, event.run.mark)) || '').trim();
      } catch {
        reply = '';
      }
      if (!current()) return;
    }
    let text = announcementText(event, deps.translate, reply);
    if (more > 0) text = `${text} ${deps.translate('car.announce.more', { count: more })}`;
    last = { chatId: event.chatId, text };
    deps.say(text, current);
  }

  const scheduler = createAnnouncementScheduler({ now, ...deps.scheduler, speak: (event, more) => void speak(/** @type {any} */ (event), more) });

  /** Starts a new run mark for every chat that just entered `working`. */
  function trackRuns(before, rows) {
    for (const row of rows) {
      if (row.status !== 'working') {
        // A done row keeps its run: the finish announcement is spoken after this tick.
        if (row.status !== 'done') runs.delete(row.chatId);
        continue;
      }
      if (before.get(row.chatId)?.status === 'working' && runs.has(row.chatId)) continue;
      if (!deps.readMark) continue;
      /** @type {RunMark} */
      const run = { mark: null, ready: Promise.resolve() };
      run.ready = Promise.resolve(deps.readMark(row.chatId))
        .then((mark) => { run.mark = Number.isSafeInteger(mark) ? /** @type {number} */ (mark) : null; })
        .catch(() => {});
      runs.set(row.chatId, run);
    }
  }

  return {
    /**
     * Feeds the newest agent list. The first call only records the snapshot.
     *
     * @param {import('./carAnnouncements.js').AnnounceRow[]} rows
     * @returns {import('./carAnnouncements.js').AgentAnnouncement[]} events queued for speech
     */
    ingest(rows) {
      const before = new Map((prevRows || []).map((row) => [row.chatId, row]));
      const events = diffAgentAnnouncements(prevRows, rows);
      prevRows = rows;
      const fresh = dropRepeatedAnnouncements(events, recent, now());
      // The run is bound now: a new working period may replace it before the event is spoken.
      scheduler.push(fresh.map((event) => ({ ...event, run: runs.get(event.chatId), gen: generation })));
      trackRuns(before, rows);
      return fresh;
    },
    /** @returns {{ chatId: string, text: string }|null} newest spoken announcement */
    getLast: () => last,
    /** "What's new / repeat": speaks the newest announcement again. */
    repeat() {
      if (!last) return { ok: true, message: deps.translate('car.announce.nothing') };
      deps.say(last.text, isCurrent(generation));
      return { ok: true, message: last.text, chatId: last.chatId };
    },
    /** Ends the session: pending and queued announcements are dropped and late async work goes silent. */
    reset() {
      generation += 1;
      scheduler.cancel();
      deps.cancelSpeech?.();
      prevRows = null;
      recent.clear();
      runs.clear();
      last = null;
    },
  };
}
