/**
 * Compact initial prompts for chats linked to a Todo item.
 */

import { resolveEffectivePhases } from './watcher-phases.js';
import { formatTodoRef } from './todo-ref.js';
import { resolveProjectPath } from './runtime-paths.js';
import { buildReviewerPoolInstruction } from './todo-execution-prompt.js';

/**
 * Reviewer policies worth a prompt line: anything but the all-default
 * (automatic, fresh) case, so default prompts stay unchanged.
 *
 * @param {{ reviewerPolicies?: object[] }} options
 * @returns {object[]}
 */
function reviewerPolicyList(options) {
  return (Array.isArray(options?.reviewerPolicies) ? options.reviewerPolicies : [])
    .some((p) => p && (p.selection === 'fixed_pair' || (p.session && p.session !== 'fresh')))
    ? options.reviewerPolicies
    : [];
}

/** Build a bounded pointer to the live todo instead of copying its saved material. */
function buildTodoStartContext(todo, chatId, options = {}) {
  const hasPlan = !!String(todo?.plan?.markdown || '').trim();
  const isApproved = hasPlan && !!String(todo?.plan?.approvedAt || '').trim();
  return [
    `TODO (id: ${todo?.id || ''}):`,
    `Title: ${String(todo?.title || '').slice(0, 240)}`,
    `Status: ${todo?.status || 'idea'}`,
    `Plan: ${hasPlan ? (isApproved ? 'saved and approved' : 'saved, not approved') : 'none yet'}`,
    formatTodoRef(todo?.id),
    `LINKED CHAT: ${chatId}`,
    '',
    'First load the current todo with todo_show, including every body/plan page. The live todo is the source of truth; re-check approval before execution. Never infer approval from status doing or this snapshot.',
    'Siblings run sequentially in sibling order by default (parallel needs an explicit parent run_mode); parent status follows its children, never forced done. Status transitions: idea -> ready -> doing -> done, and a leaf is done only after its acceptance criteria and required verification pass.',
    'Update the todo only through the MCP todo_update contract described by the canonical protocol/source; never reproduce a copied HTTP payload.',
    'If the Cretli MCP tools are unavailable, read that canonical protocol/source from the filesystem and report a concrete blocker instead of guessing or executing a copied plan.',
    ...(options.previousChats?.length
      ? ['Earlier chats are listed by todo_show; read relevant history with chat_show, then chat_history/chat_event as needed.']
      : []),
  ].join('\n');
}

/**
 * Initial prompt for a direct executor or a subtree orchestrator.
 * The legacy baseUrl argument is retained for callers; updates use MCP tools.
 *
 * @param {{ id: string, title?: string, status?: string, plan?: { markdown?: string, approvedAt?: string } }} todo
 * @param {string} chatId
 * @param {string} baseUrl
 * @param {{ hasChildren?: boolean, previousChats?: Array<object> }} [options]
 * @returns {string}
 */
export function buildTodoAgentInitialPrompt(todo, chatId, baseUrl, options = {}) {
  const hasChildren = options.hasChildren === true;
  const role = hasChildren
    ? 'You orchestrate the entire subtree of a Cretli Todo. Delegate implementation and review; do not implement in this chat.'
    : 'You are the direct executor of a Cretli Todo. Implement in this chat; do not start child delegations.';
  const protocol = hasChildren
    ? buildTodoExecutionProtocolPointer()
    : `Before working, read and follow the direct-executor protocol at ${resolveProjectPath('docs', 'todo-direct-executor-protocol.md')}.`;
  const pool = Array.isArray(options.reviewerPool) ? options.reviewerPool : [];
  const policies = reviewerPolicyList(options);
  return [role, '', buildTodoStartContext(todo, chatId, options), '', protocol,
    ...(hasChildren && (pool.length > 0 || policies.length > 0) ? [buildReviewerPoolInstruction(pool, { strict: options.reviewerPoolStrict === true, policies })] : []),
    'If the current plan is approved, continue its unfinished work without asking for approval again. Otherwise prepare or update the plan with todo_update and STOP for human approval; never approve it yourself.',
    'Report changes, verification results and remaining blockers.',
  ].join('\n');
}

