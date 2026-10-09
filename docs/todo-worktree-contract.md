# TODO Worktree Execution Contract

Status: design contract. This document defines the execution contract for
worktree-backed TODO leaves driven by the Workspace Watcher. It settles the
questions listed in the parent TODO and marks every unresolved point as
**OPEN**. It does not implement anything.

- Parent TODO: `3487b37e-b45f-41bd-b38d-7a4f7b44a502` — "Worktree dla TODO i
  watcherów oraz opcjonalny panel Git" (plan approved).
- This leaf: `64c4cfb7-457e-481c-8f4c-b4d9d6543502` — "Worktree: kontrakt
  wykonania i decyzje o integracji".
- Related, still-open product context: `docs/workspace-watcher.md`
  (cycle lifecycle, claims, plan gate, no-commit rule).

## 0. Reading conventions

A statement is only binding when it is listed in **§13.1 Settled decisions**. A
point that is not settled is tagged `OPEN (O<n>)` inline and listed in
**§13.2 OPEN decisions**. Nothing in this document authorizes an automatic
commit, push or merge.

## 1. Purpose

Today a watcher cycle runs agents in the logical workspace folder, there is one
shared working directory per project, and a review PASS immediately returns the
todo to the pool. The worktree feature must:

1. isolate execution of a TODO leaf in its own Git worktree while keeping
   TODO/memory/claims/limits bound to the logical project;
2. freeze a per-leaf execution mode and a base commit, so a retry is
   reproducible and never silently changes directory or base;
3. separate "execution finished" from "integrated", so a sequential sibling
   cannot start on top of unintegrated changes;
4. persist the result without committing, pushing or merging;
5. protect unaccepted changes on failure, cancellation, restart and rejection.

## 2. Terms

| Term | Meaning |
| --- | --- |
| **Logical workspace** (`workspaceFolder`) | The project identity. TODO tree, claims, watcher policy/state, memory, plan gate, limits, reports, notifications, authorization and grouping stay keyed to it. |
| **Execution folder** (`executionFolder`) | The directory an agent process actually runs in (a Git worktree for `worktree` mode, the logical workspace for `project` mode). Runners, material revision, write locks and test verification use it. |
| **Execution mode** (`mode`) | Requested per leaf: `inherit`, `worktree`, `project`. Resolved once to `worktree` or `project`. |
| **Resolved mode** | The frozen `worktree` / `project` value chosen before execution starts. Immutable for the lifetime of the leaf's work. |
| **Base commit** | Full commit SHA recorded *before* execution starts. The worktree is created at this commit. Never changed by a retry. |
| **Worktree record** | Durable entry linking todo id, logical workspace, worktree path, branch, base commit, cycles/chats and lifecycle state. |
| **Execution state** | Lifecycle of the agent work itself (`none` … `execution_closed`). |
| **Integration state** | Whether the finished work is available to the rest of the project (`pending`, `ready`, `integrated`, `rejected`). |
| **Claim** | The existing watcher CAS reservation of a leaf (`claimedByChatId` + `claimLeaseUntil`, `ready → doing`). |
| **Cycle** | One watcher orchestrator run for one claimed leaf (existing lifecycle, `docs/workspace-watcher.md`). |

## 3. Workspace / execution folder split

### 3.1 Logical workspace (`workspaceFolder`) — SETTLED

The logical workspace remains the single identity for:

- the TODO tree, statuses, claims, `blockedReason`, `runMode`, `assignee`;
- Workspace Watcher row, policy, active cycles, decisions, metrics;
- Workspace Memory, Scout, notifications, daily budget and `maxParallel`;
- plan gate and plan approval inheritance;
- authorization and chat/TODO grouping;
- final reports and failure counters.

### 3.2 Execution folder (`executionFolder`) — SETTLED

The execution folder is what a runner, material revision, write lock and test
verification operate on:

- agent/delegation start, resume and recovery `cwd`;
- the shared-directory write lock used to serialize mutating delegations;
- material revision hashing and review-verify test execution;
- Git reads/actions resolved for that leaf.

A child chat inherits both the logical workspace context and the execution
folder; the harness children must see the exact same worktree for
implement/review/fix.

### 3.3 Resolution and compatibility fallback — SETTLED

- With no worktree record, `executionFolder` resolves to `workspaceFolder`.
  This is the backward-compatible default for every existing chat, todo and
  delegation.
- The resolver is server-side and derives the execution folder from an
  authorized chat/TODO context, never from a global process cwd.
- Resolution must not change an already active task: once frozen, an active
  leaf's `executionFolder` is read from its worktree record.

### 3.4 What belongs where — SETTLED

