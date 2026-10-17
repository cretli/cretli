# TODO Integration Evidence Contract

Status: implementation contract. This document separates programming progress,
review and evidence that task changes are present in a target branch. It extends
the worktree integration flow; it does not create a second stored task status.

Related contract: [TODO Worktree Execution Contract](todo-worktree-contract.md).

## 1. Stored state and read labels

`status` remains `idea | ready | doing | done`. The existing
`integration.state` remains `ready | integrated | rejected`. The UI and APIs
derive an integration summary from those fields and the evidence object; there
is no persisted `integrationStatus` field. A missing integration object means
there is no integration evidence, including on legacy `project` todos.

The summary labels are:

| Stored state / evidence | Summary label | Detail |
| --- | --- | --- |
| Missing or invalid evidence, any TODO status | Unconfirmed | No current target-branch proof. `done` and review PASS do not change this. |
| `ready`, no valid target proof | Awaiting integration | A worktree result is ready for a human decision. |
| `ready` plus `appliedAt`, no valid target proof | Awaiting integration | Applied to the working directory at `appliedAt`; this is not a target-branch commit. |
| `integrated` with current target proof | Integrated | Show target branch, target commit, confirmation time and source. |
| `integrated` without target proof (legacy) | Unconfirmed | Show “Previously confirmed manually; target branch evidence unavailable”. Preserve the stored state for compatibility; do not backfill. |
| `rejected` | Unconfirmed | Preserve “Rejected”, reason and source result details. Rejection is not integration. |
| Conflict marker or failed apply | Unconfirmed | Preserve “Conflict”, affected paths and failure detail. |
| Explicit `done` + `changeScope=none` record tied to current material | Unconfirmed | Show “No code changes” and the human reason; this leaf is excluded from the parent's required code-change count. |

For `idea`, `ready` and `doing`, an absent integration field never suggests
that programming is complete. Review remains an independent read model and is
never converted into integration evidence.

## 2. Evidence schema and target verification

The existing `integration` object may carry `evidence` with bounded fields:

| Field | Meaning |
| --- | --- |
| `targetBranch` | Explicit branch selected as the integration destination. |
| `targetCommit` | Full commit SHA observed at confirmation. |
| `sourceCommit` | Commit containing the task result before integration, when available. |
| `materialRevision` | Revision/fingerprint of the task material being confirmed. |
| `cycleId` | Execution cycle or generation associated with that material, when available. |
| `source` | Confirmation source, such as `human_project`, `human_worktree`, or `human_legacy`. |
| `confirmedAt` | Timestamp of the explicit confirmation. |
| `confirmedBy` | Authenticated actor identifier, when available. |
| `changeRef` | Human supplied reference that ties the destination changes to this TODO and its material. |
| `verification` | Method and result of checking the target commit against the named branch. |

`targetBranch` and `targetCommit` are distinct from `integration.branch`, which
continues to identify a worktree's source branch. A valid proof is bound to the
TODO id, current execution/material generation, target branch, target commit,
and `changeRef`. The `changeRef` must identify the task's actual change material
(for example, an execution result/patch fingerprint or source commit) and the
operator must explicitly attest that the target commit contains that material.
The server verifies that the full target commit exists and is reachable from the
named target branch at confirmation time. An ancestry check alone, a file list,
a clean Git tree, `done`, or review PASS is not a task-to-change link and cannot
create proof.

This supports ordinary merge, squash and cherry-pick: the operator links the
task material to the resulting destination commit even when commit identities
differ. The attestation is explicit because Git cannot infer semantic
equivalence for arbitrary task changes. If a later commit reverts the task
changes, the evidence must be invalidated or explicitly marked reverted; a
historical target commit being an ancestor is not sufficient to claim the
changes remain present.

The `project` mode uses the same proof without requiring a synthetic merge. It
requires an explicit task-material reference and verified target branch/commit.
The `worktree` mode can use its frozen result (`cycleId`, material revision and
patch fingerprint) as the task-material reference. `appliedAt` only records
working-directory application and is never target proof.

### One-click confirmation

