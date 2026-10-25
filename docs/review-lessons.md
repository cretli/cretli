# Review lessons

Learn from review findings to shorten implement/review loops: measure the loop,
record structured findings, distil recurring ones into per-workspace lessons and
show the active ones to the agents that can act on them.

## Overview

1. **Measure** (`lib/review-round-resolution.js`, `lib/review-loop-stats.js`,
   `GET /api/review-loop-stats`): round and first-pass metrics. See
   Definitions and Baseline below.
2. **Record** (`CRETLI_REVIEW_FINDINGS_BLOCK`): reviewers emit a machine-readable
   findings block; a server ledger tracks each finding to an outcome
   (`fixed`, `rejected`, `out_of_scope`, ...). The orchestrator records
   rejections with `workflow_update rejected_findings`.
3. **Distil** (`lib/review-lessons-distill.js`): recurring findings become
   `candidate` lessons. Nothing is injected from a candidate.
4. **Promote** (human `lesson_update` or the Settings UI): a candidate becomes
   `active`.
5. **Inject** (`CRETLI_REVIEW_LESSONS`): implement/fix prompts get
   `[KNOWN REVIEW LESSONS]`, plan reviewers `[KNOWN PLANNING LESSONS]`, audit
   reviewers `[KNOWN FALSE POSITIVES]`.
6. **Learn** (`lib/review-lessons-feedback.js`): after each resolved round the
   injected lessons get recurrence counters; ineffective or stale ones are
   demoted or retired.

Orchestrator guidance (reject findings with a reason, OUT_OF_SCOPE vs false
positive, read `LESSONS CHECKED`, lessons are never acceptance criteria) lives
in `TODO_EXECUTION_WORKFLOW` (`lib/todo-execution-prompt.js`) and
`.agents/skills/cretli-multi-harness/references/loop-protocol.md`.

## Safety invariants

- **No auto-promotion.** Distillation, effectiveness feedback and check
  proposals only create `candidate` lessons or move lessons *down*
  (`active -> candidate`, `-> retired`). Only a human (`lesson_update`, REST,
  UI, or `activate: true` on add) makes a lesson `active`. A retired lesson
  never changes automatically.
- **Suppress guards.** A `suppress` lesson needs ledger evidence of a rejected
  `false_positive`; it cannot use the `security` category, cannot cite a P1
  finding, and never comes from `out_of_scope`, `wont_fix` or `duplicate`
  rejections. The prompt builder drops security lessons and tells the reviewer
  that P1/security findings are never suppressed. A suppression whose pattern
  later turns out real is demoted to `candidate` (`suppressed_real_issue`).
- **Privacy scrubbing.** One classifier (`lib/review-lessons-privacy.js`) rejects
  home-rooted paths, UNC shares and private LAN addresses in lesson text, globs
  and check hints, and redacts them in distilled candidates and finding notes.
- **Workspace scoping.** Lessons, ledger and routes are keyed by workspace
  folder; a chat can only read or write the workspace it belongs to (403
  `OUT_OF_SCOPE` otherwise). Data lives in gitignored `data/`.
- **Flag-off / no-lessons byte-identical.** With the flag off for an audience,
  or with no matching active lesson, every prompt is byte-identical to the
  pre-feature prompt. The default-on implementer flag therefore changes nothing
  for a workspace without active lessons.
- **Prose stays authoritative.** The findings block and ledger are metadata; the
  verdict, findings hash and `same_findings` come from the report text.
- **Lessons are hints.** They are never acceptance criteria and never gate a
  verdict.

## Environment flags

| Flag | Default | Effect |
| --- | --- | --- |
| `CRETLI_REVIEW_FINDINGS_BLOCK` | on | `0`/`false`/`off`: no findings block in review prompts and no ledger |
| `CRETLI_REVIEW_LESSONS` | unset | Master switch. `0`/`false`/`off` disables lesson injection for every audience; `1`/`true`/`on` enables every audience (including planner and reviewer); unset applies the per-audience defaults below |
| `CRETLI_REVIEW_LESSONS_IMPLEMENT` | on (rollout default) | Implement/fix `do`/`avoid` lessons; `0`/`off` turns it off individually |
| `CRETLI_REVIEW_LESSONS_PLAN` | off (opt-in) | Plan reviewer lessons; `1` enables it individually. Rolled out after the implementer audience |
| `CRETLI_REVIEW_LESSONS_REVIEW` | off (opt-in) | Reviewer `suppress` (false-positive) block; stays off pending the 2026-10-30 evaluation re-check; `1` enables it individually |
| `CRETLI_REVIEW_LESSONS_RETIRE_MIN_INJECTIONS` | 8 | Injections before the `ineffective` rule can apply |
| `CRETLI_REVIEW_LESSONS_RETIRE_RECURRENCE_RATIO` | 0.5 | Recurrence share above which a lesson is demoted |
| `CRETLI_REVIEW_LESSONS_RETIRE_INACTIVE_DAYS` | 180 | Idle days before a lesson is retired |