/** Keep the execution workflow in one source for starts, continuations and MCP. */
function buildTodoExecutionProtocolPointer() {
  return `Before starting a leaf, read ${resolveProjectPath('lib', 'todo-execution-prompt.js')} and follow the TODO EXECUTION WORKFLOW exported as TODO_EXECUTION_WORKFLOW. Continue automatically through unfinished descendants; never bypass a plan approval gate.`;
}

/**
 * Initial prompt for a chat that only reviews and refines the plan of a Todo
 * with the `cretli-todo-refine-loop` skill. It never asks for implementation.
 *
 * @param {{ id: string, title?: string, status?: string, plan?: { markdown?: string } }} todo
 * @param {string} chatId
 * @param {{
 *   previousChats?: Array<{ id?: string, title?: string, roles?: string[] }>,
 *   planReviewerSession?: { id?: string, cooperationMode?: string },
 *   reviewerPool?: Array<{ harness?: string, model?: string }>,
 *   reviewerPoolStrict?: boolean,
 *   reviewerPolicies?: object[],
 * }} [options]
 * @returns {string}
 */
export function buildTodoRefineInitialPrompt(todo, chatId, options = {}) {
  const todoId = todo?.id || '';
  const title = todo?.title != null ? String(todo.title) : '';
  const status = todo?.status != null ? String(todo.status) : 'idea';
  const hasPlan = !!(todo?.plan && typeof todo.plan === 'object' && String(todo.plan.markdown || '').trim());
  const todoRef = formatTodoRef(todoId);
  const mode = String(options.planReviewerSession?.cooperationMode || 'independent').trim() || 'independent';
  const hasPreviousChats = Array.isArray(options.previousChats) && options.previousChats.length > 0;
  const pool = Array.isArray(options.reviewerPool) ? options.reviewerPool : [];
  const policies = reviewerPolicyList(options);
  return (
    'You are refining the plan of a Cretli Todo. Do not implement it.\n\n' +
    `TODO (id: ${todoId}):\n` +
    `Title: ${title}\n` +
    `Status: ${status}\n` +
    `Plan: ${hasPlan ? 'saved on the todo' : 'none yet; the todo body is the starting point'}\n` +
    (todoRef ? `${todoRef}\n` : '') +
    `LINKED CHAT: ${chatId}\n\n` +
    'Run the skill @cretli-todo-refine-loop on this todo as the root; if its text is not included ' +
    'above, read its listed SKILL.md first.\n\n' +
    `Cooperation mode: ${mode}. After saving the plan and after every rewrite, call reviewer_session ` +
    'with this mode and use the returned session id.\n\n' +
    'Limits: do not start any leaf, do not change the todo status, never set plan approval ' +
    '(only a human approves), do not commit or push. These limits bind this refinement run only: ' +
    'do not copy them into the plan\'s acceptance criteria. The executor that later implements the ' +
    'plan marks the leaf done itself once its criteria and verification pass.\n\n' +
    (hasPreviousChats
      ? 'Earlier chats are listed by todo_show; read one with chat_show (8-char prefix ok; chat_event ' +
        'needs the full id from its output).\n\n'
      : '') +
    ((pool.length > 0 || policies.length > 0) ? `${buildReviewerPoolInstruction(pool, { strict: options.reviewerPoolStrict === true, policies })}\n\n` : '') +
    'Finish with the final report the skill describes.'
  );
}

/**
 * Initial prompt for the per-todo "do everything" orchestrator (`mode: 'full'`):
 * plan refine -> human approval gate -> implement/review/fix -> integration
 * preparation. The phase preamble is derived from the persisted plan; the
 * shared execution workflow is loaded from its canonical source.
 *
 * @param {{ id: string, title?: string, status?: string, plan?: { markdown?: string, approvedAt?: string }, review?: { plan?: { state?: string } } }} todo
 * @param {string} chatId
 * @param {{ previousChats?: Array<{ id?: string, title?: string, roles?: string[] }>, phases?: object }} [options]
 *   `phases` is the effective phase map from `lib/watcher-phases.js`.
 * @returns {string}
 */
