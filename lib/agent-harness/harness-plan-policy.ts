import { normalizeAgentTransport } from '../agent-transport.js';
import { isAskSdkMode, isReadOnlySdkMode, normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';

export interface HarnessPlanPolicy {
  nativeMode: boolean;
  denyMutatingTools: boolean;
  abortOnMutation: boolean;
  promptHint: boolean;
}

type PlanPolicyTransport = 'sdk' | 'openrouter' | 'mistral' | 'zai' | 'mimo' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen' | 'claude';

const HARNESS_PLAN_POLICIES: Readonly<Record<PlanPolicyTransport, HarnessPlanPolicy>> = Object.freeze({
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
  mistral: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: false,
  }),
  zai: Object.freeze({
    nativeMode: false,
    denyMutatingTools: true,
    abortOnMutation: false,
    promptHint: false,
  }),
  mimo: Object.freeze({
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
  'mistral',
  'zai',
  'mimo',
  'codebuddy',
  'qwen',
  'deepseek',
  'claude',
]);

/**
 * Returns how Plan mode is enforced for a chat harness.
 */
export function resolveHarnessPlanPolicy(transport: unknown): HarnessPlanPolicy {
  return HARNESS_PLAN_POLICIES[normalizeAgentTransport(transport)];
}

/**
 * Ask always denies mutations, even when Plan for this harness is prompt-only.
 * Native APIs never receive raw `ask`.
 */
export function resolveHarnessAskPolicy(_transport?: unknown): HarnessPlanPolicy {
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
 */
export function resolveHarnessReviewPolicy(transport: unknown): HarnessPlanPolicy {
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
 */
export function resolveHarnessReadOnlyPolicy(transport: unknown, mode: unknown, assignment?: unknown): HarnessPlanPolicy {
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
 */
export function resolveSdkPlanCreateOptions(
  mode: unknown,
  assignment?: unknown,
  options: { scoutReadOnly?: boolean } = {},
): { disallowedTools?: readonly string[] } {
  if (options.scoutReadOnly === true) {
    return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
  }
  const policy = resolveHarnessReadOnlyPolicy('sdk', mode, assignment);
  if ((!isReadOnlySdkMode(mode) && !isReviewReadOnlyAssignment(assignment)) || !policy.denyMutatingTools) {
    return {};
  }
  return { disallowedTools: SDK_PLAN_DISALLOWED_TOOLS };
}
