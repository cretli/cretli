/**
 * Decision cards for the car view: fetch open cards, answer one, keep one
 * shared choice flow so touch and voice drive the same pending pick.
 */

import { signal } from '@lit-labs/signals';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getTodoWorkspaceFolder, todoWorkspaceQuery } from '../todo/todoWorkspaceScope.js';
import { decisionRequestInit, sortDecisions } from '../decisions/decisionLogic.js';
import { createCarChoiceFlow } from './carChoice.js';
import { createSnoozeStore, cursorIndex, orderCarCards, stepCard } from './carCardNav.js';
import { setPendingChoiceProbe } from './carChoicePending.js';
import { buildNavCards, isLessonAggregateCard, withoutLessonCards } from './carLessons.js';

/** @type {import('@lit-labs/signals').Signal.State<Array<Record<string, any>>>} */
export const carCards = signal([]);

/** False after a failed cards fetch (any workspace): the view marks its data stale. */
export const carCardsFresh = signal(true);

const CARD_FETCH_CONCURRENCY = 4;

let loading = null;

/**
 * @param {Record<string, any>} workspace
 * @returns {string}
 */
function workspaceFolderOf(workspace) {
  return String(workspace?.workspaceFolder || workspace?.workspaceDir || '').trim();
}

/**
 * Open cards of the current workspace plus every other visible workspace.
 * One failing request keeps the others and reports `ok: false`.
 *
 * @param {{
 *   fetchJson: (query: string) => Promise<any>,
 *   currentQuery: string,
 *   workspaces?: Array<Record<string, any>>,
 *   currentFolder?: string,
 * }} deps
 * @returns {Promise<{ cards: Array<Record<string, any>>, ok: boolean }>}
 */
export async function fetchCardsAcrossWorkspaces(deps) {
  const queries = [deps.currentQuery];
  const seenFolders = new Set([String(deps.currentFolder || '').trim().toLowerCase()].filter(Boolean));
  for (const workspace of deps.workspaces || []) {
    const folder = workspaceFolderOf(workspace);
    const key = folder.toLowerCase();
    if (!folder || seenFolders.has(key)) continue;
    seenFolders.add(key);
    const parts = [`workspaceFolder=${encodeURIComponent(folder)}`];
    if (workspace.workspaceFile) parts.push(`workspaceFile=${encodeURIComponent(workspace.workspaceFile)}`);
    queries.push(`?${parts.join('&')}`);
  }
  const results = new Array(queries.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < queries.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await deps.fetchJson(queries[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CARD_FETCH_CONCURRENCY, queries.length) }, () => worker()));
  const byId = new Map();
  let ok = true;
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      ok = false;
      continue;
    }
    const items = Array.isArray(result.value?.items) ? result.value.items : [];
    for (const card of items) {
      if (card?.status === 'pending' && card.id) byId.set(card.id, card);
    }
  }
  return { cards: sortDecisions([...byId.values()]), ok };
}

/**
 * Open (pending) cards of every visible workspace, most urgent first.
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function refreshCarCards() {
  if (loading) return loading;
  loading = (async () => {
    try {
      let workspaces = [];
      try {
        const chatModule = await import('../chat/index.js');
        workspaces = chatModule.getWorkspacesList() || [];
      } catch {
        // Without the chat module only the current workspace is read.
      }
      const { cards, ok } = await fetchCardsAcrossWorkspaces({
        currentQuery: todoWorkspaceQuery(),
        currentFolder: getTodoWorkspaceFolder(),
        workspaces,
        fetchJson: async (query) => {
          const response = await cretliApiFetch(`/api/decisions${query}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        },
      });
      // A partial failure keeps the cards that did load but marks the data stale.
      if (ok || cards.length > 0) carCards.set(cards);
      carCardsFresh.set(ok);
    } catch {
      carCardsFresh.set(false);
    } finally {
      loading = null;
    }
    return carCards.get();
  })();
  return loading;
}

/**
 * @param {{ card: Record<string, any>, optionId: string, openedMs: number }} pick
 * @returns {Promise<{ ok: boolean, error?: string, stale?: boolean }>}
 */
