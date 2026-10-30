/**
 * Stick-to-bottom evaluation with all layout reads before any write, so a
 * single call forces at most one layout instead of read/write/read thrash.
 *
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} mountEl
 * @param {{ hidden: boolean }} button Scroll-to-bottom button
 * @param {{ stickToBottom: boolean, suppressHistoryPersist?: boolean }} state
 * @param {number} thresholdPx
 * @returns {boolean} the new stickToBottom value
 */
export function evaluateStickFromScroll(mountEl, button, state, thresholdPx) {
  // Reads
  const frozen = !!state.suppressHistoryPersist;
  const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
  const scrollTop = frozen ? 0 : mountEl.scrollTop;
  const stick = frozen ? state.stickToBottom : maxScroll <= 0 || scrollTop >= maxScroll - thresholdPx;
  // Writes
  state.stickToBottom = stick;
  const hidden = maxScroll <= thresholdPx || stick;
  if (button.hidden !== hidden) button.hidden = hidden;
  return stick;
}