| Concern | Logical workspace | Execution folder |
| --- | --- | --- |
| TODO tree, claims, `runMode`, plan gate | yes | no |
| Watcher policy/state/cycles/metrics | yes | no |
| Workspace Memory, Scout, notifications | yes | no |
| Daily budget, `maxParallel`, harness allow-list | yes | no |
| Agent `cwd`, resume/recovery cwd | no | yes |
| Mutating-delegation write lock content check | no | yes |
| Material revision, review-verify tests | no | yes |
| Git reads/actions for the leaf | no | yes |
| Failure/report records | yes | no |

## 4. Execution mode resolution

### 4.1 Values — SETTLED

Per-leaf request: `inherit | worktree | project`. An absent/empty value is
equivalent to `inherit`. The watcher policy carries a default
(`worktree` or `project`); the product default is `project` for compatibility
with current behavior.

### 4.2 Resolution order — SETTLED

1. An explicit leaf override wins if it is `worktree` or `project`.
2. Otherwise `inherit` continues to the parent node (see §4.3).
3. Otherwise the watcher policy default applies.
4. The resolved value is `worktree` or `project`, never `inherit`.

Resolution happens for a leaf that is about to execute, and the result is
written to the worktree record before any agent starts.

### 4.3 Ancestor inheritance — OPEN (O1)

The parent plan requires deciding whether a per-TODO override is inherited from
ancestors, and how `inherit` walks the tree. This document does **not** settle
it.

Proposal under review (not agreed): `inherit` walks from the leaf upward to the
root and takes the nearest explicit `worktree`/`project` override; if none
exists, the policy default applies. Under that proposal an explicit root
`worktree` would cover the whole subtree unless a closer node overrides it, and
a parent with an inherited value would not by itself resolve to `inherit`.

Until O1 is closed, an implementation may only use the leaf's own explicit
value plus the policy default; any ancestor walk is unapproved.

### 4.3a Manual starts key by the tree ROOT — SETTLED (manual only)

A Todo started by hand from the Todo panel (`POST /api/todos/:id/start-agent`)
resolves the execution mode from the tree **ROOT**, not from the requested leaf:

- root = walk `parentId` to the top;
- the ROOT's explicit `worktree`/`project` override wins, otherwise the Watcher
  policy default applies;
- the requested leaf's own `executionMode` is ignored for manual starts (the
  card shows a hint);
- `inherit`/absent on the root falls back to the policy default.

The root's worktree is created/reused **once** and frozen as `executionFolder`
on every chat of the tree; delegated implement/fix children copy it, and the
per-folder write lock therefore does not collide with another tree working in
the main folder. This is a **manual-start** rule only: the Workspace Watcher
still keys by the claimed leaf (`resolveWorktreeMode` is not changed).

Mixing the two keyings is unsupported: a start refuses with HTTP 409 when the
same direct line already has a live record under a different id (a manual root
record vs a Watcher leaf record). Sibling leaves are not on the same line and
may still run in parallel. Concurrent mutating chats **inside one tree** are
also unsupported (the per-folder lock is unchanged): the second start gets
`workspace_busy`.

A long prepare does not block the request: `start-agent` answers `202
{state:'preparing'}` and the client polls
`GET /api/todos/:id/start-agent/status`. The fast path (no worktree, or a live
frozen record) stays synchronous.

Manual integration is explicit: `POST /api/todos/:id/integration` with
`action=prepare` builds the root-level diff and moves the root to
`integration.state=ready` (evidence is honest: `outcome:'manual'`,
`review.verified:false`, `test.outcome:'unknown'`); `action=merge` performs
prepare plus the guarded three-way apply in one human step; `confirm`/`reject`
keep their meaning. The diff accumulates over all sibling leaves of the tree.
Any node of the tree may be named: the action resolves the worktree owner.

### 4.4 Freeze on start and retry — SETTLED

- The resolved mode and the resolved `executionFolder` are frozen when the leaf
  starts execution (after claim, before the first agent run).
- Changing watcher settings or a TODO override does **not** move or re-mode an
  active leaf. The change applies to leaves that start later.
- A retry reuses the frozen mode, the same worktree record and the same base
  commit. A retry never re-resolves the mode.
- To change mode for an existing leaf, the human must first bring it to a
  terminal integration state (`integrated` or `rejected`) and then start a new
  execution; this is `OPEN (O9)` where it concerns reuse of the old worktree.

### 4.5 Plan-only cycles — OPEN (O7)

The parent plan asks whether a plan-only cycle needs a worktree. The open
question is whether `worktree` leaves create their worktree before or only after
the plan gate is satisfied. Creating it lazily avoids empty worktrees for
plan-only cycles but complicates the "one worktree, frozen before execution"
guarantee; creating it eagerly is simpler but leaves unused worktrees whenever
the plan gate stops a leaf. Not settled.

## 5. Base commit and dirty tree

### 5.1 Base commit — SETTLED

