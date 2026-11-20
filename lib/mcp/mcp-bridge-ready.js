/**
 * Readiness signal for the managed Cretli MCP bridge.
 *
 * Some harness CLIs connect MCP servers lazily and build the first model
 * request without waiting for them, so the first prompt of a chat can run with
 * no Cretli tools at all. The bridge fetches its tool catalog right after the
 * MCP handshake; that request marks the chat here, and a harness adapter can
 * hold its first prompt until the mark arrives.
 *
 * The mark carries the tool names the bridge actually listed, because an
 * adapter that only checks "something listed" would also accept a bridge that
 * connected without the Cretli contract tools.
 */

/** Upper bound for holding a prompt when the bridge never reports in. */
export const MCP_BRIDGE_READY_TIMEOUT_MS = 5000;

/** @type {Map<string, { at: number, toolNames: string[] }>} */
const listedByChat = new Map();
/** @type {Map<string, Set<() => void>>} */
const waitersByChat = new Map();

/**
 * @param {unknown} chatId
 * @param {{ now?: number, toolNames?: unknown } | number} [options]
 * @returns {void}
 */
export function markMcpBridgeToolsListed(chatId, options = {}) {
  const key = String(chatId || '').trim();
  if (!key) return;
  const shaped = typeof options === 'number' ? { now: options } : (options || {});
  const now = Number.isFinite(shaped.now) ? Number(shaped.now) : Date.now();
  const toolNames = (Array.isArray(shaped.toolNames) ? shaped.toolNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  listedByChat.set(key, { at: now, toolNames });
  const waiters = waitersByChat.get(key);
  if (!waiters) return;
  waitersByChat.delete(key);
  for (const notify of waiters) notify();
}

/**
 * Resolve with the bridge snapshot once this chat listed its tools at or after
 * `since`, or `null` when `timeoutMs` passes first. A mark older than `since`
 * never counts, so a restarted run cannot be released by the previous run.
 *
 * @param {unknown} chatId
 * @param {{ since?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ at: number, toolNames: string[] } | null>}
 */
export function waitForMcpBridgeToolsListed(chatId, options = {}) {
  const key = String(chatId || '').trim();
  if (!key) return Promise.resolve(null);
  const since = Number.isFinite(options.since) ? Number(options.since) : 0;
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) >= 0
    ? Number(options.timeoutMs)
    : MCP_BRIDGE_READY_TIMEOUT_MS;
  const current = listedByChat.get(key);
  if (current && current.at >= since) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiters = waitersByChat.get(key) || new Set();
    waitersByChat.set(key, waiters);
    const timer = setTimeout(() => {
      waiters.delete(notify);
      if (waiters.size === 0 && waitersByChat.get(key) === waiters) waitersByChat.delete(key);
      resolve(null);
    }, timeoutMs);
    function notify() {
      clearTimeout(timer);
      resolve(listedByChat.get(key) || { at: since, toolNames: [] });
    }
    waiters.add(notify);
  });
}

/**
 * Drop the mark of one chat (or every chat) so a test or a harness restart
 * cannot read a readiness signal left behind by an earlier run.
 *
 * @param {unknown} [chatId]
 * @returns {void}
 */
export function clearMcpBridgeToolsListed(chatId) {
  const key = String(chatId || '').trim();
  if (!key) {
    listedByChat.clear();
    waitersByChat.clear();
    return;
  }
  listedByChat.delete(key);
}
