/**
 * Which agent harnesses are offered in new chat, the mode bar, and voice tools.
 * Missing or a full set means every harness is on (backward compatible).
 */

import { AGENT_TRANSPORTS, isRegisteredAgentTransportId, normalizeAgentTransport } from './agent-transport.js';
import { HARNESS_TIERS } from './harness-tiers.js';

export { HARNESS_TIERS };


/** Settings overview order; pickers follow this after a custom save. */
export const DEFAULT_HARNESS_ORDER = Object.freeze([
  'opencode',
  'openrouter',
  'sdk',
  'codebuddy',
  'deepseek',
  'mistral',
  'zai',
  'mimo',
  'antigravity',
  'qwen',
  'codex',
  'claude',
]);

/** Harnesses a new install enables when its first-run setup completes. */
export const RECOMMENDED_HARNESSES = Object.freeze(
  Object.keys(HARNESS_TIERS).filter((id) => HARNESS_TIERS[id] === 'recommended'),
);

/**
 * @param {unknown} harness
 * @returns {'recommended' | 'available' | 'experimental'}
 */
export function getHarnessTier(harness) {
  const id = normalizeAgentTransport(harness);
  return HARNESS_TIERS[id] || 'available';
}

/**
 * Enabled-harness list written once when a new install finishes (or skips) first-run
 * setup: the recommended harnesses plus the one the user picked. Unregistered ids (a
 * plugin that is not loaded) are dropped. Existing installs never pass through this.
 *
 * @param {unknown} [chosenHarness]
 * @returns {string[]|null} null when the result would enable every harness anyway
 */
export function freshInstallEnabledHarnesses(chosenHarness) {
  const chosen = String(chosenHarness || '').trim().toLowerCase();
  return normalizeEnabledHarnesses([...RECOMMENDED_HARNESSES, ...(chosen ? [chosen] : [])]);
}

/**
 * @param {unknown} raw
 * @returns {string[]|null} enabled ids, or null when every harness is enabled
 */
export function normalizeEnabledHarnesses(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const token = item.trim().toLowerCase();
    if (!token) continue;
    const id = token === 'cursor' ? 'sdk' : token;
    if (!isRegisteredAgentTransportId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) return null;
  if (out.length === AGENT_TRANSPORTS.length) return null;
  return out;
}

/**
 * @param {unknown} harness
 * @param {unknown} enabledRaw
 * @returns {boolean}
 */
export function isHarnessEnabled(harness, enabledRaw) {
  const enabled = Array.isArray(enabledRaw)
    ? normalizeEnabledHarnesses(enabledRaw)
    : enabledRaw === null || enabledRaw === undefined
      ? null
      : normalizeEnabledHarnesses(enabledRaw);
  if (enabled == null) return true;
  return enabled.includes(normalizeAgentTransport(harness));
}

/**
 * Full harness id list in display order. Unknown ids are dropped; missing
 * ids are appended in the default order.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHarnessOrder(raw) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const token = item.trim().toLowerCase();
      const id = token === 'cursor' ? 'sdk' : token;
      if (!isRegisteredAgentTransportId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of DEFAULT_HARNESS_ORDER) {
    if (seen.has(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * @param {unknown} enabledRaw
 * @param {unknown} [orderRaw]
 * @returns {string[]}
 */
export function listEnabledHarnesses(enabledRaw, orderRaw) {
  const order = normalizeHarnessOrder(orderRaw);
  const enabled = normalizeEnabledHarnesses(enabledRaw);
  if (enabled == null) return order;
  return order.filter((id) => enabled.includes(id));
}
