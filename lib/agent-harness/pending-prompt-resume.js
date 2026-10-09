/**
 * Resume idle harness rooms after the update gate releases.
 */

/** @type {Set<() => Iterable<object>>} */
const roomSources = new Set();

/**
 * @param {() => Iterable<object>} getRooms
 */
export function registerPendingPromptRoomSource(getRooms) {
  if (typeof getRooms !== 'function') return;
  roomSources.add(getRooms);
}

/**
 * Best-effort: drain the next queued prompt on every registered room.
 */
export function resumePendingPromptQueues() {
  for (const getRooms of roomSources) {
    let rooms;
    try {
      rooms = getRooms();
    } catch {
      continue;
    }
    if (!rooms) continue;
    for (const room of rooms) {
      if (!room || typeof room !== 'object') continue;
      try {
        if (typeof room.drainQueue === 'function') {
          room.drainQueue();
        } else if (typeof room.drainNextPendingPrompt === 'function') {
          room.drainNextPendingPrompt();
        }
      } catch {
        // resume is best effort
      }
    }
  }
}

/**
 * @param {Set<() => Iterable<object>>} [target]
 */
export function resetPendingPromptRoomSourcesForTest(target = roomSources) {
  target.clear();
}
