import { normalizeAgentTransport } from '../agent-transport.js';

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
    abortOnMutation: false,
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
    abortOnMutation: false,
    promptHint: false,
  }),
  deepseek: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: true,
  }),
  codex: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: true,
  }),
  qwen: Object.freeze({
    nativeMode: true,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: false,
  }),
});

/**
 * Built-in Cursor SDK tools withheld in Plan mode.
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
 * Extra Agent.create / resume fields when Plan should deny mutating tools.
 *
 * @param {unknown} mode
 * @returns {{ disallowedTools?: readonly string[] }}
 */
export function resolveSdkPlanCreateOptions(mode) {
  const policy = resolveHarnessPlanPolicy('sdk');
  if (mode !== 'plan' || !policy.denyMutatingTools) return {};
  return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
}
