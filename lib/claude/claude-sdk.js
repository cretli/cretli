/**
 * Optional loader for @anthropic-ai/claude-agent-sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @type {Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null} */
let sdkModulePromise = null;

const CLAUDE_SDK_ENTRY = pathToFileURL(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../optional-packages/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
)).href;

/**
 * @returns {boolean}
 */
export function isClaudeSdkUnavailableError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code === 'CLAUDE_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function createClaudeSdkUnavailableError(cause) {
  const error = new Error(
    'Claude Agent SDK is not installed. From the repo root run node scripts/install-optional-claude-sdk.js, '
    + 'or create a chat with the OpenCode, OpenRouter, or Cursor SDK harness.',
  );
  error.code = 'CLAUDE_SDK_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

/**
 * @returns {Promise<typeof import('@anthropic-ai/claude-agent-sdk')>}
 */
export async function loadClaudeSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import(CLAUDE_SDK_ENTRY).catch((err) => {
      sdkModulePromise = null;
      throw createClaudeSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

/**
 * @returns {Promise<boolean>}
 */
export async function isClaudeSdkAvailable() {
  try {
    await loadClaudeSdk();
    return true;
  } catch (err) {
    if (isClaudeSdkUnavailableError(err)) return false;
    return false;
  }
}
