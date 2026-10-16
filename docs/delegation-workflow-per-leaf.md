# Stan pętli delegacji per liść

Dokument opisuje kontrakt `delegation_workflow_*` po wprowadzeniu stanu per
liść. Stan nadal zapisuje parent (serwer nie jest sekwencerem), ale klucz jest
per `(parentChatId, leafId)`, a serwer potrafi odtworzyć rundę i werdykt z
historii terminalnych jobów, gdy parent ich nie zapisze.

Model pick proposals and `pick_id` on start are documented in
[`model-pick-decisions.md`](model-pick-decisions.md). Rola joba jest zapisywana
jawnie w `pickRole` (przed normalizacją `assignment`), więc `fix` nie zlewa się
z legacy `implement`; grupowanie cykli (`delegationCycleRole`) używa tego pola,
a wiersze bez niego pozostają `implement`.

The persisted verdict a leaf carries — who reviewed it, with which model and on
which subject, how independent the reviewer was and whether the review is still
current — is defined in [`todo-review-contract.md`](todo-review-contract.md).
This file stays the per-leaf *loop* contract (rounds, deadlines, budgets); the
review contract owns the `todo.review` snapshot and reads the same attempt
history. Pass `review_subject` (`code` or `plan`) on every review start; the
loop's `last_verdict`/`report_text` are inputs to the loop only — the todo's
review state is recomputed by the server and is not written by `workflow_update`.

## Bounded execution guidance

The generated TODO execution prompt tells the orchestrator to read the existing
`workflow_show` row before each leaf, initialize missing state with `max_rounds=4`,
and persist each review with its verdict, findings, material revision and stable
attempt-specific idempotency key. Existing user budgets and deadlines survive a
resume. Corrections use the `fix` pick role and assignment.

The orchestrator prompt still uses soft checkpoints (15 minutes for fix/review,
30 minutes for initial implement) to inspect progress. Separately, the runtime
worker enforces a **hard per-run limit from `startedAt`**: review and fix jobs
default to 20 minutes, implement jobs to 40 minutes (`CRETLI_DELEGATION_RUN_DEADLINE_*`,
`0` disables the default). Explicit `deadline_at` on `workflow_update` or
`delegation_start` overrides that default; the server never extends a user
deadline. On exceed the worker requests cancel like `delegation_cancel`; the job
finishes as `interrupted` with `interrupt_code=run_deadline_exceeded` (not a
review verdict and not counted as a review round in workflow history). Leaf
`deadline_at` cancels use the same stop path but keep a normal cancel finish
without `run_deadline_exceeded`. The parent waits for `slot_occupied=false`, then hands partial
work to another executor (`exclude_models`). Runs that entered `running` before
this feature shipped keep only explicit deadlines until they finish; new runs
set `runDefaultLimitActive` at first `running`.

After a finding survives a fix, or two code reviews fail, the parent must reconcile
scope and root cause and choose a different eligible executor. Transport failures
lead to a different harness for that recovery attempt. Lack of eligible alternatives
is reported as a blocker. Soft round caps and `same_findings` are not lifted repeatedly
without new evidence and a changed approach.

When the orchestrator omits `leaf_id` / `todo_id`, the server may infer the
active leaf: the calling chat must be the `orchestrator_chat_id` of a todo root
and that subtree must contain exactly one leaf in status `doing`. The resolved id
feeds leaf-size flash policy, per-leaf workflow, delegation `leafId`, and pick
proposal linkage; responses include `leaf_source=inferred` when applicable. With
zero or more than one doing leaf the call proceeds without inference and returns
`warning.code=leaf_id_missing` plus `candidates`. Explicit ids always win; a leaf
outside the orchestrator subtree is rejected. Set
`CRETLI_ORCHESTRATOR_LEAF_INFERENCE=0` to disable inference. The generated TODO
execution prompt still asks the orchestrator to pass `leaf_id` explicitly.

For implement/fix picks on a leaf, pass `leaf_id` (or `todo_id`) to `model_pick`:
after a **completed** implement or fix job on that leaf in the parent chat, the
picker sticky-prefers the same harness/model for the next implement/fix on that
leaf (unless `exclude_model` removes it). Terminal completion rate and median
duration from the last 30 days feed the implement/fix score when
`adaptive.enabled` is on (`data/model-role-profiles.json`).