Resolution order (`isReviewLessonsEnabled`, `lib/review-lessons-select.js`):
master off wins; an explicit per-audience value wins next; an explicit truthy
master enables every audience; otherwise the audience default applies. Flags
are read per run through the delegation env (`resolveDelegationEnv`), so a
`.env` or workspace env change applies to new runs without a restart.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `lesson_list` | List the workspace's lessons |
| `lesson_add` | Add a manual lesson (candidate unless `activate: true`) |
| `lesson_update` | Patch a lesson with `expected_revision` (promote, retire, edit) |
| `lesson_delete` | Delete a lesson |
| `lesson_distill` | Propose candidates from recurring findings (`dry_run` previews) |
| `lesson_check_idea` | Create one `idea` todo proposing a deterministic check for a `checkable` lesson |
| `workflow_update` (`rejected_findings`) | Record rejected findings with a reason |

The same operations are available over REST (`/api/review-lessons*`,
`/api/review-findings*`) and in the UI (see UI below).

## Definitions

**Code-review round.** One resolved review of a leaf:

- single reviewer: a credible terminal (`isCredibleCodeReviewTerminal`) is one
  round; infra failures, cancels and unspecified verdicts are not rounds;
- reviewer pool (opt-in): any member FAIL resolves FAIL; two distinct PASS
  resolve PASS; a lone member PASS is pending until the parent records PASS via
  `workflow_update`; late siblings of a resolved round are ignored; fan-out in
  one round counts once.

**Round identity** for de-duplication: `(leafId, id of the latest credible
code-review delegation)`. The closure epoch is not used — both resolution paths
bump it. Member ids of a pool round closed by a parent PASS are remembered so a
late member PASS does not fire again. The memory is in-process and bounded
(512 entries); after a server restart a late member could notify again.

**`onReviewRoundResolved(leaf, round)`** (server only; subscribe with
`subscribeReviewRoundResolved`). Fired from two paths:

1. the delegation finish hook (`syncCodeReviewWorkflowAfterFinish`), evaluated
   before its early return, so it also works with
   `CRETLI_DELEGATION_CODE_REVIEW_PHASE=0`;
2. `applyParentWorkflowUpdate` (HTTP `POST /api/chats/:id/delegation-workflow`
   and the in-process `updateDelegationWorkflow`), only for a PASS where the
   latest credible review on the leaf is a **code** review. `workflow_update`
   carries no review subject, so a parent PASS right after a plan review does
   not fire. Pool state is read before the patch (a PASS clears it).

**Plan-review round.** All credible plan reviews on one todo plan revision
(`todoPlanRevisionKey`). Rounds to PASS = number of distinct revisions reviewed
until every reviewer of one revision PASSed.

**First-pass rate** = leaves (todos) whose first PASS came in round 1 / leaves
(todos) that reached PASS.

**Findings** per review: unique `F<n>` ids and `P1/P2/P3` mentions in the
report text (best-effort regex).

## `GET /api/review-loop-stats`

Authenticated JSON, scoped like `GET /api/delegations`. Optional
`?workspaceFolder=`. Response:
`{ ok, generatedAt, windows: ['7d','30d','90d'], workspaces: [{ workspaceFolder,
windows: { '7d'|'30d'|'90d': { since, codeReview{leaves,leavesPassed,
firstPassLeaves,firstPassRate,roundsToPass{mean,median,max}}, planReview{todos,
todosPassed,firstPassTodos,firstPassRate,roundsToPass}, findings{reviews,
withFindings,total,P1,P2,P3,perReview}, stopReasons{same_findings,
closure_rounds_exhausted}, byImplementerModel, byReviewerModel, weekly[] } } }] }`.
Empty stores give zeros and `null` ratios. A leaf is in a window when its latest
credible review finished inside it. `stopReasons` come from the parent workflow
rows currently stored.

