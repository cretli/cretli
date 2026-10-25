/**
 * Optional loader for @qwen-code/sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

/** @type {Promise<typeof import('@qwen-code/sdk')> | null} */
let sdkModulePromise = null;

/**
 * @returns {boolean}
 */
export function isQwenSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'QWEN_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createQwenSdkUnavailableError(cause) {
  const error = new Error(
    'Qwen Code SDK is not installed. Install optional dependency @qwen-code/sdk, '
    + 'or create a chat with the OpenCode, OpenRouter, or Cursor SDK harness.',
  );
  error.code = 'QWEN_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@qwen-code/sdk')>}
 */
export async function loadQwenSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@qwen-code/sdk').catch((err) => {
      sdkModulePromise = null;
      throw createQwenSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isQwenSdkAvailable() {
  try {
    await loadQwenSdk();
    return true;
  } catch (err) {
    if (isQwenSdkUnavailableError(err)) return false;
    return false;
  }
}
