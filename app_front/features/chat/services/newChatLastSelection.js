/** Last new-chat modal picks (harness/model and folder/worktree) persisted in localStorage. */
import { readLocalStorageSafe } from '../chatLocalStorage.js';

export const LAST_NEW_CHAT_LOCATION_KEY = 'cretli-new-chat-last-location';
export const LAST_NEW_CHAT_EXECUTOR_KEY = 'cretli-new-chat-last-executor';

/** Last harness/model picked in the new-chat modal (empty strings when none stored). */
export function readLastNewChatExecutor() {
  try {
    const row = JSON.parse(readLocalStorageSafe(LAST_NEW_CHAT_EXECUTOR_KEY, 'null'));
    return {
      harness: typeof row?.harness === 'string' ? row.harness : '',
      model: typeof row?.model === 'string' ? row.model : '',
    };
  } catch {
    return { harness: '', model: '' };
  }
}

/** Last folder/worktree picked in the new-chat modal, or null when none was stored. */
export function readLastNewChatLocation() {
  try {
    const row = JSON.parse(readLocalStorageSafe(LAST_NEW_CHAT_LOCATION_KEY, 'null'));
    const folder = typeof row?.folder === 'string' ? row.folder.trim() : '';
    return folder ? { folder, todoId: typeof row.todoId === 'string' ? row.todoId : '' } : null;
  } catch {
    return null;
  }
}
