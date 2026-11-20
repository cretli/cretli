/**
 * Fire-and-forget chat-row writes for event handlers that cannot await (stream callbacks, sync room helpers).
 *
 * - The first write of a key is issued immediately (never deferred), so it keeps its place relative to other callers.
 * - Writes of the same key (the chat id) run strictly one after another: a burst of session-id updates must land in
 *   call order, and the SQLite adapter's version-checked commands must not race each other.
 * - A version conflict (another writer won the row meanwhile) re-runs the command, which re-reads the row.
 * - A failure is logged, never thrown into the caller's event loop: the session id / model it persists is also kept
 *   in the room, and the next successful write repairs the row.
 */

const CONFLICT_RETRIES = 3;

/** @type {Map<string, Promise<void>>} the tail of the write chain per key */
const tails = new Map();

/**
 * @param {string} label short name of the field, for the warning
 * @param {() => Promise<unknown> | unknown} write
 * @param {string} [key] serialization key, normally the chat id
 * @returns {void}
 */
export function runChatWrite(label, write, key = label) {
  const run = async () => {
    for (let left = CONFLICT_RETRIES; ; left -= 1) {
      try {
        await write();
        return;
      } catch (/** @type {any} */ error) {
        if (error?.code === 'CONFLICT' && left > 0) continue;
        console.warn(`[chat-write] ${label} not persisted: ${error?.code || error?.message || error}`);
        return;
      }
    }
  };
  const tail = tails.get(key);
  const chain = tail ? tail.then(run) : run();
  tails.set(key, chain);
  void chain.then(() => { if (tails.get(key) === chain) tails.delete(key); });
}

/**
 * Resolves when every write queued so far for `key` has settled (tests, shutdown).
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export function settleChatWrites(key) {
  return tails.get(key) || Promise.resolve();
}
