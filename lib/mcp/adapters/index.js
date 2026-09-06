/**
 * Harness MCP adapter registry.
 */

import { sdkMcpAdapter } from './sdk-adapter.js';
import { codexMcpAdapter } from './codex-adapter.js';
import { opencodeMcpAdapter } from './opencode-adapter.js';
import { qwenMcpAdapter } from './qwen-adapter.js';
import { codebuddyMcpAdapter } from './codebuddy-adapter.js';
import { deepseekMcpAdapter } from './deepseek-adapter.js';
import { openrouterMcpAdapter } from './openrouter-adapter.js';

const ADAPTERS = Object.freeze({
  sdk: sdkMcpAdapter,
  codex: codexMcpAdapter,
  opencode: opencodeMcpAdapter,
  qwen: qwenMcpAdapter,
  codebuddy: codebuddyMcpAdapter,
  deepseek: deepseekMcpAdapter,
  openrouter: openrouterMcpAdapter,
});

/**
 * @param {unknown} harness
 */
export function getHarnessMcpAdapter(harness) {
  return ADAPTERS[String(harness || '')] || null;
}

export { ADAPTERS as HARNESS_MCP_ADAPTERS };
