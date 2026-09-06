import { normalizeAgentTransport } from '../agent-transport.js';
import { isAskSdkMode, isReadOnlySdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';

/**
 * @typedef {{
 *   nativeMode: boolean,
 *   denyMutatingTools: boolean,
 *   abortOnMutation: boolean,
 *   promptHint: boolean,
 * }} HarnessPlanPolicy
 */

/** @type {Readonly<Record<'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen', HarnessPlanPolicy>>} */
const HARNESS_PLAN_POLICIES = Object.freeze({
  sdk: Object.freeze({
    nativeMode: true,
    denyMutatingTools: true,
    abortOnMutation: true,
    promptHint: false,
  }),
  opencode: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: true,
  }),
  openrouter: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: false,
  }),
  codebuddy: Object.freeze({
    nativeMode: true,
    denyMutatingTools: true,
    abortOnMutation: true,
    promptHint: false,
  }),
  deepseek: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: true,
    promptHint: true,
  }),
  codex: Object.freeze({
    nativeMode: false,
    denyMutatingTools: false,
    abortOnMutation: false,
    promptHint: true,
  }),
  qwen: Object.freeze({
    nativeMode: true,
    denyMutatingTools: true,
    abortOnMutation: true,
    promptHint: false,
  }),
});

/**
 * Built-in Cursor SDK tools withheld in Plan and Ask.
 * Do not include mcp (drops custom tools) or write — write is not a ToolName
 * (file create/update is edit) and Agent.create rejects unknown names.
 */
export const SDK_PLAN_DISALLOWED_TOOLS = Object.freeze(['edit', 'delete', 'shell']);

/**
 * Returns how Plan mode is enforced for a chat harness.
 *
 * @param {unknown} transport
 * @returns {HarnessPlanPolicy}
 */
export function resolveHarnessPlanPolicy(transport) {
  return HARNESS_PLAN_POLICIES[normalizeAgentTransport(transport)];
}

/**
 * Ask always denies mutations, even when Plan for this harness is prompt-only.
 * Native APIs never receive raw `ask`.
 *
 * @param {unknown} [_transport]
 * @returns {HarnessPlanPolicy}
 */
export function resolveHarnessAskPolicy(_transport) {
  return Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: true,
    promptHint: true,
  });
}

/**
 * Plan or Ask policy for the current conversation mode.
 *
 * @param {unknown} transport
 * @param {unknown} mode
 * @returns {HarnessPlanPolicy}
 */
export function resolveHarnessReadOnlyPolicy(transport, mode) {
  if (isAskSdkMode(mode)) return resolveHarnessAskPolicy(transport);
  if (normalizeSdkMode(mode) === 'plan') return resolveHarnessPlanPolicy(transport);
  return Object.freeze({
    nativeMode: false,
    denyMutatingTools: false,
    abortOnMutation: false,
    promptHint: false,
  });
}

/**
 * Extra Agent.create / resume fields when Plan or Ask should deny mutating tools.
 *
 * @param {unknown} mode
 * @returns {{ disallowedTools?: readonly string[] }}
 */
export function resolveSdkPlanCreateOptions(mode) {
  const policy = resolveHarnessReadOnlyPolicy('sdk', mode);
  if (!isReadOnlySdkMode(mode) || !policy.denyMutatingTools) return {};
  return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
}