- The base commit is a full SHA read from the logical repository (or, for
  nested repositories, from the resolved repository root) **before** any agent
  or prepare step runs.
- It is written to the worktree record together with the recorded time.
- It is unchanged on retry, restart, cancellation and rejection. A retry never
  re-reads HEAD to move the base.
- The worktree is created at the recorded base, so the patch and diff always
  compare against a stable point.

### 5.2 Dirty logical tree — SETTLED

- The explicit start choice accepts `block | head | snapshot`; no choice
  defaults to `block`. A saved setting never silently opts a run into `head` or
  `snapshot`.
- `block` refuses a dirty start and reports non-ignored changed paths. No state
  is stashed, staged, checked out or committed.
- `head` starts at the current HEAD. The record stores `baseKind: head` and the
  paths omitted from the execution as `skippedPaths`.
- `snapshot` starts at a commit representing the current index plus working
  tree, including untracked non-ignored files. The commit is built with a
  temporary index and retained under `refs/cretli/snapshots/<todo-id>`; the
  record stores `baseKind: snapshot`, `snapshotOfHead` and `snapshotRef`.
- Neither choice changes the user's worktree, index, stash or branches. The
  selected base and path list are frozen in the worktree record across retries.
  Cleanup removes the Cretli snapshot ref after the worktree is removed.
- The same clean-tree precondition gates a sequential sibling that must take its
  base after an earlier sibling has been integrated: first-version integration is
  patch-based and commits nothing (S14/S15), so the logical tree stays dirty until
  something commits the integrated result. The mechanism that produces the clean
  tree (for example a human committing the integrated result in the logical repo)
  is **OPEN (O5)** and is not decided here; see §12.2 step 5.
- The block is a preflight failure, not an execution failure, and does not
  count toward the failure ceiling.
- `project` mode keeps today's behavior (it runs in the existing folder; a dirty
  tree there is the current status quo).

### 5.3 Working from HEAD or a snapshot — SETTLED (O6)

The start dialog presents the dirty paths and requires the operator to choose
manual commit, `head` (skip those changes) or `snapshot` (include them). Ignored
files are not included. Both automated starts and retries without an existing
frozen record continue to use the safe `block` default. A snapshot-based result
is diffed against its snapshot base. The explicit **Apply patch to workspace**
action performs a three-way merge against a temporary index containing the
current logical-tree contents, then applies the merged delta to the worktree
only. A conflict is reported before changing files; the user's index is not
written. The operator reviews the result and separately confirms integration.

## 6. Worktree location, naming and branches

### 6.1 Location — OPEN (O3)

The direction is settled: worktrees live **outside the project directory** so
that a worktree cannot be picked up by the project's own tooling as nested
content. The exact base path, per-workspace vs shared namespace, and how the
path is configured per server/workspace are **OPEN (O3)**.

Candidate (not agreed): a server-owned root such as
`<data-root>/worktrees/<workspace-key>/<todo-id>`, never inside the repository.

### 6.2 Naming — OPEN (O3)

The branch and directory names must be deterministic, human-readable and
collision-resistant, derived from the todo id and a short slug. The exact schema
is **OPEN (O3)**. Constraints already settled:

- names are derived from the durable todo id, not from the title alone;
- a name is never evidence of ownership (see §6.4).

### 6.3 Existing worktree / foreign branch — OPEN (O4)

Handling of an existing directory or branch that is not in the registry, a
branch that exists but is not registered, a registered branch that exists under
a different worktree, and orphaned branches after cleanup is **OPEN (O4)**.
Settled constraints for any resolution:

- a foreign directory/branch is surfaced as a decision, never silently removed,
  reset or checked out;
- no `git worktree remove --force`, `git branch -D`, `git reset --hard` or
  `git clean` is run automatically on anything that may hold unaccepted work;
- reconciliation reports what was found and blocks that leaf rather than
  guessing.

### 6.4 Never adopt on name match alone — SETTLED

A worktree is adopted for a todo only when the durable registry links them and
the link is verified against Git after a restart (path, branch and recorded base
all match, and an ownership marker for the todo id is present). A matching
directory name or branch name alone is never sufficient and must not cause
adoption.

### 6.5 Registry reconciliation after restart — SETTLED (shape)

On boot and on autopilot passes the registry is reconciled with
`git worktree list --porcelain`:

- registered and Git-known worktree → verified, kept;
- registered but missing on disk → reported; the leaf is blocked, not
  silently recreated over existing changes;
- present on disk but not registered → foreign/orphan, surfaced, never adopted;
- branch exists without a worktree → reported; recreation is subject to
  `OPEN (O4)`.

The reconciliation is idempotent and never deletes unaccepted work.

## 7. Prepare step

### 7.1 Explicit prepare — SETTLED

