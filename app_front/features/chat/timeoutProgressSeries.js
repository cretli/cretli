/**
 * Consecutive idle-timeout notices belong in one card. Hidden status/system
 * lines and a dropped live pointer must not open a second waiting block.
 */

export const TIMEOUT_PROGRESS_SERIES_CLASS = 'sdk-timeout-progress-series';
export const TIMEOUT_PROGRESS_UPDATES_CAP = 40;
export const TIMEOUT_PROGRESS_UPDATES_SELECTOR = '.sdk-timeout-progress__updates';
export const TIMEOUT_PROGRESS_BODY_SELECTOR = '.sdk-timeout-progress';

/**
 * @param {unknown} node
 * @param {string} className
 * @returns {boolean}
 */
function hasClass(node, className) {
  if (!node || typeof node !== 'object') return false;
  const el = /** @type {{ classList?: { contains?: unknown }, className?: unknown }} */ (node);
  if (typeof el.classList?.contains === 'function') {
    return el.classList.contains(className) === true;
  }
  if (typeof el.className !== 'string') return false;
  return el.className.split(/\s+/).includes(className);
}

/**
 * @param {unknown} node
 * @param {string} selector
 * @returns {unknown}
 */
function queryNode(node, selector) {
  if (!node || typeof node !== 'object') return null;
  const el = /** @type {{ querySelector?: Function }} */ (node);
  if (typeof el.querySelector !== 'function') return null;
  return el.querySelector(selector);
}

/**
 * @param {unknown} node
 * @returns {boolean}
 */
export function isTimeoutProgressSeriesBlock(node) {
  if (hasClass(node, TIMEOUT_PROGRESS_SERIES_CLASS)) return true;
  return queryNode(node, TIMEOUT_PROGRESS_BODY_SELECTOR) != null;
}

/**
 * Nodes that sit between wait ticks without being real agent output.
 *
 * @param {unknown} node
 * @returns {boolean}
 */
export function isTimeoutProgressSeriesSkipNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (isTimeoutProgressSeriesBlock(node)) return false;
  if (/** @type {{ hidden?: unknown }} */ (node).hidden === true) return true;
  return (
    hasClass(node, 'sdk-rich-line--status')
    || hasClass(node, 'sdk-rich-line--muted')
    || hasClass(node, 'sdk-rich-line--task')
  );
}

/**
 * Oldest-first waiting cards at the tail, ignoring skippable lines between them.
 *
 * @param {{ insertBefore?: unknown, streamLastChild?: unknown }} [options]
 * @returns {unknown[]}
 */
export function listTrailingTimeoutProgressSeriesBlocks(options = {}) {
  const insertBefore = options.insertBefore ?? null;
  let node = insertBefore
    ? /** @type {{ previousElementSibling?: unknown }} */ (insertBefore).previousElementSibling
    : (options.streamLastChild ?? null);
  /** @type {unknown[]} */
  const found = [];
  while (node) {
    if (isTimeoutProgressSeriesBlock(node)) found.push(node);
    else if (!isTimeoutProgressSeriesSkipNode(node)) break;
    node = /** @type {{ previousElementSibling?: unknown }} */ (node).previousElementSibling;
  }
  return found.reverse();
}

/**
 * Walks backward from the insert point (or the stream tail) to the previous
 * waiting card, skipping compact/hidden transport lines.
 *
 * @param {{ insertBefore?: unknown, streamLastChild?: unknown }} [options]
 * @returns {unknown}
 */
export function findAdjacentTimeoutProgressSeriesBlock(options = {}) {
  const trailing = listTrailingTimeoutProgressSeriesBlocks(options);
  return trailing.length > 0 ? trailing[trailing.length - 1] : null;
}

/**
 * @param {unknown} block
 * @returns {{ children?: unknown, childElementCount?: number, appendChild?: Function, removeChild?: Function, lastElementChild?: { remove?: Function } | null } | null}
 */
export function readTimeoutProgressUpdatesEl(block) {
  const found = queryNode(block, TIMEOUT_PROGRESS_UPDATES_SELECTOR);
  return found && typeof found === 'object'
    ? /** @type {{ children?: unknown, childElementCount?: number, appendChild?: Function, removeChild?: Function, lastElementChild?: { remove?: Function } | null }} */ (found)
    : null;
}

/**
 * @param {{ childElementCount?: number, removeChild?: Function, lastElementChild?: { remove?: Function } | null }} updatesEl
 */
export function trimTimeoutProgressUpdates(updatesEl) {
  if (!updatesEl) return;
  while (Number(updatesEl.childElementCount) > TIMEOUT_PROGRESS_UPDATES_CAP) {
    const last = updatesEl.lastElementChild;
    const before = Number(updatesEl.childElementCount);
    if (!last) break;
    if (typeof updatesEl.removeChild === 'function') updatesEl.removeChild(last);
    else if (typeof last.remove === 'function') last.remove();
    else break;
    if (Number(updatesEl.childElementCount) >= before) break;
  }
}

/**
 * @param {unknown} extra
 * @param {{ appendChild?: Function }} keeperUpdates
 * @param {(block: unknown) => ReturnType<typeof readTimeoutProgressUpdatesEl>} getUpdatesEl
 */
function moveExtraUpdatesOntoKeeper(extra, keeperUpdates, getUpdatesEl) {
  const extraUpdates = getUpdatesEl(extra);
  if (!keeperUpdates || !extraUpdates || typeof keeperUpdates.appendChild !== 'function') return;
  const children = Array.from(extraUpdates.children || []);
  for (const child of children) keeperUpdates.appendChild(child);
}

/**
 * Collapses stacked waiting cards into the newest one. Each card stores ticks
 * newest-first, so older cards are appended from newest extra to oldest.
 *
 * @param {unknown[]} blocks oldest-first trailing series cards
 * @param {{ getUpdatesEl?: (block: unknown) => ReturnType<typeof readTimeoutProgressUpdatesEl> }} [options]
 * @returns {{ keeper: unknown, removed: unknown[] }}
 */
export function foldTrailingTimeoutProgressSeriesBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { keeper: null, removed: [] };
  }
  const getUpdatesEl = typeof options.getUpdatesEl === 'function'
    ? options.getUpdatesEl
    : readTimeoutProgressUpdatesEl;
  const keeper = blocks[blocks.length - 1];
  if (blocks.length === 1) return { keeper, removed: [] };
  const keeperUpdates = getUpdatesEl(keeper);
  const extras = blocks.slice(0, -1);
  /** @type {unknown[]} */
  const removed = [];
  for (let i = extras.length - 1; i >= 0; i -= 1) {
    const extra = extras[i];
    if (keeperUpdates) moveExtraUpdatesOntoKeeper(extra, keeperUpdates, getUpdatesEl);
    if (extra && typeof extra === 'object' && typeof extra.remove === 'function') extra.remove();
    removed.push(extra);
  }
  if (keeperUpdates) trimTimeoutProgressUpdates(keeperUpdates);
  return { keeper, removed };
}

/**
 * @param {{ insertBefore?: unknown, streamLastChild?: unknown, getUpdatesEl?: Function }} [options]
 * @returns {{ keeper: unknown, removed: unknown[] }}
 */
export function foldTimeoutProgressSeriesAtTail(options = {}) {
  return foldTrailingTimeoutProgressSeriesBlocks(
    listTrailingTimeoutProgressSeriesBlocks(options),
    options,
  );
}