## Baseline (captured 2026-10-15, 90d window, this repository's workspace)

| Metric | Value |
| --- | --- |
| Code-review leaves / reached PASS | 126 / 124 |
| Code first-pass rate | 54.8% (68 of 124) |
| Code rounds to PASS | mean 1.64, median 1, max 7 |
| Plan-review todos / reached PASS | 32 / 26 |
| Plan first-pass rate | 34.6% (9 of 26) |
| Plan rounds to PASS | mean 3.38, median 2.5, max 14 |
| Reviews / with findings / finding ids | 832 / 190 / 705 |
| Priority mentions P1 / P2 / P3 | 219 / 213 / 299 |
| Findings per review | 0.85 |
| Stop reasons `same_findings` / `closure_rounds_exhausted` | 0 / 0 (workflow rows only) |

Other workspaces in the store had no code or plan review loops.

## Evaluation (2026-10-19, interim: ~3 days after rollout)

Rollout cutoff `2026-10-16T07:30:00Z` (the feature commits landed 2026-10-16).
Every count below comes from `buildReviewLoopStats` over the delegation store of
this repository's workspace, plus the findings ledger and the lessons store,
captured 2026-10-19. The post-rollout slice reuses the same code path: a 7d
window whose `since` is the cutoff. A leaf is in a window when its latest
credible review finished inside it, and its rounds and first pass are still
computed over all its reviews, so a leaf that started before the cutoff can
carry pre-rollout rounds. The live windows are not post-rollout slices; the 7d
window starts 2026-10-12.

| Metric | Baseline (2026-10-15, 90d) | Post-rollout (2026-10-16T07:30Z to 2026-10-19) | Live 7d / 30d / 90d |
| --- | --- | --- | --- |
| Code-review leaves / reached PASS | 126 / 124 | 85 / 83 | 114 / 106 · 146 / 131 · 146 / 131 |
| Code first-pass rate | 54.8% (68 of 124) | 59.0% (49 of 83) | 61.3% (65 of 106) · 58.8% (77 of 131) · 58.8% (77 of 131) |
| Code rounds to PASS (mean / median / max) | 1.64 / 1 / 7 | 1.52 / 1 / 4 | 1.49 / 1 / 4 · 1.52 / 1 / 4 · 1.52 / 1 / 4 |
| Plan-review todos / reached PASS | 32 / 26 | 8 / 7 | 30 / 25 · 33 / 26 · 33 / 26 |
| Plan first-pass rate | 34.6% (9 of 26) | 28.6% (2 of 7) | 48.0% (12 of 25) · 50.0% (13 of 26) · 50.0% (13 of 26) |
| Plan rounds to PASS (mean / median / max) | 3.38 / 2.5 / 14 | 2.43 / 2 / 5 | 1.76 / 2 / 5 · 1.73 / 1.5 / 5 · 1.73 / 1.5 / 5 |
| Reviews / with findings / finding ids | 832 / 190 / 705 | 386 / 335 / 1642 | 505 / 366 / 1718 · 642 / 386 / 1776 · 642 / 386 / 1776 |
| Priority mentions P1 / P2 / P3 | 219 / 213 / 299 | 491 / 885 / 1824 | 523 / 901 / 1855 · 548 / 909 / 1861 · 548 / 909 / 1861 |
| Findings per review | 0.85 | 4.25 | 3.4 · 2.77 · 2.77 |
| Findings rejected as `false_positive` | n/a (ledger not live) | 0 of 1724 ledger findings (983 resolved) | not windowed (ledger is global) |
| Injector overhead, injected runs | n/a (feature not live) | 253 of 296 runs (85.5%); mean 543 lesson-text chars, max 954 | not windowed |
| Stop reasons `same_findings` / `closure_rounds_exhausted` | 0 / 0 | 0 / 0 | 0 / 0 in all three windows |

The live 30d and 90d windows are identical because every leaf's latest credible
review falls inside the last 30 days, so both windows hold the same leaves. The
90d window re-measured today holds fewer credible reviews than the 2026-10-15
capture (642 vs 832), so the review and finding columns are not comparable
across dates; compare the post-rollout slice with the live windows captured at
the same time; the live windows are supersets of the slice, not independent
comparators.

### Not enough data

- **Time.** ~3 days (2026-10-16T07:30Z to 2026-10-19), not the ~2 weeks of real
  use the decision requires.
