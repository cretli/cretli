/**
 * Harness-neutral permission engine: one ordered pipeline for every harness.
 *
 * Pure module: no network, fs or harness imports. Callers (harness adapters)
 * hand in already-computed facts — hard-block verdict, settings snapshot, grant
 * list, broker classification and advisor outcome — and apply the returned
 * PermissionDecision. Pipeline order, first decisive stage wins:
 *   1. hard block (plan / review / scout)   -> deny, source hard_block
 *   2. user category settings and grants     -> source user_category/user_grant
 *   3. broker deterministic classification   -> source broker
 *   4. advisor outcome (narrowing only)      -> source advisor
 *   5. manual card                           -> ask_user, source manual
 *
 * NOT WIRED YET: the persistent grant store and the category settings UI do not
 * exist in this round. When `settings` / `grants` are absent stage 2 is skipped.
 */

import type { PermissionDecision } from './permission-decision.ts';
import {
  buildPermissionDecision,
  classifyPermissionDecisionCategory,
} from './permission-decision.ts';

/** Per-harness policy version table; the pipeline itself is identical. */
export const PERMISSION_ENGINE_POLICY_VERSIONS = Object.freeze({
  opencode: 'approval-broker-v1',
});

const BROKER_MODES = ['off', 'shadow', 'local_reads'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function finish(
  input: Record<string, unknown>,
  ctx: { policyVersion: string; category: string },
  fields: Record<string, unknown>,
): PermissionDecision {
  return buildPermissionDecision({
    harness: input.harness,
    workspace: input.workspace,
    chatId: input.chatId,
    runId: input.runId,
    requestId: input.requestId,
    permission: input.permission,
    category: ctx.category,
    policyVersion: ctx.policyVersion,
    ...fields,
  });
}

/**
 * Stage 2: explicit user category settings, then persistent grants. An allow
 * never widens a high-risk request (fail-safe); a deny always applies.
 *
 * @param input
 * @param category
 * @param highRisk
 */
function resolveUserStage(
  input: Record<string, unknown>,
  category: string,
  highRisk: boolean,
): { state: string; source: string; reason: string } | null {
  const harness = String(input.harness || '').toLowerCase();
  const workspace = String(input.workspace || '');
  const permission = String(input.permission || '').toLowerCase();
  const grants = Array.isArray(input.grants) ? input.grants : [];
  for (const raw of grants) {
    const grant = asRecord(raw);
    if (String(grant.harness || '').toLowerCase() !== harness) continue;
    if (String(grant.workspace || '') !== workspace) continue;
    if (String(grant.permission || '').toLowerCase() !== permission) continue;
    if (grant.effect === 'deny') return { state: 'deny', source: 'user_grant', reason: 'user_grant_deny' };
    if (grant.effect === 'allow' && !highRisk) {
      return { state: 'allow_always', source: 'user_grant', reason: 'user_grant_allow' };
    }
  }
  const settings = asRecord(input.settings);
  const byHarness = asRecord(asRecord(settings.harnesses)[harness]);
  const setting = String(
    asRecord(byHarness.categories)[category] ?? asRecord(settings.categories)[category] ?? '',
  ).toLowerCase();
  if (setting === 'deny') return { state: 'deny', source: 'user_category', reason: 'user_category_deny' };
  if (setting === 'allow' && !highRisk) {
    return { state: 'allow_once', source: 'user_category', reason: 'user_category_allow' };
  }
  return null;
}

/**
 * Stage 3 recommendation from the broker facts (mirrors the legacy OpenCode
 * broker rules; the caller computes the facts with its own classifier).
 *
 * @param broker
 */
function recommendFromBroker(broker: Record<string, unknown>): { state: string; reason: string; high: boolean } {
  const categories = Array.isArray(broker.categories) ? broker.categories.map(String) : [];
  if (broker.risk === 'high') {
    const category = categories.find((entry) => entry !== 'mutation') || categories[0] || 'unknown';
    return { state: 'ask_user', reason: `high_risk_${category}`, high: true };
  }
  if (broker.delegationRead === true || broker.interactiveRead === true) {
    return {
      state: 'allow_once',
      reason: broker.delegationRead === true ? 'delegation_read_once' : 'interactive_safe_read',
      high: false,
    };
  }
  return {
    state: 'ask_user',
    reason: categories.includes('mutation') ? 'mutation_requires_user' : 'manual_review',
    high: false,
  };
}

export interface PermissionPolicyInput {
  harness?: string;
  workspace?: string;
  chatId?: string;
  runId?: string;
  requestId?: string;
  permission?: string;
  hardBlock?: { blocked?: boolean } | null;
  settings?: unknown;
  grants?: unknown[];
  broker?: {
    mode?: string;
    risk?: string;
    categories?: string[];
    delegationRead?: boolean;
    interactiveRead?: boolean;
  } | null;
  advisor?: { outcome?: string; failed?: boolean } | null;
  policyVersion?: string;
}

/**
 * Resolves one permission request through the ordered pipeline.
 *
 * @param rawInput
 */
export function resolvePermissionPolicyOutcome(rawInput: PermissionPolicyInput = {}): PermissionDecision {
  const input = asRecord(rawInput);
  const harness = String(input.harness || '').toLowerCase();
  const broker = asRecord(input.broker);
  const mode = BROKER_MODES.includes(String(broker.mode)) ? String(broker.mode) : 'off';
  const ctx = {
    category: classifyPermissionDecisionCategory(input.permission),
    policyVersion: String(
      input.policyVersion
        || (PERMISSION_ENGINE_POLICY_VERSIONS as Record<string, string>)[harness]
        || '',
    ),
  };
  const risk = ['low', 'medium', 'high'].includes(String(broker.risk)) ? String(broker.risk) : 'high';
  const categories = Array.isArray(broker.categories) ? broker.categories : [];
  const base = { risk, categories };
  const shadow = mode === 'shadow';

  // 1. Hard block always wins; in shadow mode it is only recorded.
  if (asRecord(input.hardBlock).blocked === true) {
    return finish(input, ctx, {
      ...base,
      state: 'deny',
      source: 'hard_block',
      reason: shadow ? 'shadow_plan_or_review_guard' : 'plan_or_review_guard',
      shadow,
      notifyUser: shadow,
    });
  }

  // 2. User categories and persistent grants (skipped when absent).
  const userStage = resolveUserStage(input, ctx.category, risk === 'high');
  if (userStage) {
    return finish(input, ctx, { ...base, ...userStage, shadow: false, notifyUser: false });
  }

  // 3. Broker deterministic classification.
  if (!input.broker) {
    return finish(input, ctx, { ...base, state: 'ask_user', source: 'manual', reason: 'manual_card', notifyUser: true });
  }
  if (mode === 'off') {
    const allow = broker.delegationRead === true;
    return finish(input, ctx, {
      ...base,
      state: allow ? 'allow_once' : 'ask_user',
      source: 'broker',
      reason: allow ? 'legacy_delegation_read_once' : 'broker_off',
      notifyUser: !allow,
    });
  }
  const rec = recommendFromBroker(broker);
  if (shadow) {
    return finish(input, ctx, {
      ...base,
      state: rec.state === 'allow_once' ? 'shadow_allow' : rec.state,
      source: 'broker',
      reason: `shadow_${rec.reason}`,
      shadow: true,
      notifyUser: true,
    });
  }
  if (rec.state === 'allow_once' || rec.high) {
    return finish(input, ctx, {
      ...base,
      state: rec.state,
      source: 'broker',
      reason: rec.reason,
      notifyUser: rec.state === 'ask_user',
    });
  }

  // 4. Advisor: may only narrow to a single allow_once for a non-high ask.
  const advisor = asRecord(input.advisor);
  if (input.advisor) {
    if (advisor.failed === true || !['allow_once', 'ask_user'].includes(String(advisor.outcome))) {
      return finish(input, ctx, {
        ...base, state: 'ask_user', source: 'advisor', reason: 'advisor_failed', notifyUser: true,
      });
    }
    if (advisor.outcome === 'allow_once') {
      return finish(input, ctx, {
        ...base, state: 'allow_once', source: 'advisor', reason: 'advisor_allow_once', notifyUser: false,
      });
    }
  }

  // 5. Manual card keeps the broker reason when it is the first ask.
  return finish(input, ctx, {
    ...base, state: 'ask_user', source: 'manual', reason: rec.reason, notifyUser: true,
  });
}