The UI action "Record target evidence" sends `proof: { simple: true }`. The
server then derives the proof itself: `targetBranch` is the workspace's current
local branch, `targetCommit` and `sourceCommit` are its `HEAD`, the material
revision is the stored one (or `HEAD`), and the click is the explicit
attestation. The derived proof goes through the same strict verification as a
typed one, so a detached `HEAD` is refused (`target_ref_missing`). The scope is
`tree` when the node has children, otherwise `task`. The explicit fields
(`targetBranch`, `targetCommit`, `changeRef`, ...) remain available through the
REST/MCP API for merge or cherry-pick flows where the destination differs from
the current branch.

### MCP

The `todo_integration` MCP tool exposes the evidence-only actions `confirm`
(same `proof` fields as REST, including `simple`), `invalidate`, `no_code` and
`reject`. It never prepares, applies or merges a worktree. `confirm` is the same
explicit human attestation as in the UI, so an agent may call it only when the
operator asked for it and the change was verified in the target branch.

## 3. Freshness and transitions

Evidence is current only while its task material/generation and target identity
match the current integration record. A new implementation cycle, changed
material revision, changed target branch or explicit revert invalidates current
confirmation. A title-only edit, unrelated TODO metadata change or unrelated
later branch commit does not. CAS on the TODO revision protects confirmation
from races; callers must refresh on conflict.

Transitions preserve current behavior unless explicitly extended here:

- Prepare keeps `integration.state=ready`; it does not confirm target presence.
- Apply records `appliedAt` and working-directory application only.
- Confirming a target proof stores evidence and sets `integration.state=integrated`.
- Reject stores the rejection and reason, preserves worktree changes, and does
  not create proof.
- `action=invalidate` removes current proof after an explicit report that a
  later target commit reverted the task changes; it keeps the historical
  integration state and reason while the derived summary returns to unconfirmed.
- `action=no-code` records a human reason on a `done` TODO when the task produced
  no code changes. This classification is tied to the current material
  fingerprint, is displayed as an unconfirmed no-code detail, and excludes that
  leaf from the parent's required code-change denominator. A new material
  revision makes the classification stale.
- `patch_invalid` and `integration_conflict` remain visible failure details and
  never create proof.
- No watcher or agent performs an automatic commit, push, merge, rebase,
  cherry-pick or deployment. Two user-started chats are the exception: the
  git-level worktree merge, and **Integrate with workspace (agent)**, which
  commits only the listed task paths and then confirms proof. Neither pushes.

## 4. Tree aggregation

Each node reports its own proof independently. A parent/container is:

| Descendant evidence | Parent summary |
| --- | --- |
| Current proof explicitly covers the whole tree for one target | Integrated |
| Every required code-changing leaf has current proof for the same target | Integrated |
| Some required leaves have proof and others do not | Partially integrated (`confirmed/required`) |
| No required leaf has proof | Unconfirmed or awaiting integration if a result is ready |
| Any required leaf is rejected or conflicted | Preserve that condition in details and counts; do not hide it behind a full-integrated label |

Leaves explicitly marked by a human as requiring no code change are excluded
from the required code-change denominator but remain counted in tree details;
the mark is tied to the current material fingerprint and requires a reason.
`done` children do not prove their parent's integration. Proof for one destination
does not aggregate with proof for another destination. Sequential sibling
blocking continues to use the existing TODO status contract and is not changed
by this read aggregation.

## 5. API and UI read model

REST Todo lists, cards, filters and MCP `todo_list`/`todo_show` consume the same
server-computed integration summary, including project-mode todos. The UI shows
execution status, review state and integration summary separately. The filter
offers All, Unconfirmed, Awaiting integration and Integrated, and its search
surface keeps partial, rejected and conflict records discoverable.

The worktree execution, recovery, watcher claim, and sequential dependency
guards in [todo-worktree-contract.md](todo-worktree-contract.md) remain binding.

## 6. Bulk integrate (`lib/integrate-batch.js`)

One agent chat integrates several todos strictly one after another, each on top
of the already integrated HEAD. The server owns the queue (store:
`data/integrate-batches.json`, batches plus one lock record per workspace).
Nothing in a batch pushes, commits on the server's behalf, kills a run or
discards worktree changes.

