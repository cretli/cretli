/**
 * Constructor options for @deepseek-ai/dsh-sdk-client DeepSeekHarness
 * (profile / dshBin API, 0.1.2+). The 0.1.1-rc.2 client used launch.command
 * and cannot boot `dsh --profile sdk`.
 */

import { buildDeepSeekProcessEnv } from './deepseek-api-key.js';
import { resolveDeepSeekCli } from './deepseek-cli.js';
import { ensureDeepSeekHomeDir } from './deepseek-home.js';
import { DEEPSEEK_PROVIDER, resolveDefaultDeepSeekModel } from './deepseek-models.js';
import { writeDeepSeekMcpPatch } from '../mcp/mcp-deepseek-patch.js';
import {
  DEEPSEEK_RUNTIME_PLUGIN_PATH,
  writeDeepSeekRuntimePatch,
} from './dsh-runtime-patch.js';

export { DEEPSEEK_RUNTIME_PLUGIN_PATH };

export const DEEPSEEK_PROFILE = 'sdk';
export const DEEPSEEK_INITIALIZE_TIMEOUT_MS = 30000;
export const DEEPSEEK_MAX_TOKENS = 49152;

/**
 * @param {{
 *   cwd: string,
 *   model?: string,
 *   dshBin?: string,
 *   mcpBridge?: { command: string, args: string[], env: Record<string, string> } | null,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildDeepSeekHarnessOptions(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  const model = String(input.model || '').trim() || resolveDefaultDeepSeekModel();
  const resolvedBin = typeof input.dshBin === 'string' && input.dshBin.trim()
    ? input.dshBin.trim()
    : resolveDeepSeekCli();
  const env = buildDeepSeekProcessEnv();
  const runtimePatch = writeDeepSeekRuntimePatch();
  /** @type {Record<string, unknown>} */
  const options = {
    profile: DEEPSEEK_PROFILE,
    dshHome: ensureDeepSeekHomeDir(),
    cwd,
    provider: DEEPSEEK_PROVIDER,
    model,
    maxTokens: DEEPSEEK_MAX_TOKENS,
    initializeTimeoutMs: DEEPSEEK_INITIALIZE_TIMEOUT_MS,
    patches: [runtimePatch],
    env,
  };
  const mcpPatch = writeDeepSeekMcpPatch(input.mcpBridge || null);
  if (mcpPatch) options.patches = [runtimePatch, mcpPatch];
  if (resolvedBin && resolvedBin !== 'dsh') options.dshBin = resolvedBin;
  return options;
}
