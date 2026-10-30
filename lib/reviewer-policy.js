/**
 * Effective reviewer policy per review subject (`plan` / `code`).
 *
 * One resolver feeds every start path (manual TODO, continue, full mode,
 * Watcher, MCP `model_pick`, HTTP / MCP `delegation_start`) so they all see the
 * same selection and session-continuation rules. The server enforces the result
 * on each review start; prompts only mirror it.
 *
 * Policy shape per subject:
 *   selection       auto | fixed_pair
 *   members_source  learned | configured   (fixed_pair only)
 *   members         two configured { harness, model } (configured only)
 *   session         fresh | leaf | orchestrator
 *
 * Migration (deterministic, idempotent, read-time; the legacy fields stay
 * stored untouched so a downgrade or a "use default" reset keeps working):
 *   reviewer_pair_strict=true            -> fixed_pair + session=leaf
 *       (leaf is the boundary strict mode really enforced; orchestrator-wide
 *       reuse is a NEW opt-in and the view carries a notice saying so)
 *   strict + two configured members      -> members_source=configured
 *   strict without a configured pair     -> members_source=learned
 *   enabled + two configured, not strict -> fixed_pair/configured, session=fresh
 *   anything else                        -> auto + fresh
 * `reviewer_policy` (when saved) overrides the derived value per subject.
 * `review:other` always keeps the legacy derivation.
 */

import crypto from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { resolveDelegationSettings } from './delegation-settings.js';
import { readReviewerPairMembers } from './persist/reviewer-pairs-persist.js';
import { isReviewerMemberStartable } from './reviewer-member-startable.js';
import { canonicalReviewerIdentity, sameCanonicalBaseModel } from './model-identity.js';
import { WORK_SWITCH_FIELDS } from './delegation-work-role.js';

export { normalizeReviewerPolicySnapshot } from './reviewer-policy-snapshot.js';