Implement picks also classify the leaf body as **small** or **large**
(`classifyLeafSize`: at most three listed existing file paths and no configured
large keywords → small; missing file list → large). On a **large** leaf,
`*flash*` catalog ids are merged into `exclude_models` for the pick; the start
gate still blocks flash without a substantive `pick_reason`. When every
implement candidate is flash-only, the leaf gets
`blocked_reason=no_non_flash_candidate` instead of silently picking flash.
Thresholds: `CRETLI_LEAF_SIZE_MAX_FILES`, `CRETLI_LEAF_SIZE_LARGE_KEYWORDS`
(pipe-separated, case-insensitive substring match on the body).

Both fix executors and reviewers receive stored workflow and Watcher findings,
including on retry. The fix checklist asks for `FIXED`/`STILL_OPEN` evidence for
each finding and checks production callers and consumers. An implementer PASS
never satisfies the independent review gate.

Verification starts with named regressions, directly affected suites and required
repository checks. Repeating or broadening checks requires a new change, failure
or concrete unresolved risk. Results for unchanged material can be reused;
unverified attribution of unrelated failures must remain explicit. Full acceptance
checks still run when required at the leaf or final integration boundary.

`review_can_run_tests=false` requires parent host verification through
`delegation_verify`; it does not mean repository reads or guarded read-only shell
are prohibited. The reviewer first establishes a permitted inspection path. If none
exists, the parent supplies the exact diff and relevant sources or chooses another
eligible reviewer. Mutation guards remain unchanged.

After a `completed` **implement** or **fix** the host starts the audited verify
itself (`source: auto_after_implement`, ids mapped from the changed paths, full
catalog when none map; disable with `CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT=0`). A code
review started while it runs is refused with retryable `verify_pending`; poll
`delegation_show` (`verify_running`/`verify_pending`) and retry. A passed,
non-stale result for the current revision is copied onto the review record
(`inherited_from_implement`) and its output tail is added to the review prompt.
The parent therefore calls `delegation_verify` only when the result is missing,
stale or failed. The manual rule below still applies in those cases:

After every terminal **implement** or **fix** on a leaf without such a result, the
orchestrator runs `delegation_verify` on that delegation id **before** starting a
code review (or before handing partial work to the next executor). A failed verify sends the
orchestrator to fix with the test output; it must not start review or consume a
review round. The server rejects a code review start when the latest implement/fix
on the same leaf still has a failed verify for the current material revision
(`verify_failed_before_review`; override with `allow_verify_failed_review=true`).
Verify results are stored on the implement/fix record (`verify_result.material_revision`).

The server also refuses to re-run the same reviewer (same transport and base
model; an effort suffix does not make a different reviewer) on unchanged
material (`review_recheck_no_material_change`, HTTP 409, no delegation row is
created). For `review_subject=code` unchanged means no implement/fix was queued
since that reviewer's last usable review; for `review_subject=plan` it means the
plan of the todo named by `leaf_id` is unchanged: the server stores that todo's
plan revision key (hash of `plan.updatedAt` + `plan.markdown`) on the review row
as `todoPlanRevisionKey` and compares it on the next start, whatever the
delegation source (`task_text`, history message or saved chat plan; the chat
plan revision is not used). A plan start is allowed when the todo or its plan is
missing, or when the earlier review row carries no key. A different base model, an exchange-phase start tied to an
independent row, and `allow_recheck=true` are not refused. `review_subject=other`
is not covered.

## Two-phase code review (audit + closure)

For `review_subject=code` on a leaf with an explicit `leaf_id`, the server
stores `reviewMode` on the delegation record (`audit` or `closure`) and keeps
phase counters on the workflow row:

- **`audit`** — first code review of the leaf in the current cycle: full scoped
  audit against leaf acceptance criteria; findings use stable IDs and priority;
  out-of-scope notes are `OUT_OF_SCOPE` and do not block the verdict.
- **`closure`** — later code reviews after the audit: prompt limits work to
  FIXED/STILL_OPEN on open findings plus fix regressions; new non-P1 findings
  go to `FOLLOW_UP` and do not block PASS when audit findings are closed.

