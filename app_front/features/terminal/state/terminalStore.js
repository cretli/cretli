/**
 * Terminal panel state: the open terminal sessions and the few panel-wide handles
 * (active id, session poll timer, send bar, session picker dropdown).
 */
import { createFavoritesStore } from '../../../lib/favorites.js';

/** Open terminal sessions, in creation order. */
export const terminals = [];

export const terminalState = {
  /** @type {string | null} */
  activeId: null,
  /** @type {ReturnType<typeof setInterval> | null} */
  pollInterval: null,
  /** @type {{ setMultiline: (b: boolean) => void, isMultiline: () => boolean } | null} */
  sendBar: null,
  /** @type {{ open: () => void, close: () => void, isOpen: () => boolean } | null} */
  dropdownApi: null,
};

export const terminalFavorites = createFavoritesStore('cretli-favorites-terminals');

/**
 * @param {string | null} id
 */
export function findTerminal(id) {
  return id ? terminals.find((row) => row.id === id) : undefined;
}

/** Stops the "is there a session to join" poll, if running. */
export function stopTerminalPoll() {
  if (terminalState.pollInterval) {
    clearInterval(terminalState.pollInterval);
    terminalState.pollInterval = null;
  }
}
