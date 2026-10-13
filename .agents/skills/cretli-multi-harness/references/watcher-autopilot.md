# Workspace Watcher autopilot cycles

Detail for `cretli-multi-harness` — read only when this chat is (or may be) a
watcher cycle orchestrator.

The Workspace Watcher can start this loop without a human. The watcher itself is
a **server-side, deterministic guard with no LLM**; it runs one short-lived
orchestrator chat per cycle, and that chat is the parent of one multi-harness
loop. It is a separate server-side actor, not a mode of this skill:

- The watcher (server, no LLM) snapshots and decides in `autopilot` mode, then
  spawns **one short-lived orchestrator chat per cycle**. One cycle = one chat
  run. The parent of the cycle runs `model_pick` + `delegation_start` for
  plan / implement / review / fix (a cheap parent; it does not implement the
  work itself), marks the todo done only after an independent review PASS, and
  ends. It must not start a second cycle — the watcher starts the next one.
- **End the cycle with `watcher_report`** (`watcher_update` action
  `report`) with outcome `success | blocked | failure`, the `cycle_id` and a
  one-line message. The report is idempotent and is accepted only from the
  cycle's own orchestrator chat; the watcher reads it back to update
  `failures`, `cycleCount` and the todo claim.
- Guardrails are server-side: per-UTC-day cycle budget, cooldown, exponential
  backoff, quiet hours, a same-findings stop, `allowedHarnesses` and real
  usage-limit filtering. If the watcher waits, honour it instead of retrying.
- **The plan gate never auto-approves.** A cycle with an unapproved plan writes
  the plan (kind `plan`) and stops; only a human sets `plan.approvedAt`. Do not
  loop plan cycles.
- The cycle keeps the same restrictions as a manual parent: **never commit, push
  or merge**, never edit the workspace while a review job is running, never
  start a second implement/fix while `slot_occupied=true`.
- By default delegations are one level deep (`CRETLI_DELEGATION_MAX_DEPTH=1`): a
  child without `allow_child_delegations` gets `nested_delegation_denied`. Nested
  trees are opt-in (grant, depth cap, optional tree slot/budget limits,
  `delegation_cancel` with `tree:true`). The Watcher cycle orchestrator remains
  the primary planner; nested delegation is not the default autopilot path.
- Control/inspection: `watcher_status` / `watcher_set` / `watcher_report` /
  `watcher_claim_next` and `watcher_show` / `watcher_update`
  MCP tools (or Settings → Workspace Watcher).
