/**
 * Optional loader for @cursor/sdk (optionalDependency).
 * Chat can run on OpenCode or OpenRouter without this package installed.
 */

let sdkModulePromise: Promise<typeof import('@cursor/sdk')> | null = null;

export function isCursorSdkUnavailableError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return code === 'CURSOR_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

export function createCursorSdkUnavailableError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    'Cursor SDK is not installed. Install optional dependency @cursor/sdk, '
    + 'or create a chat with the OpenCode or OpenRouter harness.',
  ) as Error & { code: string };
  error.code = 'CURSOR_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

export async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@cursor/sdk').catch((err) => {
      sdkModulePromise = null;
      throw createCursorSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

export async function isCursorSdkAvailable(): Promise<boolean> {
  try {
    await loadCursorSdk();
    return true;
  } catch (err) {
    if (isCursorSdkUnavailableError(err)) return false;
    return false;
  }
}
