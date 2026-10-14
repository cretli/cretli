# Automatic-action prompt audit

Measured on 2026-10-14 against baseline `df2b920891f663c627090b9707ecd5127099eee2`.
All sizes are UTF-8 bytes, not token estimates. Reproduce with
`node scripts/audit-automatic-prompts.mjs`.

The fixture has 60 changed ASCII paths (`src/file-00.txt` … `src/file-59.txt`),
a 60-line final report, a saved plan and one memory entry. Decoration uses a
fresh Codex Agent room in an isolated temporary workspace with the installed
shared catalog/rules; no session deduplication. Decoration sizes depend on that
catalog/configuration. Memory and chat-plan rows measure the block as a standalone
input to the same decorator, so those are diagnostic sizes, not an additional
production chat start. Plan-only uses the watcher builder's plan-gate variant.

| Builder | Before | After | Decorated before | Decorated after | Decision / derivable block |
| --- | ---: | ---: | ---: | ---: | --- |
| `buildSmartMergeRequest` | 3602 | 2830 | 11801 | 11029 | Changed: verified patch → scope sidecar; fixed prompt size. |
| `buildVerifyIntegrationRequest` | 2844 | 2771 | 11043 | 10970 | Changed: repeated autonomy wording trimmed; all guards retained. |
| `buildGitBranchMergePrompt` | 2623 | 1623 | 10822 | 9822 | Changed: informational paths → git diff --stat instruction. |
| `buildMailboxDeliveryPrompt` | 3966 | 1171 | 12165 | 9370 | Changed: matching current final report + saved assignment → MCP pointers. |
| `buildWorkspaceWatcherCyclePrompt` | 5485 | 5485 | 18030 | 18030 | No change: already points to watcher/todo snapshots; bounded memory/history and policy guards. |
| `buildWorkspaceWatcherCyclePromptPlan` | 3555 | 3555 | 16100 | 16100 | No change: same builder in plan-only mode; approval and delegation contracts retained. |
| `buildWorkspaceMemoryPromptBlock` | 159 | 159 | 8358 | 8358 | No change: bounded, ordered prior decisions are selected context, not raw repo data. |
| `buildScoutPrompt` | 14482 | 14482 | 22681 | 22681 | Follow-up d488034f: diff/log/markers, todo/memory lists derivable; cross-consumer scope work exceeds 150 lines. |
| `buildScoutPromptForProfile` | 15985 | 15985 | 24184 | 24184 | Follow-up d488034f: same signals plus matched paths; preserve configured authorization scope. |
| `buildConversationForkPrompt` | 3297 | 3297 | 11496 | 11496 | Follow-up 4608f545: saved transcript derivable; preserve fork cutoff and unavailable-history fallback. |
| `buildHarnessHandoffPrompt` | 3497 | 3497 | 11696 | 11696 | Follow-up 4608f545: same transcript with continuation and harness parameters. |
| `buildAgentAnalysisPrompt` | 401 | 401 | 8600 | 8600 | No change: already uses source chat pointer; user-provided status/message stays inline. |
| `buildForkInitialPrompt` | 3526 | 3526 | 11725 | 11725 | Follow-up 4608f545: dispatch shares fork/handoff contract; analysis variant already small. |
| `buildTodoAgentInitialPrompt` | 3919 | 3919 | 12118 | 12118 | Follow-up 9179bf1f: body/plan/previous chats derivable via todo_show; retain workflow/callback. |
| `buildApprovedPlanImplementPrompt` | 129 | 129 | 8328 | 8328 | No change: already a plan-file pointer. |
| `buildChatPlanPromptContext` | 1309 | 1309 | 9508 | 9508 | No change here: plan text duplicates a readable file; generic decoration belongs to 20a8d8ed. |

Follow-up todo references:

- Scout: `cretli-ref todo=d488034f-635d-4825-826d-aa538553bae5`
- Fork/handoff: `cretli-ref todo=4608f545-d8c5-4db5-a9f7-25f3000c5434`
- Todo executor: `cretli-ref todo=9179bf1f-fadc-4c6e-b4d0-950c51894881`
- Existing decoration/refine task: `cretli-ref todo=20a8d8ed-2641-4b45-9e4b-a14f339116ee`

The Smart merge regression test compares prompts with identical parameters and
1 versus 60 files: they are byte-for-byte identical. Conflict hints are capped
at 50 entries; the complete conflict list is in the sidecar. If the patch is
unavailable, a conflict-only sidecar has `scopeUnavailable: true`, null hash and
empty files; it does not authorize paths. An unwritable sidecar falls back to
worktree inspection.

## Patch scope contract

`<patchPath>.files.json` is an atomically replaced derived artifact, not a new
worktree-result field. It contains `patchSha256`, `files` and `conflicts`.
Each file has `path`, optional `oldPath`, `status` (`A/M/D/R/C`), optional target
`mode`, and `binary`. Both rename/copy paths authorize staging, but only changed
paths may be committed. The patch is read once and must match the recorded
SHA-256 before parsing. Extended Git headers are authoritative; C-style quoting
is decoded as UTF-8 bytes. `git apply --numstat -z` cross-checks entry counts and
size-field format, never supplies the path scope.

Missing/unreadable/mismatched patch, failed parsing, or failed sidecar write
selects a documented best-effort fallback: read `git diff --name-status -z -M
<base>` and `git ls-files --others --exclude-standard` in the worktree. Stop and
report if the worktree is gone. The result record/hash and `changedFiles` are
unchanged. Fallback cannot recover an unavailable original patch snapshot.

## Mailbox contract

Only a `final_report` reply with a mailbox id, delegation id, current attempt id
and a non-empty stored report whose SHA-256 matches the trimmed mailbox body
uses a report pointer. Read every `next_cursor` page; the final VERDICT may be
on the last page. A retry between delivery and read is handled by comparing the
returned attempt id. Empty report/different attempt means read the immutable
mailbox body via `delegation_inbox({ id })`. A pagination CONFLICT restarts once,
then falls back to that inbox message. Progress, questions, missing delegation,
older attempts, empty reports and synthetic bodies stay inline. Saved message
assignments use their stored chat/seq pointer; plan and task-text assignments
stay inline. Reply/ack/VERDICT handling is unchanged.

## Manual merge evidence

Run on 2026-10-14 with `node scripts/manual-smart-merge-fixture.mjs` in disposable
Git repositories. The fixture includes a checkpoint commit, an uncommitted
modification, rename, copy, delete, binary, untracked and empty new files,
mode-only change, symlink, space/non-ASCII/tab/quote names and an ambiguous
unquoted ` b/` path. The hand-written expected set is cross-checked with Git's
NUL-separated `--name-status -M` output plus untracked paths; `-C
--find-copies-harder` independently adds the copy source.

The generated prompt and scope file were read, and the task changes were merged
by explicit file resolution. All 16 authorized paths were accounted for;
14 staged names were reported by Git (the rename is reported by its destination;
the unchanged copy source remains authorized but unstaged). `modify.txt` retained
both its local user line and task line; `unrelated.txt` stayed uncommitted. File contents,
symlink target and executable mode matched the source. A real HTTP POST using
curl went to an isolated callback handler calling production
`reportSmartMergeOutcome`: it recorded applied state while status stayed doing.
Only afterwards did a fresh revision + branch ancestry check and
`confirmWorkspaceTodoIntegration` set the fixture todo to done. No live project
todo was used for this fixture callback.

## Validation

52 focused tests passed across scope, merge/integration, mailbox, reply fencing,
report integrity, parent reply loop, acknowledgement and simple-proof suites.
ESLint on all changed JavaScript files and `git diff --check` passed. The manual
fixture and size audit were rerun after the final changes. The project changes
were reverified during integration and committed in the main workspace; the
fixture commits occurred only in temporary repositories.
