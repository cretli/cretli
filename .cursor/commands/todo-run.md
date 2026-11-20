# Run a TODO in this workspace

Run the TODO identified by the user's arguments in the current workspace. Use
the Cretli TODO MCP tools, not the global TODO folder. Syntax:
`/todo-run <todo-id> [harness/model-id]`.

1. Parse the TODO id and optional implementation model from the command
   arguments. If the TODO id is missing, ask the user for an id and stop.
2. Call `todo_show` with the full id. Read every body and plan page, then
   recursively inspect all descendants. Respect plan approval, sibling order,
   run mode, assignees, and each TODO's configured execution mode.
3. If the root is a parent, orchestrate its complete subtree. Record this chat
   as `orchestrator_chat_id` with `todo_update` using the latest
   `expected_updated_at` value.
4. Continue from existing active work without creating duplicate delegations.
   Otherwise select the next ready leaf with `todo_next_ready({ root_id })`.
5. For each leaf, follow the TODO execution workflow in `todo_show`. If a model
   was supplied, split it into harness and model id, confirm it is enabled with
   `model_list`, and use it for implementation delegations. If it conflicts
   with an explicit TODO assignee or is unavailable, report that conflict and
   stop before changing TODO status. Keep review on a separate eligible model.
   Wait for terminal reports, and only mark the leaf done after a PASS review.
   Do not bypass an unapproved plan or change execution mode to work around a
   preparation error.
6. Continue through all descendants without asking whether to proceed. If
   blocked, report the specific blocker and leave unfinished TODOs open.

Keep all work scoped to the requested TODO subtree and this workspace.
