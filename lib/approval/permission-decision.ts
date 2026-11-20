/**
 * Harness-neutral PermissionDecision contract.
 *
 * Pure module: no fs/path and no harness imports. Every field is validated and
 * clamped; an unknown state, source or category fails closed to `ask_user` with
 * source `default` — never to an allow.
 */

export const PERMISSION_DECISION_STATES = Object.freeze([
  'allow_once',
  'allow_always',
  'deny',
  'ask_user',
  'shadow_allow',
]);

export const PERMISSION_DECISION_SOURCES = Object.freeze([
  'hard_block',
  'user_category',
  'user_grant',
  'broker',
  'advisor',
  'manual',
  'default',
]);

/** User-facing decision categories (settings and grants). */
export const PERMISSION_DECISION_CATEGORIES = Object.freeze(['files', 'mcp', 'shell', 'web', 'other']);

/** Broker risk categories; they stay separate from decision categories. */
export const PERMISSION_RISK_CATEGORIES = Object.freeze([
  'mutation',
  'network',
  'secrets',
  'privilege',
  'destructive',
  'expansion',
]);

export const PERMISSION_RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const PERMISSION_GRANT_SCOPES = Object.freeze(['once', 'always', 'none']);
export const PERMISSION_REPLIES = Object.freeze(['once', 'always', 'reject']);

const FIXED_REASONS = Object.freeze([
  'plan_or_review_guard',
  'user_category_allow',
  'user_category_deny',
  'user_grant_allow',
  'user_grant_deny',
  'legacy_delegation_read_once',
  'delegation_read_once',
  'interactive_safe_read',
  'broker_off',
  'mutation_requires_user',
  'manual_review',
  'manual_card',
  'advisor_allow_once',
  'advisor_failed',
  'invalid_state',
  'invalid_source',
  'invalid_category',
  'invalid_reason',
]);

const HIGH_RISK_REASON_RE = /^high_risk_([a-z]+)$/;

function pickClosed(value: unknown, allowed: readonly string[]): string | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(text) ? text : null;
}

/**
 * Clamps a reason to the fixed machine-readable vocabulary. Free text (for
 * example model output) collapses to `invalid_reason`.
 *
 * @param value
 */
export function normalizePermissionReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'invalid_reason';
  const base = text.startsWith('shadow_') ? text.slice('shadow_'.length) : text;
  if (FIXED_REASONS.includes(base)) return text;
  const high = HIGH_RISK_REASON_RE.exec(base);
  if (high && (high[1] === 'unknown' || PERMISSION_RISK_CATEGORIES.includes(high[1]))) return text;
  return 'invalid_reason';
}

/**
 * Maps a tool/permission name to a user-facing decision category.
 *
 * @param permission
 */
export function classifyPermissionDecisionCategory(permission: unknown): 'files' | 'mcp' | 'shell' | 'web' | 'other' {
  const name = String(permission || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) return 'other';
  if (name.startsWith('mcp') || name.includes('_mcp_')) return 'mcp';
  if (/^(bash|shell|exec|command|run_command|terminal)/.test(name)) return 'shell';
  if (/(webfetch|websearch|web_fetch|web_search|fetch|http|browse)/.test(name)) return 'web';
  if (/^(edit|write|read|multiedit|multi_edit|patch|apply_patch|glob|grep|list|ls|file|notebook)/.test(name)) return 'files';
  return 'other';
}

function normalizeRiskCategories(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const value = pickClosed(entry, PERMISSION_RISK_CATEGORIES);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function clampText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export interface PermissionDecision {
  harness: string;
  workspace: string;
  chatId: string;
  runId: string;
  requestId: string;
  permission: string;
  category: string;
  grantScope: string;
  state: string;
  source: string;
  risk: string;
  categories: string[];
  policyVersion: string;
  reason: string;
  reply: 'once' | 'always' | 'reject' | null;
  shadow: boolean;
  notifyUser: boolean;
}

/**
 * Builds a validated PermissionDecision.
 *
 * @param input
 */
export function buildPermissionDecision(input: Record<string, unknown> = {}): PermissionDecision {
  const src = input && typeof input === 'object' ? input : {} as Record<string, unknown>;
  let state = pickClosed(src.state, PERMISSION_DECISION_STATES);
  let source = pickClosed(src.source, PERMISSION_DECISION_SOURCES);
  const category = pickClosed(src.category, PERMISSION_DECISION_CATEGORIES);
  let reason = normalizePermissionReason(src.reason);
  let failed = false;
  if (!state) {
    failed = true;
    reason = 'invalid_state';
  } else if (!source) {
    failed = true;
    reason = 'invalid_source';
  } else if (!category && src.category !== undefined && src.category !== '') {
    failed = true;
    reason = 'invalid_category';
  }
  if (failed) {
    state = 'ask_user';
    source = 'default';
  }
  const risk = pickClosed(src.risk, PERMISSION_RISK_LEVELS) || 'high';
  const finalState = state as string;
  let reply = pickClosed(src.reply, PERMISSION_REPLIES);
  // The reply is derived from the state so it can never contradict it.
  if (finalState === 'allow_once') reply = reply === 'once' || reply === null ? 'once' : null;
  else if (finalState === 'allow_always') reply = 'always';
  else if (finalState === 'deny') reply = 'reject';
  else reply = null;
  // A shadow decision is advisory only: it never carries an executable reply.
  if (src.shadow === true) reply = null;
  const grantScope = finalState === 'allow_always' ? 'always' : finalState === 'allow_once' ? 'once' : 'none';
  return {
    harness: clampText(src.harness, 64).toLowerCase(),
    workspace: clampText(src.workspace, 1024),
    chatId: clampText(src.chatId, 128),
    runId: clampText(src.runId, 128),
    requestId: clampText(src.requestId, 256),
    permission: clampText(src.permission, 256),
    category: category || 'other',
    grantScope,
    state: finalState,
    source: source as string,
    risk,
    categories: normalizeRiskCategories(src.categories),
    policyVersion: clampText(src.policyVersion, 64),
    reason,
    reply: reply as 'once' | 'always' | 'reject' | null,
    shadow: src.shadow === true,
    notifyUser: failed ? true : src.notifyUser === true || finalState === 'ask_user',
  };
}
