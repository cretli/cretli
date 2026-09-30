/**
 * Thin, static descriptors for built-in harness providers.
 *
 * WR1 pilot: OpenRouter is described once, declaratively, so the WebSocket
 * router can resolve its chat handler through a small registry instead of a
 * bespoke hard-coded call. The descriptor carries metadata only — no vendor
 * behavior, no settings, no lifecycle.
 *
 * The existing OpenRouter handler is imported statically on purpose: that
 * module registers the OpenRouter chat-run adapter as an import side effect
 * (`registerChatRunAdapter`), so a dynamic import would change when the adapter
 * becomes available. This module is read-only once evaluated.
 *
 * Built-in descriptors are intentionally NOT local plugin manifests and must
 * never be fed to `validateHarnessPluginManifest`: that validator reserves the
 * built-in transport ids for local plugins. Reusing only the shared closed
 * capability key set keeps the declarative shape aligned without validating a
 * built-in.
 */

import { handleOpenRouterAgentWebSocket } from '../openrouter/openrouter-agent-ws.js';
import { handleClaudeAgentWebSocket } from '../claude/claude-agent-ws.js';
import { HARNESS_PLUGIN_CAPABILITY_KEYS } from './harness-plugin-contract.js';
import { getHarnessMeta } from './registry.js';

/**
 * Build the closed capability block for a built-in provider: every shared key
 * is present and boolean, and anything not explicitly enabled is `false`.
 *
 * @param {Record<string, boolean>} [overrides]
 * @returns {Readonly<Record<string, boolean>>}
 */
function buildCapabilities(overrides = {}) {
  return Object.freeze(Object.fromEntries(
    HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, overrides[key] === true]),
  ));
}

/** Registry metadata for the OpenRouter transport (single source of truth). */
const OPENROUTER_META = getHarnessMeta('openrouter');
const CLAUDE_META = getHarnessMeta('claude');

/**
 * @typedef {Object} BuiltinHarnessProvider
 * @property {string} id Stable built-in transport id.
 * @property {'builtin'} origin Built-in origin marker.
 * @property {string} label Human label, synchronized with the harness registry.
 * @property {string} description Human description, synchronized with the registry.
 * @property {Readonly<Record<string, boolean>>} capabilities Closed declarative capability set.
 * @property {(ws: object, sessionKey: string, deps: object) => unknown} handler Existing WebSocket handler.
 */

/**
 * Static OpenRouter built-in provider descriptor. `handler` is the exact
 * existing WebSocket handler, so dispatch calls forward unchanged.
 *
 * @type {BuiltinHarnessProvider}
 */
export const OPENROUTER_HARNESS_PROVIDER = Object.freeze({
  id: 'openrouter',
  origin: 'builtin',
  label: OPENROUTER_META && OPENROUTER_META.label ? OPENROUTER_META.label : 'OpenRouter',
  description: OPENROUTER_META && OPENROUTER_META.description
    ? OPENROUTER_META.description
    : 'OpenRouter LLM with server-side workspace tools.',
  capabilities: buildCapabilities({ chat: true }),
  handler: handleOpenRouterAgentWebSocket,
});

/**
 * Claude Code is a built-in transport (its id is reserved against local
 * plugins); this descriptor only centralizes its existing SDK WebSocket
 * handler and does not alter authentication or chat lifecycle.
 * @type {BuiltinHarnessProvider}
 */
export const CLAUDE_HARNESS_PROVIDER = Object.freeze({
  id: 'claude',
  origin: 'builtin',
  label: CLAUDE_META?.label || 'Claude Code',
  description: CLAUDE_META?.description || 'Claude Agent SDK harness.',
  capabilities: buildCapabilities({ chat: true, models: true }),
  handler: handleClaudeAgentWebSocket,
});

/** @type {readonly BuiltinHarnessProvider[]} */
const BUILTIN_HARNESS_PROVIDER_LIST = Object.freeze([
  OPENROUTER_HARNESS_PROVIDER,
  CLAUDE_HARNESS_PROVIDER,
]);

const BUILTIN_HARNESS_PROVIDER_BY_ID = Object.freeze(
  Object.fromEntries(BUILTIN_HARNESS_PROVIDER_LIST.map((provider) => [provider.id, provider])),
);

/**
 * @returns {BuiltinHarnessProvider[]} A fresh array of the frozen descriptors.
 */
export function listBuiltinHarnessProviders() {
  return BUILTIN_HARNESS_PROVIDER_LIST.slice();
}

/**
 * Look up a built-in provider descriptor by id. Ids are matched case- and
 * whitespace-insensitively; unknown/blank ids return `null`.
 *
 * @param {unknown} rawId
 * @returns {BuiltinHarnessProvider | null}
 */
export function getBuiltinHarnessProvider(rawId) {
  const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
  if (!id) return null;
  return BUILTIN_HARNESS_PROVIDER_BY_ID[id] || null;
}

/**
 * Return the declared chat handler for a built-in provider, or `null` when the
 * provider or its handler is missing/not callable.
 *
 * @param {unknown} rawId
 * @returns {((ws: object, sessionKey: string, deps: object) => unknown) | null}
 */
export function getBuiltinHarnessChatHandler(rawId) {
  const provider = getBuiltinHarnessProvider(rawId);
  if (provider && typeof provider.handler === 'function') return provider.handler;
  return null;
}

/**
 * Resolve the chat handler for a built-in provider, falling back to the
 * caller-supplied handler when the descriptor is unavailable. This lets the
 * ws-router OpenRouter branch keep its exact previous handler as a fallback
 * while normal behavior goes through the descriptor registry.
 *
 * @param {unknown} rawId
 * @param {((ws: object, sessionKey: string, deps: object) => unknown) | null} [fallbackHandler]
 * @returns {((ws: object, sessionKey: string, deps: object) => unknown) | null}
 */
export function resolveBuiltinHarnessChatHandler(rawId, fallbackHandler = null) {
  const handler = getBuiltinHarnessChatHandler(rawId);
  if (handler) return handler;
  return typeof fallbackHandler === 'function' ? fallbackHandler : null;
}
