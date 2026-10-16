/** Shared instructions for explicit TODO execution in an existing or new chat. */
export const TODO_EXECUTION_WORKFLOW = [
  'TODO EXECUTION WORKFLOW:',
  'Load the referenced todo with todo_show, including all body/plan pages. If it has children, this chat orchestrates the entire subtree, not just the parent description.',
  'Read all children pages using next_children_cursor as children_cursor, then recursively read descendants with todo_show. Keep work scoped to this root. Resume unfinished descendants; skip done tasks. Respect sibling_index order and sequential execution by default; parallel requires an explicit parent run_mode setting and disjoint `## Leaf scope` paths across active siblings.',
  'Record this chat as orchestrator_chat_id on the root using todo_update with the latest expected_updated_at. Use todo_next_ready({ root_id: <full root id> }) to choose the next leaf. Re-read the tree after each completed task.',
  'Before starting a leaf, read workflow_show with leaf_id and resume its existing state. Initialize missing state with workflow_update (leaf_id, max_rounds=4); preserve existing rounds, findings, deadlines and user budgets. After each review persist last_verdict, report_text, stable finding IDs, material_revision and an idempotency_key tied to that review attempt. Never count an implementer PASS as a review PASS.',
  'If the root or any leaf explicitly has execution_mode=worktree and this chat is not already bound to its prepared worktree, start the subtree with todo_start (execution_mode=worktree). Once this orchestrator is bound to the prepared worktree, use delegation_start normally for implementation and review children; direct starts from a project-folder chat are rejected.',
  'For each leaf: read its requirements and plan, set it to doing, then create an implementation subchat with Cretli MCP delegation_start (assignment=implement, execution_mode=agent, task_text with the leaf todo reference and acceptance criteria). Select an eligible enabled model with model_pick/model_list, respecting the todo assignee when specified. Forward the pickId returned by model_pick as pick_id on delegation_start (one pick -> one start), without re-picking or matching the proposal by time.',
  'Tell the implementation child to leave the todo doing and report changes and test results; only this orchestrator marks it done after verification. Children must not start further delegations.',
  'Give each child a bounded assignment: acceptance criteria, all unresolved finding IDs with reproduction/evidence, the existing partial work, and a focused verification list. Use model_pick role=fix and delegation_start assignment=fix for corrections. Require a per-finding FIXED/STILL_OPEN table with code and test evidence; do not send a knowingly incomplete fix for another full review.',
  'The server enforces a default hard run limit from startedAt (review/fix 20 minutes, implement 40 minutes unless configured or disabled). Explicit deadline_at on workflow_update or delegation_start overrides that default; the server never extends a user deadline. At the soft checkpoint (15 minutes fix/review, 30 minutes implement) inspect progress once: changed files, findings closed and remaining checks. Extend only for concrete progress with another stated checkpoint; otherwise cancel before the hard limit when possible. After interrupt_code=run_deadline_exceeded, wait for slot_occupied=false, pass partial work to a different eligible executor via model_pick exclude_models, and do not retry the same model for that slice.',
  'After a finding survives a fix or two code reviews FAIL, change strategy before another attempt: reconcile scope against the approved leaf, identify the shared root cause, and choose a different eligible executor using exclude_models. Prefer demonstrated completion and correctness over nominal low cost. On transport/startup failure exclude the failing harness for this recovery attempt instead of blindly retrying it. If exclusions leave no eligible model, report the blocker. Do not repeatedly lift max_rounds or clear same_findings without new evidence and a concrete changed approach.',
  'Before review, distinguish repository inspection from test execution: review_can_run_tests=false requires host verification through delegation_verify, not a blanket shell prohibition. Permit supported read-only file/search/diff tools under the harness guard. If no permitted repository inspection path exists, choose another eligible reviewer or provide the exact diff and required source context; never request a verdict from the implementer summary alone.',
  'Verification per round is the named regression tests plus directly affected suites and required repository checks. Reuse prior results for unchanged material. Broaden or repeat only for new changes, failures or a concrete unresolved risk; do not repeatedly run full suites, builds, mutation experiments or clean-HEAD baselines. Track unrelated failures once with evidence; leave unverified attribution explicit. Reserve full acceptance checks for the leaf or final integration boundary when required.',
  'Wait with delegation_wait until the child is terminal AND slot_occupied=false, then read the full report using delegation_show. After every terminal implement or fix (including failed or interrupted runs with partial changes), run delegation_verify on that delegation id before starting a code review or handing work to another executor. When verify fails, read `newFailures` vs `preexistingFailures` in the result: only newFailures (or all failures when baseline source is `unavailable`) go to a fix round with the test output as findings, and a leaf is never done while newFailures exist; for preexisting failures create ONE follow-up todo (idempotency key from the sorted failing ids) instead of looping. Do not start review while newFailures exist. When verify passes, attach the verify summary to the reviewer task. Start a separate verification subchat with assignment=review and execution_mode=agent, passing the leaf requirements, implementation report, and host verify evidence. Always pass review_subject on that start: review_subject=code for a code review, review_subject=plan for a plan review. The server chooses code review mode audit vs closure from workflow state (first code review of the leaf is audit; later ones are closure with the same audit reviewer when available). Create separate todos for reviewer FOLLOW_UP and OUT_OF_SCOPE items instead of expanding the current leaf. The reviewer must inspect the work and run relevant checks without editing files or changing todo status.',
  'The server persists the review status on the todo (the `review` block: per-subject state, reviewers, implementer, independence, material). Before closing a leaf, re-read it with `todo_show` and confirm the block matches the verdict and verify evidence you saw. The field is server-owned: never try to set it with `todo_update` or `todo_create`.',
  'Keep the leaf doing until verification PASS. On FAIL, delegate fixes and repeat verification. On BLOCKED, missing eligible models, or a required unapproved plan, report the concrete blocker and leave unfinished tasks open. Never bypass a plan approval gate or silently implement/review in the parent instead.',
  'After verification PASS, re-read todo_show and mark the leaf done with todo_update using its latest expected_updated_at. Continue automatically with the next descendant without asking whether to continue. Parent statuses are derived from children; do not force the parent done.',
  'Autonomy boundary: routine, reversible decisions inside the approved leaf scope belong to the executor — file layout within `## Leaf scope`, naming, test selection and equivalent implementation choices. Do not ask the orchestrator to confirm them. A real blocker (a required unapproved plan, no eligible model, ambiguous acceptance criteria, a check that cannot run in this environment) is reported with its evidence and leaves the leaf doing.',
  'Completion definition: a leaf is complete only when every acceptance criterion is met or explicitly reported as not met, the named regression tests and directly affected suites have been run, and the report lists remaining problems. Do not finish after planning, after one child report, or on a first partial implementation, and never treat an unverified claim as a result.',
  'If no ready leaf exists, inspect doing descendants and existing delegations and resume them without duplicating active work. Finish only when all descendants are done, or report a concrete blocker. Do not stop after planning, one child report, or the first finished leaf.',
].join('\n');

