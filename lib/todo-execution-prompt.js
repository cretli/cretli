/** Shared instructions for explicit TODO execution in an existing or new chat. */
export const TODO_EXECUTION_WORKFLOW = [
  'TODO EXECUTION WORKFLOW:',
  'Load the referenced todo with todo_show, including all body/plan pages. If it has children, this chat orchestrates the entire subtree, not just the parent description.',
  'Read all children pages using next_children_cursor as children_cursor, then recursively read descendants with todo_show. Keep work scoped to this root. Resume unfinished descendants; skip done tasks. Respect sibling_index order and sequential execution by default; parallel requires an explicit parent run_mode setting.',
  'Record this chat as orchestrator_chat_id on the root using todo_update with the latest expected_updated_at. Use todo_next_ready({ root_id: <full root id> }) to choose the next leaf. Re-read the tree after each completed task.',
  'If the root or any leaf explicitly has execution_mode=worktree and this chat is not already bound to its prepared worktree, start the subtree with todo_start (execution_mode=worktree). Once this orchestrator is bound to the prepared worktree, use delegation_start normally for implementation and review children; direct starts from a project-folder chat are rejected.',
  'For each leaf: read its requirements and plan, set it to doing, then create an implementation subchat with Cretli MCP delegation_start (assignment=implement, execution_mode=agent, task_text with the leaf todo reference and acceptance criteria). Select an eligible enabled model with model_pick/model_list, respecting the todo assignee when specified. Forward the pickId returned by model_pick as pick_id on delegation_start (one pick -> one start), without re-picking or matching the proposal by time.',
  'Tell the implementation child to leave the todo doing and report changes and test results; only this orchestrator marks it done after verification. Children must not start further delegations.',
  'Wait with delegation_wait until the child is terminal AND slot_occupied=false, then read the full report using delegation_show. Start a separate verification subchat with assignment=review and execution_mode=agent, passing the leaf requirements and implementation report. The reviewer must inspect the work and run relevant checks without editing files or changing todo status.',
  'Keep the leaf doing until verification PASS. On FAIL, delegate fixes and repeat verification. On BLOCKED, missing eligible models, or a required unapproved plan, report the concrete blocker and leave unfinished tasks open. Never bypass a plan approval gate or silently implement/review in the parent instead.',
  'After verification PASS, re-read todo_show and mark the leaf done with todo_update using its latest expected_updated_at. Continue automatically with the next descendant without asking whether to continue. Parent statuses are derived from children; do not force the parent done.',
  'If no ready leaf exists, inspect doing descendants and existing delegations and resume them without duplicating active work. Finish only when all descendants are done, or report a concrete blocker. Do not stop after planning, one child report, or the first finished leaf.',
].join('\n');

export function buildTodoContinueNote(note) {
  return `${String(note || '').trim()}\n\n${TODO_EXECUTION_WORKFLOW}`;
}

/** Hide generated agent instructions while preserving the user's own message. */
export function stripTodoExecutionWorkflow(text) {
  const source = String(text || '').trimEnd();
  return source.endsWith(TODO_EXECUTION_WORKFLOW)
    ? source.slice(0, -TODO_EXECUTION_WORKFLOW.length).trimEnd()
    : source;
}
