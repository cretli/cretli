/**
 * Whether the car view is open. Kept apart from `carService.js` so the voice
 * matcher can ask without loading the card API layer; the service registers the
 * real probe when it loads. Without it the answer is "closed".
 */

let probe = () => false;

/** @param {() => boolean} fn */
export function setCarViewProbe(fn) {
  probe = typeof fn === 'function' ? fn : () => false;
}

/** @returns {boolean} */
export function isCarViewOpen() {
  try {
    return probe() === true;
  } catch {
    return false;
  }
}
