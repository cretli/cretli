/**
 * Optional loader for @tencent-ai/agent-sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

/** @type {Promise<typeof import('@tencent-ai/agent-sdk')> | null} */
let sdkModulePromise = null;

/**
 * @returns {boolean}
 */
export function isCodeBuddySdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'CODEBUDDY_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createCodeBuddySdkUnavailableError(cause) {
  const error = new Error(
    'CodeBuddy SDK is not installed. Install optional dependency @tencent-ai/agent-sdk, '
    + 'or create a chat with the OpenCode, OpenRouter, or Cursor SDK harness.',
  );
  error.code = 'CODEBUDDY_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@tencent-ai/agent-sdk')>}
 */
export async function loadCodeBuddySdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@tencent-ai/agent-sdk').catch((err) => {
      sdkModulePromise = null;
      throw createCodeBuddySdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isCodeBuddySdkAvailable() {
  try {
    await loadCodeBuddySdk();
    return true;
  } catch (err) {
    if (isCodeBuddySdkUnavailableError(err)) return false;
    return false;
  }
}