- Prepare is a distinct, explicit step between worktree creation and the first
  agent run. It is not hidden inside worktree creation and not part of the agent
  prompt.
- It runs a declared per-workspace prepare action (for example install
  dependencies or generate ignored config) in the execution folder.
- Prepare is idempotent and may run again on retry.
- A prepare failure is a preflight failure: the claim is rolled back, the leaf
  returns to the pool with a readable reason, and there is **no silent
  fallback** to `project` mode or to an unprepared folder.

### 7.2 Secrets — SETTLED

Prepare must not automatically copy secrets, tokens, `.env` files, credentials
or ignored local configuration into a worktree. If a workspace needs a
non-secret generated file, the prepare action must create it explicitly; secret
material stays out of worktrees by default.

### 7.3 `data/` — SETTLED

The worktree must not symlink, bind-mount or share the main `data/` directory
(or the main runtime data root). A worktree gets its own data directory or none.
Runtime data, TODO stores and chat history always stay in the logical workspace
data root.

### 7.4 Dependencies and services — SETTLED limitation

The worktree does not isolate ports, databases or external services. Two
concurrent worktrees can collide on a fixed port or a shared service. This is a
documented limitation, not a defect; prepare and run docs must warn about it.

## 8. State model and transitions

### 8.1 State fields — SETTLED (separation), OPEN (representation)

Every worktree-backed leaf carries two independent pieces of state plus the
existing todo status:

- `executionState`: `none | preparing | active | execution_closed`;
- `integrationState`: `not_applicable | pending | ready | integrated |
  rejected`;
- `status` (existing): `idea | ready | doing | done`.

`integrationState` is separate from `executionState` and from `status`. Whether
it is a stored field or derived, and its exact name, is **OPEN (O2)**. The todo
`status` remains the only pickable status.

For `project` mode, `integrationState` is `not_applicable` (current behavior;
review PASS returns the leaf to the existing flow) `OPEN (O2)` on whether
project mode also needs an integration gate.

### 8.2 Start

Preconditions (all must hold; otherwise preflight failure):

1. The leaf was claimed (`ready → doing`, `claimedByChatId` set) inside the
   watcher lock.
2. The resolved mode is known and frozen; `executionFolder` resolved.
3. For `worktree`: the logical repo exists, the tree is clean (§5.2), the base
   commit is recorded, and no foreign/other-todo worktree maps to this leaf.
4. Create the worktree at the base commit idempotently and write the registry
   record.
5. Run prepare.
6. Set `executionState = active` and start the agent run in `executionFolder`.

Rollback: any failure before step 6 releases the claim, leaves the leaf
`ready` (or parks it per the failure policy), records a readable reason and
does **not** silently convert `worktree` to `project`. `executionState` returns
to `none` (the leaf never reached `active`; `preparing` is not a terminal state)
and `integrationState` stays `not_applicable`. A worktree created before
a later preflight failure is preserved for inspection, not force-removed.

Concurrency: two cycles must never create the same worktree for one leaf. The
reservation is race-safe (registry write under the same cross-process
discipline as the watcher). The exact CAS mechanism is **OPEN (O10)**.

### 8.3 PASS

On independent review PASS:

1. Persist the result per §9 (kept worktree + patch, or an approved
   alternative).
2. `executionState = execution_closed`; `integrationState = ready`.
3. Close the cycle as today (metrics, failure counters, archive chat) and
   release the claim.
4. The leaf **stays `doing`**. It is not returned to `ready` and is not
   re-pickable. `integrationState = ready` adds a new blocking predicate to the
   recovery classifier, so a `doing` row without a claim is classified
   `user_action` (a human must integrate) rather than `recoverable`. **This is a
   deliberate change to existing recovery behavior**: today such a claim-less
   `doing` row falls to the existing `recoverable` path; under this contract the
   integration-ready guard takes precedence for it.
5. Sequential siblings remain blocked because `done` is deferred (§8.5).

Review PASS therefore means "execution finished and verified", never "done" and
never "available to the next sibling".

### 8.4 Integration readiness

`integrationState = ready` is the manual-integration queue:

- the UI/TODO view shows branch, base commit, changed files, patch location,
  test/review result and the related cycle/chats;
- the scheduler must not select the leaf, must not re-run implement/review/fix
  for it, and must not treat the closed cycle as a new opportunity;
- siblings and descendants of a sequential parent wait;
- no automatic merge/rebase/cherry-pick is performed by the watcher.

The actor and exact confirmation action that moves `ready → integrated` are
**OPEN (O8)**. The default assumption is a human, because integration is manual
in the first version.

### 8.5 Done

`done` is set only when integration is confirmed:

- `integrationState = integrated`, `status → done` (CAS on the live
  `updatedAt`);
- claim is already released;
- the worktree becomes eligible for explicit cleanup;
- the next sequential sibling may start on the next watcher pass, after the
  tree is re-read.