- **Leaf count.** The >= 15 resolved post-rollout code-review leaves condition
  is met: 85 leaves, 83 reached PASS.
- **No control group.** 253 of 296 post-rollout implement runs (85.5%) had a
  non-empty `injectedLessonIds`, 43 (14.5%) were empty, and the slice has no
  `fix` assignment: fix-loop reruns are stored as implement rows with
  `pickRole: fix`, so they are included in the same 296 rows. Lessons were
  therefore injected in the overwhelming majority of implement rows and no
  causal claim is made from any delta.
- **Plan sample.** 8 todos (7 reached PASS): too small to judge the planner
  audience even if it were enabled.
- **False positives.** 0 `rejected` and 0 `false_positive` outcomes in 1724
  ledger findings (983 resolved, 741 open) carry no signal. The findings ledger
  itself only starts after rollout (its earliest origin-delegation `recordedAt`
  is 2026-10-16T12:12Z; the earliest entry-level `recordedAt` is
  2026-10-17T06:24Z), so all 1724 entries are post-rollout by construction. 174
  of them carry no `recordedAt`; they are attributed to the period by their
  origin delegation.
- **Findings counts.** 4.25 finding ids per review post-rollout vs 0.85 in the
  baseline, but the live 30d/90d windows measure 2.77 on the same code path
  today while the 2026-10-15 capture recorded 0.85; the store now holds fewer
  reviews than at that capture (642 vs 832 in the 90d window), so the row set
  and reviewed material differ and the delta is not attributable to lessons.

The interim numbers are not a verdict on the feature.

### Re-check (2026-10-30)

- Trigger: on or after 2026-10-30 (2 weeks after rollout). The >= 15 resolved
  post-rollout code-review leaves condition is already satisfied (85 today); the
  remaining open condition is time. This evaluation todo stays open until then.
- Re-run the same measurement: `buildReviewLoopStats` for the live 7d/30d/90d
  windows plus the post-cutoff slice, the ledger rejection counts, and the
  injected vs empty split. Compare against the baseline table and against this
  interim slice.
- Compare injected and empty implement runs separately (253 vs 43 today): do the
  43 empty runs show a different first-pass rate or rounds to PASS once the slice
  is large enough? If the split stays this lopsided, the re-check reports that no
  clean control group exists rather than a causal conclusion.
- Also check the retirement rules' effect on the active set (10 active, 1
  candidate injected so far) before deciding the planner and reviewer flags.

### Flag-default decision (2026-10-19)

- `CRETLI_REVIEW_LESSONS_IMPLEMENT` stays **on** (rollout default, unchanged).
  This retains the rollout default pending sufficient evidence: the interim
  slice can support neither an improvement nor an absence of regression (~3
  days, no clean control group, non-comparable review sets). The measured
  numbers are recorded above for the 2026-10-30 re-check, and prompt overhead
  stays inside the documented budget (<= 6 lessons and 1500 characters; mean 543
  lesson-text characters observed).
- `CRETLI_REVIEW_LESSONS_PLAN` stays **off**.
- `CRETLI_REVIEW_LESSONS_REVIEW` stays **off** pending the 2026-10-30 re-check.
- No code or config change is made in this step; the decision is recorded here
  only.

Injector overhead detail for the post-rollout slice: 11 distinct lesson ids were
injected (10 currently active, 1 since demoted to candidate), 1 to 6 lessons per
run, mean 543 lesson-text characters per injected run, max 954 (limits: 6 lessons
and 1500 characters); the distinct lesson texts total 1479 characters. Character
counts cover lesson text only, not the block framing. Code-review rows with a
non-empty `injectedLessonIds`: 0 of 469, and plan-review rows: 0 of 96, matching
the reviewer and planner flags staying off. Those row counts are all
post-rollout review delegation rows, including non-credible terminals, so they
are larger than the credible-review counts in the table.

## Structured findings capture (`CRETLI_REVIEW_FINDINGS_BLOCK`)

