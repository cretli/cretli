# Direct TODO executor protocol

This protocol applies to the ordinary start of a TODO without children. The
chat implements the task itself. It is not the subtree orchestrator and must
not start implementation or review delegations.

1. Load the live TODO with `todo_show`. Read every body/plan page using the
   returned cursor until none remains. Read relevant previous chats from the
   TODO's linked history only when needed. Do not rely on a copied plan or an
   earlier chat's approval claim.
2. Check the current plan and its human approval. `doing` alone does not mean
   approved. The `plan_gate` line of `todo_show` is authoritative: approval on
   an ancestor (up to the root) opens the gate for this TODO even without an
   own approved plan, so implement within that plan. If the gate is closed, prepare or update the detailed plan
   (steps, files, risks and acceptance criteria) with `todo_update`, preserving
   the latest `expected_updated_at`, then stop for human approval. Never set
   approval yourself. If the plan is already approved, resume unfinished work
   without asking for the same approval again. If it no longer matches the
   requested scope, report the discrepancy before implementing.
3. Implement within the approved scope. Preserve existing partial work and
   unrelated changes. Routine reversible choices within that scope belong to
   the executor; report concrete blockers instead of silently broadening scope.
4. Update the TODO using MCP `todo_update` and the latest `expected_updated_at`.
   Re-read after a conflict rather than overwriting concurrent changes. Save
   major progress as changelog entries. Never write the server-owned `review`
   field or claim an independent review from your own verification.
5. Run the named regression checks, directly affected suites and required
   repository checks. Reuse results for unchanged material; repeat or broaden
   verification only when changes, failures or unresolved risks justify it.
6. Keep unfinished or blocked work open. Mark the leaf done only when all
   acceptance criteria are met and required verification passes. Do that
   yourself with `todo_update`; do not leave the step to the user. A plan line such as
   "never change status" is about plan approval and review state, not this
   completion step; only the `review` field and plan approval stay off limits. Report changed
   files, test results and remaining problems. Do not commit, push, merge or
   confirm integration unless the user separately authorizes those actions.

If the live TODO now has children, stop direct implementation and report that
it needs the subtree orchestration path. Orchestrator starts load the canonical
`TODO_EXECUTION_WORKFLOW` from
[todo-execution-prompt.js](../lib/todo-execution-prompt.js); continuation messages
and MCP execution tools use that same source.

`todo_show` publishes `execution_protocol_path` in both its text response and
structured result. Existing-chat continuations read that server-resolved path
before orchestrating, even when the TODO belongs to a different project. An
inspection response only points to the protocol; it does not authorize execution.
Manual review assignments also load the live body and plan through `todo_show`
and follow all detail cursors rather than embedding a copy of either field.

## Ordering and status

Siblings run sequentially in `sibling_index` order; parallel execution needs an
explicit parent `run_mode`. A parent status is derived from its children at every
depth and is never forced done. Statuses move `idea -> ready -> doing -> done` (`deferred` parks a todo outside this flow);
the executor sets `doing` after approval and marks a leaf `done` itself only when
all acceptance criteria are met and required verification passes. Reopening a
child reopens its ancestors.

## When the Cretli MCP tools are unavailable

A missing or broken MCP bridge is not permission to guess. Do not treat a plan
copied into a start prompt, an earlier chat, or a cached transcript as live, and
do not post a hand-built `set-todo-from-agent` payload. Instead:

1. Read this protocol and, for the subtree path,
   [todo-execution-prompt.js](../lib/todo-execution-prompt.js) directly from the
   filesystem.
2. Gather read-only evidence with the local file, search and git tools.
3. Report a concrete blocker: the failing MCP call, the command or file that
   failed, and what remains unknown. Leave the TODO status, plan approval and
   `review` field untouched.
