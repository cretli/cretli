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

After every terminal **implement** or **fix** on a leaf, the orchestrator runs
`delegation_verify` on that delegation id **before** starting a code review (or
before handing partial work to the next executor). A failed verify sends the
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

## Klucz i dopasowanie liścia

- Klucz wiersza: `parentChatId` + `leafId` (`leaf_id`/`todo_id`).
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
| `workflow_budget_exhausted` | zmierzony koszt/tokeny osiągnęły budżet liścia |

## Controller key

The workflow row is keyed by `(delegationController(row), leafId)`. Rows without `controllerChatId` use the historical parent, so existing workflows are unchanged. Code-review phase patches write to the controller's workflow.
