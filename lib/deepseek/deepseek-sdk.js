/**
 * Optional loader for @deepseek-ai/dsh-sdk-client (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

/** @type {Promise<typeof import('@deepseek-ai/dsh-sdk-client')> | null} */
let sdkModulePromise = null;

/**
 * @returns {boolean}
 */
export function isDeepSeekSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'DEEPSEEK_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createDeepSeekSdkUnavailableError(cause) {
  const error = new Error(
    'DeepSeek Harness SDK is not installed. Install optional dependency @deepseek-ai/dsh-sdk-client '
    + '(and @deepseek-ai/dsh), or create a chat with the OpenCode, OpenRouter, CodeBuddy, or Cursor SDK harness.',
  );
  error.code = 'DEEPSEEK_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@deepseek-ai/dsh-sdk-client')>}
 */
export async function loadDeepSeekSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@deepseek-ai/dsh-sdk-client').catch((err) => {
      sdkModulePromise = null;
      throw createDeepSeekSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isDeepSeekSdkAvailable() {
  try {
    await loadDeepSeekSdk();
    return true;
  } catch (err) {
    if (isDeepSeekSdkUnavailableError(err)) return false;
    return false;
  }
}
