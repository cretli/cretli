/**
 * Stick-to-bottom evaluation with all layout reads before any write, so a
 * single call forces at most one layout instead of read/write/read thrash.
 *
 * With `state.lastScrollTop` tracked, stick follows the direction of the scroll,
 * not the distance alone:
 * - it is released only when the view moved up and is no longer at the very bottom
 *   (a user scroll; content growth or a shrinking viewport never moves scrollTop up,
 *   and a clamp after content shrinks ends at the bottom);
 * - it is taken again only when the view did not move up and is within the threshold.
 * Without `lastScrollTop` (first call) it falls back to the distance check.
 *
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} mountEl
 * @param {{ hidden: boolean }} button Scroll-to-bottom button
 * @param {{ stickToBottom: boolean, suppressHistoryPersist?: boolean, lastScrollTop?: number }} state
 * @param {number} thresholdPx
 * @returns {boolean} the new stickToBottom value
 */
export function evaluateStickFromScroll(mountEl, button, state, thresholdPx) {
  // Reads
  const frozen = !!state.suppressHistoryPersist;
  const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
  const scrollTop = frozen ? 0 : mountEl.scrollTop;
  const stick = frozen
    ? state.stickToBottom
    : nextStickToBottom({
      stick: state.stickToBottom,
      lastScrollTop: state.lastScrollTop,
      scrollTop,
      maxScroll,
      thresholdPx,
    });
  // Writes
  if (!frozen && 'lastScrollTop' in state) state.lastScrollTop = scrollTop;
  state.stickToBottom = stick;
  const hidden = maxScroll <= thresholdPx || stick;
  if (button.hidden !== hidden) button.hidden = hidden;
  return stick;
}

/** Below this many px from the bottom the view counts as at the very bottom. */
const AT_BOTTOM_EPSILON_PX = 2;

/**
 * Pure stick transition for one scroll observation.
 *
 * @param {{ stick: boolean, lastScrollTop?: number, scrollTop: number, maxScroll: number, thresholdPx: number }} input
 * @returns {boolean}
 */
export function nextStickToBottom({ stick, lastScrollTop, scrollTop, maxScroll, thresholdPx }) {
  if (maxScroll <= 0) return true;
  const distance = maxScroll - scrollTop;
  if (!Number.isFinite(lastScrollTop)) return distance <= thresholdPx;
  const movedUp = scrollTop < /** @type {number} */ (lastScrollTop) - 1;
  if (movedUp) return stick && distance <= AT_BOTTOM_EPSILON_PX;
  return stick || distance <= thresholdPx;
}
