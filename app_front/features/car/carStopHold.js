/**
 * Hold-to-confirm logic for the car view STOP button (pure, injected clock).
 *
 * One accidental tap must not interrupt an agent. Pointer and keyboard users
 * hold the button for `holdMs` (`press` / `release`). Assistive technology and
 * switch controls cannot hold, so a plain activation arms the button and a
 * second one inside `confirmMs` confirms (`activate`).
 */

export const STOP_HOLD_MS = 1000;
export const STOP_CONFIRM_MS = 3000;

/**
 * @param {{
 *   holdMs?: number,
 *   confirmMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 *   onStop: () => void,
 *   onChange?: (phase: 'idle'|'holding'|'armed') => void,
 * }} deps
 */
export function createStopHold(deps) {
  const holdMs = deps.holdMs ?? STOP_HOLD_MS;
  const confirmMs = deps.confirmMs ?? STOP_CONFIRM_MS;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(/** @type {any} */ (id)));
  const onChange = deps.onChange || (() => {});

  /** @type {'idle'|'holding'|'armed'} */
  let phase = 'idle';
  let timerId = null;

  function setPhase(next) {
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    if (phase === next) return;
    phase = next;
    onChange(phase);
  }

  return {
    holdMs,
    confirmMs,
    getPhase: () => phase,

    /** Pointer down / key down. Repeated presses while holding are ignored. */
    press() {
      if (phase === 'holding') return;
      setPhase('idle');
      phase = 'holding';
      onChange(phase);
      timerId = setTimer(() => {
        timerId = null;
        phase = 'idle';
        onChange(phase);
        deps.onStop();
      }, holdMs);
    },

    /** Pointer up / cancel / leave, key up: letting go early abandons the stop. */
    release() {
      if (phase === 'holding') setPhase('idle');
    },

    /** Activation without a hold (assistive technology): arm, then confirm with a second one. */
    activate() {
      if (phase === 'armed') {
        setPhase('idle');
        deps.onStop();
        return;
      }
      setPhase('idle');
      phase = 'armed';
      onChange(phase);
      timerId = setTimer(() => {
        timerId = null;
        phase = 'idle';
        onChange(phase);
      }, confirmMs);
    },

    cancel() {
      setPhase('idle');
    },
  };
}
