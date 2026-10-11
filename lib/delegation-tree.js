/**
 * Delegation tree model: root/depth computation and the depth + grant gate.
 * Pure logic, no persistence. Default CRETLI_DELEGATION_MAX_DEPTH=1 keeps the
 * historical "child chats cannot delegate" behavior.
 */

export const DEFAULT_DELEGATION_MAX_DEPTH = 1;
export const HARD_DELEGATION_MAX_DEPTH = 8;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveDelegationMaxDepth(env = process.env) {
  const raw = Number.parseInt(String(env?.CRETLI_DELEGATION_MAX_DEPTH ?? '').trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DELEGATION_MAX_DEPTH;
  return Math.min(raw, HARD_DELEGATION_MAX_DEPTH);
}

/**
 * Depth of the chat that would start a delegation. A root chat is 0; a
 * delegation child chat is its recorded depth (legacy children count as 1).
 *
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function readChatDelegationDepth(chat) {
  if (!chat || typeof chat !== 'object') return 0;
  if (!String(chat.delegationParentChatId || '').trim()) return 0;
  const depth = Math.floor(Number(chat.delegationDepth));
  return depth >= 1 ? depth : 1;
}

/**
 * Internal grant hook: a child chat may delegate further only when flagged.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function hasNestedDelegationGrant(chat) {
  return chat?.delegationGrant === true;
}

/**
 * @param {{ parent: object, maxDepth?: number }} input
 * @returns {{ ok: true, depth: number, rootChatId: string, rootDelegationId: string }
 *   | { ok: false, status: number, error: string, code: string }}
 */
export function evaluateDelegationDepthGate(input) {
  const parent = input.parent;
  const maxDepth = input.maxDepth ?? resolveDelegationMaxDepth();
  const parentDepth = readChatDelegationDepth(parent);
  const depth = parentDepth + 1;
  if (parentDepth >= 1) {
    if (!hasNestedDelegationGrant(parent)) {
      return {
        ok: false,
        status: 409,
        error: 'Child chats cannot start another delegation. Return the report to the parent instead.',
        code: 'nested_delegation_denied',
      };
    }
    if (depth > maxDepth) {
      return {
        ok: false,
        status: 409,
        error: `Delegation depth ${depth} exceeds the maximum of ${maxDepth}.`,
        code: 'depth_exceeded',
      };
    }
  }
  const rootChatId = parentDepth >= 1
    ? String(parent.delegationRootChatId || '').trim() || String(parent.delegationParentChatId || '').trim()
    : String(parent.id || '').trim();
  return {
    ok: true,
    depth,
    rootChatId,
    rootDelegationId: parentDepth >= 1 ? String(parent.delegationRootDelegationId || '').trim() : '',
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function normalizeAllowChildDelegations(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

/**
 * Attenuation: the grant a new child receives. A root chat (depth 0) may grant
 * freely; a child may grant only when it holds the grant itself, so a grant
 * can never exceed what the granting chat was given. The grant is always
 * scoped to the new child's own subtree (its row, its descendants).
 *
 * @param {{ parent: object, requested?: unknown }} input
 * @returns {boolean}
 */
export function resolveChildDelegationGrant(input) {
  if (!normalizeAllowChildDelegations(input?.requested)) return false;
  const parent = input?.parent;
  if (readChatDelegationDepth(parent) === 0) return true;
  return hasNestedDelegationGrant(parent);
}

/**
 * Remaining nested levels a chat at `depth` may still create.
 *
 * @param {{ depth: number, maxDepth?: number }} input
 * @returns {number}
 */
export function remainingDelegationDepth(input) {
  const maxDepth = input.maxDepth ?? resolveDelegationMaxDepth();
  return Math.max(0, maxDepth - Math.max(0, Math.floor(Number(input.depth)) || 0));
}

/**
 * Backfill for legacy rows: depth 1, root = direct parent. Idempotent.
 *
 * @param {object} row
 * @returns {{ depth: number, rootChatId: string, rootDelegationId: string }}
 */
export function resolveRecordTreeFields(row) {
  const depth = Math.floor(Number(row?.depth));
  return {
    depth: depth >= 1 ? depth : 1,
    rootChatId: String(row?.rootChatId || '').trim() || String(row?.parentChatId || '').trim(),
    rootDelegationId: String(row?.rootDelegationId || '').trim() || String(row?.id || '').trim(),
  };
}
