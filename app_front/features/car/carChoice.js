/**
 * Car view decision choice: logic only, no DOM and no network.
 *
 * A driver answers a decision card with one of 2-4 big buttons or a spoken
 * "option 2". Because a misheard word must not decide anything, every choice is
 * two steps: `choose` remembers the pick ("Choosing: X. Yes?") and `confirm`
 * sends it. Cards that only a person may decide (`humanOnly`) are selectable
 * and confirmable by touch only (`source: 'touch'`): the signed-in browser user
 * is the human, whereas a spoken pick (local voice or the Realtime agent) is
 * refused. A card that changed after the pick (status or revision) selects
 * nothing. Sending reuses the existing card API through
 * `submit`, with the card id and revision, and is idempotent per card+revision.
 */

import { createIdempotentRunner } from '../voice/commandHandlers.js';

export const CAR_MIN_OPTIONS = 2;
export const CAR_MAX_OPTIONS = 4;
/** Where a pick comes from; human-only cards accept `touch` alone. */
export const CAR_TOUCH = 'touch';
/** A pick that is not confirmed within this window is dropped. */
export const CAR_CONFIRM_TTL_MS = 30000;
const SHORT_LABEL_CHARS = 28;
export const HUMAN_ONLY_KINDS = new Set(['plan_approval', 'integration', 'policy_upgrade', 'doc_proposal']);

/**
 * @param {string} label
 * @returns {string}
 */
export function shortCarLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  return text.length > SHORT_LABEL_CHARS ? `${text.slice(0, SHORT_LABEL_CHARS - 1).trimEnd()}…` : text;
}

/**
 * @param {Record<string, any>|null|undefined} card
 * @returns {boolean}
 */
export function isHumanOnlyCard(card) {
  return card?.humanOnly === true || HUMAN_ONLY_KINDS.has(String(card?.kind || ''));
}

/**
 * @param {Record<string, any>|null|undefined} card
 * @param {unknown} source
 * @returns {boolean} whether this source may decide the card
 */
export function sourceMayDecide(card, source) {
  return !isHumanOnlyCard(card) || source === CAR_TOUCH;
}

/**
 * @typedef {{ index: number, id: string, label: string, recommended: boolean }} CarOption
 * @typedef {{
 *   ok: true, cardId: string, revision: number, chatId: string, workspaceFolder: string,
 *   title: string, humanOnly: boolean, options: CarOption[],
 * } | { ok: false, code: 'stale'|'human_only'|'bad_options' }} CarChoice
 */

/**
 * @param {Record<string, any>|null|undefined} card
 * @param {{ source?: string }} [opts] `touch` unlocks human-only cards
 * @returns {CarChoice}
 */
export function buildCarChoice(card, opts = {}) {
  if (!card || card.status !== 'pending' || !card.id) return { ok: false, code: 'stale' };
  if (!sourceMayDecide(card, opts.source)) return { ok: false, code: 'human_only' };
  const raw = Array.isArray(card.options) ? card.options : [];
  if (raw.length < CAR_MIN_OPTIONS || raw.length > CAR_MAX_OPTIONS) return { ok: false, code: 'bad_options' };
  const ids = new Set();
  const options = [];
  for (const option of raw) {
    const id = String(option?.id || '');
    // A repeated or empty id cannot be told apart by a number, so nothing is selectable.
    if (!id || ids.has(id)) return { ok: false, code: 'bad_options' };
    ids.add(id);
    options.push({
      index: options.length + 1,
      id,
      label: shortCarLabel(option.label || id),
      recommended: id === card.recommended,
    });
  }
  return {
    ok: true,
    cardId: String(card.id),
    revision: Number(card.revision),
    chatId: String(card.subject?.chatId || ''),
    workspaceFolder: String(card.workspaceFolder || ''),
    title: String(card.title || ''),
    humanOnly: isHumanOnlyCard(card),
    options,
  };
}

/**
 * Spoken/typed option reference -> 1-based index. Accepts digits and the
 * Polish/English number words 1-4.
 *
 * @param {unknown} value
 * @returns {number} 0 when it is not an option number
 */
