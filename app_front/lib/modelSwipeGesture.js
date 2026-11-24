import { haptic } from './haptics.js';

/** Finger travel per step: vertical walks models, horizontal walks thinking levels. */
const STEP_Y_PX = 34;
const STEP_X_PX = 40;
/** Quiet time after the last step before the choice is really applied. */
export const SWIPE_COMMIT_MS = 260;

/**
 * Touch gesture on a closed model select: up/down steps through models, right/left raises or
 * lowers the thinking level. Every step ticks; `commit` runs once the finger rests.
 *
 * @param {HTMLElement} el closed select (events from its shadow DOM bubble to it)
 * @param {{ step: (axis: 'model' | 'effort', dir: 1 | -1) => boolean, commit: () => void }} handlers
 *   `step` returns false at the end of the list.
 * @returns {() => void} detach
 */
export function attachModelSwipe(el, handlers) {
  /** @type {{ id: number, x: number, y: number, axis: '' | 'x' | 'y', moved: boolean } | null} */
  let drag = null;
  let swiped = false;
  let timer = 0;
  const commit = () => { clearTimeout(timer); handlers.commit(); };
  const onDown = (event) => {
    if (event.pointerType === 'mouse' || /** @type {HTMLButtonElement} */ (el).disabled) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: '', moved: false };
    swiped = false;
  };
  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      try { el.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
    }
    drag.moved = true;
    swiped = true;
    const horizontal = drag.axis === 'x';
    const stepPx = horizontal ? STEP_X_PX : STEP_Y_PX;
    const travel = horizontal ? dx : dy;
    // Right = more thinking, up = next model in the list.
    const dir = horizontal ? Math.sign(travel) : -Math.sign(travel);
    let steps = Math.trunc(Math.abs(travel) / stepPx);
    while (steps-- > 0) {
      if (!handlers.step(horizontal ? 'effort' : 'model', dir > 0 ? 1 : -1)) break;
      haptic('tick');
      clearTimeout(timer);
      timer = setTimeout(commit, SWIPE_COMMIT_MS);
      if (horizontal) drag.x += Math.sign(travel) * stepPx;
      else drag.y += Math.sign(travel) * stepPx;
    }
  };
  const onEnd = () => {
    const moved = drag?.moved;
    drag = null;
    if (!moved) return;
    setTimeout(() => { swiped = false; }, 0);
    commit();
  };
  // The tap that ends a swipe must not open the dropdown. Capture runs before the trigger.
  const onClick = (event) => {
    if (!swiped) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
  el.addEventListener('click', onClick, true);
  // Vertical drags belong to the picker; the page behind must not scroll with them.
  el.style.touchAction = 'none';
  return () => {
    clearTimeout(timer);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onEnd);
    el.removeEventListener('pointercancel', onEnd);
    el.removeEventListener('click', onClick, true);
  };
}
