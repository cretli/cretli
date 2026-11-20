/**
 * Harness MCP adapter registry.
 *
 * A second, lightweight composition root next to builtin-harness-providers.js:
 * it may import only the leaf adapter modules. Importing the provider module
 * here would pull every harness WebSocket module into the MCP session's import
 * graph and create an initialization cycle (room-kernel → … → a harness module
 * reading a room-kernel constant before it is initialized).
 */

import { sdkMcpAdapter } from './sdk-adapter.js';
import { codexMcpAdapter } from './codex-adapter.js';
import { claudeMcpAdapter } from './claude-adapter.js';

/**
 * @typedef {Record<string, any>} HarnessMcpAdapter
 * @property {string} harness
 * @property {readonly string[]} transports
 * @property {boolean} liveUpdate Declarative flag only.
 * @property {'bridge' | 'managed' | 'native'} callControl `native` is handled by mcp-session; no adapter uses it yet.
 * @property {string} unsupportedFeature Empty when the harness supports MCP.
 */

/** @type {Readonly<Record<string, HarnessMcpAdapter>>} */
const ADAPTERS = Object.freeze({
  sdk: sdkMcpAdapter,
  codex: codexMcpAdapter,
  claude: claudeMcpAdapter,
});

/**
 * Adapters contributed by repo harness plugins (light entry), registered once at
 * boot. Empty unless a plugin is enabled.
 *
 * @type {Map<string, HarnessMcpAdapter>}
 */
const OPTIONAL_ADAPTERS = new Map();

/**
 * Side-effect-free collision check used before a multi-registry plugin load.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function hasHarnessMcpAdapter(id) {
  return Object.hasOwn(ADAPTERS, id) || OPTIONAL_ADAPTERS.has(id);
}

/**
 * Add a plugin's MCP adapter; an id that is already served is refused.
 *
 * @param {HarnessMcpAdapter} adapter
 * @returns {{ ok: true } | { ok: false, code: 'id_collision', error: string }}
 */
export function registerOptionalHarnessMcpAdapter(adapter) {
  const id = String(adapter?.harness || '');
  if (Object.hasOwn(ADAPTERS, id) || OPTIONAL_ADAPTERS.has(id)) {
    return { ok: false, code: 'id_collision', error: `MCP adapter "${id}" is already registered` };
  }
  OPTIONAL_ADAPTERS.set(id, Object.freeze({ ...adapter }));
  return { ok: true };
}

/**
 * @param {unknown} harness
 * @returns {HarnessMcpAdapter | null}
 */
export function getHarnessMcpAdapter(harness) {
  const id = String(harness || '');
  if (Object.hasOwn(ADAPTERS, id)) return ADAPTERS[id];
  return OPTIONAL_ADAPTERS.get(id) || null;
}

export { ADAPTERS as HARNESS_MCP_ADAPTERS };