/** The server resolves the protocol path, including for non-Cretli workspaces. */
export const TODO_CONTINUE_INSTRUCTIONS = [
  'TODO CONTINUATION:',
  'Load the referenced todo with todo_show, including every body/plan page. Read the file at execution_protocol_path returned by todo_show and follow its TODO_EXECUTION_WORKFLOW before starting work.',
  'This chat orchestrates the referenced root, including a root with no children; delegate implementation and independent review. Resume unfinished work without duplicating active delegations, respect human plan approval, and continue until completion or a concrete blocker.',
].join('\n');

/**
 * Opt-in reviewer pool instruction (`reviewer_pair_enabled` with a complete
 * `reviewer_pair_members`). Appended to the prompts only when the switch is
 * on; with it off the prompts stay byte-identical. It never mentions
 * `resume_session_of` or keep-alive: the pool is two fresh, independent reviewers.
 * With `strict` (`reviewer_pair_strict`) the server re-enters each member's
 * previous reviewer session itself, so the parent starts no extra chats.
 *
 * @param {Array<{ harness?: string, model?: string }>} members
 * @param {{ strict?: boolean }} [options]
 * @returns {string}
 */
export function buildReviewerPoolInstruction(members, options = {}) {
  const strict = options?.strict === true;
  const list = (Array.isArray(members) ? members : [])
    .filter((m) => m && m.harness && m.model)
    .map((m) => `${m.harness}/${m.model}`)
    .join(', ');
  return [
    'REVIEWER POOL (opt-in):',
    `Reviews use a fixed pool of two reviewers: ${list}. Call model_pick for every review with prefer_models ([{harness, model}, ...]) AND count=2: picks[0] and picks[1] are the two reviewers of the round. Start one ${strict ? '' : 'fresh '}review delegation per pick for the same round; any FAIL fails the round, both must PASS, and the round counts once against CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES.`,
    'Hard excludes always win: never pick the implementer as a reviewer. If a pool member is excluded (for example the implementer), the response marks rotation.pool.degraded=true and picks[1] is the normal-pick replacement; continue with picks[0] and picks[1]. On infra/quota failure of one member, call model_pick again WITHOUT prefer_models, with exclude_models = [the failed member, the surviving member, the implementer] and count=1, within the existing single retry; never block on the pool. ' + (strict
      ? 'STRICT PAIR is on: the server re-enters each member\'s previous reviewer session by itself (see `session_resume` in the start result), so never pass resume_session_of, never start reviewers outside the pool and never open extra review chats; a new chat appears only when the server reports a resume fallback.'
      : 'Do not use resume_session_of for pool reviewers.'),
  ].join('\n');
}

export function buildTodoContinueNote(note) {
  return `${String(note || '').trim()}\n\n${TODO_CONTINUE_INSTRUCTIONS}`;
}

/** Hide generated agent instructions while preserving the user's own message. */
export function stripTodoExecutionWorkflow(text) {
  const source = String(text || '').trimEnd();
  for (const instructions of [TODO_CONTINUE_INSTRUCTIONS, TODO_EXECUTION_WORKFLOW]) {
    if (source.endsWith(instructions)) return source.slice(0, -instructions.length).trimEnd();
  }
  return source;
}