export function parseOptionNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= CAR_MAX_OPTIONS ? value : 0;
  const text = String(value ?? '').toLowerCase().replace(/ł/g, 'l').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  const words = { jeden: 1, jedynka: 1, one: 1, first: 1, pierwsza: 1, pierwszy: 1, dwa: 2, dwojka: 2, two: 2, second: 2, druga: 2, drugi: 2, trzy: 3, trojka: 3, three: 3, third: 3, trzecia: 3, trzeci: 3, cztery: 4, czworka: 4, four: 4, fourth: 4, czwarta: 4, czwarty: 4 };
  if (/^[1-4]$/.test(text)) return Number(text);
  return words[text] || 0;
}

/**
 * @param {{
 *   getCards: () => Array<Record<string, any>>,
 *   submit: (pick: { card: Record<string, any>, optionId: string, openedMs: number }) => Promise<{ ok: boolean, error?: string, stale?: boolean }>,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} deps
 */
export function createCarChoiceFlow(deps) {
  const now = deps.now || (() => Date.now());
  const ttlMs = deps.ttlMs ?? CAR_CONFIRM_TTL_MS;
  const runOnce = createIdempotentRunner({ now, ttlMs: 10000 });
  /** @type {{ cardId: string, revision: number, optionId: string, label: string, index: number, at: number }|null} */
  let pending = null;

  const openCards = () => deps.getCards().filter((card) => card && card.status === 'pending');

  return {
    getPending() {
      if (pending && now() - pending.at > ttlMs) pending = null;
      return pending ? { ...pending } : null;
    },

    /**
     * @param {{ cardId?: string, option: unknown, source?: string }} args option is 1-4 or an option id;
     *   `source: 'touch'` is required for human-only cards
     * @returns {{ ok: true, needsConfirm: true, cardId: string, revision: number, optionId: string, label: string, index: number }
     *   | { ok: false, code: string }}
     */
    choose(args) {
      const cards = openCards();
      let card = null;
      if (args?.cardId) {
        card = cards.find((entry) => entry.id === args.cardId) || null;
        if (!card) return { ok: false, code: 'stale' };
      } else if (cards.length === 1) {
        card = cards[0];
      } else {
        return { ok: false, code: cards.length === 0 ? 'no_card' : 'ambiguous_card' };
      }
      const choice = buildCarChoice(card, { source: args?.source });
      if (choice.ok === false) return { ok: false, code: choice.code };
      const number = parseOptionNumber(args?.option);
      const picked = number
        ? choice.options[number - 1]
        : choice.options.find((option) => option.id === String(args?.option ?? ''));
      if (!picked) return { ok: false, code: 'bad_option' };
      pending = {
        cardId: choice.cardId,
        revision: choice.revision,
        optionId: picked.id,
        label: picked.label,
        index: picked.index,
        at: now(),
      };
      return { ok: true, needsConfirm: true, ...pending };
    },

    cancel() {
      const had = Boolean(pending);
      pending = null;
      return { ok: had, ...(had ? {} : { code: 'nothing_to_cancel' }) };
    },

    /**
     * @param {{ source?: string }} [args] `touch` is required for human-only cards
     * @returns {Promise<{ ok: boolean, code?: string, error?: string, cardId?: string, optionId?: string }>}
     */
    async confirm(args = {}) {
      const current = this.getPending();
      if (!current) return { ok: false, code: 'nothing_to_confirm' };
      const card = openCards().find((entry) => entry.id === current.cardId);
      // A spoken "yes" must not send a touch-made human-only pick; the pick stays for the touch confirm.
      if (card && !sourceMayDecide(card, args.source)) return { ok: false, code: 'human_only' };
      const choice = buildCarChoice(card, { source: args.source });
      if (!card || !choice.ok || choice.revision !== current.revision
        || !choice.options.some((option) => option.id === current.optionId)) {
        pending = null;
        return { ok: false, code: choice.ok === false ? choice.code : 'stale' };
      }
      pending = null;
      const result = await runOnce(`${current.cardId}:${current.revision}`, () => deps.submit({
        card,
        optionId: current.optionId,
        openedMs: Math.max(0, now() - current.at),
      }));
      return result.ok
        ? { ok: true, cardId: current.cardId, optionId: current.optionId }
        : { ok: false, code: /** @type {any} */ (result).stale ? 'stale' : 'send_failed', error: result.error };
    },
  };
}
