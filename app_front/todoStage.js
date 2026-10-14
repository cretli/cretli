/**
 * Todo stage progress (checkout-style stepper).
 *
 * Pure derivation of "where is this todo in the lifecycle" from the fields the
 * server already computes. Containers rely on the server-aggregated
 * `integrationSummary` / `review` aggregates — nothing is re-aggregated here.
 */

/** Step ids in lifecycle order. */
export const TODO_STAGE_IDS = ['planning', 'review', 'implementation', 'integration', 'integrated'];

/** @typedef {'done'|'active'|'pending'|'blocked'} TodoStageState */
/** @typedef {{ id: string, state: TodoStageState, hint?: string }} TodoStageStep */

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {object} item front todo item
 * @returns {TodoStageStep}
 */
function derivePlanning(item) {
  return { id: 'planning', state: str(item?.plan?.markdown) ? 'done' : 'active' };
}

/**
 * @param {object} item
 * @param {boolean} approved
 * @returns {TodoStageStep}
 */
function deriveReview(item, approved) {
  const state = str(item?.review?.plan?.state) || 'none';
  switch (state) {
    case 'passed':
    case 'manual':
      return { id: 'review', state: 'done' };
    case 'pending':
      return { id: 'review', state: 'active' };
    case 'failed':
    case 'stale':
      return { id: 'review', state: 'blocked' };
    case 'none':
      // A human-approved plan without a review counts as consciously skipped.
      return approved ? { id: 'review', state: 'done', hint: 'skipped' } : { id: 'review', state: 'pending' };
    default:
      return { id: 'review', state: 'pending' };
  }
}

/**
 * @param {object} item
 * @param {boolean} approved
 * @returns {TodoStageStep}
 */
function deriveImplementation(item, approved) {
  const status = str(item?.status);
  const codeState = str(item?.review?.code?.state) || 'none';
  if (status === 'done') {
    return codeState === 'none'
      ? { id: 'implementation', state: 'done', hint: 'notReviewed' }
      : { id: 'implementation', state: 'done' };
  }
  if (codeState === 'failed' || codeState === 'stale') {
    return { id: 'implementation', state: 'blocked', hint: 'changesRequested' };
  }
  if (codeState === 'pending') return { id: 'implementation', state: 'active', hint: 'inReview' };
  if (approved && (status === 'ready' || status === 'doing')) {
    return { id: 'implementation', state: 'active' };
  }
  return { id: 'implementation', state: 'pending' };
}

/**
 * @param {object} item
 * @returns {TodoStageStep}
 */
function deriveIntegration(item) {
  const state = str(item?.integrationSummary?.state) || 'unconfirmed';
  const detail = str(item?.integrationSummary?.detail);
  if (detail === 'conflict' || detail === 'rejected') {
    return { id: 'integration', state: 'blocked', hint: detail };
  }
  if (detail === 'no_code_changes') return { id: 'integration', state: 'done', hint: 'noCode' };
  const hint = detail === 'stale_evidence' || detail === 'proof_invalidated' ? detail : undefined;
  /** @type {TodoStageStep} */
  let step;
  if (state === 'integrated') step = { id: 'integration', state: 'done' };
  else if (state === 'partial') step = { id: 'integration', state: 'active', hint: 'partial' };
  else if (state === 'awaiting') step = { id: 'integration', state: 'active' };
  else if (state === 'rejected' || state === 'conflict') step = { id: 'integration', state: 'blocked', hint: state };
  else step = { id: 'integration', state: 'pending' };
  if (hint && !step.hint) step.hint = hint;
  return step;
}

/**
 * @param {object} item front todo item (`plan`, `review`, `status`, `integrationSummary`)
 * @returns {{ current: string, steps: TodoStageStep[] }}
 */
export function deriveTodoStage(item) {
  const approved = !!str(item?.plan?.approvedAt);
  const integration = deriveIntegration(item);
  const implementation = deriveImplementation(item, approved);
  const integrated = {
    id: 'integrated',
    state: integration.state === 'done' && str(item?.status) === 'done' ? 'done' : 'pending',
  };
  const steps = [
    derivePlanning(item),
    deriveReview(item, approved),
    implementation,
    integration,
    integrated,
  ];
  const open = steps.find((step) => step.state !== 'done');
  return { current: open ? open.id : 'integrated', steps };
}

/**
 * @param {object} item
 * @returns {boolean} true when the whole item (tree, for a container) is integrated
 */
export function isTodoFullyIntegrated(item) {
  return deriveTodoStage(item).steps[4].state === 'done';
}
