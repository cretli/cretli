/**
 * Pure, browser-safe decision for the "Approve plan" affordances on a Todo
 * card. It is shared by the approval banner and the Plan tab so both stay in
 * sync, and it runs both in the bundler (Lit component) and under `node:test`.
 *
 * Approval is bound to plan content, not to the task status: editing the plan
 * drops `plan.approvedAt`, but a container's status is derived from its
 * children, so a root whose children are all done stays `done` and cannot be
 * reopened by hand. The approval prompt must therefore stay available for a
 * `done` item too. Only a human may set `approvedAt` in the UI — this helper
 * never mutates the item.
 */

/**
 * Whether the Todo card should offer the plan approval action.
 *
 * @param {{ plan?: { markdown?: unknown, approvedAt?: unknown } | null } | null | undefined} item Todo item (read-side shape)
 * @returns {boolean} true when the plan has a non-empty markdown and no approval
 */
export function shouldOfferPlanApproval(item) {
  const plan = item?.plan;
  if (!plan || typeof plan !== 'object') return false;
  const markdown = typeof plan.markdown === 'string' ? plan.markdown.trim() : '';
  if (!markdown) return false;
  const approvedAt = typeof plan.approvedAt === 'string' ? plan.approvedAt.trim() : '';
  return !approvedAt;
}
