/**
 * Per-device interface size. `--cr-ui-scale` feeds the root font-size rule in
 * `css/base/_global.scss`, which only applies to wide fine-pointer screens, so
 * phones and tablets keep 1rem = 16px. The inline bootstrap in `public/index.html`
 * applies the stored value before first paint and must keep the same preset list.
 */
const UI_SCALE_KEY = 'cretli-ui-scale';

export const UI_SCALE_PERCENTS = Object.freeze([80, 85, 90, 95, 100, 110]);
export const UI_SCALE_DEFAULT_PERCENT = 90;

/**
 * @param {unknown} value
 * @returns {number} A preset percent, or the default for anything else.
 */
export function normalizeUiScalePercent(value) {
  const percent = Number(value);
  return UI_SCALE_PERCENTS.includes(percent) ? percent : UI_SCALE_DEFAULT_PERCENT;
}

/** @returns {number} */
export function readUiScalePercent() {
  try {
    return normalizeUiScalePercent(localStorage.getItem(UI_SCALE_KEY));
  } catch {
    return UI_SCALE_DEFAULT_PERCENT;
  }
}

function applyUiScalePercent(percent) {
  document.documentElement.style.setProperty('--cr-ui-scale', String(percent / 100));
  // Docked panels and xterm refit from the window resize signal.
  window.dispatchEvent(new Event('resize'));
}

export function initUiScaleSelect() {
  const select = /** @type {any} */ (document.getElementById('ui-scale-select'));
  if (!select) return;
  select.options = UI_SCALE_PERCENTS.map((percent) => ({
    value: String(percent),
    label: `${percent}%`,
  }));
  select.value = String(readUiScalePercent());

  select.addEventListener('change', () => {
    const percent = normalizeUiScalePercent(select.value);
    try {
      localStorage.setItem(UI_SCALE_KEY, String(percent));
    } catch {
      // Storage may be blocked; the size still applies until reload.
    }
    applyUiScalePercent(percent);
  });

  // Keep other tabs of this browser in step with the setting.
  window.addEventListener('storage', (event) => {
    if (event.key !== UI_SCALE_KEY) return;
    const percent = normalizeUiScalePercent(event.newValue);
    select.value = String(percent);
    applyUiScalePercent(percent);
  });
}
