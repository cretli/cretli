/**
 * Soft context budget for what Cretli adds to a turn.
 *
 * Scope and guarantees:
 * - The budget measures Cretli's own contribution (static blocks, dynamic
 *   blocks, message) as characters and ESTIMATED tokens (chars / 4). It is a
 *   separate record from provider usage, cache counters and cost; nothing here
 *   reads or writes those, and the numbers are never labelled as usage.
 * - It is soft: it warns, it never blocks a send and never trims a block.
 *   Required material (message/task, mode hint, active alwaysApply rules and
 *   AGENTS.md, an explicitly selected skill, the current plan/criteria, the
 *   seed) is never shortened by this module.
 * - Optional material (catalog descriptions, page context, reports) may be
 *   named as a reduction candidate in a fixed order, but only an explicit
 *   caller applies it, and a bounded text keeps a marker plus a reference to
 *   the full content (`buildTruncationMarker`).
 * - Existing hard limits (`CONTEXT_LEGACY_LIMITS`) keep their semantics; they
 *   are character limits of individual inputs, not a model window.
 */
import { estimateTokensFromText } from '../sdk/sdk-context-advisory.ts';
import { buildTruncationMarker } from './truncation-marker.ts';

export { buildTruncationMarker };

export const CONTEXT_BUDGET_SCHEMA = 1;
export const CONTEXT_BUDGET_MODES = Object.freeze(['soft', 'off']);
/** Estimated tokens of Cretli-added material above which a warning is shown. */
export const DEFAULT_SOFT_BUDGET_TOKENS = 12000;
export const CONTEXT_TOKEN_ESTIMATE_METHOD = 'chars_div_4';

/**
 * Blocks that must reach the model whole. Anything not listed is optional.
 * `message`, `seed` and `task` are not assembler blocks; callers add them.
 */
export const REQUIRED_CONTEXT_BLOCKS = Object.freeze([
  'message', 'task', 'seed',
  'agents_md', 'workspace_rules', 'shared_rules',
  'skills', 'modeHint', 'chatPlan',
]);

/**
 * Order in which optional material is named as a reduction candidate when the
 * soft budget is exceeded: catalog descriptions first, then optional resources.
 */
export const OPTIONAL_REDUCTION_ORDER = Object.freeze([
  'skills_catalog', 'delegationReports', 'pageContext', 'titleHint',
]);

/**
 * Limits that existed before the budget. Listed so the UI and manifests can
 * mark them as legacy per-input character limits (not token windows).
 */
export const CONTEXT_LEGACY_LIMITS: Readonly<Record<string, { limit: number, unit: 'chars' | 'bytes', applies: string, behaviour: string }>> = Object.freeze({
  delegationTask: Object.freeze({ limit: 100000, unit: 'chars', applies: 'delegation task body', behaviour: 'rejected with plan_too_large' }),
  delegationReport: Object.freeze({ limit: 8000, unit: 'chars', applies: 'delegation report in parent context', behaviour: 'truncated with marker and delegation_show reference' }),
  harnessHandoff: Object.freeze({ limit: 24000, unit: 'chars', applies: 'harness-switch handoff transcript (tail kept)', behaviour: 'head dropped with marker and size' }),
  skillFile: Object.freeze({ limit: 64 * 1024, unit: 'bytes', applies: 'skill file read', behaviour: 'file skipped' }),
  skillDescription: Object.freeze({ limit: 1000, unit: 'chars', applies: 'skill description in catalog', behaviour: 'cut at limit' }),
});

/**
 * @returns Estimated tokens (never negative).
 */
export function estimateContextTokens(text: unknown): number {
  return estimateTokensFromText(text);
}

/**
 * Block requirement class.
 */
export function classifyContextBlock(id: string): 'required' | 'optional' {
  return REQUIRED_CONTEXT_BLOCKS.includes(String(id)) ? 'required' : 'optional';
}

export function normalizeBudgetMode(value: unknown): 'soft' | 'off' {
  return value === 'off' ? 'off' : 'soft';
}

/**
 * Soft budget for one turn.
 */
