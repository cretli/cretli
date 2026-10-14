/**
 * Shared phase contract for the Workspace Watcher and the per-todo
 * `mode: 'full'` orchestrator.
 *
 * Phases only NARROW what an orchestration may do; they never grant authority.
 * Plan approval (`plan.approvedAt`) and integration confirmation
 * (`todo_integration confirm`) are not phases and stay human-only. `integrate`
 * means "prepare only" (state `awaiting`): never apply/merge, commit or push.
 */
export const WATCHER_PHASE_KEYS = Object.freeze(['plan', 'review', 'implement', 'integrate']);

export const WATCHER_PHASE_DEFAULTS = Object.freeze({
  plan: true,
  review: true,
  implement: true,
  integrate: false,
});

/**
 * Keep only known phase keys with boolean values.
 *
 * @param {unknown} value
 * @returns {Partial<Record<'plan'|'review'|'implement'|'integrate', boolean>>}
 */
export function normalizePartialPhases(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of WATCHER_PHASE_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  }
  return out;
}

/**
 * Strict validator for API input: returns an error string or `''`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validatePhasesInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'phases must be an object';
  for (const [key, flag] of Object.entries(value)) {
    if (!WATCHER_PHASE_KEYS.includes(key)) return `unknown phase "${key}"`;
    if (typeof flag !== 'boolean') return `phase "${key}" must be a boolean`;
  }
  return '';
}

/**
 * Full phase map: defaults, then the workspace policy, then per-todo overrides
 * that may only restrict (AND; `todoChain` is nearest-first: the todo, its
 * parent, ... the root, so descendants inherit every ancestor restriction).
 *
 * @param {{ phases?: unknown } | null | undefined} policy
 * @param {Array<{ watcherPhases?: unknown } | null | undefined>} [todoChain]
 * @returns {{ plan: boolean, review: boolean, implement: boolean, integrate: boolean }}
 */
export function resolveEffectivePhases(policy, todoChain = []) {
  const merged = { ...WATCHER_PHASE_DEFAULTS, ...normalizePartialPhases(policy?.phases) };
  for (const todo of [...(Array.isArray(todoChain) ? todoChain : [])].reverse()) {
    // Restrict-only: an override can switch a phase off, never on.
    const override = normalizePartialPhases(todo?.watcherPhases);
    for (const key of WATCHER_PHASE_KEYS) {
      if (override[key] === false) merged[key] = false;
    }
  }
  return merged;
}

/**
 * Nearest-first ancestor chain of a todo (cycle safe).
 *
 * @param {object[]} items
 * @param {object | null | undefined} todo
 * @returns {object[]}
 */
export function todoPhaseChain(items, todo) {
  const index = new Map((Array.isArray(items) ? items : []).map((row) => [String(row?.id || ''), row]));
  const chain = [];
  const seen = new Set();
  let current = todo || null;
  while (current && !seen.has(String(current.id || ''))) {
    seen.add(String(current.id || ''));
    chain.push(current);
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  return chain;
}

/**
 * Pick-level phase a todo needs next. The plan gate rule wins: an unapproved
 * plan needs `plan`; once `approvedAt` is set the todo needs `implement`
 * (review state is not consulted, so `review:false` never blocks a todo).
 *
 * @param {object} todo
 * @param {object[]} items
 * @param {{ requirePlanApproval?: boolean } | null} [policy]
 * @returns {'plan' | 'implement'}
 */
export function neededPhase(todo, items, policy = null) {
  if (policy && policy.requirePlanApproval === false) return 'implement';
  // Same inheritance as the plan gate: the nearest approved plan up the chain.
  const approved = todoPhaseChain(items, todo).some((node) => String(node?.plan?.approvedAt ?? '').trim());
  return approved ? 'implement' : 'plan';
}

/**
 * Drop candidates whose needed phase is disabled. Pure; returns the kept rows
 * and the skipped ones (with the phase) so the caller can record why.
 *
 * @param {object[]} candidates
 * @param {{ items?: object[], policy?: object | null }} ctx
 * @returns {{ kept: object[], skipped: Array<{ todo: object, phase: string }> }}
 */
export function filterTodosByEnabledPhases(candidates, ctx = {}) {
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  const kept = [];
  const skipped = [];
  for (const todo of Array.isArray(candidates) ? candidates : []) {
    const phases = resolveEffectivePhases(ctx.policy, todoPhaseChain(items, todo));
    const phase = neededPhase(todo, items, ctx.policy);
    if (phases[phase]) kept.push(todo);
    else skipped.push({ todo, phase });
  }
  return { kept, skipped };
}

/**
 * Which phase a delegation assignment needs. `review` with a plan subject is
 * the `review` phase; code review, implement and fix are `implement`.
 *
 * @param {string} assignment
 * @param {string} [reviewSubject]
 * @returns {'plan'|'review'|'implement'|''}
 */
export function phaseForAssignment(assignment, reviewSubject = '') {
  const a = String(assignment || '').trim().toLowerCase();
  if (a === 'plan') return 'plan';
  if (a === 'implement' || a === 'fix') return 'implement';
  if (a === 'review') return String(reviewSubject || '').trim().toLowerCase() === 'plan' ? 'review' : 'implement';
  return '';
}

/**
 * Prompt lines describing the narrowed scope. Empty for the default phases, so
 * the default prompt stays byte-identical.
 *
 * @param {{ plan: boolean, review: boolean, implement: boolean, integrate: boolean }} phases
 * @returns {string[]}
 */
export function buildPhaseScopePromptLines(phases) {
  const p = { ...WATCHER_PHASE_DEFAULTS, ...(phases || {}) };
  const lines = [];
  if (!p.review) {
    lines.push('PHASE SCOPE: the `review` phase is disabled. Do not start plan reviews; code review of an implementation is part of `implement`.');
  }
  if (p.integrate) {
    lines.push('PHASE SCOPE: `integrate` is enabled = PREPARE ONLY. After the last leaf is done you may run the existing prepare step (state `awaiting`). Never apply or merge into the project folder, never commit or push, never confirm integration.');
  }
  if (!p.plan || !p.implement) {
    lines.push(`PHASE SCOPE: disabled phases: ${['plan', 'implement'].filter((k) => !p[k]).join(', ')}. If the work needs a disabled phase, report outcome "blocked" with message "phase_disabled:<phase>" instead of starting it.`);
  }
  return lines;
}