export function buildTodoFullOrchestratorPrompt(todo, chatId, options = {}) {
  const plan = todo?.plan && typeof todo.plan === 'object' ? todo.plan : null;
  const hasPlan = !!(plan && String(plan.markdown || '').trim());
  const isApproved = hasPlan && !!String(plan.approvedAt || '').trim();
  const reviewState = String(todo?.review?.plan?.state || '').trim();
  const isReviewPassed = reviewState === 'passed' || reviewState === 'manual';
  const phases = resolveEffectivePhases({ phases: options.phases }, []);
  let phase;
  if (!isApproved && !phases.plan) {
    phase = [
      'CURRENT PHASE: planning, but the `plan` phase is disabled for this todo.',
      'Do not run plan refinement. Report `phase_disabled:plan` and STOP; only a human approves a plan.',
    ];
  } else if (!isApproved) {
    phase = [
      'CURRENT PHASE: planning / approval gate.',
      !phases.review
        ? '1. Plan refinement: the `review` phase is disabled; write or update the plan draft without starting plan reviews.'
        : !hasPlan || !isReviewPassed
        ? '1. Plan refinement: the plan is missing or its plan review has not passed. Run the skill @cretli-todo-refine-loop on this todo as the root (read its listed SKILL.md if the text is not included) until the plan review passes or a stop rule fires. Use reviewer_session after every plan rewrite.'
        : '1. Plan refinement: the plan review already passed; do not repeat it.',
      '2. Approval gate: when the plan is saved and reviewed but not yet approved, STOP and report `ready for human approval`. Only a human approves a plan, in the UI. Never approve it yourself and never start a leaf before approval.',
    ];
  } else if (!phases.implement) {
    phase = [
      'CURRENT PHASE: execution, but the `implement` phase is disabled for this todo.',
      'Do not start implement/review/fix delegations. Report `ready: implement phase disabled` (phase_disabled:implement) and STOP.',
    ];
  } else {
    phase = [
      'CURRENT PHASE: execution (the plan is approved by a human).',
      '3. Implementation: load and run the TODO EXECUTION WORKFLOW on the whole subtree — implement, review and fix every leaf until all descendants are done.',
      phases.integrate
        ? '4. Integration (prepare only): once every leaf is done, prepare integration only through the existing worktree integration path (lib/workspace-watcher-integration.js, lib/worktree/git-worktree.js) so it reaches state `awaiting`, then STOP. Never apply or merge into the project folder. Confirming integration is a human attestation: never call todo_integration with action confirm. If integration cannot be prepared, report the blocker.'
        : '4. Integration is disabled for this run: once every leaf is done, STOP. Never call todo_integration with action confirm.',
    ];
  }
  return (
    'You are the per-todo orchestrator ("do everything") for a Cretli Todo. You delegate work to child chats and do not implement in this chat.\n\n' +
    `${buildTodoStartContext(todo, chatId, options)}\n\n` +
    `${phase.join('\n')}\n\n` +
    'Limits: never commit, push or merge; never set plan approval; never confirm integration. Resume = the user starts this orchestrator again; the user can stop this run by cancelling this chat, and child runs with delegation_cancel.\n\n' +
    `${buildTodoExecutionProtocolPointer()}\n\n` +
    ((Array.isArray(options.reviewerPool) && options.reviewerPool.length > 0) || reviewerPolicyList(options).length > 0
      ? `${buildReviewerPoolInstruction(options.reviewerPool || [], { strict: options.reviewerPoolStrict === true, policies: reviewerPolicyList(options) })}\n\n`
      : '') +
    'Finish with a final report: phase reached, leaves done/open, blockers.'
  );
}