export function buildContextBudget(input: {
  blocks?: { id: string, text?: string, required?: boolean }[],
  message?: string,
  extraRequired?: { id: string, text?: string }[],
  mode?: string,
  softLimitTokens?: number,
} = {}): Record<string, any> {
  const mode = normalizeBudgetMode(input.mode);
  const softLimit = Number.isFinite(Number(input.softLimitTokens)) && Number(input.softLimitTokens) > 0
    ? Math.floor(Number(input.softLimitTokens))
    : DEFAULT_SOFT_BUDGET_TOKENS;
  const rows: { id: string, requirement: 'required' | 'optional', chars: number, estimatedTokens: number }[] = [];
  const push = (id: string, text: unknown, required: boolean) => {
    const value = String(text ?? '');
    if (!value) return;
    rows.push({
      id,
      requirement: required ? 'required' : 'optional',
      chars: value.length,
      estimatedTokens: estimateContextTokens(value),
    });
  };
  push('message', input.message, true);
  for (const block of input.blocks || []) {
    push(block.id, block.text, block.required ?? classifyContextBlock(block.id) === 'required');
  }
  for (const block of input.extraRequired || []) push(block.id, block.text, true);

  const sum = (pick: (row: (typeof rows)[number]) => boolean) => rows.filter(pick).reduce((total, row) => total + row.estimatedTokens, 0);
  const totals = {
    chars: rows.reduce((total, row) => total + row.chars, 0),
    estimatedTokens: sum(() => true),
    requiredTokens: sum((row) => row.requirement === 'required'),
    optionalTokens: sum((row) => row.requirement === 'optional'),
  };
  const over = mode === 'soft' && totals.estimatedTokens > softLimit;
  const overBy = over ? totals.estimatedTokens - softLimit : 0;

  const warnings: { code: string, message: string }[] = [];
  const suggestions: { id: string, estimatedTokens: number, action: string }[] = [];
  if (over) {
    warnings.push({
      code: 'soft_budget_exceeded',
      message: `Cretli adds about ${totals.estimatedTokens} estimated tokens (soft limit ${softLimit}). Nothing was trimmed or blocked.`,
    });
    let remaining = overBy;
    for (const id of OPTIONAL_REDUCTION_ORDER) {
      const row = rows.find((candidate) => candidate.id === id && candidate.requirement === 'optional');
      if (!row) continue;
      suggestions.push({ id, estimatedTokens: row.estimatedTokens, action: 'shorten_or_disable' });
      remaining -= row.estimatedTokens;
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      warnings.push({
        code: 'required_exceeds_soft_budget',
        message: 'Optional material alone cannot bring the turn under the soft limit; required blocks are never shortened.',
      });
    }
  }
  return {
    schema: CONTEXT_BUDGET_SCHEMA,
    mode,
    estimate: { method: CONTEXT_TOKEN_ESTIMATE_METHOD, kind: 'estimated' },
    // This record is not provider usage, cache accounting or cost.
    separateFrom: ['usage', 'cache', 'cost'],
    softLimitTokens: softLimit,
    status: mode === 'off' ? 'off' : over ? 'over_soft_limit' : 'ok',
    overByTokens: overBy,
    totals,
    blocks: rows,
    suggestions,
    // Cretli itself never shortens anything here.
    trimmed: [],
    legacyLimits: CONTEXT_LEGACY_LIMITS,
    warnings,
  };
}

/**
 * Human-facing message for a hard provider window error. It states the sizes
 * Cretli contributed and the ways forward. It is never followed by an
 * automatic resend with shortened instructions (`autoRetry` is always false).
 */
export function buildProviderWindowError(input: { transport?: string, providerMessage?: string, budget?: Record<string, any> | null } = {}): Record<string, any> {
  const budget = input.budget || null;
  const sizes = budget
    ? {
      cretliChars: budget.totals?.chars ?? 0,
      cretliEstimatedTokens: budget.totals?.estimatedTokens ?? 0,
      requiredEstimatedTokens: budget.totals?.requiredTokens ?? 0,
      optionalEstimatedTokens: budget.totals?.optionalTokens ?? 0,
      blocks: (budget.blocks || []).map((row: Record<string, any>) => ({ id: row.id, requirement: row.requirement, chars: row.chars, estimatedTokens: row.estimatedTokens })),
      estimated: true,
    }
    : null;
  const detail = sizes
    ? `Cretli added ${sizes.cretliChars} chars (about ${sizes.cretliEstimatedTokens} estimated tokens; ${sizes.requiredEstimatedTokens} required, ${sizes.optionalEstimatedTokens} optional). The history and tool output are not included in this figure.`
    : 'Cretli could not measure its own contribution for this turn.';
  return {
    code: 'context_window_exceeded',
    transport: String(input.transport || ''),
    message: `The provider rejected the request because it exceeds the model context window. ${detail} Cretli did not shorten any instructions and did not resend.`,
    providerMessage: String(input.providerMessage || '').slice(0, 500),
    sizes,
    options: ['change_context_set', 'start_new_session', 'compress_history'],
    autoRetry: false,
  };
}

const WINDOW_ERROR_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /prompt is too long/i,
  /too many (input )?tokens/i,
  /input is too long/i,
  /exceeds? the (model'?s )?(context|token) (limit|window)/i,
];

/**
 * @param message Provider error text.
 */
export function isProviderWindowError(message: unknown): boolean {
  const text = String(message || '');
  return text.length > 0 && WINDOW_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