### Eligibility

`resolveBatchEntry` is the single resolver for create, dispatch and the
read-only `batchEligibility { mode, reason }` field of every todo in the list
payload. Any node resolves to the nearest ancestor owning a live worktree
(`readIntegrationTarget`); duplicates and parent/child selections of one target
collapse to the first entry (`aliased:<targetId>`).

| mode | condition |
| --- | --- |
| `smart-merge` | live worktree, target awaiting integration, not `smart_merge_running` |
| `verify` | `done`, no live worktree, not integrated / no-code |
| `none` | reason: `not_found`, `not_eligible`, `already_integrated`, `busy`, `locked` |

The order is the order the client sent; the server validates and dedupes but
never reorders. A todo that changed since the click is skipped at dispatch.

### Entry states and the outcome protocol

`queued | running | awaiting_confirmation | merged | verified | failed |
skipped | cancelled`. At most one entry is open. The entry's real prompt is built
by the existing smart-merge / verify builders only when it is that entry's turn.

`POST /api/integrate-batch/next` (public path, capability secret in the body):
without `entryId` it returns the current or next entry; with `{ entryId,
attempt, outcome }` it reports the entry and returns the following one. Answers
carry an `action`: `entry`, `pending_confirm`, `resolved` (idempotent replay of a
finished entry, no advance) or `stop` (`cancelled | paused | completed`).

- A report of `merged | verified | no_code` is accepted only when the target todo
  reads confirmed (`integrated` or `no_code_changes`); `rejected` never counts.
  Otherwise the answer is `pending_confirm`; the third consecutive one fails the
  entry as `unconfirmed`.
- Smart-merge entries follow `fenced legacy report -> confirm -> next`; verify
  entries follow `confirm or no-code -> next` and have no legacy report. The
  legacy `smart-merge-report-from-agent` call never advances the batch; a valid
  `merged` only moves the entry to `awaiting_confirmation`.
- No-code guard: `no_code` is accepted for a verify entry, or a smart-merge entry
  whose prepared result has no changed files; otherwise the entry fails as
  `no_code_with_changes`. The guard classifies after the fact: the stored
  `no_code_changes` state is not rewritten and is left for the human.

### Capability and trust model

Per epoch the server generates a random secret and stores only its hash; the
secret is in the wrapper prompt. `next` validates it even for loopback callers
(401); an old epoch answers 409 `stale_epoch`. The per-entry callback of a
smart-merge entry additionally carries `{ batchId, entryId, attempt, epoch,
token }`; a legacy report for a todo of an open entry without matching context,
or from an old attempt/epoch, is rejected with 409 `batch_context_invalid` and
changes nothing, including the heartbeat. Confirmation is an agent attestation
recorded against the current HEAD and no-code is not git-checked; the batch
trusts them exactly as the single flow does. Both are lock-guarded like the other
writers (see Workspace lock): only the batch chat that owns the lock may confirm
or record no-code through MCP. Only a recorded liveness override
can leave an old agent running; the entry is then flagged `override`.

### Workspace lock

One record per workspace `{ owner: 'batch' | 'single', batchId?, todoId, chatId,
since }`. Taken by batch create and by single smart-merge / verify / git-branch
merge; refused with 409 `integration_locked` at `POST /api/todos/:id/smart-merge`,
`.../verify-integration`, `.../integration` (prepare, merge, apply),
`POST /api/worktrees/:todoId/merge|reject|cleanup`. The Watcher cycle close is
deliberately not gated (it only writes worktree records and patches). A `single`
lock is released by a failed lib report / confirm / no-code / reject /
invalidate, lazily when its chat is confirmed idle (after a 60 s grace), or by
`POST /api/integration-lock/clear`; a `batch` lock only by a terminal batch
state. A `merged` report keeps the lock: the confirm that follows releases it,
so another flow (e.g. a batch) cannot start in the window between the report and
the attestation.

#### Confirm and no-code writers