Defaults: one audit plus two closure **rounds** per cycle
(`CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES`, default `2`). A round is one
implement/fix material revision: parallel closure fan-out in the same round
counts once. Only terminal reviews with a usable verdict advance counters;
infra/cancel/deadline/unspecified finishes and retries of the same delegation id
do not consume closure budget. A closure FAIL on the last allowed round sets
`stop_reason=closure_rounds_exhausted`; `resume_rounds` on `workflow_update` (or
on `delegation_start`) clears the stop and grants one more closure allowance.
Closure picks sticky-prefer the audit reviewer (`codeReviewAuditReviewer`) when
still eligible; an infra outcome by that reviewer on the leaf drops sticky
automatically. Plan reviews and ad-hoc code reviews without a leaf id keep the legacy
full regression gate (`CRETLI_DELEGATION_CODE_REVIEW_PHASE=0` disables the
split). The orchestrator should create separate todos for `FOLLOW_UP` and
`OUT_OF_SCOPE` items instead of expanding the current leaf.

Opt-in reviewer pool: with a fixed pair (`reviewer_policy`, or the legacy
`reviewer_pair_enabled` + complete `reviewer_pair_members`; Settings → Delegations) the parent passes the two
members to `model_pick` as `prefer_models` with `count=2` and runs two fresh
review jobs per round (no resume). The workflow row keeps one round record
(`codeReviewPoolRound`: round key, epoch, mode, members' results and reviewer
identities) captured when the round starts, so a later settings change or a
replacement start does not reclassify it. The counter/audit/epoch effect is
applied once, when the round resolves: any FAIL resolves it as a failed round
(closure count +1; audit mode sets `codeReviewAuditDone`), two distinct PASS
resolve it as PASS (counter reset). Only distinct reviewer **canonical**
identities count (same harness + base model; an effort suffix or a Claude moving
alias never creates a second identity, and an `outside_pool` reviewer never
supplies one of the pair's two PASS results): a second PASS from the same
reviewer never resolves the round as approval. A
member PASS that finishes first mutates nothing, and a late sibling result of
an already resolved round is ignored. A lone PASS stays pending while a second
distinct member can still arrive; if two credible PASS results come from the
same reviewer identity (the fixed pair never obtained a second eligible
reviewer), the round resolves `DEGRADED` with
`stop_reason=reviewer_pool_degraded`, advances no counter and never approves the
leaf. That stop is actionable: the parent reports it as blocked, and
`resume_rounds` on `workflow_update` clears it once reviewer eligibility is
restored. Consequently `CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES` counts
rounds, not jobs.

### Reviewer policy per review kind (`reviewer_policy`)

Settings → Delegations → Review holds one policy per review subject, **plan** and
**code** (`review:other` keeps the legacy `reviewer_pair_*` behavior and is not
configurable in the new UI). Each entry has:

| field | values | meaning |
| --- | --- | --- |
| `selection` | `auto` \| `fixed_pair` | `auto`: `model_pick` chooses each reviewer. `fixed_pair`: the same two reviewers every round. |
| `members_source` | `learned` \| `configured` | `learned`: the first two distinct reviewers of a controller (orchestrator chat) and subject become its pair (`reviewer-pairs.json`, partitioned per subject; an errored member is evicted, a verdict FAIL never evicts). `configured`: two chosen favorites (same harness + base model = one reviewer; effort never makes a second reviewer). |
| `session` | `fresh` \| `leaf` \| `orchestrator` | `fresh`: new chat per review. `leaf`: re-enter the member's earlier session of the same leaf. `orchestrator`: any leaf of the same controller. |

One resolver (`lib/reviewer-policy.js`) feeds manual TODO start/continue, full mode,
refine, Watcher cycle prompts (`resolveReviewerPoliciesForPrompt`), MCP
`model_pick` and the server start path, so every route sees the same effective
policy. `model_pick` has no default `review_subject`: it injects a fixed pair as
`prefer_models` only when the caller passes `review_subject=plan|code` explicitly.
Without it no pair is injected (the picker never guesses a subject, so a plan
review cannot silently receive the code pair). **The server enforces it** in
`createAndStart` for every review start, including from an older running
orchestrator; prompts only mirror it. A running job keeps the snapshot stored on
it (`delegation.reviewerPolicy`: subject, revision, selection, session, members,
membership, reuse decision).

Reuse rules (every gate of `inspectDelegationSessionResume` still applies):

- A reviewed round is always a NEW delegation, attempt, report, verdict and material
  id, even when `childChatId` is reused. No earlier PASS is inherited.
- The first known member is reused while the pair is still being learned; a
  reviewer outside a complete pair is started fresh (`reuse_not_pool_member`) and
  never redefines the pair.
- Audit and closure never share a session (`phase_changed`, both directions);
  with a same-phase candidate available it wins over a newer other-phase one.
- A session whose chat also ran implement/fix work is never reused
  (`resume_implementation_history`); independence is judged against every
  implementer of the *current* leaf.
- Execution folder, execution mode, options, effort, permissions, root/depth,
  adapter support, lockouts, busy/claimed/reset/missing sessions and peer-opinion
  (exchange) contamination fall back to ONE fresh chat with a durable reason.
  The fallback never relaxes read-only, independence or model gates.
- Every review records its decision (`reuse_fresh_by_policy`, `reuse_first_session`,
  `reuse_learning_pair`, `reuse_no_eligible_source`, `reuse_not_pool_member`,
  `resumed`, or a `resume_*` fallback code) on `sessionResume` (when a policy asked
  for reuse) and always on `reviewerPolicy.reuse`; the delegation card shows
  "same chat, round N" or the reason a new chat opened.
- Implement/fix children always start in a new chat; this policy never covers
  them (a separate explicit policy would be required).

Migration (read-time, deterministic, idempotent; legacy fields stay stored so a
reset or downgrade keeps working): `strict` -> `fixed_pair` + `session=leaf` (the
boundary strict mode really enforced; `members_source=configured` with a stored
pair, else `learned`); `enabled` + complete pair without strict -> `fixed_pair`,
`configured`, `fresh`; anything else -> `auto`, `fresh`. Orchestrator-wide reuse
is a new opt-in (the Settings view shows a notice). Saving a `reviewer_policy`
overrides the derived value per subject; clearing it returns to the derivation.
Learned pairs migrate lazily per controller and subject: the legacy mixed pair is
filtered to the members that actually reviewed that subject (original order, at
most two); rows without a plan/code subject infer nothing and stay in the legacy
`other` pair.

Session resume (`resume_session_of`, see `docs/plan-reviewer-cooperation.md`) is
optional, off by default and not wired into this flow: a closure review whose
named audit session is of a different `reviewMode` falls back to a new chat
(`resume_scope_changed`), and the sticky preference for the audit reviewer
(`codeReviewAuditReviewer`) is computed exactly as before.

Cache keep-alive (see `docs/usage-telemetry.md` §10) is likewise optional, off
by default and not wired into this flow. A keep-alive ping is a bounded, paid
request in a resumed reviewer session; it creates no delegation, attempt,
report, verdict or round, does not advance the workflow counters and does not
change the TODO review state. It never preempts a running review or a user
command, stops when the workflow ends (stop reason or PASS), is cancelled, reset
or hits a provider limit, and its cost is reported as a separate `keep_alive`
row per leaf, not as a review round.

## Klucz i dopasowanie liścia

- Klucz wiersza: `parentChatId` + `leafId` (`leaf_id`/`todo_id`); po przejęciu `parentChatId` tego wiersza wskazuje nowego kontrolera. Historyczny rodzic delegacji pozostaje bez zmian. Stan rund, deadline i idempotencji jest przenoszony w całości. Wiersz chat-wide źródła pozostaje; limity celu łączą się przez najmniejszą dodatnią wartość (zero oznacza brak limitu).
- Atrybucja joba do liścia (kolejność):
  1. pole `leafId` zapisane na rekordzie delegacji (ustawiane przy starcie z
     `leaf_id`/`todo_id` w żądaniu MCP/HTTP albo z linku parent→todo, gdy job
     nie ma innej atrybucji),
  2. jawne `leafId`/`todoId` w żądaniu startu (dla bramki przed utworzeniem
     rekordu),
  3. linia `cretli-ref todo=<id>` w `sourceText`.
- Przy starcie z planu (`sourceKind=plan`) `sourceText` bywa puste — wtedy
  `leaf_id` w żądaniu musi trafić do rekordu, inaczej historia liścia, deadline
  i budżet nie widzą joba.
- **Pusty `leafId` nie dopasowuje niczego.** Wiersz bez liścia to zachowanie
  legacy per-czat: brak inferencji z historii, brak auto-sync. Dzięki temu N
  liści nie sumuje rund w jednym wierszu.

## Runda

- `round` = liczba cykli implement/fix **od ostatniego PASS** dla tego liścia.
- Cykl otwiera terminalny `implement`/`fix`; jeżeli historii brakuje
  implementu, cykl otwiera pierwszy terminalny `review`.
- Równoległe review jednej rundy (fan-out) są grupowane: kolejne review bez
  implementu między nimi nie zwiększają rundy. Przy liczeniu `todo.review` awaria
  infrastruktury bez raportu (np. `failed` bez treści) nie blokuje użytecznego
  PASS zastępczego w tej samej rundzie — szczegóły w `docs/todo-review-contract.md` §4.5.
- `review` z `VERDICT: PASS` zeruje rundę; następny implement/fix startuje nowy
  cykl od 1. Auto-reset działa też na ścieżce historii (`resolve` obniża
  zapisane `round`, gdy ostatnie review to PASS).
- `resolve_delegation_workflow_row`/`inspect` syncują w górę przy nowym cyklu i
  w dół przy PASS. Werdykt jest zapisywany razem z tą zmianą, więc zagregowany
  werdykt fan-outu zapisany przez parenta nie jest nadpisywany, dopóki runda
  się nie zmienia.

## Miękki limit rund i wznowienie

- Przekroczenie `max_rounds` ustawia `stop_reason=rounds_exhausted_soft`
  (miękki stop, nie `workflow_stopped`).
- `resume_rounds: true`:
  - bez `max_rounds` — podnosi `max_rounds` o 1 powyżej `max(max_rounds, round)`
    (dokładnie jeden kolejny cykl),
  - z `max_rounds` — ustawia jawny limit.
- Bramka startu (`workflow_rounds_exhausted`) blokuje tylko wtedy, gdy
  `round >= max_rounds`; po poprawnym wznowieniu liść jest odblokowany.

## Deadline

- `deadline_at` jest budżetem czasu per liść. Po jego przekroczeniu worker
  anuluje **wyłącznie joby przypisane do tego liścia** (`cretli-ref todo=` /
  `leafId`). Wiersz bez liścia obejmuje tylko joby bez atrybucji — nigdy
  wszystkie joby parenta.
- Worker zapisuje fence `deadline_cancel_key = deadline_at`, więc przeterminowany
  wiersz nie jest anulowany ponownie w każdym ticku. Zmiana `deadline_at` zeruje
  fence.
- Start dla przeterminowanego liścia zwraca `workflow_deadline`; parent czeka na
  `slot_occupied=false`.
- Domyślny limit czasu pojedynczego joba (review/fix 20 min, implement 40 min od
  `startedAt`) działa tylko gdy job ma `runDefaultLimitActive` (nowe przebiegi po
  wdrożeniu). Jawny `deadline_at` liścia albo `deadline_at`/`deadlineAt` przy
  `delegation_start` wygrywa z domyślnym; przy obu jawnych źródłach obowiązuje
  wcześniejszy moment. Po przekroczeniu domyślnego limitu joba:
  `interrupt_code=run_deadline_exceeded` (nie liczy się jako runda review).
  Anulowanie przez `deadline_at` liścia kończy się zwykłym cancel bez tego kodu.
  Slot do `slot_occupied=false`. `delegation_show` / `delegation_list` pokazują
  `interrupt_code`.

## Budżet kosztu/tokenów

- Pola per liść: `budget_tokens`, `budget_cost_usd`.
- Egzekwowanie: start zwraca `workflow_budget_exhausted`, gdy usage ledger
  zmierzył zużycie `>=` skonfigurowanego limitu.
- **Bezpieczeństwo przy braku pomiaru:** brak zdarzeń usage dla liścia
  (`measured=false`) nigdy nie blokuje. Podniesienie lub wyzerowanie budżetu
  wznawia liść.
- Ograniczenie: usage ledger nie ma indeksu per delegacja. Pomiar sumuje
  zdarzenia dopasowane po `delegationId` lub `chatId` jobów liścia w zakresie
  dat od najstarszego joba. Dlatego liczenie odbywa się tylko wtedy, gdy budżet
  jest ustawiony; przy dużym dzienniku może to być kosztowny skan. Gdy harness
  nie raportuje usage, budżet pozostaje nieaktywny (żadnej fałszywej blokady).

## Leaf material base and checkpoints

- Before the first implement/fix on a leaf, the server captures a **leaf base**:
  in worktree mode the base commit is the previous sibling's successful checkpoint
  (or the worktree prepare base for the first leaf); in project mode it is a
  manifest of tracked and untracked paths with content hashes (pre-existing dirty
  files are part of the base, not the leaf delta).
- Implement, fix and review prompts include `[LEAF MATERIAL BASE]` with the base
  commit or partial paths after a failed/interrupted run.
- `material_revision` on `workflow_update` is rewritten server-side from the
  leaf-scoped revision when a base exists. Host verify stores the same scoped
  revision on `verify_result`.
- After code review PASS and the leaf moves to `done`, the server writes a
  checkpoint (worktree commit on the prepared branch, or project manifest on the
  todo). Checkpoint failures are visible in `todo_show` (`leaf_material:` line).

## Kody odpowiedzi bramki startu

| Kod | Znaczenie |
| --- | --- |
| `workflow_deadline` | minął `deadline_at` liścia |
| `workflow_rounds_exhausted` | `round >= max_rounds` |
| `workflow_stopped` | twardy `stop_reason` (np. `same_findings`, `blocked`, `closure_rounds_exhausted`) |
| `closure_rounds_exhausted` | wyczerpany domyślny limit rund closure (1 audyt + 2 closure); `resume_rounds` podnosi stop |
| `reviewer_pool_degraded` | stała para nie uzyskała drugiego różnego recenzenta (dwa PASS-y z tej samej tożsamości); runda nie jest zatwierdzona, `resume_rounds` ponawia po przywróceniu kwalifikowalności |
| `workflow_budget_exhausted` | zmierzony koszt/tokeny osiągnęły budżet liścia |

## Controller key

The workflow row is keyed by `(delegationController(row), leafId)`. Rows without `controllerChatId` use the historical parent, so existing workflows are unchanged. Code-review phase patches write to the controller's workflow.

## Reviewer rotation data (refine loop)

`delegation_list` / `delegation_show` expose `plan_reviewer_session_id`,
`plan_reviewer_phase`, `review_uncertified` (`true|false|null`, stored at the
first start and never rewritten by replays; `review_uncertified_now` on the
start response is the live adapter evaluation) and `leaf_id`, plus compact text
tokens (`session=`, `phase=`, `uncertified=`, `leaf=`, `err=`, `report=`,
`queued=`). The `cretli-todo-refine-loop` skill uses them to rotate reviewers
mechanically (references/round-protocol.md §1).

## Verify runs: de-duplication and visibility

`runReviewVerify` keeps an in-flight map keyed by the resolved execution folder
and the sorted resolved ids. Concurrent calls with the same key (from
`delegation_verify` or the harness runner) await one execution and share its
result and `dataDir`; completed results are not cached, and a dropped client
connection does not cancel the run. `delegation_show` reports `verify_running`
(a run is in flight in the delegation's execution folder) and `verify_recorded`
(the current attempt has a `verify_result`). The bridge client gives
`delegation_verify` a 60 s per-call budget (`BRIDGE_VERIFY_TIMEOUT_MS`); every
other API call keeps 30 s.

UI-started plan refinement includes the limit "do not change the todo status".
The refine skill therefore leaves an `idea` todo in `idea` and explains that
limit in its final report. A refine run whose start message has no such limit
may promote `idea` to `ready` after the required plan reviews and verification
pass.

Verify one delegation at a time. Before a call, note the existing result and
its `dataDir`. On a timeout, first use a fresh result, otherwise wait while
`verify_running` (at most four 20-second waits), otherwise retry the call once.
If the run is still active without fresh evidence after those waits, report
"no confirmation yet". An older result is not evidence for the timed-out call.
Pass pagination `cursor` values only by copying the previous `next_cursor`.

## Review findings ledger

Code reviews also feed a durable, server-side findings ledger keyed by
workspace + leaf (`lib/persist/review-findings-ledger-persist.js`). It is
additive: the workflow row, verdicts, findings hash and `same_findings` are
computed from the prose report exactly as before (the optional
` ```findings-json ` block is stripped first). The ledger cycle closes only on a
resolved PASS round (`onReviewRoundResolved`), independent of
`codeReviewClosureEpoch`. `workflow_update.rejected_findings` records
orchestrator rejections and is included in the patch idempotency fingerprint.
See `docs/review-lessons.md` for keys, outcomes and the
`CRETLI_REVIEW_FINDINGS_BLOCK` flag.

## Review lessons prompt blocks

By default the implementer audience is on (planner and reviewer are opt-in;
`CRETLI_REVIEW_LESSONS=0` disables all, see `docs/review-lessons.md`). When
active lessons match, the executor prompt carries one
extra block after the leaf acceptance criteria: `[KNOWN REVIEW LESSONS]`
(implement/fix, with a `LESSONS CHECKED` report section), `[KNOWN FALSE
POSITIVES]` (audit code review) or `[KNOWN PLANNING LESSONS]` (plan review).
Selection and budget: `docs/review-lessons.md`. The injected lesson ids are
stored on the delegation record as `injectedLessonIds`.