Audit and closure review prompts ask the reviewer for one fenced
` ```findings-json ` block placed before the final `TASK:` / `VERDICT:` lines,
with one concrete example object. The block is machine-readable metadata only:
**prose stays authoritative** for the verdict, the findings hash, `same_findings`
and the prior-findings text. Every report consumer (closure verdict
reconciliation, `applyDelegationWorkflowPatch` report-derived fields and hashes,
the review-gate prompt blocks) calls `stripFindingsBlock` first, so a report with
and without the block behaves identically.

- Flag: `CRETLI_REVIEW_FINDINGS_BLOCK` (default on). `0` / `false` / `off`
  restores the previous prompts byte-for-byte and disables the ledger.
- Parser: `lib/review-findings-parse.js` — JSON block first (confidence `high`),
  prose regex fallback (confidence `low`). Fields: `id`, `status`
  (`NEW|FIXED|STILL_OPEN|REGRESSION|OUT_OF_SCOPE|FOLLOW_UP`), `priority`,
  `category`, `files`, `summary`.
- Categories (`lib/review-findings-taxonomy.js`): `missing-test`, `test-weak`,
  `docs-not-updated`, `caller-not-updated`, `contract-violation`,
  `error-handling`, `concurrency-race`, `security`, `i18n`, `style-convention`,
  `scope-creep`, `perf`, `other`.
- Delegation records carry a compact `reviewFindings` summary (source, totals by
  priority / category / status, confidence).

### Ledger and outcomes

`data/review-findings-ledger.json` (atomic writes) is keyed by
`workspaceFolder` + `leafId`. Each finding gets a canonical key:
`R<cycle>A<n>-<id>` for the n-th audit reviewer of the cycle (two pool members
that both report `F1` stay distinct) and `R<cycle>C<n>-<id>` for findings first
reported by closure round n. Outcomes: `open`, `fixed`, `still_open_at_stop`
(open when `closure_rounds_exhausted` fires), `rejected` (orchestrator, with a
reason), `out_of_scope`, `follow_up`, `unlinked` (a status that matches neither
a canonical key nor a unique raw id).

A cycle closes only on a resolved **PASS** announced through
`onReviewRoundResolved`, not on the closure epoch bump; the next review starts a
new cycle. Late pool siblings (null workflow patch) are still recorded; a retry
replaces the earlier attempt's contribution; a replayed finish is a no-op.

When the ledger has open current-cycle entries, the fixer, regression-gate and
closure prompts append a `[FINDING KEYS]` table *after* the unchanged prior
findings text (and list the keys instead of "No open findings" when the prior
text is empty).

### `rejected_findings`

`workflow_update` accepts `rejected_findings: [{ key, reason, note }]` with
`reason` one of `false_positive`, `wont_fix`, `duplicate`,
`out_of_scope_elsewhere`. It travels through the MCP handler, the HTTP route and
the in-process client, is part of the idempotency fingerprint (same key +
different list = `CONFLICT`) and is written with `actor=orchestrator`.
`OUT_OF_SCOPE` findings get outcome `out_of_scope`, are never `rejected`, and
never feed suppress candidates. When a list was applied, the returned workflow
row carries `rejectedFindings: { applied, unknown }`; `unknown` names keys that
matched no ledger entry so the orchestrator can correct the reference.

## Per-workspace lessons

Lessons live in `data/review-lessons/<workspaceKey>.json`, where the key uses
the same realpath-based workspace identity as Workspace Memory. The document
is atomically replaced under the shared workspace file lock. A lesson has an
audience (`implementer`, `reviewer`, or `planner`), kind (`do`, `avoid`, or
`suppress`), one imperative rule of at most 300 characters, a taxonomy category,
optional path globs and model filters, evidence references, lifecycle status,
origin, effectiveness counters, timestamps, and a per-lesson revision. Text
and category are normalized for deduplication. Updates require the current
revision and return `CONFLICT` on a stale write. Corrupt documents are reported
without replacing the unreadable file.

### REST routes

The authenticated API exposes `GET` and `POST /api/review-lessons`, plus
`PATCH` and `DELETE /api/review-lessons/:id`. Every request includes
`workspaceFolder` and, normally, the calling `chatId`: the chat must belong to
that folder (same rule as the delegation routes, so todo worktree chats work),
otherwise the request is rejected with 403 `OUT_OF_SCOPE`. Without a `chatId`
the folder must be in the UI-selected workspace. The in-process client applies
the same rule. POST accepts the lesson fields and defaults status to
`candidate`; `activate: true` alone creates an active lesson (the flag is not
stored). Suppress evidence is stored on the lesson and revalidated on update.
PATCH only writes `audience`, `kind`, `text`, `category`, `pathGlobs`,
`appliesToModels`, `checkable`, `checkHint`, `status`, `retiredReason` and
`supersededByTodoId` (snake_case aliases accepted); omitted fields are kept and
stats, evidence and origin are store-owned. PATCH takes
`{ workspaceFolder, expectedRevision, patch }` and returns HTTP 409 with
`code: CONFLICT` for a stale revision.

### Adding lessons by hand

`lesson_add` defaults to candidate; use `activate: true` only after reviewing the
rule. `suppress` lessons require ledger evidence for a rejected `false_positive`
(see Safety invariants). Lesson text cannot contain absolute home paths or
private LAN addresses (see Privacy under distillation).

To seed the first manual lessons, add a short imperative rule with a taxonomy
category, choose the audience and `do`/`avoid` kind, and leave it as a candidate
for review. Example: “Add a regression test for each bug fix.” in category
`missing-test`, audience `implementer`. Activate only after confirming it is
useful and narrowly scoped. All lesson data remains in gitignored `data/`.

## Prompt injection (`CRETLI_REVIEW_LESSONS`)

Active lessons are shown to the agents that can act on them. Defaults: implementer
**on**, planner and reviewer **off** (see Environment flags for the exact names
and how to switch each off). With the flag off, or with no matching lessons, the
prompt is byte-identical to the previous one.

- Selection is pure and deterministic (`lib/review-lessons-select.js`): only
  `active` lessons of the audience, never `candidate`/`retired`. Lessons whose
  `pathGlobs` miss every known path (paths named in the leaf text) and lessons
  restricted to other models are dropped. Ranking: path-glob match > category
  keyword hits in the leaf text > lesson effectiveness > evidence count > recency.
- Budget: at most 6 lessons and 1500 characters per block (same idea as the
  workspace-memory prompt budget).
- Blocks: implement/fix get `[KNOWN REVIEW LESSONS]` (`do`/`avoid`) and report a
  `LESSONS CHECKED` section (`L1: ok`, `L2: n/a`) that only the orchestrator
  reads. Audit code reviewers get `[KNOWN FALSE POSITIVES]` (`suppress`
  lessons); security-category lessons are never listed and P1/security findings
  are never suppressed. Plan reviewers get `[KNOWN PLANNING LESSONS]`.
- Exposure: every delegation record carries `injectedLessonIds` (empty array
  when nothing was shown) and `lessonsInjectedAt`. The ids are fixed at the
  first run start. A retry resolves lessons through the same
  `resolveRunReviewLessons` path as a first start: a record with
  `lessonsInjectedAt` replays its pinned ids in injection order (so the `L1`/`L2`
  labels never change; a pinned lesson retired since is still shown), while a
  legacy record without the fields gets them set on its first retry.
- Audiences: a plan *author* (an implement run in plan mode, or the planner
  chat) gets the implementer block, not `[KNOWN PLANNING LESSONS]`; only plan
  reviewers get the planner block.
- P1 exclusion: leaving P1 findings out of the false-positives block relies on
  the lessons service (`lib/review-lessons-service.js`) rejecting P1 evidence for
  `suppress` lessons; the prompt builder only filters security categories.
- Review-verify catalog proposal: ids `review-lessons-select` and
  `review-lessons-inject` are already selectable in the catalog (see the catalog
  tests) and are the proposed checks for this feature.

## Distilling candidate lessons

`lib/review-lessons-distill.js` proposes lessons deterministically (no LLM) from
the findings ledger. A single finding never becomes a lesson.

- Bucketing: category + the most common two-segment path prefix of an entry's
  files. `fixed` findings feed implementer `avoid` candidates; only `rejected`
  findings with reason `false_positive` feed reviewer `suppress` candidates.
  `out_of_scope`, `follow_up`, `wont_fix`, `duplicate`, `security` and P1
  findings never produce `suppress`.
- Threshold (overridable per call): weight >= 3 from >= 2 distinct leaves within
  90 days. Backfilled or low-confidence findings weigh 0.5, so backfill-only
  evidence needs twice the findings.
- A bucket already covered by a non-retired lesson of the same kind and category
  (overlapping `pathGlobs`) is skipped. Output is always a `candidate` with
  `origin: distilled`, written through the lessons service; promotion stays a
  human `lesson_update`. The text is a template the human edits on approval.
- Privacy: one shared classifier, `lib/review-lessons-privacy.js`, is used by the
  store guard (text, `pathGlobs`, `checkHint`) and by the distiller (file prefixes,
  globs, candidate text, dry-run output). It tokenises text instead of anchoring a
  regex: markdown and punctuation (backticks, quotes, brackets, `<>`, `*`, `=`, `,`)
  end a path run, `label:` separators are split, and each piece is classified.
  Private: home-rooted absolute paths (`/home/x`, `/Users/x`, `/root`, `/mnt/c/Users/x`,
  `~/`, `C:\Users\x` / `C:/Users/x`, `file://` forms), UNC shares (`\\host\share`),
  a slash-less `home/x` only as the first segment, and private LAN addresses
  (`10.*`, `192.168.*`, `172.16-31.*`). Folders named `users/` or `home/` inside a
  repo path are fine. A profile name containing spaces
  (`C:\Users\Jan Kowalski\a.js`) is redacted as a whole: up to two extra words
  unconditionally, then up to twenty more that still look like part of a name (a
  word starting with a Unicode uppercase letter — `É`, `Ł`, `Ñ`, `И` via
  `[\p{Lu}\p{Lt}]` — or a lowercase particle such as `de`/`van`/`der`, including
  the extended set `y`/`e`/`af`/`zu`/`st`/`mac` and the `o'` word prefix), and
  only when a path separator follows. Both counts are bounded and the name
  branches are disjoint, so a long run of name-like prose cannot backtrack
  catastrophically on server text. Residuals are deliberately re-scoped rather
  than fixed here: a fully lowercase multi-word surname still leaks its tail
  (consuming arbitrary lowercase words would swallow prose tails), and the
  distill FU-1 item, the P3 follow-ups tracked under `23007e68` and the browser
  check belong to their own leaves/runs because they need a product decision or
  unrelated verification. Finding files are re-anchored at the first
  known top-level folder (`lib`, `src`, ...) or dropped; a private path in a
  finding summary is redacted to its repo-relative tail or `<path>` before it
  reaches the candidate text. Known limitation: the re-anchor cut can expose a
  project directory name (e.g. `src/acme-client`) in a prefix. The spec matrix
  (must-reject and must-accept vectors) is
  `tests/review-lessons-privacy.test.js`; change the classifier against that
  table, not against a single new case.
