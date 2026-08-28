import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';
import { getEffectiveOpenCodeApiKey } from './opencode/opencode-api-key.js';
import { getEffectiveOpenRouterApiKey } from './openrouter/openrouter-api-key.js';
import { isCursorSdkAvailable } from './sdk/cursor-sdk.js';

/**
 * @typedef {{ available: boolean, configured: boolean }} HarnessBackendStatus
 * @typedef {{
 *   sdk: HarnessBackendStatus,
 *   opencode: HarnessBackendStatus,
 *   openrouter: HarnessBackendStatus,
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
  const opencodeConfigured = !!getEffectiveOpenCodeApiKey();
  const openrouterConfigured = !!getEffectiveOpenRouterApiKey();
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
    anyConfigured: sdkConfigured || opencodeConfigured || openrouterConfigured,
  };
}
