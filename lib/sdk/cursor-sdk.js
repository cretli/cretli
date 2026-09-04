/**
 * Optional loader for @cursor/sdk (optionalDependency).
 * Chat can run on OpenCode or OpenRouter without this package installed.
 */

/** @type {Promise<typeof import('@cursor/sdk')> | null} */
let sdkModulePromise = null;

/**
 * @returns {boolean}
 */
export function isCursorSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'CURSOR_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @returns {Error}
 */
export function createCursorSdkUnavailableError(cause) {
  const error = new Error(
    'Cursor SDK is not installed. Install optional dependency @cursor/sdk, '
    + 'or create a chat with the OpenCode or OpenRouter harness.',
  );
  error.code = 'CURSOR_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@cursor/sdk')>}
 */
export async function loadCursorSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@cursor/sdk').catch((err) => {
      sdkModulePromise = null;
      throw createCursorSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isCursorSdkAvailable() {
  try {
    await loadCursorSdk();
    return true;
  } catch (err) {
    if (isCursorSdkUnavailableError(err)) return false;
    return false;
  }
}
