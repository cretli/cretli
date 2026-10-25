---
name: cretli-orchestrator-contention-block
description: As the Cretli Workspace Watcher orchestrator (parent), when delegation_start returns CONFLICT/job_in_progress because a FOREIGN parent's mutating job holds the maxParallel=1 write slot — do not cancel it, do not busy-poll a job you don't own, and report outcome=blocked (which, unlike failure, does NOT increment maxConsecutiveFailures and so won't trip the ceiling); keep the todo doing, verify-tree + author the full verbatim brief anyway so the retry cycle is instant, and record a short-ttl blocker + long-ttl design-pattern in workspace memory.
source: auto-skill
extracted_at: '2026-10-05T11:55:31.718Z'
---

# Parent orchestrator: foreign job holds the write slot (CONFLICT → report blocked)

Trigger: you are the **Workspace Watcher orchestrator for exactly ONE cycle** (`cretli-ref todo=…`,
`cretli-multi-harness` `loop`). You have verified the todo, picked a model, and called
`delegation_start` for `assignment=implement` (or `fix`) — and it is refused because the single
workspace write slot is occupied by a **different chat's** in-flight mutating job.

Companions (do not duplicate them): **cretli-multi-harness** (the parent loop; note it only covers
`MODEL_UNAVAILABLE` / `review_uncertified` start errors, NOT this CONFLICT),
**cretli-orchestrator-stale-finding** (finding already fixed in the tree — assumes you *can* start a
child), **cretli-delegation-implement** / **cretli-delegation-review** (the child roles).

## Recognize the error
`delegation_start` returns (do not retry, do not "reverse-engineer"):
```
CONFLICT: Another parent already has a mutating job in this workspace.
Blocker delegation id: <uuid>. Blocker parent chat: <uuid>.
```
structured: `{ ok:false, code:"CONFLICT", reason:"job_in_progress", delegation_id, attempt_id }`.
This is `maxParallel=1` working as designed — it is a workspace-wide exclusive lock, not a per-chat
lock. It is a **transient external dependency**, NOT a failure of your task and NOT something your
todo body caused.

## Step 1 — identify the holder (read-only), then decide
- `chat_show({ chat:<blocker parent uuid>, scope:"all" })` — read what that parent is doing. In the
  observed cycle the holder was a human-driven Claude watcher that had delegated todo `a083fe13` to a
  **Grok child on `sdk`** (`fcdcb5be` / child `d4a05b59`), actively grepping/reading.
- `delegation_list({ chat_id:<parent uuid>, scope:"all" })` → shows `running <delegation-id> sdk/grok-…`.
  `running` = slot stays held. There is no way to bound its duration from here.
- **You cannot `delegation_wait` on it**: that tool only long-polls jobs owned by *your* chat. So do
  NOT busy-poll `chat_show` hoping it finishes inside your cycle — a watcher cycle is meant to be
  short-lived, and spinning wastes the run (and risks re-triggering the very slot-contention the
  holder may be fixing).

## Step 2 — report `blocked`, NOT `failure` (the load-bearing insight)
`watcher_report({ outcome:"blocked", cycle_id, report_id:<cycle_id>, todo_ids:[<your todo>],
summary:"cannot start implement — maxParallel=1 write slot held by foreign job <id> (<holder>, <what
it fixes>), status=running; did not cancel/edit tree; brief+anchors ready for retry when slot frees" })`
(or the equivalent `workspace_watcher_update` action `report`).

Why `blocked` and not `failure`: the failure counter `maxConsecutiveFailures` (observed =3) only
advances on `failure`. The observed todo already had `failures: 66818ace=2` from two earlier
**infra** `ECONNRESET` terminations; a third "failure" would have tripped the ceiling and halted the
watcher for this todo. After reporting `blocked` the snapshot showed `failures: -` (cleared) and
`3d020d01=blocked` — i.e. `blocked` is a non-punitive, honest terminal state. Use `failure` only for
a genuine quality/loop stop; use `blocked` for an external prerequisite you correctly refused to work
around.

## Hard DON'Ts while a foreign job holds the slot
- Do NOT cancel or interrupt another parent's job.
- Do NOT "start a second implement on a free harness" — the lock is workspace-wide, not per-harness.
- Do NOT edit the tree yourself to "make progress" — you would race a concurrent implementer's
  writes (and my instructions forbid editing while a job is in flight). There is often genuinely
  nothing safe to do this cycle except wait or report blocked.
- Never overwrite a todo that is `doing`/`done` outside this cycle. Keep your todo `doing` (honest:
  claimed, in progress, externally blocked) — do NOT mark it done (no code, no review). A `status`
  change on `todo_update` appends the changelog note, so don't call it just to leave a note.

## Step 3 — still do the prep so the retry cycle is one turn, not a re-diagnosis
Before you discovered the CONFLICT you should have (this cycle did):
- Verified every cited symbol against the CURRENT dirty tree (`grep`/`read_file`) — prior cycles'
  line numbers drift, and the branch has concurrent human edits.
- Authored the full **verbatim, per-clause** implement brief (see the `orchestrator-brief-paraphrasing`
  memory: copy each named call-site/guard as its own numbered item) + any key design constraint (e.g.
  a node-importable leaf-module requirement because a view file pulls the whole browser graph).
- Captured `material_revision` = `git rev-parse --short HEAD` + `git status --porcelain | git hash-object --stdin`.
Then record so the next cycle doesn't rediscover:
- `workspace_memory_add({ type:"blocker", key:"todo-<id>-blocked-on-foreign-write-slot", ttl_ms:10800000 (≈3h), value:"<blocker id/model/parent/what it fixes> + rule: do not cancel; when slot free re-run model_pick role=implement and delegate the verbatim brief" })`
- `workspace_memory_add({ type:"pattern", key:"<reusable design insight>", ttl_ms:2592000000 (≈30d), value:"…" })` for the durable, non-obvious constraint you verified.

## Self-healing note
The observed holder was itself fixing the slot-contention bug (`a083fe13`: a prior orchestrator kept
getting re-woken by leftover child mailbox replies after it reported, so it was counted as an external
active agent at `maxParallel=1`). Such a block clears itself once that fix lands — honor the watcher's
`wait_cooldown` / `wait_active/max_parallel` guardrail and let it re-claim the todo on a later tick;
never spawn a cycle yourself.

## End state
`watcher_report ok` → STOP. One cycle = exactly this run. Never commit/push/merge; never start
another cycle; the watcher starts the next one (and should immediately be able to delegate your
already-authored brief once the slot frees).
