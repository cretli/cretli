# Recovery contract

Versioned, machine-readable recovery contract for Cretli. The source of truth
in code is `lib/recovery/recovery-contract.ts`; this document describes the same
contract in English (constant names remain unchanged). The document and the
module must be changed together.

- `RECOVERY_SCHEMA_VERSION = 1`
- `RECOVERY_CONTRACT_REVISION = '2026-10-08.3'`

## Scope and boundary

The contract defines a shared vocabulary for leaves R2–R20: run states and
allowed transitions, durable interrupt reasons, recovery decisions, the owner of
each run family, the split between the infrastructure outcome and the agent
report, the accounting rules for failures/backoff/budget/cycleCount, and the
list of MVP adapters.

Boundary: the module **only describes and derives**. It does not connect to the
runtime and does not change `chat-run-service.js`, `delegation-service.js`,
`workspace-watcher*.js` or any route. All functions are deterministic; `now` is
injected by the caller, so the result does not depend on the clock or on
external state.

Two hard rules that later leaves must not bypass:

1. **The server determines `infraOutcome` and the run lifecycle.** An agent
   report (outcome and verdict) never overwrites them.
2. **Never automatically reattach a non-alive run.** `reattach` is the only
   automatic decision and only for `liveness === 'alive'` with an adapter that
   supports reattach.

## State matrix + transition table

States (`RUN_LIFECYCLE_STATES`, exactly 8):

| State | Classification |
| --- | --- |
| `starting` | active (`RUN_ACTIVE_STATES`) |
| `running` | active (`RUN_ACTIVE_STATES`) |
| `waiting` | active (`RUN_ACTIVE_STATES`) |
| `completed` | terminal (`RUN_TERMINAL_STATES`) |
| `cancelled` | terminal (`RUN_TERMINAL_STATES`) |
| `interrupted` | terminal for the attempt and recoverable at the same time (`RUN_TERMINAL_STATES`, `RUN_RECOVERABLE_STATES`) |
| `unknown` | indeterminate (`RUN_INDETERMINATE_STATES`) and recoverable (`RUN_RECOVERABLE_STATES`) |
| `recovering` | indeterminate (`RUN_INDETERMINATE_STATES`) |

- `RUN_RECOVERABLE_STATES = ['interrupted','unknown']`
- `normalizeRunLifecycleState(value)` returns the state or `''` for an unknown
  value (including an empty one).
- `canTransitionRunLifecycle(from, to)` checks the edge; a self-transition is
  always allowed, and `completed` and `cancelled` are final (apart from self).

Transition table (`yes` = allowed; a self-transition is omitted in the cells and
described as always allowed):

| from \ to | starting | running | waiting | completed | cancelled | interrupted | unknown | recovering |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `''` (no run) | yes | - | - | - | - | - | - | - |
| `starting` | self | yes | yes | yes | yes | yes | yes | - |
| `running` | - | self | yes | yes | yes | yes | yes | - |
| `waiting` | - | yes | self | yes | yes | yes | yes | - |
| `completed` | - | - | - | self | - | - | - | - |
| `cancelled` | - | - | - | - | self | - | - | - |
| `interrupted` | - | - | - | yes | yes | self | - | yes |
| `unknown` | - | - | - | yes | yes | - | self | yes |
| `recovering` | yes | yes | yes | yes | yes | yes | yes | self |

Notes:

- `completed` and `cancelled` cannot return to an active state
  (`completed -> running` is forbidden).
- `interrupted -> recovering` and `unknown -> recovering` are allowed; only
  `recovering` may start a new attempt.
- `unknown -> starting` is forbidden — the interruption must first be confirmed
  and `recovering` entered.

## Reasons and recovery decisions

Interrupt reasons (`RUN_INTERRUPT_REASONS`):

| Reason | Meaning |
| --- | --- |
| `server_restart` | server restart; comes from `DELEGATION_INTERRUPT_CODES` |
| `starting_timeout` | the run did not start within the start window; from `DELEGATION_INTERRUPT_CODES` |
| `running_orphan` | orphaned running run; from `DELEGATION_INTERRUPT_CODES` |
| `interrupted_restart` | the child died with a previous process instance (restart evidence); not recoverable; from `DELEGATION_INTERRUPT_CODES` |
| `process_gone` | process killed externally (SIGKILL / OOM) |
| `unknown` | undetermined cause; conservative fallback |

The first three codes are imported from `lib/delegation-status.js`
(`DELEGATION_INTERRUPT_CODES`), so they cannot drift apart. `process_gone` and
`unknown` are additions of the recovery contract. `normalizeRunInterruptReason(value)`
returns a known reason or `'unknown'`.

Decisions (`RUN_RECOVERY_DECISIONS`): `reattach`, `resume_session`, `new_attempt`,
`manual_only`, `unsupported`, `not_recoverable`.

Allowed decisions per reason (`RUN_RECOVERY_DECISION_BY_REASON`):

| Reason | Allowed decisions |
| --- | --- |
| `server_restart` | `reattach`, `resume_session`, `new_attempt`, `manual_only` |
| `starting_timeout` | `resume_session`, `new_attempt`, `manual_only` |
| `running_orphan` | `reattach`, `resume_session`, `new_attempt`, `manual_only` |
| `review_cancel_stuck` | `not_recoverable` |
| `interrupted_restart` | `not_recoverable` |
| `process_gone` | `resume_session`, `new_attempt`, `manual_only` |
| `unknown` | `not_recoverable` |

`resolveRecoveryDecision({ reason, adapter, liveness })` applies a deterministic
priority:

1. missing/unsupported adapter → `unsupported`, `automatic: false`,
2. reason without a recovery path (e.g. `unknown`) → `not_recoverable`,
3. `liveness === 'alive'`, `adapter.reattach === true` **and** `reattach` is in
   the allowed decisions for the reason → `reattach`, `automatic: true`,
4. `liveness !== 'alive'`, the adapter has `resumeStrategy` **and**
   `resume_session` is allowed for the reason → `resume_session`
   (`automatic: false`),
5. otherwise → `manual_only` (`automatic: false`) when it is allowed for the
   reason.

`review_cancel_stuck` is explicitly `not_recoverable` (unlike `cancel_unconfirmed`,
which keeps `manual_only`): the review job was already force-finished with its slot
released after a cancel stuck in `cancelling`, and a review is read-only, so the safe
path is a new review rather than resuming or reattaching the stuck run.

