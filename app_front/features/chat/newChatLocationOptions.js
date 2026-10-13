import { readLocalStorageSafe, writeLocalStorageSafe } from './chatLocalStorage.js';

const FAVORITES_KEY = 'cretli-chat-favorite-locations';

/** Store the folder and optional worktree id in one unambiguous picker value. */
export function encodeNewChatLocation(folder, todoId = '') {
  return JSON.stringify([folder, todoId]);
}

/** Reject malformed choices before they reach the native form backing fields. */
export function decodeNewChatLocation(value) {
  try {
    const pair = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string') && pair[0]
      ? { folder: pair[0], todoId: pair[1] } : null;
  } catch {
    return null;
  }
}

/** Read persisted location favorites without retaining stale cross-tab state. */
export function readNewChatLocationFavorites() {
  try {
    const rows = JSON.parse(readLocalStorageSafe(FAVORITES_KEY, '[]'));
    return new Set(Array.isArray(rows) ? rows.filter((value) => decodeNewChatLocation(value)) : []);
  } catch {
    return new Set();
  }
}

/** Toggle one location without affecting the selected folder or worktree. */
export function toggleNewChatLocationFavorite(value) {
  if (!decodeNewChatLocation(value)) return;
  const favorites = readNewChatLocationFavorites();
  if (favorites.has(value)) favorites.delete(value);
  else favorites.add(value);
  writeLocalStorageSafe(FAVORITES_KEY, JSON.stringify([...favorites]), 'locationFavorites');
}

/** Group project folders and worktrees, preserving folder identity across equal branch names. */
export function buildNewChatLocationOptions(folders, worktrees, favorites, t, locale) {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  return [...folders].sort((a, b) => compare(a.label, b.label)).flatMap((folder) => {
    const entries = [{ todoId: '', label: t('chat.newWorktreeNone'), path: folder.value },
      ...(worktrees.get(folder.value) || []).filter((row) => row.todoId).map((row) => ({
        todoId: row.todoId, label: row.title ? `${row.branch} — ${row.title}` : row.branch,
        path: row.worktreePath || folder.value,
      })).sort((a, b) => compare(a.label, b.label))];
    return entries.map((entry) => {
      const value = encodeNewChatLocation(folder.value, entry.todoId);
      return { value, label: entry.label, group: folder.label, description: entry.path,
        keywords: `${folder.value} ${entry.todoId}`, worktree: Boolean(entry.todoId), favorite: favorites.has(value) };
    });
  });
}
