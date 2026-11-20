export type SdkUiMode = 'full' | 'compact';

export const SDK_UI_MODE_DEFAULT: SdkUiMode = 'compact';

const VALID_SDK_UI_MODES = new Set<string>(['full', 'compact']);

function isSdkUiMode(value: string): value is SdkUiMode {
  return VALID_SDK_UI_MODES.has(value);
}

/**
 * @param {unknown} value
 * @returns {SdkUiMode}
 */
export function normalizeSdkUiMode(value: unknown): SdkUiMode {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  return isSdkUiMode(normalized) ? normalized : SDK_UI_MODE_DEFAULT;
}
