/**
 * Reuse one Implementation plan card across CreatePlan snapshots.
 * Streaming/history persist one room seq per snapshot, so catch-up must
 * not spawn a new card for the same call id.
 */

import { pickRicherPlanMarkdown, stripChatPlanComment } from '../chat-plan-markdown.js';

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function isPlaceholderSdkPlanMarkdown(text) {
  const raw = stripChatPlanComment(text);
  if (!raw) return true;
  if (raw === '{}') return true;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    if (keys.length === 1 && keys[0] === 'plan') {
      const plan = /** @type {{ plan?: unknown }} */ (parsed).plan;
      return plan == null || String(plan).trim() === '';
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {{ callId?: string, text?: string } | null | undefined} card
 * @param {{ callId?: string, text?: string } | null | undefined} keeper
 * @returns {boolean}
 */
export function shouldFoldSdkPlanCard(card, keeper) {
  if (!card || !keeper || card === keeper) return false;
  const keepId = String(keeper.callId || '').trim();
  const cardId = String(card.callId || '').trim();
  if (keepId && cardId && keepId === cardId) return true;
  if (keepId && !cardId && isPlaceholderSdkPlanMarkdown(card.text)) return true;
  if (!keepId && !cardId) {
    if (isPlaceholderSdkPlanMarkdown(card.text)) return true;
    return stripChatPlanComment(card.text) === stripChatPlanComment(keeper.text);
  }
  return false;
}

/**
 * @param {Array<{ status?: string, text?: string }>} cards
 * @returns {{ status?: string, text?: string } | null}
 */
export function pickSdkPlanKeeper(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  let best = cards[0];
  for (let i = 1; i < cards.length; i += 1) {
    const card = cards[i];
    const bestText = String(best?.text || '');
    const cardText = String(card?.text || '');
    const bestPlaceholder = isPlaceholderSdkPlanMarkdown(bestText);
    const cardPlaceholder = isPlaceholderSdkPlanMarkdown(cardText);
    if (bestPlaceholder && !cardPlaceholder) {
      best = card;
      continue;
    }
    if (!bestPlaceholder && cardPlaceholder) continue;
    const bestCompleted = String(best?.status || '').toLowerCase() === 'completed';
    const cardCompleted = String(card?.status || '').toLowerCase() === 'completed';
    if (cardCompleted && !bestCompleted) {
      best = card;
      continue;
    }
    if (!cardCompleted && bestCompleted) continue;
    const richer = pickRicherPlanMarkdown(bestText, cardText);
    if (richer === stripChatPlanComment(cardText) && stripChatPlanComment(cardText) !== stripChatPlanComment(bestText)) {
      best = card;
    }
  }
  return best;
}

/**
 * Empty CreatePlan args must not replace a full card already on screen.
 *
 * @param {unknown} current
 * @param {unknown} incoming
 * @returns {string}
 */
export function mergeSdkPlanMarkdown(current, incoming) {
  if (isPlaceholderSdkPlanMarkdown(incoming)) {
    return stripChatPlanComment(current);
  }
  return pickRicherPlanMarkdown(current, incoming);
}
