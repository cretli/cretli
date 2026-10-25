/** Workspace grouping pipeline shared by sidebar render passes. */

import { partitionChatsByArchive, flattenChatsTree } from '../../../../lib/chat-tree.js';
import { groupSettledChildren } from '../sidebarSubchatGroups.js';

/**
 * Split and group workspace chats without touching the DOM.
 * @param {object[]} chats
 * @param {{ activeChatId?: string, searching?: boolean, isFavorite?: (id: string) => boolean, isExpanded?: (parentId: string) => boolean }} options
 */
export function buildSidebarWorkspaceGroups(chats, options = {}) {
  const { live, archived } = partitionChatsByArchive(Array.isArray(chats) ? chats : []);
  const tree = flattenChatsTree(live);
  const grouped = groupSettledChildren(tree, {
    isFavorite: typeof options.isFavorite === 'function' ? options.isFavorite : () => false,
    activeChatId: options.activeChatId || '',
    searching: options.searching === true,
    isExpanded: typeof options.isExpanded === 'function' ? options.isExpanded : () => false,
  });
  return { live, archived, grouped, tree };
}