- Trigger: a listener on `onReviewRoundResolved` runs once per resolved **PASS**
  round (single reviewer, two pool PASS, or a parent-resolved lone PASS). It is
  deferred to a microtask so findings rejected in the same workflow update are
  counted, and any failure is logged, never thrown into the finish hook. Replays
  are harmless (round identity memory plus the covered check).
- Manual: `POST /api/review-lessons/distill` (same scope rule as the other lesson
  routes; optional `dryRun`, `minFindings`, `minLeaves`, `windowDays`), the
  `distillReviewLessons` method of both clients, and the MCP tool `lesson_distill`.

### Backfill

`node scripts/backfill-review-findings.js --workspace DIR [--apply] [--json]`
parses historical code-review reports from the delegation store into the ledger
with `source: backfill` and `confidence: low`. Dry-run is the default and writes
nothing; `--apply` skips delegations the ledger already knows, so a second run
adds nothing and live records are never rewritten.

Review-verify catalog proposal: `review-lessons-distill`,
`review-lessons-distill-trigger`, `review-lessons-distill-transport`,
`review-lessons-privacy` and `review-findings-backfill`.

## Effectiveness, retirement and check proposals

### Lifecycle

`candidate` (distilled or manual, never injected) -> `active` (promoted by a
human, or `activate: true`) -> `retired`. Automatic transitions only go
`active -> candidate` and `active|candidate -> retired`; a retired lesson never
changes automatically and always keeps `status` plus its reason
(`retiredReason`, mirrored in `statusReason`). Promotion stays human.