`done` must never be set directly by review PASS or by the orchestrator to
unblock siblings. This preserves the parent rule: "integration readiness does
not unblock siblings and does not cause repeated cycles of the same task".

### 8.6 Failure

Failure covers an agent/delegation error, an infrastructure error, and an
exhausted run with no PASS:

- preserve the worktree and every change already made;
- `executionState = execution_closed`; `integrationState` returns to
  `not_applicable` (or stays `pending` if a result was partially recorded);
- release the claim; return the leaf to `ready` so the normal retry path can
  pick it up, unless the existing failure ceiling parks it with a
  `blockedReason`;
- record the failure in the existing metrics/failure counters;
- never delete or reset the worktree.

A preflight/prepare failure (§8.2) is handled as described there and does not
create unaccepted content.

### 8.7 Cancellation

When a human or the autopilot stops a running cycle:

- preserve the worktree and all changes;
- `executionState = execution_closed` with no verified result;
- `integrationState` stays not ready;
- release the claim; the leaf returns to the pool (or stays parked per the
  failure policy);
- no automatic cleanup.

### 8.8 Retry

Triggered through the normal selection path when a leaf is `ready` again:

- if a worktree record exists, reuse the same worktree, branch, frozen mode and
  **recorded base commit**; do not recreate and do not reset;
- existing changes from the previous attempt are the starting point; retry
  continues rather than restarting from base;
- re-run preflight verification and prepare;
- if the worktree is missing, foreign or fails verification, block with a
  readable reason instead of silently recreating or adopting it
  (`OPEN (O4)` for the recovery choice);
- changing the mode/override before retry does not apply to this leaf; it stays
  frozen (§4.4).

### 8.9 Restart

On server restart:

- run registry reconciliation (§6.5) before any new cycle;
- a cycle whose orchestrator chat is confirmed idle/missing is closed as today;
  the worktree and result artifacts are preserved;
- a `doing` leaf with `integrationState = ready` must survive as `user_action`
  and must not be released to `ready`;
- unknown liveness keeps the cycle/leaf as unknown and blocks new work rather
  than guessing (existing rule);
- no worktree is deleted or force-removed during restart.

### 8.10 Rejection

When the integrated result is rejected (or integration is abandoned):

- `integrationState = rejected`; preserve the worktree and changes for
  inspection;
- return the leaf to `ready` (or park it with a readable rejection reason) so it
  can be retried;
- cleanup requires an explicit action and must not force-delete unaccepted
  changes (§11);
- whether rejection automatically triggers a retry or waits for a human is
  **OPEN (O8)**.

### 8.11 Claim release and sibling progression — SETTLED

- The claim is released when the cycle closes in a terminal outcome
  (`success`, `failure`, cancellation). Review PASS closes the execution cycle,
  so the claim is released there too.
- A leaf awaiting integration is not in the ready queue, so the release cannot
  cause a re-pick.
- Sequential sibling progression: an earlier sibling blocks its later siblings
  until its whole subtree is `done` (existing `isTodoNodeBlocked` rule). Because
  `done` is deferred to confirmed integration, **sequential siblings wait for
  confirmed integration** in this MVP. This is the intended behavior.
- Parallel siblings (`parent.runMode = parallel`) may run concurrently, each
  with its own worktree and its own integration gate. A full `dependsOn` graph
  across leaves is out of scope for the MVP.
- Whether the claim should instead be held from PASS until integration is
  **OPEN (O2)**; the settled default is release-at-close plus the
  integration-ready guard.

### 8.12 Transition table
| From | Event | To | Todo status | Claim | Sibling effect |
| --- | --- | --- | --- | --- | --- |
| ready | claim + preflight OK | preparing/active | doing | held | blocked |
| ready | preflight dirty/missing Git/prepare fail | ready (+reason) | ready | released | unchanged |
| active | review PASS | execution_closed / integration ready | doing | released | blocked |
| active | failure | closed / not_applicable | ready (+reason) or parked | released | unchanged |
| active | cancel | closed / not ready | ready (+reason) | released | unchanged |
| integration ready | integration confirmed — owner **OPEN (O8)**, state representation **OPEN (O2)** | integrated | done | — | next sibling may start, subject to the §5.2/S6 clean-tree precondition |
| integration ready | rejected — owner/auto-retry **OPEN (O8)**, state representation **OPEN (O2)** | rejected | ready (+reason) | — | unchanged |
| ready | retry (record exists) | preparing/active | doing | held | blocked |
| ready | retry, worktree missing/foreign | ready (+reason) | ready | released | unchanged |
| integration ready | server restart | integration ready (user_action) | doing | — | blocked |
| active | server restart (orchestrator confirmed idle/missing) — owner: watcher/registry reconciliation (§8.9) | execution_closed / not ready (cycle closed as today) | ready (+reason) or parked | released by the existing close | unchanged |

