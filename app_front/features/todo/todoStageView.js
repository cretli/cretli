import { t } from '../../i18n/index.js';
import { deriveTodoStage } from '../../todoStage.js';

const HINT_KEYS = {
  skipped: 'todo.stageHintSkipped',
  notReviewed: 'todo.stageHintNotReviewed',
  changesRequested: 'todo.stageHintChangesRequested',
  inReview: 'todo.stageHintInReview',
  noCode: 'todo.stageHintNoCode',
  partial: 'todo.stageHintPartial',
  conflict: 'todo.stageHintConflict',
  rejected: 'todo.stageHintRejected',
  stale_evidence: 'todo.stageHintStaleEvidence',
  proof_invalidated: 'todo.stageHintProofInvalidated',
};

const STEP_KEYS = {
  planning: 'todo.stagePlanning',
  review: 'todo.stageReview',
  implementation: 'todo.stageImplementation',
  integration: 'todo.stageIntegration',
  integrated: 'todo.stageIntegrated',
};

const STATE_KEYS = {
  done: 'todo.stageStateDone',
  active: 'todo.stageStateActive',
  pending: 'todo.stageStatePending',
  blocked: 'todo.stageStateBlocked',
};

/**
 * View model for the stage stepper: derived steps plus localized labels/titles.
 * @param {object} item front todo item
 */
export function buildTodoStageView(item) {
  const stage = deriveTodoStage(item);
  const steps = stage.steps.map((step) => {
    const label = t(STEP_KEYS[step.id]);
    const hint = step.hint && HINT_KEYS[step.hint] ? t(HINT_KEYS[step.hint]) : '';
    const stateText = t(STATE_KEYS[step.state]);
    return {
      id: step.id,
      state: step.state,
      label,
      hint,
      title: `${label}: ${hint ? `${stateText} (${hint})` : stateText}`,
    };
  });
  const integratedStep = steps[steps.length - 1];
  return { current: stage.current, steps, isIntegrated: integratedStep.state === 'done' };
}

/**
 * Plain-DOM stepper for the (non-Lit) todo row.
 * @param {object} item
 * @returns {HTMLElement}
 */
export function createTodoStageStepperEl(item) {
  const view = buildTodoStageView(item);
  const root = document.createElement('span');
  root.className = 'todo-stage';
  root.setAttribute('role', 'list');
  root.setAttribute('aria-label', t('todo.stageLabel'));
  root.dataset.current = view.current;
  for (const step of view.steps) {
    // The last step collapses into an explicit badge once the whole tree is integrated.
    if (step.id === 'integrated' && view.isIntegrated) {
      const badge = document.createElement('span');
      badge.className = 'todo-stage-badge';
      badge.setAttribute('role', 'listitem');
      badge.textContent = t('todo.stageBadgeIntegrated');
      root.appendChild(badge);
      continue;
    }
    const el = document.createElement('span');
    el.className = 'todo-stage-step';
    el.dataset.state = step.state;
    el.dataset.step = step.id;
    el.setAttribute('role', 'listitem');
    el.title = step.title;
    el.setAttribute('aria-label', step.title);
    if (step.id === view.current) el.setAttribute('aria-current', 'step');
    root.appendChild(el);
  }
  return root;
}