### Effectiveness feedback (`lib/review-lessons-feedback.js`)

Installed next to the distillation subscription on `onReviewRoundResolved`
(both the finish hook and `applyParentWorkflowUpdate`), so a pool round, a
single-reviewer round and a lone PASS closed by the parent each count once.
Work runs in a deferred task; errors are logged, never thrown into the finish
hook. For each resolved PASS/FAIL round:

- every lesson in `injectedLessonIds` of the leaf's implement/fix delegations in
  the ledger cycle of the round gets `injected++` once, then `recurred++` when a
  finding of the round's reviewers has the lesson's category and (when the lesson
  has globs) a matching file, else `cleanAfterInjection++`;
- findings are attributed through their origin delegation and its ledger cycle,
  so a late result still counts for the cycle it belongs to after it closed;
- an active `suppress` lesson injected into a reviewer of the leaf is demoted to
  `candidate` (`suppressed_real_issue`, one notification) when the pattern was
  reported by another delegation and ended `fixed`. Suppress lessons are built
  only from `false_positive` rejections, so a real bug outside an earlier leaf's
  scope is still reported.

All writes go through one store transaction (`applyLessonFeedback` in the
service, internal only: not reachable from routes, clients or `lesson_update`)
under the store lock, keyed by `leafId:roundId`, so replays and restarts never
double count. `stats`, `lastInjectedAt` and `statusReason` are not patchable.

