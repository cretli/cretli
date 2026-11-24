/** Pure helpers for the 300-character review-lesson text limit (no DOM imports). */

export const LESSON_TEXT_MAX = 300;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function clampLessonText(value) {
  return String(value ?? '').slice(0, LESSON_TEXT_MAX);
}

/**
 * cr-bar-textarea has no maxlength. Clamp the host value and, because Lit skips
 * re-writing an unchanged `.value`, also force the inner control to the clamped text.
 *
 * @param {any} host
 */
export function bindLessonTextLimit(host) {
  const clamp = () => {
    const clamped = clampLessonText(host.value);
    if (host.value !== clamped) host.value = clamped;
    const inner = host.shadowRoot?.querySelector?.('textarea');
    if (inner && inner.value !== clamped) inner.value = clamped;
  };
  host.addEventListener('input', clamp);
  host.addEventListener('change', clamp);
}
