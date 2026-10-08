import { normalizeAgentTransport } from '../agent-transport.js';
import { isAskSdkMode, isReadOnlySdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';

/**
 * @typedef {{
 *   nativeMode: boolean,
 *   denyMutatingTools: boolean,
 *   abortOnMutation: boolean,
 *   promptHint: boolean,
 * }} HarnessPlanPolicy
 */

/** @type {Readonly<Record<'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen' | 'claude', HarnessPlanPolicy>>} */
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
  claude: Object.freeze({
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
 * Cursor SDK has no canUseTool before native shell. Review keeps the same
 * native block as Plan/Ask so `rm` cannot start before host abort.
 */
export const SDK_REVIEW_DISALLOWED_TOOLS = SDK_PLAN_DISALLOWED_TOOLS;

const REVIEW_PRE_EXEC_DENY_TRANSPORTS = new Set([
  'opencode',
  'openrouter',
  'codebuddy',
  'qwen',
  'deepseek',
  'claude',
]);

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
 * Review denies mutations. Harnesses that can reject before exec do not abort
 * the whole job, so the reviewer can keep reading and reporting.
 *
 * @param {unknown} transport
 * @returns {HarnessPlanPolicy}
 */
export function resolveHarnessReviewPolicy(transport) {
  const name = normalizeAgentTransport(transport);
  const abortOnMutation = !REVIEW_PRE_EXEC_DENY_TRANSPORTS.has(name);
  return Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation,
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
export function resolveHarnessReadOnlyPolicy(transport, mode, assignment) {
  if (isReviewReadOnlyAssignment(assignment)) return resolveHarnessReviewPolicy(transport);
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
 * Review uses the same native Cursor block as Plan (edit, delete, shell).
 *
 * @param {unknown} mode
 * @param {unknown} [assignment]
 * @param {{ scoutReadOnly?: boolean }} [options]
 * @returns {{ disallowedTools?: readonly string[] }}
 */
export function resolveSdkPlanCreateOptions(mode, assignment, options = {}) {
  if (options.scoutReadOnly === true) {
    return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
  }
  const policy = resolveHarnessReadOnlyPolicy('sdk', mode, assignment);
  if ((!isReadOnlySdkMode(mode) && !isReviewReadOnlyAssignment(assignment)) || !policy.denyMutatingTools) {
    return {};
  }
  return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
}
