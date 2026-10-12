/**
 * Harness MCP adapter registry.
 */

import { sdkMcpAdapter } from './sdk-adapter.js';
import { codexMcpAdapter } from './codex-adapter.js';
import { opencodeMcpAdapter } from './opencode-adapter.js';
import { qwenMcpAdapter } from './qwen-adapter.js';
import { claudeMcpAdapter } from './claude-adapter.js';
import { codebuddyMcpAdapter } from './codebuddy-adapter.js';
import { deepseekMcpAdapter } from './deepseek-adapter.js';
import { openrouterMcpAdapter } from './openrouter-adapter.js';
import { mistralMcpAdapter } from './mistral-adapter.js';
import { zaiMcpAdapter } from './zai-adapter.js';
import { mimoMcpAdapter } from './mimo-adapter.js';

const ADAPTERS = Object.freeze({
  sdk: sdkMcpAdapter,
  codex: codexMcpAdapter,
  opencode: opencodeMcpAdapter,
  qwen: qwenMcpAdapter,
  claude: claudeMcpAdapter,
  codebuddy: codebuddyMcpAdapter,
  deepseek: deepseekMcpAdapter,
  openrouter: openrouterMcpAdapter,
  mistral: mistralMcpAdapter,
  zai: zaiMcpAdapter,
  mimo: mimoMcpAdapter,
});

/**
 * @param {unknown} harness
 */
export function getHarnessMcpAdapter(harness) {
  return ADAPTERS[String(harness || '')] || null;
}

export { ADAPTERS as HARNESS_MCP_ADAPTERS };
