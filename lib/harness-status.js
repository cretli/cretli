import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';
import { hasOpenCodeCredentials } from './opencode/opencode-api-key.js';
import { getEffectiveOpenRouterApiKey } from './openrouter/openrouter-api-key.js';
import { getEffectiveCodeBuddyApiKey } from './codebuddy/codebuddy-api-key.js';
import { isCodeBuddyCliFound } from './codebuddy/codebuddy-cli.js';
import { isCodeBuddySdkAvailable } from './codebuddy/codebuddy-sdk.js';
import { getEffectiveDeepSeekApiKey } from './deepseek/deepseek-api-key.js';
import { isDeepSeekCliFound } from './deepseek/deepseek-cli.js';
import { isDeepSeekSdkAvailable } from './deepseek/deepseek-sdk.js';
import { hasCodexCredentials } from './codex/codex-credentials.js';
import { isCodexCliFound } from './codex/codex-cli.js';
import { isCodexSdkAvailable } from './codex/codex-sdk.js';
import { isCursorSdkAvailable } from './sdk/cursor-sdk.js';
import { getEffectiveQwenApiKey } from './qwen/qwen-api-key.js';
import { isQwenSdkAvailable } from './qwen/qwen-sdk.js';

/**
 * @typedef {{ available: boolean, configured: boolean }} HarnessBackendStatus
 * @typedef {{
 *   sdk: HarnessBackendStatus,
 *   opencode: HarnessBackendStatus,
 *   openrouter: HarnessBackendStatus,
 *   codebuddy: HarnessBackendStatus,
 *   deepseek: HarnessBackendStatus,
 *   codex: HarnessBackendStatus,
 *   qwen: HarnessBackendStatus,
 *   anyConfigured: boolean,
 * }} HarnessStatus
 */

/**
 * Snapshot of which chat backends are installed and have credentials.
 * Used by Settings and the first-run harness wizard (no secrets).
 *
 * @returns {Promise<HarnessStatus>}
 */
export async function getHarnessStatus() {
  const sdkAvailable = await isCursorSdkAvailable();
  const sdkConfigured = sdkAvailable && !!getEffectiveCursorApiKey();
  const opencodeConfigured = hasOpenCodeCredentials();
  const openrouterConfigured = !!getEffectiveOpenRouterApiKey();
  const codebuddyAvailable = (await isCodeBuddySdkAvailable()) && isCodeBuddyCliFound();
  const codebuddyConfigured = codebuddyAvailable && !!getEffectiveCodeBuddyApiKey();
  const deepseekAvailable = (await isDeepSeekSdkAvailable()) && isDeepSeekCliFound();
  const deepseekConfigured = deepseekAvailable && !!getEffectiveDeepSeekApiKey();
  const codexAvailable = (await isCodexSdkAvailable()) && isCodexCliFound();
  const codexConfigured = codexAvailable && hasCodexCredentials();
  const qwenAvailable = await isQwenSdkAvailable();
  const qwenConfigured = qwenAvailable && !!getEffectiveQwenApiKey();
  return {
    sdk: {
      available: sdkAvailable,
      configured: sdkConfigured,
    },
    opencode: {
      available: true,
      configured: opencodeConfigured,
    },
    openrouter: {
      available: true,
      configured: openrouterConfigured,
    },
    codebuddy: {
      available: codebuddyAvailable,
      configured: codebuddyConfigured,
    },
    deepseek: {
      available: deepseekAvailable,
      configured: deepseekConfigured,
    },
    codex: {
      available: codexAvailable,
      configured: codexConfigured,
    },
    qwen: {
      available: qwenAvailable,
      configured: qwenConfigured,
    },
    anyConfigured: sdkConfigured || opencodeConfigured || openrouterConfigured || codebuddyConfigured
      || deepseekConfigured || codexConfigured || qwenConfigured,
  };
}