The `RUN_RECOVERY_DECISION_BY_REASON` map is authoritative: the resolver never
returns a decision outside the list assigned to the reason (exceptions:
`unsupported`, `not_recoverable`).

The result has the shape
`{ decision, reason, adapter, liveness, automatic, rationale }`, where
`adapter` is the harness identifier (`''` when absent). `new_attempt` is
sometimes a legal decision in the reason map, but the resolver does not choose it
by itself — that belongs to a higher policy layer (R14). `liveness` accepts
`alive`, `dead`, `unknown` (an unknown value normalizes to `unknown`).

## Run family owners

`RUN_FAMILY_OWNERS` maps a run family to exactly one server-side owner. Recovery
does not duplicate the owner's claim/queue logic — it asks the owner.

| Family | Owner | Module | Purpose |
| --- | --- | --- | --- |
| `chat` | `chat-run-service` | `lib/chat-run-service.js` | start/cancel/probe of a regular chat run and the per-chat lock |
| `delegation` | `delegation-service` | `lib/delegation-service.js` | delegation lifecycle, parent slot, one-time continuation |
| `watcher` | `workspace-watcher` | `lib/workspace-watcher.js` | cycles, lease, failures and workspace backoff |
| `mailbox` | `delegation-mailbox` | `lib/delegation-mailbox.js` | delivery of reports and messages to the parent |
| `workflow` | `delegation-workflow` | `lib/delegation-workflow.js` | plan/implement/review/fix loop state and budget |
| `scout` | `workspace-watcher-scout` | `lib/workspace-watcher-scout.js` | workspace scanning and findings proposals |

- `ownerOfRunFamily(family)` returns the entry or `null`.
- `assertSingleRunFamilyOwner()` verifies that every family has exactly one
  entry with a non-empty `owner` and that no owner handles two families; it
  returns `true` and throws on a violation.

## Infra outcome vs agent report

This is the most important split in the contract.

- `RUN_INFRA_OUTCOMES` (set exclusively by the server): `none`, `accepted`,
  `completed`, `cancelled`, `interrupted`, `unsupported`, `unknown`.
- `RUN_AGENT_OUTCOMES` (agent report): `unspecified`, `success`, `failure`,
  `blocked` — matching `DELEGATION_TASK_OUTCOMES`.
- `RUN_AGENT_VERDICTS`: `unspecified`, `PASS`, `FAIL`, `BLOCKED`, `conflict`.

`resolveRunOutcome({ infraOutcome, agentOutcome, agentVerdict })` returns
`{ outcomeSource: 'server', infraOutcome, agentOutcome, agentVerdict, accepted,
countsAsFailure, terminal, rationale }` and applies these rules:

1. `accepted` only when `infraOutcome === 'completed'` **and** `agentVerdict` is
   not `FAIL`/`BLOCKED`/`conflict` **and** `agentOutcome` is not
   `failure`/`blocked`.
2. An agent report never changes `infraOutcome` or the lifecycle; `PASS` alone
   does not save an `interrupted`/`unknown`/`cancelled` run.
3. `interrupted`, `unsupported`, `unknown` → `accepted: false`,
   `countsAsFailure: true` (even with `PASS`).
4. `conflict` → `accepted: false`.
5. `cancelled` is terminal but is not a failure.
6. `countsAsFailure` describes only the infrastructure counter. An agent
   `failure`/`blocked` on `completed` blocks acceptance but **does not**
   increase the failures counter (see below).

`terminal` is true only for `completed`, `cancelled`, `interrupted`.

## Accounting rules

`RECOVERY_ACCOUNTING_RULES` is the machine-readable description;
`nextRecoveryAccounting` is a deterministic reducer (it accepts `previous`,
`event.kind` and `now`).

Event kinds (`RECOVERY_EVENT_KINDS`): `cycle_start`, `cycle_success`,
`infra_failure`, `interrupted`, `agent_failure`, `user_cancel`.

- **failures** — increase only on `infra_failure` and `interrupted`. Reset on
  `cycle_success`. `agent_failure`, `user_cancel` and `cycle_start` do not change
  the counter.
- **backoff** — `computeRecoveryBackoffMs({ failures })`:
  `min(baseMs * 2^(failures-1), capMs)` for `failures > 0`, otherwise `0`. By
  default `baseMs = 30000` (`RECOVERY_BACKOFF_BASE_MS`), and
  `capMs = 3600000` (`RECOVERY_BACKOFF_CAP_MS`). Backoff is set on
  `infra_failure`/`interrupted` as `backoffUntil = now + backoff`, and cleared
  on `cycle_success` and `user_cancel`.
- **budget** — `budgetUsed` always equals `cyclesStarted`. An infra failure
  **does not** return budget; `budgetRefunded` stays `false` (no event in the
  MVP performs a refund).
- **cycleCount** — `cycle_start` increments both `cyclesStarted` and
  `cycleCount` at the same time; failures stay unchanged.
- **cycleStart** — `cycle_start`: `cyclesStarted+1`, `cycleCount+1`, failures
  unchanged.
- **agentReport** — `agent_failure`: no effect on failures/backoff/budget; only
  `lastEventKind` is recorded.

`nextRecoveryAccounting` returns
`{ failures, consecutiveFailures, backoffUntil, cyclesStarted, cycleCount,
budgetUsed, budgetRefunded, lastEventKind }`. `now` is injected, so
`backoffUntil` is a number (epoch ms) or `null`. An unknown event is ignored and
keeps the previous `lastEventKind`.

## MVP adapters

`RECOVERY_MVP_ADAPTERS` — six families with a full recovery contract in the MVP:

| Harness | `resumeStrategy` | `reattach` |
| --- | --- | --- |
| `sdk` | `agent_resume` | no |
| `claude` | `session_resume` | no |
| `codex` | `resume_thread` | no |
| `qwen` | `session_resume` | no |
| `deepseek` | `session_id` | no |
| `opencode` | `server_reattach` | yes |

