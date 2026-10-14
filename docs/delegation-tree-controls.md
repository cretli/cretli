# Delegation tree controls — inventory and contract

Status: **contract draft, written before any code.** The document has two
parts and they must not be mixed up:

- [Part 1 — Existing behavior](#part-1--existing-behavior-verified-against-the-code)
  describes what the code does today. Every value and name below was read from
  the source files cited.
- [Part 2 — Target contract](#part-2--target-contract-not-implemented)
  describes fields, flags and error codes that **do not exist yet**. Nothing in
  Part 2 works today; do not rely on it.

Related reading: [ARCHITECTURE.md](ARCHITECTURE.md) (delegations),
[DELEGATION-STORE.md](DELEGATION-STORE.md) (persistence, M12 executor pool).

## Part 1 — Existing behavior (verified against the code)

### 1.1 One level only

Delegation is **single-level**. A parent chat starts a child chat on another
harness/model; the child never starts further delegations.

- The child chat is created with `delegationParentChatId = <parent chat id>`
  (`lib/delegation-service.js`, child chat creation passes
  `delegationParentChatId: parent.id`; persisted by `lib/persist/chats-persist.js`).
- Starting from a chat that carries `delegationParentChatId` is refused with
  `nested_delegation_denied` (HTTP status 409, message "Child chats cannot start
  another delegation. Return the report to the parent instead.").
- There is **no flag** to lift this. No depth counter, no grant and no
  `CRETLI_DELEGATION_MAX_DEPTH` exist in the code (`rg MAX_DEPTH lib` only hits
  unrelated constants; `depth_exceeded` appears nowhere in `lib/`).
- Parent-only MCP/HTTP surfaces also reject a child session:
  workflow state updates, `delegation_rate`, `delegation_ack`
  (`lib/mcp/builtin/delegation-tools.js`, `lib/mcp/mcp-inprocess-client.js`,
  `lib/routes/delegations-routes.js`). Those are `CONFLICT`/409 with their own
  messages, not `nested_delegation_denied`.

### 1.2 Enforcement points

Both entry points share `validateDelegationExecutorStart` (nested denial lives
there) and `parentWidthConflict` (slot gates live there). Both run under
`withParentLock(parentChatId)`, so starts/retries of one parent serialize.

#### `createAndStart(input)` — `lib/delegation-service.js`

Order of checks:

1. Runtime/update gates: `runtime_not_ready` (503), `canAcceptNewRun()` update
   conflict.
2. `parent_required` (400) when `parentChatId` is empty;
   `pick_reason_too_long`; `idempotency_key_required` when `pickId` is set.
3. Under the parent lock, `validateDelegationExecutorStart`, in this order:
   parent validation (`validateDelegationParent`), `ask_mode_denied`,
   **`nested_delegation_denied`**, `no_workspace`, executor transport/adapter
   (`executor_unavailable`), model availability (`model_unavailable`). A missing
   parent maps to `chat_not_found` (404).
4. Workspace Watcher parent guard (`validateWorkspaceWatcherParentDelegation`).
5. Source resolution (`source_unavailable`, `source_changed`, `plan_missing`,
   `plan_revision_conflict`).
6. Idempotency lookup. A hit returns `resumeExistingDelegation` (same job; it is
   exempt from slot gates through `resumeDelegationId`) or `idempotency_conflict`.
7. Model/role hard gates (`evaluateDelegationStartHardGates`, includes
   `review_uncertified`).
8. Workflow gate `inspectDelegationWorkflowStart` (per parent+leaf):
   `workflow_deadline`, `workflow_rounds_exhausted`, `workflow_stopped`,
   `workflow_budget_exhausted` (see 1.4).
9. **Slot gate** `parentWidthConflict(gate: 'start')` — see 1.3. Queueable
   conflicts (`active_delegation_exists`, `parent_busy`, `review_fanout_full`)
   park the job as `queued` unless the parent's queue is at
   `CRETLI_DELEGATION_QUEUE_MAX` → `queue_full`. `workspace_busy` and
   `global_limit` are always hard rejections.
10. Pick-slot and explore-budget reservations (these `await`).
11. Because of those awaits, the parent and `parentWidthConflict` are
    **re-checked synchronously** immediately before `createDelegationRecord`
    (a refused re-check releases the reservations), followed by a final
    `canAcceptNewRun()`.

#### `retryUnlocked(id)` — `lib/delegation-service.js`

Same shared gates, different order and **no queueing**:

1. Runtime/update gates; `not_found` (404).
2. Under the parent lock: `still_active` if the job is active/slot-occupied;
   interrupted-retry gate.
3. `validateDelegationExecutorStart` again (so a retry of a child's job from a
   parent that has since become a child is `nested_delegation_denied`;
   it also revalidates ask mode, workspace, adapter, model).
4. Prompt build, review adapter guarantee (`assertReviewAdapterAllowed`), then
   `inspectDelegationWorkflowStart` for the stored leaf.
5. `parentWidthConflict(gate: 'retry', resumeDelegationId: id)`. **Any** block is
   returned as-is (`parent_busy`, `review_fanout_full`, `workspace_busy`,
   `global_limit`); retry is never parked in the queue and `queue_full` cannot
   occur here. Exclusive conflicts use code `parent_busy` on retry and
   `active_delegation_exists` on start.
6. Parent re-validation and `canAcceptNewRun()`, then the attempt transitions
   to `starting`.

Queue drain (`drainQueueForController`, FIFO head only) re-runs
`parentWidthConflict(gate: 'start', ignoreQueued: true)` and keeps the head
parked on any block.

### 1.3 Slot semantics

`parentWidthConflict` evaluates three gates in a fixed order and returns the
first failure; the first two compare against different row sets.

| Order | Gate | Source | Scope | Code |
|-------|------|--------|-------|------|
| 1 | Parent width | `lib/delegation-width.js` `resolveDelegationParentWidth` | rows counted by `isDelegationSlotOccupied` (`listActiveDelegationsForController`) for the **same parent chat** — active statuses plus terminal jobs with a non-stale `runStoppingAt` (see 1.3) | `active_delegation_exists` (start) / `parent_busy` (retry), `review_fanout_full` |
| 2 | Workspace write lock | `lib/delegation-workspace-guard.js` `resolveDelegationWorkspaceWriteConflict` | occupied, non-queued, **mutating** (non-review) rows from a **different parent** with the same execution folder (realpath-normalized; falls back to workspace folder) | `workspace_busy` |
| 3 | Process-wide cap | `lib/delegation-workspace-guard.js` `resolveDelegationGlobalLimit` | all occupied, non-queued rows across all parents | `global_limit` |

Details:

- Parent width: one implement/fix at a time per parent by default
  (`CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT=1`). When fanout is 2 (default),
  additional implement/fix jobs on the same parent are allowed only for a
  different leaf id with disjoint `## Leaf scope` paths (`lib/todo-parallel-scope.js`).
  Active implement rows still block incoming reviews. Reviews fan out up to
  `readDelegationReviewFanout()` (2 by default). A same-job resume is exempt.
- Workspace guard: an incoming **review** is never blocked. Two parents in
  different execution folders do not block each other. Rows of the same parent
  are not "foreign" to it.
- Global limit counts both review and mutating rows; `0` (the default) means
  unlimited.
- "Occupied" is `isDelegationSlotOccupied` (`lib/delegation-status.js`): a row
  with `runStoppingAt` set (unless stale) or an active status. A job in
  `waiting_for_input` or `cancelling` still occupies its slot, which is why
  parents must wait for `slot_occupied=false` (`delegation_wait`) before the next
  start.
- Slots are keyed by **parent chat id**. There is no concept of a slot shared
  by a tree of jobs.

### 1.4 Budget and workflow gate

`lib/delegation-workflow-budget.js` (`summarizeDelegationWorkflowUsage`) sums
the usage ledger for the delegations of **one parent chat and one workflow
leaf** (matched through the leaf id on the delegation row, then by
`delegationId` or child `chatId` in the usage events). `measured: false` when
there is no usable measurement, so a missing ledger never blocks.

`inspectDelegationWorkflowBudget` (in `lib/delegation-workflow.js`) blocks with
`workflow_budget_exhausted` (409) only when `budgetTokens` / `budgetCostUsd`
are configured **and** measured spend is at or above the cap. Default max
rounds per leaf is `DELEGATION_WORKFLOW_DEFAULT_MAX_ROUNDS = 4`. Budgets are
per parent+leaf, not per tree.

### 1.5 Cancellation

`cancel(id)` in `lib/delegation-service.js` cancels **one** delegation:

- Terminal job: no-op `200`, unless the child run is still stopping (then it
  tries to stop the run and returns `200`/`202`).
- Active job (except `queued`): transition to `cancelling`, `cancelChatRun` on
  the child chat, then `cancelled` (`200`) or `202 pending` while the run is
  still busy. `queued` is an active status but there is no allowed transition
  `queued` → `cancelling` (`lib/delegation-status.js`); `cancel(id)` returns
  `cancel_blocked` (409) before calling the adapter.
- `cancel_blocked` (409) for any other illegal transition.

`cancelForDeletedChat(chatId)` cancels every active delegation where the chat
is the **child or parent** of the row (flat; there is no descent). The
workflow deadline worker also requests cancel per leaf. No operation cancels a
set of related delegations as a tree.

### 1.6 Error code mapping

`lib/mcp/builtin/errors.js` `toCretliMcpToolError` maps service codes to MCP
error codes:

| Service code | Origin | HTTP status in service result | MCP code |
|--------------|--------|-------------------------------|----------|
| `nested_delegation_denied` | `validateDelegationExecutorStart` | 409 | `CONFLICT` |
| `workspace_busy` | workspace guard | 409 | `CONFLICT` |
| `global_limit` | process-wide cap | 409 | `CONFLICT` |
| `queue_full` | `queueFullConflict` in `createAndStart` only — when accepting a new delegation (initial queueable slot block and the synchronous re-check before `createDelegationRecord`); `drainQueueForController` never returns it (a blocked head stays `queued`) | 409 | `CONFLICT` |
| `depth_exceeded` | **not produced anywhere** | — | no explicit mapping; would fall through to `status === 409` → `CONFLICT` only if a producer set it |

Other 409 codes in the same family: `active_delegation_exists`, `parent_busy`,
`review_fanout_full`, `still_active`, `workflow_*`, `review_uncertified`.
`workflow_budget_exhausted` has no explicit entry in the list but is mapped by
`err?.status === 409`. `conflictDetails` forwards `delegationId`, `attemptId`
and `reason` of the blocker.

### 1.7 Flags and defaults

| Env var | Reader | Default | Parsing |
|---------|--------|---------|---------|
| `CRETLI_DELEGATION_REVIEW_FANOUT` | `readDelegationReviewFanout` (`lib/delegation-width.js`) | `2` concurrent reviews per parent | Exact trimmed `1` → 1; **anything else** (incl. `0`, `garbage`, `9`) → 2. Cap is `DELEGATION_REVIEW_FANOUT_MAX = 2` |
| `CRETLI_DELEGATION_QUEUE_MAX` | `readDelegationQueueMax` (`lib/delegation-width.js`) | `8` queued jobs per parent | `parseInt`; non-finite or negative → 8; `0` is accepted (no queueing: first queueable conflict is `queue_full`) |
| `CRETLI_DELEGATION_GLOBAL_LIMIT` | `readDelegationGlobalLimit` (`lib/delegation-workspace-guard.js`) | `0` (unlimited) | `parseInt`; non-finite or `<= 0` → 0 |
| `CRETLI_DELEGATION_MAX_DEPTH` | — | **does not exist** | — |

Values are read through `readEnvAlias` with only the `CRETLI_*` name (no
legacy alias is passed for these three flags).

### 1.8 Tests that pin the current behavior

| Test | Covers |
|------|--------|
| `tests/delegation-review-fanout.test.js` | `nested_delegation_denied` from a child chat; fanout parsing (`CRETLI_DELEGATION_REVIEW_FANOUT`) and review queueing |
| `tests/delegation-queue.test.js` | queueing, FIFO drain, `queue_full` with `CRETLI_DELEGATION_QUEUE_MAX`, MCP mapping of `queue_full` |
| `tests/delegation-workspace-guard.test.js` | `workspace_busy` (same folder, symlink alias, concurrent starts), `global_limit` with `CRETLI_DELEGATION_GLOBAL_LIMIT` |
| `tests/execution-folder.test.js` | `workspace_busy` keyed on execution folder |
| `tests/todo-manual-worktree.test.js` | `workspace_busy` for worktree/folder starts |
| `tests/delegation-run-stopping-stale.test.js` | `workspace_busy` while a run is stopping |
| `tests/mcp-builtin-tools.test.js` | MCP `delegation_start` from a child session is rejected with "Child chats cannot start another delegation" |
| `tests/delegation-workflow-http.test.js`, `tests/delegation-ratings.test.js` | child chats are rejected (409) from parent-only operations (workflow state write, rate) |

There is no test for depth, a tree budget, tree cancel, or a grant — none of
those features exist.

### 1.9 Known gaps

1. **No explicit grant/permission.** A child may never delegate; nothing can
   allow it for a given parent, model or workspace.
2. **No depth tracking.** The chain is one hop, encoded only by the boolean
   presence of `delegationParentChatId`; no depth value is stored and
   `depth_exceeded` is never produced.
3. **No shared tree budget or slots.** Width, workspace and global limits count
   rows per parent/folder/process; token/cost budget is per parent+leaf. A tree
   would not share any of these.
4. **No tree visibility.** Listing is per parent chat; no API returns the
   descendants of a root.
5. **No tree-wide cancel.** `cancel(id)` is single-job; chat deletion cancels
   one parent/child pair level only.

## Part 2 — Target contract (not implemented)

Nothing below exists in the code. It is the agreed shape for the follow-up
todos so they implement against one contract.

### 2.1 Principles

- **Default stays single-level.** With no new configuration, behavior is
  exactly Part 1: a child chat starting a delegation gets
  `nested_delegation_denied`.
- **Multi-level is explicit opt-in**, by a server-side maximum depth *and* a
  per-start grant (both must allow it). The maximum depth is a new flag whose
  default keeps one level (`1`).
- Every limit that is new must compose with the existing gates; it must not
  replace `workspace_busy`, `global_limit`, `queue_full` or workflow gates.

### 2.2 Tree fields (on the delegation row)

| Field | Meaning | Legacy rows |
|-------|---------|-------------|
| `rootChatId` | Chat that initiated the tree: the topmost chat with no `delegationParentChatId`. | Derived: `parentChatId` (equal for every one-level row) |
| `rootDelegationId` | Id of the **first** delegation of the tree (the one whose parent is `rootChatId`). For a first-level job it equals its own `id`. | Derived: own `id` |
| `depth` | Number of delegation hops from `rootChatId` (first-level job = `1`). | Derived: `1` |

Resolution of the two root identifiers:

- `rootChatId` is the **scope key** for anything that must be shared by the
  whole tree *and* must exist before the first delegation: slot accounting,
  token/cost budget, queue limits. It is stable and known at the first start.
- `rootDelegationId` is the **handle key** for tree visibility and
  cancellation (`cancel tree` = cancel every active row with that
  `rootDelegationId`). It is not known before the first row exists, so it is
  never used for admission gates.
- A parent chat may start several first-level delegations over time; each is
  its own `rootDelegationId` under the same `rootChatId`. A tree-wide
  operation therefore always names a `rootDelegationId`; a chat-wide operation
  names a `rootChatId`.

### 2.3 Legacy persistence behavior

- The fields are **additive**. Rows written before the change have none of
  them and must keep loading unchanged (no schema bump required for JSON;
  SQLite migration must treat them as nullable).
- Readers derive missing values as in the table above; they never write the
  derived values back as a side effect of reading.
- New rows always store all three fields. A one-level row stores
  `rootChatId == parentChatId`, `rootDelegationId == id`, `depth == 1`, so
  default-mode rows are indistinguishable from derived legacy rows.
- Chats keep `delegationParentChatId` as the source of truth for "is a child".

### 2.4 Error precedence (new codes slot into the existing order)

In `validateDelegationExecutorStart`, after `ask_mode_denied` and before
`no_workspace`:

1. Starter is not a child chat → continue (unchanged).
2. Starter is a child chat and multi-level is **not enabled** (max depth `1`
   or no grant) → `nested_delegation_denied` (unchanged code, so existing
   clients and `tests/delegation-review-fanout.test.js` stay valid).
3. Multi-level enabled and granted, but `depth + 1 > maxDepth` →
   `depth_exceeded` (409, mapped to MCP `CONFLICT` in
   `lib/mcp/builtin/errors.js`; it needs an explicit entry for clarity).

Then the existing order continues untouched: workspace/executor/model, source
and idempotency, hard gates, workflow gate, `parentWidthConflict`
(parent width → `workspace_busy` → `global_limit`; queueable conflicts →
`queue_full`). `retryUnlocked` must call the same helper so both enforcement
points agree; a retry never queues, as today.

### 2.5 Planned flags (do not exist yet)

| Env var | Intended default | Intent |
|---------|------------------|--------|
| `CRETLI_DELEGATION_MAX_DEPTH` | `1` (single level) | Highest allowed `depth`. `1` reproduces today's behavior exactly. |

Further tree-level limits (shared slots/budget per `rootChatId`) are to be
specified by their own todos and must be added to this table only when they
are implemented.

### 2.6 Planned tree operations

- Tree visibility: list delegations by `rootDelegationId` / `rootChatId`.
- Tree cancel: cancel all active rows sharing a `rootDelegationId`, built on
  the single-job `cancel(id)` semantics (including `202 pending`).
- Shared tree budget and slots keyed by `rootChatId` (see 2.2).

These close gaps 1.9.1–1.9.5; until they ship, Part 1 is the behavior.

## Controller vs historical parent

A delegation record keeps `parentChatId` as its historical identity (who
started it). Who currently *controls* it is `delegationController(row)` from
`lib/delegation-control.js`: the optional `controllerChatId`, falling back to
`parentChatId`. Waiting, ack, rating, cancel, the per-leaf workflow key, the
queue (`listDelegationsForController`, `drainQueueForController`), the parent
lock and idempotency replay all use the controller. Scope gates resolve the chat
through `resolveDelegationScopeChat`, so a deleted original parent does not hide
the delegation from its controller. No operation moves control yet; rows without
`controllerChatId` are unchanged. The guard test
`tests/delegation-controller-guard.test.js` and
`config/delegation-controller-allowlist.json` classify each remaining
`parentChatId` use as control / identity / scope.
