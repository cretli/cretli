/**
 * Optional loader for @mistralai/mistralai (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

/** @type {Promise<typeof import('@mistralai/mistralai')> | null} */
let sdkModulePromise = null;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMistralSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'MISTRAL_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createMistralSdkUnavailableError(cause) {
  const error = new Error(
    'Mistral SDK is not installed. Install optional dependency @mistralai/mistralai, '
    + 'or create a chat with the OpenRouter, OpenCode, CodeBuddy, or Cursor SDK harness.',
  );
  error.code = 'MISTRAL_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@mistralai/mistralai')>}
 */
export async function loadMistralSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@mistralai/mistralai').catch((err) => {
      sdkModulePromise = null;
      throw createMistralSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isMistralSdkAvailable() {
  try {
    await loadMistralSdk();
    return true;
  } catch {
    return false;
  }
}