export async function submitCarDecision({ card, optionId, openedMs }) {
  try {
    // The big-button screen is the card's detail view, so the anti-reflex "details opened" rule holds.
    const init = decisionRequestInit({ card, optionId, reason: '', gesture: false, detailsOpened: true, openedMs }, false);
    // A card of another workspace is answered in the workspace that owns it.
    const scope = card.workspaceFolder && card.workspaceFolder !== getTodoWorkspaceFolder()
      ? `?workspaceFolder=${encodeURIComponent(card.workspaceFolder)}`
      : '';
    const response = await cretliApiFetch(`/api/decisions/${encodeURIComponent(card.id)}${scope}`, init);
    if (response.status === 409) {
      void refreshCarCards();
      return { ok: false, stale: true, error: 'stale' };
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    carCards.set(carCards.get().filter((item) => item.id !== card.id));
    void refreshCarCards();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let flow = null;

/** @returns {ReturnType<typeof createCarChoiceFlow>} */
export function getCarChoiceFlow() {
  if (!flow) {
    flow = createCarChoiceFlow({
      // Review-lesson proposals are never decided from the car view, by touch or voice.
      getCards: () => withoutLessonCards(carCards.get()),
      submit: submitCarDecision });
    setPendingChoiceProbe(() => flow.getPending() !== null);
  }
  return flow;
}

/** Card under the driver's eyes; '' = the first visible card. */
export const carCursor = signal('');
/** Chat the view shows; its cards come first in the card order. Set by the view. */
export const carFocusChatId = signal('');
/** Bumped when a card is snoozed so signal readers re-evaluate the visible list. */
const snoozeTick = signal(0);

let snoozeStore = null;

/** @returns {ReturnType<typeof createSnoozeStore>} */
export function getCarSnoozeStore() {
  if (!snoozeStore) snoozeStore = createSnoozeStore();
  return snoozeStore;
}

/** Ordered, unsnoozed cards; review-lesson proposals are still inside. */
function getOrderedCarCards() {
  snoozeTick.get();
  return getCarSnoozeStore().visible(orderCarCards(carCards.get(), carFocusChatId.get()));
}

/** Cards in navigation order, snoozed ones and review-lesson proposals left out. */
export function getVisibleCarCards() {
  return withoutLessonCards(getOrderedCarCards());
}

/** What the screen pages through: the visible cards, then one aggregate card per workspace with lesson proposals. */
export function getCarNavCards() {
  return buildNavCards(getOrderedCarCards(), { includeAggregates: true });
}

/**
 * Voice-facing current card: never an aggregate (it has nothing to decide).
 *
 * @returns {Record<string, any>|null} */
export function getCurrentCarCard() {
  const cards = getVisibleCarCards();
  return cards[cursorIndex(cards, carCursor.get())] || null;
}

/** @returns {boolean} whether the screen shows a lessons aggregate card (nothing to decide by voice) */
export function isCarOnLessonsAggregate() {
  return isLessonAggregateCard(getCurrentCarEntry());
}

/** @returns {Record<string, any>|null} the card on screen, an aggregate card included */
export function getCurrentCarEntry() {
  const cards = getCarNavCards();
  return cards[cursorIndex(cards, carCursor.get())] || null;
}

/**
 * ‹ › navigation. Touch pages through the aggregate cards too; the "next / previous card"
 * voice commands (default) skip them.
 *
 * @param {number} direction 1 = next, -1 = previous
 * @param {{ includeAggregates?: boolean }} [opts]
 * @returns {{ card: Record<string, any>|null, index: number, total: number }}
 */
export function stepCarCard(direction, opts = {}) {
  const cards = opts.includeAggregates ? getCarNavCards() : getVisibleCarCards();
  // Voice paging from an aggregate card (not in its list) wraps to the first / last real card.
  if (!opts.includeAggregates && cards.length && isCarOnLessonsAggregate()) {
    const card = direction < 0 ? cards[cards.length - 1] : cards[0];
    getCarChoiceFlow().cancel();
    carCursor.set(card.id);
    return { card, index: cards.indexOf(card), total: cards.length };
  }
  const current = cards[cursorIndex(cards, carCursor.get())];
  const result = stepCard(cards, current?.id || '', direction);
  // A pick belongs to one card; leaving it must not leave a stale "Yes?" armed.
  if (result.card && result.card.id !== current?.id) getCarChoiceFlow().cancel();
  if (result.card) carCursor.set(result.card.id);
  return result;
}

/**
 * Hides a card locally for a while; nothing changes on the server.
 *
 * @param {string} cardId
 */
export function snoozeCarCard(cardId) {
  const cards = getCarNavCards();
  const at = cursorIndex(cards, cardId);
  getCarSnoozeStore().snooze(cardId);
  const flowPending = getCarChoiceFlow().getPending();
  if (flowPending?.cardId === cardId) getCarChoiceFlow().cancel();
  snoozeTick.set(snoozeTick.get() + 1);
  const rest = getCarNavCards();
  carCursor.set(rest.length ? rest[Math.min(at, rest.length - 1)].id : '');
}

/**
 * Plan text of the todo behind a plan card (existing todo API). '' when unavailable.
 *
 * @param {Record<string, any>} card
 * @returns {Promise<string>}
 */
export async function fetchCardPlanMarkdown(card) {
  const todoId = String(card?.subject?.todoId || '');
  if (!todoId) return '';
  try {
    const { getTodo } = await import('../../core/api/todos.js');
    const data = await getTodo(todoId, card.workspaceFolder || undefined);
    const item = data?.item || data;
    return typeof item?.plan?.markdown === 'string' ? item.plan.markdown : '';
  } catch {
    return '';
  }
}
