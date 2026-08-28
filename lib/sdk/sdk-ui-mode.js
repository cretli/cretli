/** @typedef {'full'|'compact'} SdkUiMode */

export const SDK_UI_MODE_DEFAULT = 'compact';

const VALID_SDK_UI_MODES = new Set(['full', 'compact']);

/**
 * @param {unknown} value
 * @returns {SdkUiMode}
 */
export function normalizeSdkUiMode(value) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  return VALID_SDK_UI_MODES.has(normalized) ? normalized : SDK_UI_MODE_DEFAULT;
}
