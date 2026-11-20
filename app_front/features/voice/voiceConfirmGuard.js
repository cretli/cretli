/**
 * Hard guards for risky Realtime tool calls in car mode (pure logic, injected clock).
 *
 * A tool description alone cannot stop the model from passing `confirm=true` in
 * its first call or from chaining `send_prompt` -> `send_now` by itself, so the
 * app enforces both rules here: each needs the driver to speak AFTER the step
 * that asked for it (`noteUserSpeech`), so the model alone can never complete it.
 */

/** How long a `needs_confirm` answer stays valid for the follow-up `confirm=true` call. */
export const CONFIRM_WINDOW_MS = 30000;

/** Minimum gap between `needs_confirm` and the accepted confirm (the driver needs time to answer). */
export const CONFIRM_MIN_GAP_MS = 700;

/** Extra guard: `send_now` is refused this long after a submit even when the driver spoke. */
export const SEND_NOW_COOLDOWN_MS = 1500;

/**
 * @param {{ now?: () => number, confirmWindowMs?: number, confirmMinGapMs?: number, sendNowCooldownMs?: number }} [deps]
 */
export function createConfirmGuard(deps = {}) {
  const now = deps.now || (() => Date.now());
  const confirmWindowMs = deps.confirmWindowMs ?? CONFIRM_WINDOW_MS;
  const confirmMinGapMs = deps.confirmMinGapMs ?? CONFIRM_MIN_GAP_MS;
  const sendNowCooldownMs = deps.sendNowCooldownMs ?? SEND_NOW_COOLDOWN_MS;
  /** Counts the driver's utterances; steps compare against the count they started at. */
  let speechCount = 0;
  /** @type {Map<string, { at: number, speech: number }>} */
  const asked = new Map();
  let submit = null;

  const keyOf = (action, target) => `${action}\u0000${target || ''}`;

  return {
    /** Records that the driver was asked to confirm this action/target. */
    askConfirm(action, target) {
      asked.set(keyOf(action, target), { at: now(), speech: speechCount });
    },

    /**
     * @returns {boolean} true once per earlier `askConfirm` for the same action/target, inside
     *   the window, after the minimum gap and only if the driver spoke in between
     */
    consumeConfirm(action, target) {
      const key = keyOf(action, target);
      const entry = asked.get(key);
      asked.delete(key);
      if (!entry) return false;
      const age = now() - entry.at;
      return age <= confirmWindowMs && age >= confirmMinGapMs && speechCount > entry.speech;
    },

    /** A prompt entered the undo window. */
    noteSubmit() {
      submit = { at: now(), speech: speechCount };
    },

    /** The driver started a new utterance (never the one that issued the tool call). */
    noteUserSpeech() {
      speechCount += 1;
    },

    /** @returns {boolean} whether `send_now` may run: the driver spoke after the submit, and not instantly */
    sendNowAllowed() {
      if (!submit) return false;
      return speechCount > submit.speech && now() - submit.at >= sendNowCooldownMs;
    },

    reset() {
      asked.clear();
      submit = null;
    },
  };
}