### 8.13 Integration-ready representation — SETTLED by this implementation

The representation of `integrationState` (OPEN O2) is fixed for the first
version as follows.

- The todo carries a top-level `integration` object:
  `{ state, cycleId, resultPath, baseCommit, branch, worktreePath,
  materialRevision, reviewOutcome, testOutcome, changedFiles, reason,
  recordedAt, updatedAt }`.
- `integration.state` is one of `ready`, `integrated`, `rejected`. An absent
  `integration` object means "not applicable" (today's `project` behavior).
- A worktree PASS sets `integration.state = ready` and **forces
  `status = doing`**. It never uses a new `status` value, so the persisted
  status vocabulary is unchanged and `doing` remains the only "not pickable"
  state.
- The durable evidence lives in the worktree registry record, not on the todo:
  `record.results[cycleId]` is a normalized result (base commit, changed files
  including new files, diff stat, patch path/sha, material revision, review and
  test outcome). The patch file is written under
  `<data-root>/worktree-results/<todoId>/<cycleId>.patch`.
- The write is idempotent by `(cycleId, resultHash)`: a repeated report, a
  restart or a lost claim cannot double-count and cannot lose the result.
- Selection guard: `listReadyTodoLeaves`, `pickNextWorkspaceReadyTodo` and the
  recovery classifier exclude `integration.state = ready`, so such a leaf is
  never re-picked and is reported as `user_action` (reason `integration_ready`)
  rather than `recoverable`.
- Manual actions: `POST /api/todos/:id/integration` with `action=prepare`
  (builds the diff and marks `integration.state=ready`, keeping `status=doing`),
  `action=merge` (explicit human "integrate with workspace": prepare when needed,
  then apply the guarded three-way merge to the logical working tree),
  `action=apply`, `action=confirm` (CAS `expectedUpdatedAt`, sets `status=done`
  and unblocks siblings) or `action=reject` (sets `status=ready` with a rejection
  reason; the worktree and its patch are preserved). No automatic
  merge/rebase/cherry-pick exists: every one of these runs only on an explicit
  human request, commits nothing and reports conflicts before touching a file.
- Any node of a tree may name the todo: the action resolves the worktree OWNER by
  walking from the requested node up to the root and taking the first node with a
  live record. A Watcher cycle keys the claimed LEAF, a manual Todo start keys the
  tree ROOT, and a tree that was closed as `done` without integration is still
  integrable. A `done` container whose children are all `done` is re-derived to
  `done` by `synchronizeTodoParentStatuses`, so `integration.state=ready` — not a
  forced `doing` — is what keeps the result awaiting a human decision.
- `GET /api/todos` carries a per-item `worktree` summary
  (`{ live, ownerTodoId, branch, worktreePath, baseCommit, executionState,
  integrationState }`) for every node of a tree that has a live worktree, so the
  Todo panel can offer integration from a subtask row.

## 9. Result persistence

### 9.1 First version: kept worktree + patch — SETTLED

The primary mechanism is:

- keep the worktree after execution (on PASS, failure, cancel and rejection);
- export a patch that includes tracked changes, deletions and **new/untracked
  files**;
- store the patch outside the worktree (in the logical workspace data root) and
  record its path, the base commit, the changed-file list, the test result and
  the review delegation in the worktree record;
- the patch is an artifact for human integration; generating it does not commit
  anything.

### 9.2 Local commits — OPEN (O5)

Whether local commits on the worktree branch are ever allowed is **OPEN (O5)**.
The parent analyses explicitly are **not** consent to automatic committing. If a
local-commit policy is later agreed, it must be: explicit, local only (no push),
recorded in the registry, and still never an automatic push/merge. Until that
policy exists, no local commit is made by the feature.

### 9.3 No automatic commit / push / merge — SETTLED

In every mode and every transition, the watcher, the orchestrator and the
delegated children must not run `git commit`, `git push`, `git merge`,
`git rebase`, `git cherry-pick`, `git reset --hard` or `git clean` as part of
the worktree flow. Integration is manual in the first version.

### 9.4 Integration result record — SETTLED (shape)

The record shown to the operator contains at least: branch, base commit,
worktree path, changed files, patch location, test/review evidence, the related
cycle id and chats, and the current `integrationState`. The exact schema is
`OPEN (O2)`.

## 10. Scope, authorization and test directory

### 10.1 Authorization — SETTLED

- Git reads and actions resolve `executionFolder` server-side from an authorized
  chat/TODO context. A client cannot pass an arbitrary path.
- The caller must be authorized for the logical workspace; the resolved folder
  must stay inside the registered worktree for that leaf (or the logical folder
  in `project` mode). Path traversal outside is rejected, reusing the existing
  realpath containment check.
- Changing the selected chat/workspace must re-resolve the context; no cached
  global cwd.

### 10.2 Mutating Git actions — OPEN (O11)

Whether the existing Git panel may expose mutating actions
(`switch`, `merge`, `rebase`, `push`) against a worktree by default is
**OPEN (O11)**. Settled: agent/automation callers never get commit/push/merge
through this feature, and a mutating action must never target another todo's
worktree.

### 10.3 Test directory — SETTLED

- Tests and review verification run with cwd = `executionFolder`, so
  implement/review/fix all see the same revision.
- Test artifacts and logs are written inside the worktree or a registered
  artifact path, never into the main workspace `data/`.
- The test/review result is recorded in the registry result record before the
  leaf can reach `integrationState = ready`.

### 10.4 Write locks and limits — SETTLED

- The shared-directory write lock and mutating-delegation content checks use
  `executionFolder`.
- Global limits (`maxParallel`, daily budget, harness allow-list, plan gate,
  snapshot/claims) stay keyed to `workspaceFolder`.

## 11. Protecting unaccepted changes — SETTLED

- No automatic force removal of a worktree or branch that may hold work that is
  not integrated or explicitly rejected-and-discarded.
- Automatic cleanup is allowed only when `integrationState = integrated` (or a
  human explicitly confirmed discarding a rejected result) **and** no active
  agent/delegation slot holds the leaf.
- On failure, cancellation, restart and preflight failure, the worktree is
  preserved.
- Any cleanup that discards changes requires an explicit human confirmation that
  names the affected worktree and branch.
- A missing worktree is reported; it is never silently recreated over an
  existing branch/directory.

## 12. Worked scenarios

These walk the contract through the two cases required by the leaf's
verification note. They are contract checks, not code tests.

### 12.1 Two independent TODOs, `maxParallel = 2`

Two leaves A and B with no dependency, policy `worktree`, `maxParallel = 2`.

1. Cycle 1 claims A (`ready → doing`), freezes mode `worktree`, records base
   `cA`, creates worktree `wA`, runs prepare, `executionState = active`.
2. Cycle 2 claims B, freezes base `cB`, creates `wB`, runs prepare, active.
3. A's implement/review/fix all run in `wA`; B's in `wB`. Their write locks are
   per execution folder, so they do not serialize against each other, but the
   logical workspace's `maxParallel` and daily budget still gate both.
4. A reaches review PASS: `wA` is kept, patch `pA` is written, cycle closes,
   claim released, A stays `doing` with `integrationState = ready`. A is not
   re-picked. B is unaffected (`parallel`/independent).
5. The human integrates A manually from `pA`/`wA`; A becomes `integrated` and
   `done`. `wA` becomes cleanup-eligible.
6. B's PASS follows the same path. Neither A nor B was committed, pushed or
   merged by the watcher.

Failure variant: B's prepare fails. B's claim is rolled back, B returns to
`ready` with a reason, no worktree is force-removed and nothing falls back to
`project`. A continues unaffected.

### 12.2 Sequential siblings

Parent with `runMode = sequential`, children S1 then S2, policy `worktree`.

1. S1 is claimed and executes in `wS1`.
2. S1 reaches review PASS: `integrationState = ready`, `status` stays `doing`.
3. S2 is evaluated for readiness: an earlier sibling (S1) is not `done`, so
   `isTodoNodeBlocked` keeps S2 blocked. The scheduler cannot select S2 and
   cannot re-select S1.
4. The human integrates S1 manually from `pS1`/`wS1`; S1 → `done`. Integration is
   patch-based and commits nothing (S14/S15), so the logical repository working
   tree is still dirty after this step.
5. Precondition before S2 can take its base: the logical repo must be clean per
   §5.2/S6. Because the manual integration left the tree dirty, S2 cannot start
   yet; the mechanism that makes the tree clean again is **OPEN (O5)** and is not
   decided here (the default reading is that a human commits the integrated S1
   result in the logical repository, but that is not settled). Only once §5.2/S6's
   clean-tree precondition holds is the tree re-read, S2 found unblocked, and S2
   started in its own worktree `wS2` created at its own base `cS2` (which then
   includes the integrated—and committed—S1 result).
6. Rejection variant: S1 is rejected. S1 → `ready` with a rejection reason and
   `wS1` preserved; S2 stays blocked because S1 is not `done`. A retry of S1
   reuses `wS1` and base `cS1`.

Restart variant: if the server restarts while S1 is `integrationState = ready`
and `doing`, reconciliation keeps S1 as `user_action` (not `recoverable`), so it
is neither auto-released to `ready` nor re-executed; S2 stays blocked.

## 13. Decision register

### 13.1 Settled decisions

| # | Decision |
| --- | --- |
| S1 | `workspaceFolder` stays the logical identity; `executionFolder` is the runner/test/Git context; child chats inherit both. |
| S2 | Default execution folder falls back to the logical workspace when no worktree record exists (compatibility). |
| S3 | Modes are `inherit/worktree/project`; the resolved value is `worktree`/`project`; policy default is `project` for compatibility. |
| S4 | The resolved mode, execution folder and base commit are frozen before execution and unchanged on retry; setting changes do not move an active leaf. |
| S5 | Base commit is a full SHA recorded before execution and never moved on retry/restart. |
| S6 | A dirty logical tree blocks `worktree` start by default; no silent stash/checkout; preflight failure rolls back the claim. The same clean-tree precondition gates the next sequential sibling after a patch-based integration; how the logical tree becomes clean is **OPEN (O5)**. |
| S7 | One worktree per leaf, shared by implement/review/fix, tracked in a durable registry. |
| S8 | Worktrees live outside the project directory (exact path OPEN). |
| S9 | Never adopt a worktree on name match alone; ownership must be registry-verified against Git. |
| S10 | Explicit prepare step; no automatic secret copying; no sharing/binding the main `data/`; no silent fallback to `project` on prepare failure. |
| S11 | Review PASS closes the execution cycle but does not set `done`; the leaf stays `doing` with `integrationState = ready` and is not re-pickable. |
| S12 | `done` is set only after confirmed integration; sequential siblings wait for confirmed integration; full `dependsOn` is out of scope. |
| S13 | Claim is released at terminal cycle close (including PASS); the integration-ready guard prevents re-pick and auto-release by recovery. |
| S14 | First-version result persistence is kept worktree + patch including new files; the patch is an artifact, not a commit. |
| S15 | No automatic commit, push, merge, rebase, cherry-pick, reset --hard or clean in the worktree flow. |
| S16 | On failure/cancellation/restart the worktree and changes are preserved; cleanup is explicit and gated on no active agents. |
| S17 | Git reads/actions resolve the execution folder server-side from an authorized chat/TODO context; no global cwd; containment checked. |
| S18 | Tests/review-verify run in `executionFolder`; artifacts do not pollute the main `data/`; results are recorded before integration readiness. |
| S19 | Write locks/material revision use `executionFolder`; limits/plan gate/claims stay on `workspaceFolder`. |
| S20 | Worktrees do not isolate ports or services (documented limitation). |

### 13.2 OPEN decisions

| # | Open question | Notes / candidate (not agreed) |
| --- | --- | --- |
| O1 | Does a per-TODO override inherit from ancestors, and how does `inherit` walk the tree? | Candidate: nearest ancestor override, else policy default. Watcher implementation must use leaf value + policy default until closed. **Manual starts** are settled separately (§4.3a): they use the ROOT override, else the policy default. |
| O2 | Is `integrationState` a stored field or derived, what is its exact name/schema, and does `project` mode need the same gate? | **Representation settled for v1 in §8.13**: todo field `integration.state` in `ready/integrated/rejected`; the todo stays `doing`, the durable result is a worktree-registry `results[cycleId]` record. `project` mode keeps today's behavior (`not_applicable`). Still open: whether the claim should be held from PASS to integration. |
| O3 | Exact worktree base path, per-workspace namespace, branch/directory naming schema. | Candidate: `<data-root>/worktrees/<workspace-key>/<todo-id>`. |
| O4 | Handling of existing/foreign branches, orphaned branches, and a registered worktree missing on disk. | Settled constraints: no force removal, no adoption on name, no silent recreation; the choice is open. |
| O5 | Are local commits ever allowed, and under what explicit policy? | Analyses are not consent; no commits until agreed. Also patch format/storage details. |
| O7 | Do plan-only cycles create a worktree eagerly or only once execution starts? | Affects the freeze guarantee and empty-worktree cleanup. |
| O8 | Who confirms integration and rejection, and does rejection auto-retry or wait for a human? | Default assumption: human, manual integration. Exact action open. |
| O9 | Retry/normalization after rejection or integration failure: reuse the old worktree/branch or start a fresh one? | Must not lose unaccepted work. |
| O10 | Exact race-safe CAS for worktree reservation/creation across concurrent starts and processes. | Must reuse watcher lock discipline. |
| O11 | Does the Git panel expose mutating actions on a worktree by default? | Agent/automation callers stay read-only regardless. |
| O12 | Registry storage format and location (side store vs fields on the todo). | Affects persistence/backup and restart reconciliation. |

## 14. Out of scope for this leaf

- implementation of the folder split, worktree manager, TODO mode UI or Git UI;
- a full cross-leaf `dependsOn` graph;
- automatic merge/cherry-pick/rebase integration;
- port/service isolation between worktrees;
- any change to the reviewed plan gate, claims or failure-ceiling semantics.
