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

The `buildConversationForkPrompt`, `buildHarnessHandoffPrompt` and
`buildForkInitialPrompt` rows were re-measured after the 4608f545 history-pointer
change: `After` uses `historyPointer: true` (persisted source) and `Before` is the
retained inline fallback. That run moved the shared decoration baseline by +608
bytes, so only those three `Decorated` values come from the newer run.

| Builder | Before | After | Decorated before | Decorated after | Decision / derivable block |
| --- | ---: | ---: | ---: | ---: | --- |
| `buildSmartMergeRequest` | 3602 | 2830 | 11801 | 11029 | Changed: verified patch → scope sidecar; fixed prompt size. |
| `buildVerifyIntegrationRequest` | 2844 | 2593 | — | — | Fixture with 3 linked chat IDs and a worktree checkpoint: remove 706 bytes of step-2 text and add a 455-byte hints block. Search tools and verify-first guard remain; manual tool-call observation not run in this code session. |
| `buildGitBranchMergePrompt` | 2623 | 1623 | 10822 | 9822 | Changed: informational paths → git diff --stat instruction. |
| `buildMailboxDeliveryPrompt` | 3966 | 1171 | 12165 | 9370 | Changed: matching current final report + saved assignment → MCP pointers. |
| `buildWorkspaceWatcherCyclePrompt` | 5485 | 5485 | 18030 | 18030 | No change: already points to watcher/todo snapshots; bounded memory/history and policy guards. |
| `buildWorkspaceWatcherCyclePromptPlan` | 3555 | 3555 | 16100 | 16100 | No change: same builder in plan-only mode; approval and delegation contracts retained. |
| `buildWorkspaceMemoryPromptBlock` | 159 | 159 | 8358 | 8358 | No change: bounded, ordered prior decisions are selected context, not raw repo data. |
| `buildScoutPrompt` | 14482 | 5766 | 23289 | 14573 | Changed: diff/log/markers/todos/memory behind scoped git/MCP pointers. |
| `buildScoutPromptForProfile` | 15985 | 7099 | 24792 | 15906 | Changed: diff/log/markers/todos/memory behind scoped git/MCP pointers. |
| `buildConversationForkPrompt` | 3297 | 1203 | 12104 | 10010 | Changed: persisted source → compact MCP history pointer (source id/title, cutoff, guards); inline transcript fallback retained. |
| `buildHarnessHandoffPrompt` | 3497 | 1369 | 12304 | 10176 | Changed: same pointer with harness labels; partial fork bounded by `before_seq: cutoff + 1`. |
| `buildAgentAnalysisPrompt` | 401 | 401 | 8600 | 8600 | No change: already uses source chat pointer; user-provided status/message stays inline. |
| `buildForkInitialPrompt` | 3526 | 1398 | 12333 | 10205 | Changed: dispatch routes fork/handoff to the pointer path; analyze branch stays transcript-free. |
| `buildTodoAgentInitialPrompt` | 3919 | 1584 | 12726 | 10391 | Changed: body/plan/previous-chat copies → paginated `todo_show` pointers; todo/chat ids, `cretli-ref`, approval gate, sequential workflow, status transitions, update contract and MCP-unavailable fallback pointer retained. |
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

Retention: the sidecar has the same lifetime as the patch it describes. No
dedicated cleanup exists; it is removed together with the patch directory.

Missing/unreadable/mismatched patch, failed parsing, or failed sidecar write
selects a documented best-effort fallback: read `git diff --name-status -z -M
<base>` and `git ls-files --others --exclude-standard` in the worktree. Stop and
report if the worktree is gone. The result record/hash and `changedFiles` are
unchanged. Fallback cannot recover an unavailable original patch snapshot.

## Scout pointer contract

Both Scout prompt builders no longer inline the derivable repository snapshot
(`git diff`, `git log`, TODO/FIXME/HACK markers, the todo list and Workspace
Memory). They emit compact trusted host pointers that the Scout resolves with a
live read, so a bigger diff/log/list does not grow the prompt at all.

- Pointer lines are trusted host text; the host never wraps them in the
  `<<<UNTRUSTED_SIGNAL_DATA>>>` block. Only the remaining host-only signals
  (`failingTests`, `errorLogs`, `priorFindings`, `changedFiles`) stay wrapped.
- Scope preservation: each git pointer carries the pathspec from
  `buildScoutGitPathspecArgs(scope)`. A pointer is emitted only when the profile
  `sources` allow that signal (an absent `sources` means all sources, matching
  `collectScoutSignalsForProfile`). When the pathspec is empty — scope absent
  (e.g. this audit fixture) or a scope with no include/exclude — the pointer
  restricts reads to the inline in-scope file list instead of emitting a bare
  git command, so a pointer can never reveal out-of-scope changes.
- The live workspace tree and the canonical MCP stores (`todo_list`,
  `wmem_list`) are the source of truth; the inline snapshot only scopes the
  scan.
- Fallback: when a pointer cannot be read (no git, empty resolved base, MCP tool
  unavailable), read the inline in-scope files directly and never scan outside
  the configured include/exclude. The "scope matched no files" branch still
  blocks a whole-repository scan.

`collectScoutSignalsForProfile` and `buildScoutSignalsBlock` keep their shape
and remain the full snapshot/consumer API; the preview UI, dedupe and runner
still read all signals.

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
