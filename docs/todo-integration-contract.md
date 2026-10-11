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
  cherry-pick or deployment.

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
