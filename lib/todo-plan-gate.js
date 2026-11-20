/**
 * Browser-safe plan-gate semantics shared by the Watcher guardrail, the MCP
 * read models and the todo UI, so every surface agrees on when a ready todo
 * still waits for a human to approve a plan.
 */
import { isFeedbackDerivedTodo } from './feedback-marker.js';

/** Body length (chars) from which a leaf without `## Leaf scope` reads as an initiative. */
export const WATCHER_INITIATIVE_BODY_MIN_CHARS = 1200;

const LEAF_SCOPE_HEADING_RE = /^##\s+leaf\s+scope\s*$/im;

function hasLeafScopeSection(text) {
  return String(text || '').split(/\r?\n/).some((line) => LEAF_SCOPE_HEADING_RE.test(line.trim()));
}

/**
 * True when the leaf looks like an initiative rather than a scoped task: no
 * `## Leaf scope` section and a large description.
 *
 * @param {Record<string, any> | null | undefined} todo
 * @returns {boolean}
 */
export function isWatcherInitiativeLeaf(todo) {
  const body = String(todo?.body ?? '');
  return body.trim().length >= WATCHER_INITIATIVE_BODY_MIN_CHARS && !hasLeafScopeSection(body);
}

/**
 * The todo followed by its ancestors, nearest first.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} pickedTodo
 * @returns {Record<string, any>[]}
 */
export function planChain(items, pickedTodo) {
  const index = new Map((Array.isArray(items) ? items : []).map((row) => [String(row?.id || ''), row]));
  const chain = [];
  const seen = new Set();
  let current = pickedTodo || null;
  while (current && !seen.has(String(current.id || ''))) {
    seen.add(String(current.id || ''));
    chain.push(current);
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  return chain;
}

/**
 * Plan text and approval the gate reads for a todo: the nearest saved plan and
 * approval on its chain, else an accepted container body.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} pickedTodo
 * @returns {{ markdown: string, approvedAt: string }}
 */
export function resolveWatcherGatePlan(items, pickedTodo) {
  const list = Array.isArray(items) ? items : [];
  const chain = planChain(list, pickedTodo);
  let markdown = '';
  let approvedAt = '';
  for (const node of chain) {
    if (!markdown) markdown = String(node?.plan?.markdown ?? '').trim();
    if (!approvedAt) approvedAt = String(node?.plan?.approvedAt ?? '').trim();
    if (markdown && approvedAt) break;
  }
  if (markdown) return { markdown, approvedAt };
  const parentIds = new Set(list.map((row) => String(row?.parentId || '').trim()).filter(Boolean));
  for (const node of chain) {
    if (!parentIds.has(String(node?.id || ''))) continue;
    const body = String(node?.body ?? '').trim();
    if (!body) continue;
    const status = String(node.status || '');
    const accepted = status === 'ready' || status === 'doing' || status === 'done';
    return { markdown: body, approvedAt: accepted ? String(node.updatedAt || '').trim() || status : '' };
  }
  return { markdown: '', approvedAt: '' };
}

/**
 * Plan-gate approval for one todo under a watcher policy. `gated: false` means
 * the policy does not require approval for it (`requirePlanApproval: false`,
 * except feedback-derived todos, which always do).
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} todo
 * @param {Record<string, any> | null | undefined} policy
 * @returns {{ gated: boolean, approvedAt: string, markdown: string }}
 */
export function resolveTodoPlanGateApproval(items, todo, policy) {
  if (!todo) return { gated: false, approvedAt: '', markdown: '' };
  const feedbackDerived = isFeedbackDerivedTodo(items, todo);
  if (policy?.requirePlanApproval === false && !feedbackDerived) return { gated: false, approvedAt: '', markdown: '' };
  const plan = resolveWatcherGatePlan(items, todo);
  const chain = planChain(items, todo);
  const hasMarkdownInChain = chain.some((node) => String(node?.plan?.markdown ?? '').trim());
  const hasApprovalInChain = chain.some((node) => String(node?.plan?.approvedAt ?? '').trim());
  // A container body only counts as implicit approval for ordinary leaves; an
  // initiative-shaped leaf with no saved plan still gets a plan draft first.
  const approvedAt = !feedbackDerived && plan.approvedAt
    && !(!hasMarkdownInChain && isWatcherInitiativeLeaf(todo) && !hasApprovalInChain)
    ? plan.approvedAt
    : (feedbackDerived ? String(todo.plan?.approvedAt || '').trim() : '');
  return { gated: true, approvedAt, markdown: plan.markdown };
}

/**
 * True for a stored-`ready` leaf the Watcher would hold behind its plan gate.
 * Without a policy nothing can be claimed, so the answer is false.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} todo
 * @param {Record<string, any> | null | undefined} policy
 * @returns {boolean}
 */
export function isTodoWaitingForPlan(items, todo, policy) {
  if (!policy || typeof policy !== 'object' || todo?.status !== 'ready') return false;
  const id = String(todo.id || '');
  if (id && (Array.isArray(items) ? items : []).some((row) => String(row?.parentId || '') === id)) return false;
  const gate = resolveTodoPlanGateApproval(items, todo, policy);
  return gate.gated && !gate.approvedAt;
}