### Retirement rules (count-based, configurable)

| Rule | Condition | Result |
| --- | --- | --- |
| `ineffective` | `recurred / injected > 0.5` after >= 8 injections (active) | `candidate` for rewrite |
| `stale_paths` | the lesson has globs and none matches a file of `workspaceFolder` | `retired` |
| `inactive` | no evidence and no injection for 180 days | `retired` |

Thresholds: `CRETLI_REVIEW_LESSONS_RETIRE_MIN_INJECTIONS`,
`CRETLI_REVIEW_LESSONS_RETIRE_RECURRENCE_RATIO`,
`CRETLI_REVIEW_LESSONS_RETIRE_INACTIVE_DAYS`. The stale-path rule is skipped
when the workspace file listing is empty or unreadable. Effectiveness is also a
ranking factor in `selectReviewLessons` (smoothed clean-after-injection share,
neutral 0.5 without measurements).

### Check proposals (`lib/review-lessons-checks.js`)

`POST /api/review-lessons/:id/propose-check`, the `proposeLessonCheck` method of
both clients and the MCP tool `lesson_check_idea` create exactly one `idea`
todo for a `checkable`, non-retired lesson (idempotency key
`lesson-check-<lessonId>`; a repeat returns the same todo with
`created: false`). The body carries the lesson, evidence and a suggested
lint/test/verify-catalog implementation, all passed through the privacy module.
It never writes the check. When the check exists the human retires the lesson
with `lesson_update` (`retiredReason: superseded_by_check`,
`supersededByTodoId`); there is no automatic hook into todo integration.

Guard: activating a lesson (via `activate: true` or a status patch) whose text
is a normalized substring of `CLAUDE.md` or `.cursor/rules/*.mdc` of the
lesson's own workspace is refused (`DUPLICATE_RULE`) with a hint to strengthen
that rule. Rule files are confined to the workspace (symlinks leaving it are not
followed); `options.ruleFiles` overrides the list for tests.

Review-verify catalog proposal: `review-lessons-feedback`,
`review-lessons-checks` and `review-lessons-checks-transport`.

## UI (Settings -> Delegations -> Lessons, Todo findings)

The **Lessons** subtab lists the active workspace's lessons in three views:
Candidates (approve, edit text and path globs in a `cr-dialog`, reject),
Active (injected, recurred and clean rate; edit, retire) and Retired (reason;
move back to candidates). Evidence links open the source todo. A small card
shows the review-loop summary from `GET /api/review-loop-stats` (first-pass
rate, rounds to PASS, findings per review, weekly trend) for a 7d/30d/90d
window. Every write sends the loaded `expectedRevision`; on a 409 the list is
reloaded and a message is shown instead of overwriting. Lesson text is rendered
with `textContent` only.

On a leaf in the Todo panel, **Show findings** loads
`GET /api/review-findings?workspaceFolder=&leafId=` (scrubbed read model plus
the ledger `seq`) and offers a per-finding **Reject** with a reason
(`false_positive | wont_fix | duplicate | out_of_scope_elsewhere`) and an
optional note, sent to `POST /api/review-findings/reject` with `expectedSeq`.
Both routes use the same `resolveScope` workspace rule as the lesson routes.
A human rejection (actor `human`) overrides an orchestrator rejection, is
idempotent for the same reason and note, and returns 409 `CONFLICT` for a stale
`expectedSeq`; OUT_OF_SCOPE and FOLLOW_UP findings return 409
`NOT_REJECTABLE` and never become suppress sources. A later orchestrator
`rejected_findings` row for a human-rejected key is reported as `humanLocked`
and does not change the entry. Notes are scrubbed of private paths.
