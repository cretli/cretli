/**
 * Optional loader for @openai/codex-sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

let sdkModulePromise: Promise<typeof import('@openai/codex-sdk')> | null = null;

export function isCodexSdkUnavailableError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return code === 'CODEX_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

export function createCodexSdkUnavailableError(cause?: unknown): Error {
  const error: Error & { code?: string } = new Error(
    'Codex SDK is not installed. Install optional dependency @openai/codex-sdk '
    + '(and @openai/codex), or create a chat with the OpenCode, OpenRouter, CodeBuddy, DeepSeek, or Cursor SDK harness.',
  );
  error.code = 'CODEX_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

export async function loadCodexSdk(): Promise<typeof import('@openai/codex-sdk')> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@openai/codex-sdk').catch((err) => {
      sdkModulePromise = null;
      throw createCodexSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

export async function isCodexSdkAvailable(): Promise<boolean> {
  try {
    await loadCodexSdk();
    return true;
  } catch (err) {
    if (isCodexSdkUnavailableError(err)) return false;
    return false;
  }
}
