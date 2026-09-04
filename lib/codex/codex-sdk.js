/**
 * Optional loader for @openai/codex-sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

/** @type {Promise<typeof import('@openai/codex-sdk')> | null} */
let sdkModulePromise = null;

/**
 * @returns {boolean}
 */
export function isCodexSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'CODEX_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createCodexSdkUnavailableError(cause) {
  const error = new Error(
    'Codex SDK is not installed. Install optional dependency @openai/codex-sdk '
    + '(and @openai/codex), or create a chat with the OpenCode, OpenRouter, CodeBuddy, DeepSeek, or Cursor SDK harness.',
  );
  error.code = 'CODEX_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@openai/codex-sdk')>}
 */
export async function loadCodexSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@openai/codex-sdk').catch((err) => {
      sdkModulePromise = null;
      throw createCodexSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isCodexSdkAvailable() {
  try {
    await loadCodexSdk();
    return true;
  } catch (err) {
    if (isCodexSdkUnavailableError(err)) return false;
    return false;
  }
}