Every entry has `requiresCrashValidation: true`, `validation: 'pending'` and
`scope: 'mvp'`. This means auto-recovery cannot be enabled until leaf R19 (live
SIGKILL) passes the crash test for the specific harness and SDK version. Leaf R7
builds the adapter validation matrix (`adapterValidation`).
`describeRecoveryAdapterContract` returns only the declared state
(`validation: 'pending'`, `requiresCrashValidation: true`) plus the static
`context` and `live_executor` scenarios. The `waiting`, `cancel` and
`missing_transcript` scenarios stay `pending` (`notRun`) until an explicit
`evaluateRecoveryAdapterValidation({ harness, store })` computes them against
the injected store (or `{ openEphemeralStore: true }` in the tools).
`buildRecoveryAdapterValidationRecord` only assembles those fields and performs
no I/O. The contract view does not open SQLite. The matrix itself does not
replace the crash suite. Only `opencode` can `reattach` to a live executor; the
others resume a saved session after the process dies.

Outside the MVP (`RECOVERY_DEFERRED_ADAPTERS`): `codebuddy`, `openrouter`,
`mistral`, `zai` and `mimo`, with the rationale in
`RECOVERY_DEFERRED_ADAPTER_REASONS`:

- `codebuddy` — after process loss the runner creates a fresh live session
  without resuming the saved ID; full tool recovery requires separate work.
- `openrouter` — reconstructs only user/assistant text, without the full
  tool-call/tool-result loop; it does not qualify for auto-resume.
- `mistral` — like `openrouter`: reconstructs only user/assistant text, without
  the host's full tool-call/tool-result loop; it does not qualify for
  auto-resume.
- `zai` — like `openrouter`: hydrates the chat from history
  (`buildOpenRouterConversationFromHistory`), so after a restart it reconstructs
  only text without the full tool-call/tool-result loop; it does not qualify for
  auto-resume.
- `mimo` — like `openrouter`: hydrates the chat from history
  (`buildOpenRouterConversationFromHistory`), so after a restart it reconstructs
  only text without the full tool-call/tool-result loop; it does not qualify for
  auto-resume.

`resolveRecoveryAdapter(harness)` returns the MVP entry or
`{ supported: false, harness, scope: 'unsupported' }` for an unknown harness.

## Adapter contract in runtime and explicit transcript loss

`describeRecoveryAdapterContract(harness)` is the single place the runtime uses
(leaf R6: `lib/chat-run-service.js#getChatRunAdapterCapabilities`,
`lib/chat-run/kernel-adapter.ts`) so that the capability table is not
duplicated. It returns the fields of the static MVP entry plus the signals the
adapter must expose: `supported`, `scope`, `deferred`, `reattach`,
`resumeStrategy`, `requiresCrashValidation`, `validation`, `transcriptLost`,
`transcriptLossReason`, `adapterValidation` (the R7 matrix: key
`{harness}@{sdkVersion}`, overall status `pending` until R19; the contract view
does not run store scenarios — `waiting` / `cancel` / `missing_transcript` are
`pending` until `evaluateRecoveryAdapterValidation` receives an explicit store),
and for a transport without a contract — `decision: 'unsupported'` and
`infraOutcome: 'unsupported'` (the same tokens as `RUN_RECOVERY_DECISIONS` and
`RUN_INFRA_OUTCOMES`; `unsupported` is not redefined).

A transport outside the MVP (`codebuddy`, `openrouter`, `mistral`, `zai`, `mimo`)
or an unknown one is never returned as a silent `false` that the caller could
read as "the run has ended". It gets an explicit `unsupported`.

The rule of "explicit handling of context loss, missing sessions" (section 3 of
the plan) is a metadata signal, not a decision. `RUN_TRANSCRIPT_LOSS_REASONS`
tokens:

| Token | Meaning |
| --- | --- |
| `none` | the same live executor context continues (reattach) |
| `room_missing` | observed: the room holding the transcript is gone (process restart) |
| `no_live_run_match` | observed: the room exists but does not hold a live run matching the durable `adapterRunId` |
| `fresh_turn_in_saved_session` | resume starts a new turn in the saved session ID, not in the middle of the transcript |
| `no_recovery_contract` | the transport did not declare a recovery contract at all |

Statically: only `opencode` (`server_reattach`, `reattach: true`) gives
`transcriptLost: false`; every other MVP strategy is a new turn in the saved
session, so `transcriptLost: true` with the `fresh_turn_in_saved_session` token;
a transport without a contract gets `no_recovery_contract`. In the lookup by
`requestId`, two observed signals are added: `room_missing` (the room is gone)
and `no_live_run_match` (the room exists but does not hold a live run matching
the durable `adapterRunId` — no `currentRun` or a different `id`). None of these
tokens unlocks a resume — the decision is still computed by
`resolveRecoveryDecision`, and the `accepted` gate remains in R5.

## Evidence classification and `unknown` re-probe (R8)

`lib/recovery/recovery-boot.ts` classifies the evidence of a durable run at boot
into one of seven states (`BOOT_EVIDENCE_STATES`):

| State | When | Durable reason |
| --- | --- | --- |
| `completed` | durable completion proof or lifecycle `completed` | `terminal_proof` |
| `cancelled` | durable Stop request or lifecycle `cancelled` | `user_cancel` |
| `still_running` | liveness `alive` | `alive_executor` |
| `waiting` | durable waiting record or lifecycle `waiting` | `waiting_for_input` |
| `unsupported` | adapter without a recovery contract | `unsupported_adapter` |
| `interrupted` | liveness `dead` with an interrupt reason | `dead_executor` |
| `unknown` | no proof of life or death | `unknown_liveness` |

The order is deterministic: a terminal fact beats liveness, and `unknown` is the
absence of proof — never a guess. `reason` and `interruptReason` are written
durably on the run row as `bootEvidence` (a CAS patch through the R2 store).

