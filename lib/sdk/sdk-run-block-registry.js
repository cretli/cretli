/**
 * One SDK run renders several Thinking blocks and Activity trays (a new one after every
 * assistant turn). Per-run "latest" maps only remember the last of them, so anything that
 * finalizes a run (spinner off, tray status) misses the earlier blocks and leaves them
 * spinning forever. This registry keeps every block of a run.
 */

/**
 * @param {unknown} runKey
 * @returns {string}
 */
function normalizeRunKey(runKey) {
  return String(runKey || '').trim();
}

/**
 * @param {Map<string, Set<unknown>>} registry
 * @param {string} runKey
 * @param {unknown} item
 * @returns {void}
 */
export function registerRunItem(registry, runKey, item) {
  const key = normalizeRunKey(runKey);
  if (!key || item == null) return;
  const bucket = registry.get(key);
  if (!bucket) {
    registry.set(key, new Set([item]));
    return;
  }
  bucket.add(item);
}

/**
 * @param {Map<string, Set<unknown>>} registry
 * @param {string} runKey
 * @returns {unknown[]}
 */
export function listRunItems(registry, runKey) {
  const key = normalizeRunKey(runKey);
  if (!key) return [];
  const bucket = registry.get(key);
  if (!bucket) return [];
  return Array.from(bucket);
}

/**
 * @param {Map<string, Set<unknown>>} registry
 * @returns {unknown[]}
 */
export function listAllRunItems(registry) {
  const items = [];
  for (const bucket of registry.values()) {
    for (const item of bucket) items.push(item);
  }
  return items;
}
