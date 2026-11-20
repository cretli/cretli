/**
 * Context profiles of delegated children.
 *
 * A child never inherits the parent's whole global skills catalog. The role
 * (`review`, `implement`, `plan`) selects a profile; the only skills a child
 * sees are the ones the parent selected explicitly (`selected_skill_ids`),
 * delivered as selected-skill blocks. Rules keep their normal scope matching.
 *
 * The profile is applied by the assembler (preview and manifest) and by the
 * real decoration path through `resolveChatContextProfile`, so what the
 * manifest says is what is sent.
 */
import { findDelegationByChildChatId } from '../persist/delegations-persist.js';

export const DELEGATION_CONTEXT_PROFILE_SCHEMA = 1;

export interface DelegationContextProfile {
  id: 'review' | 'implement' | 'plan';
  /** Whether the global skills catalog is inherited. */
  skillsCatalog: boolean;
  /** How a child gets skills. */
  skillActivation: 'explicit_ids_only';
  /** Scope-matched alwaysApply rules still apply. */
  rules: boolean;
  /** AGENTS.md follows the normal channel matrix. */
  agentsMd: boolean;
}

export const DELEGATION_CONTEXT_PROFILES: Readonly<Record<'review' | 'implement' | 'plan', Readonly<DelegationContextProfile>>> = Object.freeze({
  review: Object.freeze({ id: 'review', skillsCatalog: false, skillActivation: 'explicit_ids_only', rules: true, agentsMd: true }),
  implement: Object.freeze({ id: 'implement', skillsCatalog: false, skillActivation: 'explicit_ids_only', rules: true, agentsMd: true }),
  plan: Object.freeze({ id: 'plan', skillsCatalog: false, skillActivation: 'explicit_ids_only', rules: true, agentsMd: true }),
});

export function resolveDelegationContextProfile(row: { assignment?: unknown, workRole?: unknown, pickRole?: unknown } | null | undefined): Readonly<DelegationContextProfile> {
  const workRole = String(row?.workRole || '').trim().toLowerCase();
  if (workRole === 'plan') return DELEGATION_CONTEXT_PROFILES.plan;
  const assignment = String(row?.assignment || row?.pickRole || '').trim().toLowerCase();
  return assignment === 'review' ? DELEGATION_CONTEXT_PROFILES.review : DELEGATION_CONTEXT_PROFILES.implement;
}

/**
 * Profile of a chat that is a delegation child; null for every other chat
 * (their behaviour is unchanged). Best effort: a lookup failure means no profile.
 */
export function resolveChatContextProfile(chatId: unknown): Readonly<DelegationContextProfile> | null {
  const id = String(chatId || '').trim();
  if (!id) return null;
  try {
    const row = findDelegationByChildChatId(id) as Record<string, any> | null;
    return row ? resolveDelegationContextProfile(row) : null;
  } catch {
    return null;
  }
}