export const REVIEWER_SUBJECTS = Object.freeze(['plan', 'code']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Same harness and canonical base model = same reviewer (effort never makes a
 * second reviewer; a Claude alias and the numbered id it resolves to are one
 * reviewer).
 *
 * @param {{ harness?: unknown, model?: unknown }} a
 * @param {{ harness?: unknown, model?: unknown }} b
 * @returns {boolean}
 */
export function isSameReviewer(a, b) {
  const harnessA = text(a?.harness).toLowerCase();
  const harnessB = text(b?.harness).toLowerCase();
  return harnessA === harnessB && sameCanonicalBaseModel(harnessA, a?.model, b?.model);
}

/**
 * @param {unknown} subject
 * @returns {'plan' | 'code' | 'other'}
 */
export function normalizeReviewerSubject(subject) {
  const value = text(subject).toLowerCase();
  return value === 'plan' || value === 'code' ? value : 'other';
}

/**
 * Policy implied by the legacy `reviewer_pair_*` fields.
 *
 * @param {Record<string, unknown>} effective
 * @returns {{ selection: string, members_source: string, members: Array<{ harness: string, model: string }>, session: string }}
 */
export function deriveLegacyReviewerPolicy(effective) {
  const strict = effective?.reviewer_pair_strict === true;
  const enabled = effective?.reviewer_pair_enabled === true;
  const configured = Array.isArray(effective?.reviewer_pair_members) ? effective.reviewer_pair_members : [];
  const hasPair = configured.length === 2;
  if (strict) {
    return {
      selection: 'fixed_pair',
      members_source: hasPair ? 'configured' : 'learned',
      members: hasPair ? configured.map((m) => ({ harness: m.harness, model: m.model })) : [],
      session: 'leaf',
    };
  }
  if (enabled && hasPair) {
    return {
      selection: 'fixed_pair',
      members_source: 'configured',
      members: configured.map((m) => ({ harness: m.harness, model: m.model })),
      session: 'fresh',
    };
  }
  return { selection: 'auto', members_source: 'learned', members: [], session: 'fresh' };
}

/**
 * Settings view of all three subjects (no controller context): what the
 * Settings tab shows and what the migration produced.
 *
 * @param {Record<string, unknown>} effective
 * @returns {{
 *   plan: object, code: object, other: object,
 *   migration: { applied: boolean, notice: string, legacy: object },
 * }}
 */
export function buildReviewerPolicyView(effective) {
  const saved = effective?.reviewer_policy && typeof effective.reviewer_policy === 'object' ? effective.reviewer_policy : {};
  const legacy = deriveLegacyReviewerPolicy(effective);
  const entry = (subject) => (saved[subject]
    ? { ...saved[subject], source: 'policy' }
    : { ...legacy, source: 'legacy' });
  const legacyStrict = effective?.reviewer_pair_strict === true;
  const legacyMembers = Array.isArray(effective?.reviewer_pair_members) ? effective.reviewer_pair_members : [];
  // The "same members" notice only makes sense with a COMPLETE stored pair;
  // `enabled` without two members derives to `auto` and migrates nothing.
  const legacyPairApplied = effective?.reviewer_pair_enabled === true && legacyMembers.length === 2;
  const legacyActive = legacyStrict || legacyPairApplied;
  const usesLegacy = REVIEWER_SUBJECTS.some((subject) => !saved[subject]);
  return {
    plan: entry('plan'),
    code: entry('code'),
    other: { ...legacy, source: 'legacy' },
    migration: {
      applied: usesLegacy && legacyActive,
      // Strict used to reuse within one leaf only; widening is a new opt-in.
      notice: usesLegacy && legacyStrict ? 'strict_leaf_reuse' : '',
      legacy: {
        enabled: effective?.reviewer_pair_enabled === true,
        strict: legacyStrict,
        members: legacyMembers,
      },
    },
  };
}

/**
 * Stable short revision of a policy (snapshot id stored with each start).
 *
 * @param {object} policy
 * @returns {string}
 */
function policyRevision(policy) {
  // Identity of a configured member is the shared canonical reviewer key, so an
  // effort suffix or a Claude moving alias does not produce a different revision
  // for the SAME pair. `text` keeps the harness in the key for non-model fields.
  const canonical = JSON.stringify([
    policy.subject, policy.selection, policy.membersSource, policy.session,
    (policy.configured || []).map((m) => canonicalReviewerIdentity(m.harness, m.model)),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Effective reviewer policy of one workspace + subject (+ controller, for the
 * learned pair).
 *
 * @param {unknown} workspaceFolder
 * @param {{
 *   subject?: unknown,
 *   parentChatId?: unknown,
 *   delegations?: object[],
 *   dataDir?: string,
 *   env?: Record<string, string | undefined>,
 *   isMemberStartable?: (member: { harness: string, model: string }) => boolean,
 *   keepMember?: { harness: string, model: string } | null,
 * }} [options] `isMemberStartable` overrides the configuration check that
 *   evicts a learned member which can no longer be started (tests inject a
 *   stub); `keepMember` exempts the member the current start just learned.
 * @returns {{
 *   subject: 'plan' | 'code' | 'other',
 *   source: 'policy' | 'legacy',
 *   selection: string,
 *   membersSource: string,
 *   session: string,
 *   configured: Array<{ harness: string, model: string }>,
 *   learned: Array<{ harness: string, model: string }>,
 *   known: Array<{ harness: string, model: string }>,
 *   members: Array<{ harness: string, model: string }>,
 *   active: boolean,
 *   learning: boolean,
 *   reuse: boolean,
 *   revision: string,
 * }}
 */
export function resolveReviewerPolicy(workspaceFolder, options = {}) {
  const subject = normalizeReviewerSubject(options.subject);
  const empty = {
    subject, source: 'legacy', selection: 'auto', membersSource: 'learned', session: 'fresh',
    configured: [], learned: [], known: [], members: [], active: false, learning: false, reuse: false, revision: '',
  };
  const folder = text(workspaceFolder);
  if (!folder) return { ...empty, revision: policyRevision(empty) };
  try {
    const { effective } = resolveDelegationSettings({
      workspaceFolder: folder,
      dataDir: options.dataDir || resolveDataPath(),
      ...(options.env ? { env: options.env } : {}),
    });
    const view = buildReviewerPolicyView(effective);
    const entry = view[subject];
    const fixed = entry.selection === 'fixed_pair';
    const configured = fixed && entry.members_source === 'configured' ? entry.members : [];
    const learned = fixed && entry.members_source === 'learned' && text(options.parentChatId)
      ? readReviewerPairMembers(options.parentChatId, options.delegations, subject, {
        isMemberStartable: typeof options.isMemberStartable === 'function'
          ? options.isMemberStartable
          : isReviewerMemberStartable,
        keepMember: options.keepMember || null,
      })
      : [];
    const known = configured.length === 2 ? configured : learned;
    const members = known.length === 2 ? known.map((m) => ({ harness: m.harness, model: m.model })) : [];
    const policy = {
      subject,
      source: entry.source,
      selection: entry.selection,
      membersSource: entry.members_source,
      session: entry.session,
      configured,
      learned,
      known,
      members,
      active: members.length === 2,
      learning: fixed && entry.members_source === 'learned' && members.length < 2,
      // Session continuity is independent from reviewer membership. `auto`
      // still selects a model normally, then may reuse that model's own chat.
      reuse: entry.session !== 'fresh',
      revision: '',
    };
    return { ...policy, revision: policyRevision(policy) };
  } catch {
    return { ...empty, revision: policyRevision(empty) };
  }
}

/**
 * Durable snapshot stored on a review delegation (what was in force at start).
 *
 * @param {ReturnType<typeof resolveReviewerPolicy>} policy
 * @param {{ membership?: string, decision?: object | null }} [extra]
 * @returns {object}
 */
export function buildReviewerPolicySnapshot(policy, extra = {}) {
  return {
    subject: policy.subject,
    source: policy.source,
    revision: policy.revision,
    selection: policy.selection,
    membersSource: policy.membersSource,
    session: policy.session,
    members: policy.members.map((m) => ({ harness: m.harness, model: m.model })),
    membership: extra.membership || '',
    reuse: extra.decision
      ? {
        status: text(extra.decision.status),
        reasonCode: text(extra.decision.reasonCode),
        reason: text(extra.decision.reason),
        sourceDelegationId: text(extra.decision.sourceDelegationId),
      }
      : null,
  };
}

/**
 * Plan + code policies for the prompt builders of every start path, plus the
 * legacy `reviewerPool` / `reviewerPoolStrict` view (union of known members).
 *
 * @param {unknown} workspaceFolder
 * @param {Parameters<typeof resolveReviewerPolicy>[1]} [options]
 * @returns {{ policies: ReturnType<typeof resolveReviewerPolicy>[], workPolicies: object[], reviewerPool: Array<{ harness: string, model: string }>, reviewerPoolStrict: boolean }}
 */
export function resolveReviewerPoliciesForPrompt(workspaceFolder, options = {}) {
  const policies = REVIEWER_SUBJECTS.map((subject) => resolveReviewerPolicy(workspaceFolder, { ...options, subject }));
  const resolved = resolveDelegationSettings({
    workspaceFolder,
    dataDir: options.dataDir || resolveDataPath(),
    ...(options.env ? { env: options.env } : {}),
  });
  const workPolicies = Object.entries(WORK_SWITCH_FIELDS).map(([role, field]) => ({
    role,
    field,
    enabled: resolved.effective[field] === true,
    scope: resolved.effective[field] === true ? 'leaf' : 'fresh',
    source: resolved.source[field] || 'default',
  }));
  const reviewerPool = [];
  for (const policy of policies) {
    for (const member of policy.known) {
      if (!reviewerPool.some((m) => isSameReviewer(m, member))) reviewerPool.push({ harness: member.harness, model: member.model });
    }
  }
  return { policies, workPolicies, reviewerPool, reviewerPoolStrict: policies.some((p) => p.reuse) };
}

/**
 * @param {{ harness?: unknown, model?: unknown }} row
 * @returns {string}
 */
function pairIdentityKey(row) {
  return canonicalReviewerIdentity(text(row?.harness).toLowerCase(), text(row?.model));
}

/**
 * Can a fixed reviewer pair still obtain two DISTINCT canonical identities
 * (same harness + canonical base model, effort ignored)? Pure: the caller
 * supplies the members (with `startable: false` for a member that cannot be
 * started), the hard excludes (implementer / orchestrator) and the eligible
 * stand-in candidates. Independence is never relaxed: an excluded or
 * unstartable member is counted out, and two members of one identity count once.
 *
 * `missing` names the members that do not count (empty when satisfiable), each
 * with the reason: `excluded` (implementer/orchestrator), `unstartable`, or
 * `same_identity` (duplicate of another counted identity).
 *
 * @param {{
 *   members?: Array<{ harness?: unknown, model?: unknown, startable?: boolean }>,
 *   hardExcluded?: Array<{ harness?: unknown, model?: unknown }>,
 *   candidates?: Array<{ harness?: unknown, model?: unknown }>,
 * }} input
 * @returns {{ satisfiable: boolean, distinct: number, missing: Array<{ harness: string, model: string, reason: 'excluded' | 'unstartable' | 'same_identity' }> }}
 */
export function evaluateReviewerPairSatisfiability({ members = [], hardExcluded = [], candidates = [] } = {}) {
  const excluded = (row) => hardExcluded.some((ex) => {
    const harness = text(ex?.harness).toLowerCase();
    const rowHarness = text(row?.harness).toLowerCase();
    return (!harness || harness === rowHarness) && sameCanonicalBaseModel(rowHarness, ex?.model, row?.model);
  });
  /** @type {Set<string>} */
  const counted = new Set();
  /** @type {Array<{ harness: string, model: string, reason: 'excluded' | 'unstartable' | 'same_identity' }>} */
  const missing = [];
  for (const member of members) {
    const entry = { harness: text(member?.harness).toLowerCase(), model: text(member?.model) };
    if (excluded(member)) missing.push({ ...entry, reason: 'excluded' });
    else if (member?.startable === false) missing.push({ ...entry, reason: 'unstartable' });
    else if (counted.has(pairIdentityKey(member))) missing.push({ ...entry, reason: 'same_identity' });
    else counted.add(pairIdentityKey(member));
  }
  for (const candidate of candidates) {
    if (counted.size >= 2) break;
    if (!text(candidate?.harness) || !text(candidate?.model) || excluded(candidate)) continue;
    counted.add(pairIdentityKey(candidate));
  }
  const satisfiable = counted.size >= 2;
  return { satisfiable, distinct: counted.size, missing: satisfiable ? [] : missing };
}
