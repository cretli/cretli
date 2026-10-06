/**
 * Chat archive confirmation helpers.
 *
 * Archiving a chat in Cretli is a cascade: the server stamps the clicked chat
 * plus its whole fork subtree (`forkParentChatId`). The sidebar confirm must
 * therefore show the real blast radius, and the user may opt out of the prompt
 * permanently — this module keeps those decisions pure and unit-testable.
 */

import { collectForkSubtreeIds, isChatArchived } from '../../../lib/chat-tree.js';

/**
 * Live (not yet archived) rows in the clicked chat's fork subtree.
 *
 * @param {object[] | null | undefined} chats
 * @param {string} chatId
 * @returns {{ total: number, subchats: number }}
 */
export function countArchiveSubtree(chats, chatId) {
  const rootId = String(chatId || '').trim();
  const ids = collectForkSubtreeIds(chats, rootId);
  let total = 0;
  let subchats = 0;
  for (const chat of Array.isArray(chats) ? chats : []) {
    const id = String(chat?.id || '').trim();
    if (!id || !ids.has(id) || isChatArchived(chat)) continue;
    total += 1;
    if (id !== rootId) subchats += 1;
  }
  return { total, subchats };
}

/**
 * Polish/English plural category for the "{count} chats" confirm text.
 *
 * @param {number} count
 * @param {string} [lang]
 * @returns {'one' | 'few' | 'many' | 'other'}
 */
export function resolveArchiveConfirmPluralCategory(count, lang = 'en') {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (String(lang).toLowerCase().startsWith('pl')) {
    if (n === 1) return 'one';
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'few';
    return 'many';
  }
  return n === 1 ? 'one' : 'other';
}

/**
 * Confirm text for the archive dialog. `t()` does not resolve plural objects,
 * so the category key is picked first (`chat.archiveConfirmCount.*`).
 *
 * @param {number} total
 * @param {number} subchats
 * @param {(key: string, vars?: Record<string, string|number>) => string} translate
 * @param {string} [lang]
 * @returns {string}
 */
export function buildArchiveConfirmMessage(total, subchats, translate, lang = 'en') {
  const tFn = typeof translate === 'function' ? translate : (key) => key;
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  if (count <= 1) return tFn('chat.archiveConfirmSingle');
  const vars = {
    count: String(count),
    subchats: String(Math.max(0, Math.trunc(Number(subchats) || 0))),
  };
  const key = `chat.archiveConfirmCount.${resolveArchiveConfirmPluralCategory(count, lang)}`;
  const label = tFn(key, vars);
  return label === key ? tFn('chat.archiveConfirmCount.other', vars) : label;
}