`confirm` and `no-code` write integration evidence only (never the working tree)
but are serialised by the same lock as the other writers:
`confirmWorkspaceTodoIntegration` and `markTodoIntegrationNoCode` call
`refuseWhenIntegrationLockedForWriter` first and answer
`{ ok: false, reason: 'integration_locked', lock }` like reject / invalidate.
Allowed writers are the todo owning a `single` lock (or the todo its tree
resolves to) and the chat bound to a `batch` lock, i.e. the batch agent that the
MCP call identifies as `callerChatId`; a caller with no chat id is refused while
a batch owns the lock. With no lock nothing is refused.

The human UI attestation is the one exemption: the REST route
`POST /api/todos/:id/integration` passes `humanAttested: true` for `confirm` and
`no-code` only (not for reject / invalidate), so the operator's click keeps
working while an agent flow owns the lock. The MCP path
(`recordTodoIntegration`) never sets it, so a non-owning agent is refused
instead of silently writing evidence.

### Liveness, recovery and boundary

`stalled` needs a stale heartbeat AND positive idle evidence from
`probeChatRunLiveness` (`known && !busy`); every other result, including a
restart, is unknown and keeps the lock. Resume and abandon need idle evidence or
`forceLiveness`, which is recorded on the batch. Resume rotates the epoch first,
clears the running marker, re-reads the open entry (already confirmed -> done,
else re-queued) and returns a new wrapper prompt for a new chat. Cancel ends the
queue; a running entry keeps the lock until it reports or the batch is abandoned.

After a failed or unconfirmed entry the batch continues only from a safe
boundary (`lib/integrate-batch-boundary.js`): nothing unmerged, no merge /
rebase / cherry-pick / revert in progress, and the dirty-path fingerprint map
equal to the snapshot taken at dispatch. Otherwise the batch is `paused`; resume
re-checks and takes `entryAction: retry | skip`. Sequential siblings of a failed
entry are skipped `blocked_by:<entryId>`.

### Bulk integrate: fix-round additions

- **Structural boundary everywhere.** Before any entry is built — batch create,
  every dispatch (including the first) and every resume from `paused`,
  `stalled` or a forced `running` takeover — the workspace must have no
  unmerged paths and no merge / rebase / cherry-pick / revert in progress.
  Create and resume answer `boundary_unsafe`; a dispatch pauses the batch with
  `pausedReason: boundary_unsafe:<reasons>`. Dirty-path drift is additionally
  compared only for a batch paused after a failed entry.
- **`single` lock lifetime.** Released by a failed report, confirm, no-code,
  reject, invalidate, a failed chat start (together with the `smart_merge_running`
  marker) and confirmed-idle evidence. A `merged` report keeps the lock until the
  confirm releases it. A `single` lock that never got a chat is
  reclaimable after 10 minutes. A lock whose chat liveness is unknown (e.g.
  after a restart) or busy never expires: only positive idle evidence or the
  explicit clear frees it.
- **Gated actions.** `reject`, `invalidate`, `confirm` and `no-code` on
  `/api/todos/:id/integration` answer 409 `integration_locked` while another
  flow owns the lock; the todo that owns a `single` lock may still use them
  (which releases it). The human REST `confirm` / `no-code` attestation is
  exempt. The watcher cycle close is not gated (see below).
- **Resume.** The agent chat is created before the epoch rotates; a chat that
  cannot be created answers `chat_unavailable` and leaves the batch unchanged.
  A repeated report of a settled entry answers `action: "resolved"` (documented
  in the wrapper prompt). A verify entry reporting `no_code` fails with
  `no_code_not_recorded` unless the no-code review was recorded.

### Lock handling at the edges (bulk integrate)

- The watcher cycle close is never gated by the lock: a cycle that closes as success
  while a batch or single flow holds the lock still prepares / records its worktree
  result and marks the todo ready for integration (it only writes worktree records and
  patches, never the main workspace). The integration itself stays serialised by the lock.
- `reject` / `invalidate` / `confirm` / `no-code` are guarded in library code
  (`refuseWhenIntegrationLockedForWriter`), so REST and MCP share the check.
  Allowed writers: the todo owning a `single` lock and the chat bound to the
  `batch` lock (the batch agent). The REST `confirm` / `no-code` human
  attestation is exempt (`humanAttested: true`); the MCP path never sets it.
