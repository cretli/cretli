/**
 * Whether a car-view pick waits for its "yes". Kept apart from the choice flow
 * so the local voice matcher can ask without loading the card API layer.
 */

let probe = () => false;

/**
 * @param {() => boolean} fn
 * @returns {void}
 */
export function setPendingChoiceProbe(fn) {
  probe = typeof fn === 'function' ? fn : () => false;
}

/** @returns {boolean} */
export function hasPendingChoice() {
  try {
    return probe() === true;
  } catch {
    return false;
  }
}