**Changed contract (G1, todo `b9c5a098`).** The evidence write used to be
metadata only. Now, when the classification is `interrupted` (`dead_executor`)
and the run is `starting` or `running`, the same CAS (`expectedState` guarded)
moves the run to the lifecycle state `interrupted` with a durable reason (the
run's own interrupt reason, or `process_gone` when none is known). Everything
else keeps its state: `unknown` liveness stays `starting`/`running` with
`bootEvidence.state = unknown` (re-probed on the bounded plan below), a live
executor stays `running` (`still_running`), `waiting` stays `waiting`, and a
cancel request is classified `cancelled` without moving the run. A lost CAS is
reported per row in `errors`; the pass never overwrites a newer revision.

`unknown` gets a bounded re-probe plan (`resolveBootUnknownReprobe`): a delay of
`base * 2^(attempt-1)` with a hard `capMs`, and after
`BOOT_UNKNOWN_MAX_REPROBES` attempts it escalates
(`unknown_reprobe_exhausted`) instead of treating the run as alive or dead.

## Graceful shutdown: restart intent and checkpoint (R9)

A SIGTERM/SIGINT alone is not proof of a planned restart (it may be a user stop),
and a SIGKILL/crash runs no handler at all. The only proof is a durable
**restart intent** written by the shutdown handler into the recovery store
(`recovery_meta`, key `restartIntent`, `lib/recovery/recovery-shutdown.ts`).

- Write: only for `SIGTERM`/`SIGINT`, synchronously in phase 1 (after
  `beginServerShutdown`). `reason` is `planned_restart` only when an explicit
  `serverRestartScheduled` (`/api/dev-actions`, restart after an update) was set;
  a plain `SIGTERM`/`SIGINT` without a scheduled restart is `user_stop`, because
  the signal alone does not prove a restart. Fields: `reason`
  (`planned_restart` | `user_stop`), `signal`, `writtenAt`, the process
  `instanceId`/`generation`/`pid`, and a bounded deadline (`deadlineMs`,
  120 s by default). Fatal paths (crash, server error) write no intent.
- Boot (R8) first reads the intent without deleting it and attaches it as
  `bootEvidence.restartIntent` to every classified run, and deletes it (read +
  delete in one `BEGIN IMMEDIATE` transaction) only after a successful
  classification. A classification error therefore does not lose the evidence,
  and an intent read error is logged and treated as "no intent" (it does not
  degrade the runtime). A missing intent, an expired one (older than the
  deadline + margin), one from the future, one from the same instance, or a
  corrupt one is ignored (and deleted). The intent is evidence only: it does not
  change `state`, `reason`, `interruptReason` or the R1 retry accounting.
- Without an intent (SIGKILL/OOM) a run is classified from liveness alone
  (`unknown` / `server_restart`), never as planned.
- Start lock: from the beginning of shutdown `canAcceptNewRun()` refuses new chat
  runs (`startChatRun` → `server_shutting_down`), delegation starts, the prompt
  queue drain and watcher cycle starts (`server_shutting_down`).
- Bounded flush: room history buffers (2 s buffer) are written, and every open
  run gets a `shutdownCheckpoint` (`interruptedBy`, `inProgress: true`) — a
  metadata patch through CAS without a state change, so an in-flight run does
  not become completed. Everything runs under a hard timeout
  (`runBoundedShutdownFlush`); errors are logged and do not block the exit.

## Shared recovery owner of a delegation family (R10)

`lib/recovery/recovery-family.ts` defines a **family**: the parent
(orchestrator) chat together with its child delegations, mailbox and workflow
state. The family key is `family:<parentChatId>` (`resolveFamilyKey`); a row
without a parent forms a single-member family `family:orphan:<id>`.

- **One owner.** After a restart only the parent side performs family recovery.
  The claim is a CAS in `recovery_meta` (key `familyRecovery:<familyKey>`,
  `BEGIN IMMEDIATE`) with the owner token and generation from R3
  (`claimFamilyRecovery`): `claimed` / `renewed` / `takeover` (a claim of another
  token or an older generation) / `stale_generation` (same token, a newer stored
  generation); without a live R3 lease the result is `fence_rejected`. Mutual
  exclusion of two live owners comes from the R3 fence: the second owner never
  reaches the CAS. Boot releases (deletes) the lease in `finally`, and the next
  boot starts at generation 1 with a new token — so a claim under another token
  is always a `takeover` (its owner is released or dead), with `outboxDone`
  preserved. A child has no token of its own, so it cannot pass
  `authorizeFamilyRecoveryAction` — boot never starts or retries a child on its
  own (`autoStartChildIds` is always empty).
- **Outbox.** `reconcileDelegationsOnBoot({ deferOutbox: true })` does not drain
  the mailbox; `runFamilyBootRecovery` does that only after R8 has finished
  (`bootReconciled`). Only `queued` rows are redelivered; `uncertain` is never
  sent automatically. The ids of delivered messages are stored in the claim
  (`outboxDone`), so a second pass or a takeover does not duplicate them.
  Redelivery is limited to the row ids of that family (`onlyIds` in
  `drainChatMailbox`); a family without a queued outbox is not claimed, and an
  error in one family (`family_failed`) does not stop the others. A message
  without a linked delegation belongs to the recipient's family
  (`family:<toChatId>`). When the R3 lease is not acquired
  (`family-recovery-skipped`), boot skips the outbox pass; the rows stay `queued`
  and the worker's normal drain empties them.
- **Claims and budgets.** Recovery does not change workflow rounds, token/cost
  budgets, deadlines or todo/leaf claims (`budgetMutations` is empty).
  Accounting stays as in R1: an infrastructure interruption counts once, with no
  extra failures.
- **`server_restart` retry.** The one-time manual retry
  (`interruptContinuedAt`) is kept. The plan only reports the eligible rows
  (`restartRetryEligibleIds`); a row with `runStoppingAt` is not eligible.
- **Slots.** A family with an active row (also one with unknown liveness) or with
  an unconfirmed stop (`runStoppingAt`) stays occupied (`slotOccupied`); a run
  that is still stopping is not resumed (`noResumeChildIds`).

## Workspace Watcher cycle interrupted by a restart (R11)

After a restart, boot-reconcile closes orphaned watcher cycles so that a single
crash does not switch autopilot off.

- **`interrupted_restart` outcome.** A neutral close outcome. An orchestrator
  cannot report it; it only appears as `closeOutcome` / `cycleChats.outcome`.
  It does not increase `failures`, does not arm `backoffUntil`, does not count
  toward `maxConsecutiveFailures` and does not reset existing `failures`
  history. Decision log entry: `cycle_interrupted` (no notification).
- **Evidence, not a blanket rule.** A cycle closes neutrally only with positive
  restart evidence (`lib/workspace-watcher-restart-evidence.js`): the process
  instance token stored on the slot at reservation (`instanceId`, from
  `getProcessInstance()`) differs from the current one. Watcher cycles are NOT
  written to the recovery registry (its `requestId` is `req_<uuid>`, a
  `cycleId` is a bare UUID), so the registry is not an evidence source. A
  cycle that already reported an outcome is never reclassified.
- **One rule on every path.** Boot/heartbeat reconcile and the runtime
  reconcile both call `isWorkspaceWatcherCycleRestartInterrupted`: a cycle is
  restart-interrupted only with a foreign instance token AND a probe proving the
  room absent (gone or idle). `busy` / `unknown` liveness is never treated as
  finished, whatever the token. The verdict matrix is pinned in
  `tests/workspace-watcher-restart-interrupt.test.js`.
- **Done-todo success exception.** If the cycle has no report but its todo is
  already `done`, the work finished before the process died: the cycle closes
  as `success` (`cycle_success`) instead of `interrupted_restart`, and keeps no
  failure history. This check takes precedence over the neutral close.
- **Other slots.** A slot without a token (legacy), and a live-instance cycle
  that ended without a report, stay `failure` + backoff.
- **Dead-instance slots.** A slot with a foreign `instanceId` whose room is
  absent from the adapters (`state_missing` / `adapter_missing`) or confirmed
  idle does not wait for the `starting` phase deadline or the 2-minute
  `cycle_room_gone` grace, and does not hold `maxParallel`. `unknown` (e.g.
  `adapter_error`) and `busy` still hold the slot, also for a dead instance.
- **planOnly and cleanup.** An interrupted plan-only cycle closes the same
  neutral way, releases pending `planRequests` (unless a draft is waiting for a
  human) and returns the todo to `ready` through the existing release path.
  Release clears `claimedByChatId`, `claimedAt` and `claimLeaseUntil`; a plan
  is never approved. Single-delegation `server_restart` retry is unchanged.
- **Out of scope for R11.** UI status (R13), process supervisor (R16), OOM
  visibility (R17).

## Server-side manual resume (R12)

`lib/recovery/recovery-resume.ts` (`createRecoveryResumeService().resumeRun`) is
the only path of the "Resume" action; the scheduler (R15) uses the same service.
Endpoint: `POST /api/chats/:id/runs/:logicalRunId/resume` with the body
`{ expectedState, expectedRevision, idempotencyKey, confirmUnknown? }`
(`lib/routes/recovery-resume-routes.js`, authenticated like the other `/api/*`
actions). There is no separate WS action. Result:
`{ status, path, attemptId, reason, logicalRunId, revision, replayed }`.

- **CAS + idempotency.** Resume is allowed only from `interrupted` (or `unknown`
  with `confirmUnknown: true`). A mismatched `expectedState` /
  `expectedRevision` gives `conflict`. The claim `-> recovering` is one
  `transitionRun` CAS that also stores the key and the result
  (`resumeRequests`); replaying the same key returns the stored result
  (`replayed: true`) and does not launch a second time — also after a restart. A
  failed launch is remembered too: another try needs a new key.
- **Per-run exclusion.** The `recovering` state is a lock: a second concurrent
  resume gets `already_recovering`.
- **Path by adapter capability (R6/R7).** `reattach` only for a provably live
  executor and an adapter with `canReattach`; `new_turn_same_session` when the
  adapter resumes the saved session (`canResumeSession` + a non-empty
  `sessionId`); otherwise `unsupported` with `details.transcriptLost`. A live
  executor without reattach gives `executor_alive` (no second turn next to a
  live one). Unknown liveness or the `unknown` state needs `confirmUnknown`
  (`liveness_unknown`). Never a silent fresh session.
- **No replay.** The continuation prompt is the fixed
  `RESUME_CONTINUATION_PROMPT` (it asks to check workspace changes and processes
  first); the previous prompt/command is never sent again.
- **Gates.** `cancelled` (durable Stop), `waiting` (a question/approval stays
  with the human), `stopping` (`runStoppingAt`), `family_blocked` (R10 family
  owner; only the `chat` family by default), `limit_blocked`
  (limits/permissions/budgets injected through `checkLimits`), `not_resumable`
  (an active/`completed` state).
- **Fencing.** The CAS binds a new `activeAttemptId`; `checkRunFence({
  logicalRunId, attemptId })` rejects a callback of an older attempt with the
  code `run_mismatch`. **Partly wired (todo `e43108ed`):** after an accepted
  start `resumeRun` calls `recordResumedAttemptAck` (which goes through
  `checkRunFence`), linking the new `adapterRunId` to the new attempt and moving
  the run `starting` → `running`. The fence protects ONLY the ack (the
  `starting` → `running` link). The terminal goes through
  `noteChatRunFinished`, which does NOT call `checkRunFence`: protection against
  an old turn is the `chatId` + `adapterRunId` match
  (`acceptance.adapterRunId` / `resumeAdapterRunId`). `finishResumedAttempt`
  (fence + terminal) stays as a fenced finish for adapters that report the
  terminal with an attempt id; in production it has no caller. An ack of an old
  attempt gets `run_mismatch` and does not change the run. A `resumed` result
  carries `fencing: "enforced"` (or `"unlinked"` when the adapter returned no
  run id — the run then stays in `starting`). Another key for a `running` run
  gives `not_resumable`/`state_running`.
- **Reattach (production).** The liveness probe uses the exact
  `run.acceptance.adapterRunId`; a missing id => `liveness_unknown` (never
  "alive"). Real reattach is R19, so a live executor gives `reattach_deferred`
  (`reason: liveness_confirmed_only`) with no claim and no change of
  state/attemptId.
- **Session.** `new_turn_same_session` requires the chat's current session to
  equal `run.sessionId`; otherwise `unsupported` / `session_changed`.
- **Race with Stop/sweep.** Right before the launch the Stop ledger and the state
  are checked; Stop => `cancelled` / `cancelled_during_resume`, a lost claim =>
  `superseded` (no launch). A stored result in flight is `in_progress`; a replay
  after a crash while the run is still `recovering` returns `in_progress`,
  otherwise `superseded` — never `resumed`. Boot releases a dead owner's
  `recovering` claim (G5), so that `in_progress` does not outlive a restart.
- **Errors and revisions.** Only allowlisted codes reach the result/HTTP
  (`toSafeErrorCode`, otherwise `launch_failed`/`internal_error`), never a raw
  `err.message`. The stored result carries the revision after the finish, so
  after `launch_failed` the client retries with a new key and that revision.
- **Limits (gap).** Before the claim only the update/shutdown gate and the chat
  check (archive) run; concurrency limits/budgets are not enforced on this path
  yet.
- **Accounting (R1).** Resume does not change failures/backoff/budget/cycleCount
  or the one-time `server_restart` delegation retry (`interruptContinuedAt`); the
  interruption was counted once when it was written.

## Versioning

- `RECOVERY_SCHEMA_VERSION` — bumped when the persisted recovery record shape
  gains/changes a field. Currently `1`.
- `RECOVERY_CONTRACT_REVISION` — human-readable version of the matrix/document.
  Currently `2026-10-08.3`.

Every change to a value in `lib/recovery/recovery-contract.ts` requires:

1. bumping the appropriate version (schema and/or revision),
2. updating this document so it stays in sync with the module,
3. keeping `tests/recovery-contract.test.js` green, which among other things
   checks for the presence of the revision and all states in this document.

## Restart policy (R14)

`chatRestartRecoveryMode: off | manual | automatic` (default `manual`; a missing
or invalid value migrates to `manual` without rewriting the file). Per-workspace
override: `chatRestartRecoveryWorkspaces[workspaceFolder]`. API:
`GET /api/settings` returns `chatRestartRecovery { mode, workspaces }`;
`PATCH /api/settings` accepts `chatRestartRecoveryMode` and
`chatRestartRecoveryWorkspace { workspaceFolder, mode }` (an empty/null `mode`
removes the override). Code: `lib/recovery/recovery-policy.ts`.

- `off`: manual resume is refused (`limit_blocked: recovery_mode_off`).
- `automatic`: only a confirmed interruption (`interrupted`, `accepted` proof, a
  recoverable reason, liveness `dead`), an adapter with `canResumeSession` and a
  stored `sessionId`. `unknown` is never automatic. The resume goes through the
  R12 service (actor `automatic`), so fencing, Stop, waiting, family and limits
  still apply. The scheduler (R15, section below) calls `resumeRunIfAutomatic`.
- The settings UI is not part of this leaf (API only).

## Client-less auto-resume scheduler (R15)

`lib/recovery/recovery-scheduler.ts` (`createRecoveryScheduler`, `tick()`,
`start()`): a server-side loop, independent of the browser/WebSocket. Every tick
scans the `chat` family runs in the `interrupted` state and hands them to
`resumeRunIfAutomatic` (R14 → the R12 service, actor `automatic`). The default /
`manual` / `off` policy resumes nothing; `unknown` is never automatic.

- **One attempt.** The idempotency key is per run (`auto-<logicalRunId>`), and a
  run with a stored `auto-` result is skipped (`attempt_already_made`). A failed
  start is not retried, also not after a restart.
- **Maximum age.** An interruption older than `maxAgeMs` (10 min by default,
  counted from the `updatedAt` of the `interrupted` row) is left for a human
  (`too_old`).
- **Concurrency.** At most `maxConcurrent` (1 by default) resumes at once:
  automatic runs in `recovering`, `starting` or `running` + starts from the
  current tick; the counter pages the whole store (a single read is capped at
  1000), and the rest waits (`concurrency_limit`).
- **Separate backoff.** A transient refusal (limits, `stopping`, family, liveness
  not yet confirmed `dead`) is not an attempt: the run is deferred exponentially
  (`backoffBaseMs` 15 s, cap 240 s, `maxDeferrals` 5, then
  `deferrals_exhausted`). The backoff state lives in process memory, independent
  of the failures/backoff accounting of runs, the watcher and delegations; the
  durable bound across a restart is the maximum age.
- **Gates.** Stop/cancel, a pending question/approval, `runStoppingAt`, the
  workflow/watcher lock (injected `isLocked`) are checked before the claim; mode,
  adapter, family, cost/harness limits and chat permissions are enforced by
  R14/R12.
- A tick is non-reentrant (a call in flight = `tick_in_progress`) and optionally
  gated by `isReady` (e.g. after boot reconciliation finished).
- The runtime boot starts the scheduler only after the durable recovery,
  delegation and watcher reconcile and after the lifecycle reached `ready`. A
  degraded boot does not start it, and the first shutdown phase stops the timer
  and blocks further claims/starts of a tick already in flight (it does not
  cancel a start already handed to the adapter). The production lock skips
  active delegation chats and watcher cycle chats; lock read errors fail closed
  and are logged. The tick uses the same adapters, settings, liveness,
  permissions, shutdown/update gate and harness/model lockouts as manual resume.

## Rollout (R19c)

State as of this document: this section describes what **actually works today**
for manual resume, not the target contract. Line references are as of 2026-10-21
(branch `cretli/todo/53efd61e…`); each one names the function next to the number
so it can still be found after the code drifts. Update the references together
with the code.

### Policy mode

- The default mode is `manual`: `DEFAULT_CHAT_RESTART_RECOVERY_MODE = 'manual'`
  (`lib/recovery/recovery-policy.ts:20`). A missing, mistyped or unknown value
  normalizes to `manual` (`normalizeChatRestartRecoveryMode`,
  `lib/recovery/recovery-policy.ts:48-50`); an invalid per-workspace override is
  dropped and the workspace inherits the global mode
  (`getChatRestartRecoverySettings`, `:57`).
- `automatic` is strictly opt-in: `evaluateAutomaticResume` returns
  `mode_<mode>` for every mode other than exactly `automatic`
  (`lib/recovery/recovery-policy.ts:132-136`). `off` also refuses manual resume
  (`checkLimits` in `lib/routes/recovery-resume-routes.js:81-83`).
- Tests for the defaults: `tests/recovery-policy.test.js` (cases "default and
  migration" and "rollout defaults", including `resumeRunIfAutomatic` with empty
  settings making no attempt) and `tests/recovery-policy-settings-routes.test.js:71-74`
  (`GET /api/settings` returns `{ mode: 'manual', workspaces: {} }`).

### Adapters and SDK validation (R7)

- Manual resume is enabled by adapter capability, not by validation results. The
  manual service reads only `canResumeSession` / `canReattach`
  (`selectPath` in `lib/recovery/recovery-resume.ts:249,257`; capabilities from
  `resolveEffectiveRecoveryCapabilities`, `lib/chat-run/adapter-capabilities.ts:37-38`);
  no resume path checks `validation` / `overallStatus`.
- MVP adapters with a declared strategy: `sdk`, `claude`, `codex`, `qwen`,
  `deepseek` (a new turn in the saved session) and `opencode` (`server_reattach`,
  the only one with `reattach: true`) — `RECOVERY_MVP_ADAPTERS`,
  `lib/recovery/recovery-contract.ts:750-755`.
- **No adapter has the status `validated`.** Every entry carries
  `validation: 'pending'` (`defineMvpAdapter`,
  `lib/recovery/recovery-contract.ts:738`), and the R7 matrix computes at most
  `pending` or `failed` plus `enableGateValidation: 'pending'`
  (`composeHarnessValidationRecord` path,
  `lib/recovery/adapter-validation.ts:582-583`). Validation results are not
  persisted anywhere, so there is no list of "validated SDK versions".
- The R19a/R19b crash suites use a mock adapter (a mocked `codex` transport), not
  the real SDKs, so they do not change the validation status of any harness.
- SDK versions this section was written against (installed versions read at
  runtime by `readInstalledSdkVersion`, `lib/recovery/adapter-validation.ts:107`;
  key format `harness@version`): `@cursor/sdk` 1.0.40 (`package.json:213`),
  `@openai/codex-sdk` 0.160.0 (`package.json:218`), `@qwen-code/sdk` 0.1.8
  (`package.json:219`), `@deepseek-ai/dsh` 0.1.2-alpha.5 (`package.json:214`),
  `@opencode-ai/sdk` 1.18.26 (`package.json:201`) and
  `@anthropic-ai/claude-agent-sdk` 0.3.284
  (`optional-packages/claude-agent-sdk/package.json:6`). These are installed
  versions, not validated ones; the ranges in `package.json` are caret ranges, so
  another install yields another version key (package specs:
  `RECOVERY_MVP_HARNESS_SDK_SPECS`, `lib/recovery/adapter-validation.ts:62-93`).
- Out of the MVP: `codebuddy`, `openrouter`, `mistral`
  (`RECOVERY_DEFERRED_ADAPTERS`, `lib/recovery/recovery-contract.ts:759`;
  rationale in the "MVP adapters" section above). Full tool recovery for
  CodeBuddy and OpenRouter is not supported.

### Automatic (opt-in)

- **Opt in.** Set `chatRestartRecoveryMode` to exactly `automatic` globally, or
  per workspace through `chatRestartRecoveryWorkspaces` (Settings, restart
  recovery). Anything else resolves to `manual`. Automatic is never the default.
- **Per-adapter enable gate (R20).** Policy `automatic` is necessary but not
  sufficient: `evaluateAutomaticResume` answers `adapter_not_validated` unless
  the adapter's R7 record has `overallStatus` and `enableGateValidation` both
  `validated` (`isRecoveryAdapterValidated` in `lib/delegation-runtime-boot.js`,
  injected as `isAdapterValidated`). Unknown harnesses, missing injection and
  lookup errors stay blocked. Since no adapter is validated today, automatic
  currently resumes nothing in production; manual resume is unaffected.
- **Never auto-resumed.** Stop/cancelled runs, runs waiting for a question or
  approval, `unknown`-liveness runs and runs in state `unknown`, runs whose
  interruption is older than 10 minutes, runs owned by an active delegation or
  watcher cycle, and delegation-family runs. Delegation retry (the one-time
  `server_restart` continuation; `running_orphan` and `starting_timeout` stay
  non-retryable) is unchanged and not duplicated by the chat scheduler.
- **Attempt limits.** One automatic attempt per run, ever (stable idempotency
  key `auto-<logicalRunId>`; a failed launch is not retried, also not after a
  restart); one concurrent automatic resume by default; transient refusals back
  off exponentially (15 s base, 240 s cap) and are abandoned after 5 deferrals.
  A broken recovery store makes the tick fail and be logged
  (`recovery-scheduler-tick-failed`); the next try is the fixed 15 s interval,
  nothing resumes and nothing spins.
- **Current limitation (G1, todo `b9c5a098`).** Runs killed in flight never
  reach `interrupted`, so the scheduler cannot see them; only runs that were
  interrupted through the normal finish path are candidates.
- Tests: `tests/recovery-automatic-rollout.test.js`,
  `tests/recovery-scheduler.test.js`, `tests/recovery-policy.test.js`.

### Known limitations (current state)

- **Manual resume currently works only for runs that reached `interrupted`
  through the normal finish path.** The only code that sets `interrupted` for a
  chat run is `noteChatRunFinished` on a status other than `finished` / cancel
  (`lib/chat-run/chat-run-recovery.ts:252`, called from
  `lib/agent-harness/room-kernel.ts:428`, `lib/sdk/cursor-agent-sdk-ws.ts:753`
  and `lib/delegation-run-bridge.js:134`) and the return from a failed resume
  launch (`finishClaim` in `lib/recovery/recovery-resume.ts:368,410`). Nothing
  writes the state `unknown`.
- **G1 (todo `b9c5a098`) — closed.** Boot now CAS-moves a `starting`/`running`
  run with dead-executor proof to `interrupted` (reason `process_gone` by
  default), so manual resume accepts it (`resumed`, not `not_resumable`). Runs
  with `unknown` liveness stay `starting`/`running`, so they still answer
  `not_resumable` until a lifecycle `unknown` state is written; a lifecycle
  `unknown` run needs `confirmUnknown` and, while its boot re-probe plan is
  not exhausted (`bootEvidence.escalated !== true`), is refused with
  `liveness_unknown`/`reprobe_pending`. Pinned by
  `tests/recovery-chat-run-crash.test.js` ("during a tool call", "live executor
  survives", "unknown acceptance") and the matrix in `tests/recovery-boot.test.js`.
- **G5 (todo `14d2641a`) — closed.** A crash during a resume leaves the run in
  `recovering` (the claim CAS in `execute`). **Changed contract:** boot now
  reads `recovering` runs too (`listOpenRuns({ includeRecovering: true })`,
  used only by `classifyAndRecordOpenRuns` without an explicit `listRuns`; the
  shutdown sweep and the periodic `runDueBootReprobes` still list only
  `starting`/`running`/`waiting`). A `recovering` run found at boot lost its
  claim holder, so the claim is released in the same CAS as the evidence write:
  dead-executor proof -> `interrupted`; no proof -> lifecycle `unknown`; both
  with durable reason `process_gone` (or the classified interrupt reason). A
  live executor (`still_running`) keeps `recovering`, and a claim whose holder
  the optional `claimHolderAlive(run)` callback reports alive (or whose probe
  throws) is skipped entirely. After the release a replay of the same
  idempotency key returns `superseded` / `claim_not_finished` instead of
  `in_progress`, and a new key can resume again (`interrupted`, or `unknown`
  with `confirmUnknown`). Pinned by `tests/recovery-chat-run-crash.test.js`
  ("G5 closed" x2 and "G5 negative").
- **G2 (todo `36441f4c`) — intentional, documented.** Production boot
  (`lib/delegation-runtime-boot.js`) calls `classifyAndRecordOpenRuns` with
  `restartIntent` and `probeLiveness` only. The optional `cancelRequested`,
  `terminalProof` and `waiting` callbacks are deliberately NOT wired: a Stop and
  a terminal result are written durably into the run row (`cancelled` /
  `terminalProof`), so a run still `starting`/`running` at boot has neither, and
  an in-memory log line (e.g. `FINISH`) is not a durable proof. Evidence is
  therefore derived from lifecycle state plus the liveness probe, and the
  default (`false`) of each callback applies. Pinned by the "G2" test in
  `tests/recovery-chat-run-crash.test.js`.
- **G4 (todo `36441f4c`) — intentional, documented.** A known launch refusal
  (e.g. `recipient_busy`) is recorded as terminal `cancelled`
  (`launch_refused:<code>`) and may be retried. An UNKNOWN adapter start error
  (`recordChatRunStartFailed`) is not proof that no executor started, so the run
  stays `starting` with acceptance `unconfirmed`; there is no automatic
  escalation to `failed`. Boot probes liveness and records evidence but keeps
  the lifecycle state `starting` (only a `recovering` row is moved to `unknown`),
  and a retry of the same request is refused with `acceptance_unconfirmed`. The
  row leaves `starting` only when a later liveness probe proves the executor
  dead (`interrupted`, then resumable). While liveness stays unknown it remains
  `starting` + `unconfirmed` (re-probes and escalation evidence only): resume
  accepts just `interrupted` / `unknown` runs, so even `confirmUnknown` yields
  `not_resumable` / `state_starting`. There is no operator resume path for this
  case today; that part of G4 is intentionally left undecided. Pinned by "launch error ...
  (G4)" in `tests/recovery-chat-run-crash.test.js`.
- **Lost claim after launch (FU-1, todo `e43108ed`).** If Stop lands while the
  continuation is starting, the claim CAS fails (`superseded` /
  `claim_lost_after_launch`); the service then records a durable
  `cancelLaunched` (production: `cancelChatRun` with reason `internal_cancel`) for
  ONLY the just-started adapter run id. No durable run cancel is written (a real
  Stop already recorded its own; a sweep or another resumer must not become a
  Stop), so a later resume stays possible. With an empty adapter run id nothing
  is cancelled (an empty id would mean "the chat's current turn").
  The window between the last pre-launch check and the executor start is the same
  CAS: a Stop in it is caught after the launch and cancelled this way.
- **`state_missing` is dead only for `interrupted` runs (FU-2).** The resume
  route's probe maps `state_missing` (no state for the run in this process) to
  `dead`. The probe contract does NOT treat that as proof the executor ended; it
  is accepted only because the run is already `interrupted`. An `unknown` run
  still needs explicit `confirmUnknown`.
- **Pre-claim limits (item 4 — documented gap, not added).** `checkLimits`
  (`createRuntimeRecoveryResumeService`) already checks policy mode, harness
  enabled, harness usage limit, update/shutdown admission and chat permission
  before the claim, and `startChatRun` refuses a busy recipient. There is no
  concurrency or budget accounting for MANUAL resume (the scheduler has
  `maxConcurrent` for automatic resume); adding it needs a product decision on
  the budget source, so it is left as a known gap.
- **Watcher W3 (todo `6db870c0`).** A `startChatRun` rejection classified as
  `rollback` (e.g. `recipient_busy`) still counts a failure, arms backoff and
  keeps the cycle budget (`clearCycleRow` call in the catch branch of
  `startWorkspaceWatcherCycle`, `lib/workspace-watcher-cycle.js:1118`, without
  `countFailure:false` / `rollbackReserve:true`).
- **Watcher W4 (todo `1ed043e3`).** Two concurrent boot reconciles can rarely
  return `database is locked` in `errors` (returned, not thrown) while each slot
  is still closed exactly once (per-row catch in
  `reconcileWorkspaceWatchersOnBoot`, `lib/workspace-watcher.js:1872`). Both W3
  and W4 are pinned in `tests/workspace-watcher-crash.test.js`.
- A watcher cycle with a live child delegation is held after a restart until the
  children are terminal, and the dead process's lease then blocks a new start for
  the freed slot (`lease_held`); see `tests/workspace-watcher-crash.test.js`.

### Operator checklist

1. Process supervisor (R16): install the unit from
   `systemd/cretli.service.example`; restart, stop and start-limit behaviour is
   described in `docs/server-diagnostics.md:39-60` ("Process supervision"). Without
   it a SIGKILL/OOM does not bring the server back.
2. OOM diagnostics (R17): the external monitor (`scripts/memory-orphan-monitor.js`
   with `systemd/cretli-memory-monitor.*.example`) and the markers in
   `oom-markers.jsonl`, `docs/server-diagnostics.md:7-11,124`.
3. Watcher history repair after a restart (R18):
   `node scripts/workspace-watcher-history-repair.js --restart-at <iso>` (preview
   by default; writing requires `--apply` and the CAS arguments printed by the
   preview), `scripts/workspace-watcher-history-repair.js:1-14`.
4. Crash suites before changing the mode: `node --test tests/recovery-chat-run-crash.test.js`
   and `node --test tests/workspace-watcher-crash.test.js`; their review-verify
   catalog ids are `recovery-chat-run-crash` and `workspace-watcher-crash`
   (`lib/sdk/sdk-review-verify.ts`).
5. Leave `chatRestartRecoveryMode` at `manual`. Enable `automatic` only after G1,
   G5 and fencing are resolved and the specific harness has been validated on
   the installed SDK version; until then it stays opt-in.
