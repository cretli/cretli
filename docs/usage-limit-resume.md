# Usage-limit auto-resume and the wake-up scheduler

When a provider usage limit stops a chat run or a delegation, Cretli records a
durable *wake-up* and, after the limit has reset, resumes the work exactly once
under a bounded saving policy. The mechanism is deterministic server code (no
LLM). Usage-limit resume is the first *kind* of a generic wake-up substrate.

## 1. Generic wake-up substrate

| Piece | File | Role |
| --- | --- | --- |
| Store | `lib/persist/wakeups-persist.js` (`data/wakeups.json`, `v: 1`) | One row per episode: common envelope (`id`, `kind`, `subjectType`, `subjectId`, `state`, `reason`, `attempts`, `pendingAttempt`, `resumeRequestId`, `pausedAt`) plus flat kind fields. Rows of an unknown kind are kept untouched. |
| Scheduler | `lib/wakeup-scheduler.js` | Tick loop, state machine, persist-before-call, outcome classification. It never references a chat or a delegation. |
| Kind | `lib/usage-limit-resume-executor.js` | The chat/delegation-specific half of `usage_limit_resume`. |
| Policy | `lib/usage-limit-resume-policy.js` | Pure: due instant, candidate order, decision table. |
| Settings | `lib/usage-limit-resume-settings.js` | `usageLimitResume` block in `config.json`. |
| Boot | `lib/delegation-runtime-boot.js` | Registers the kind and starts/stops the scheduler next to the delegation runtime worker. |

### Adding a kind

Register an object with `createWakeupScheduler(deps).registerKind(kind)`:

```js
{
  kind: 'my_kind',
  getSettings(),                       // { enabled, maxPerTick, ... }
  normalize(row),                      // row -> record | null (unknown shape is ignored)
  selectCandidates({ records, now, settings }), // -> [{ record, dueAt }] in the order to act
  prepare(record, ctx),                // read-only preflight + I/O inputs for decide
  decide({ record, now, dueAt, settings, prepared }),
                                       // -> { action: resume|defer|expire|block|skip|cancel, reason }
  buildRequestId(record, attempt),     // optional idempotency token, persisted before the call
  execute(record, ctx),                // -> { outcome: resumed|refund|blocked|ambiguous, reason }
  resolveCrash(record, ctx),           // -> { outcome: resumed|refund|blocked, reason }
  // Optional metadata for the generic wake-up UI (the scheduler never reads it):
  label, description,                  // display strings; `label` falls back to `kind`
  settingsSchema,                      // { key: { type: 'boolean'|'integer', min?, max?, default } }
  describeRow(record, ctx),            // pure -> { dueAt: ISO|null }; `ctx = { now, settings, deps }`
}
```

`describeRow` exists because `dueAt` is never stored; a kind without it, or a row
whose due time cannot be derived, reports `dueAt: null`.

`tests/wakeup-scheduler.test.js` drives a fake second kind through the same
tick with no usage-limit code; copy it as a template. A new kind also adds its
name to `WAKEUP_KINDS` in the store so pruning knows it.

## 2. State machine

`armed` -> `resuming` -> `resumed`; `armed` -> `cancelled | expired | blocked`;
`resuming` -> `armed` (refund) or `blocked`. `resumed`, `cancelled`, `expired`
and `blocked` are terminal and pruned after 7 days.

Tick order (60 s interval, `unref`, generation guard, no overlapping tick):

1. Resolve every `resuming` row through the kind's `resolveCrash`.
2. For each due `armed` row (snapshot taken before step 1, so a refunded row
   waits for the next tick): `prepare` and `decide` with **no writes**.
   `defer` and `skip` leave the row `armed` and never consume an attempt;
   `expire`, `block` and `cancel` persist the terminal state and reason.
3. Only `resume` counts against `maxPerTick`, and the budget is **per kind**.
   Candidates are ordered by `dueAt`, then `pausedAt`, then `id`.
4. Immediately before the persist-before-call write the scheduler re-reads the
   row and skips it unless it is still `armed`; the write itself is a
   compare-and-set on `state: armed` (`patchWakeup` `expectState`), so a pause
   cancelled while an earlier candidate was executing is never resurrected.

`dueAt` is never stored: it is `resetAt + marginMs + jitter`, where the jitter
is `sha256(id) % jitterMs`, so changing the margin never leaves a stale schedule.

### Persist-before-call

Before any provider call the scheduler writes `state: resuming`,
`attempts + 1`, `pendingAttempt` and `resumeRequestId`
(`ulresume:<pauseId>:<attempt>`). Then `execute` runs and the result is
classified:

| Outcome | Store effect | Used for |
| --- | --- | --- |
| `resumed` | `resumed`, `attempts = pendingAttempt`, `lastResumeAt` | proven acceptance only (`accepted: true` / `ok: true`) |
| `refund` | back to `armed`, `attempts - 1` | a definitive refusal: `accepted:false`, `adapter_unavailable`, `recipient_busy`, `still_active`, `update_in_progress`, `slot_*`, `runtime_not_ready`, `chat_archived`, `delegation_archived`, `parent_archived` |
| `blocked` | terminal `blocked` + reason | `chat_not_found`, `start_failed` (also when `retry` already assigned a fresh `attemptId` before the failed start), a missing delegation, an unrecognized `retry` refusal (`retry_refused`) |
| `ambiguous` | stays `resuming` | timeouts, transport errors, a throwing `execute`; never refunded or re-sent in the same tick |

## 3. Decision table (`decideResumeAction`)

First match wins: `disabled` (skip) -> `unconfirmed_reset` (block; only
`provider` and `provider-message` clocks are trusted, `fallback-ttl` is not) ->
`before_due` (defer) -> missing delegation (block `session_not_resumable`) ->
`subject_moved` (cancel) -> `chain_exhausted` (block) -> `premium_model`
(block) -> `limit_active` (the lockout is read with `getHarnessUsageLimit({ latest: true })`,
the active row for the pair that clears last; defer to that reset + margin + jitter; expire
with `catch_up_window_missed` when that is past `dueAt + catchUpMs`) ->
`catch_up_window_missed` (expire) -> `parent_busy` (defer; for a chat anything
but a known idle liveness probe — busy **or unknown** — defers) ->
`session_not_resumable` (block, no chat-run adapter) -> `delegations_disabled`
(skip) -> `due` (resume).

The premium gate prices the run's own `subjectModel` with
`estimateModelCostTier`; an empty, `auto` or unknown model counts as tier 5, so
an account-wide lockout (whose row has `model: ''`) cannot hide a premium model.

## 4. Delegation preflight

For a delegation, `prepare` re-reads the row before any write:

- row missing -> `blocked` (`session_not_resumable`);
- status is no longer `failed`, or `attemptId` differs from the record's
  `subjectAttemptId` -> `cancelled` (`subject_moved`), and `retry` is **not**
  called. A human already retried it; the scheduler never resurrects it.

The resume itself is `delegationService.retry(delegationId)`, which re-runs all
slot, parent, model and archive gates.

## 5. Crash recovery (tri-state)

A row left in `resuming` after a crash is resolved by the kind and the default
answer is never "send it again".

- **Chat.** `lookupChatRunRequest` is tri-state: `accepted:true` -> `resumed`;
  `accepted:false` -> `armed` (refunded); `null` or a throw is *no answer*
  (only the kernel and opencode adapters implement `lookupRequest`). On no
  answer `probeChatRunLiveness` decides, and **only `busy: true` is proof**:
  busy -> `resumed`. **Idle** (`known: true, busy: false`, which is also the
  state before the resume was sent) or `known: false` -> terminal `blocked`
  with `start_uncertain`; no second turn is sent.
- **Delegation.** A different non-empty `attemptId` than the recorded
  `subjectAttemptId` -> `resumed` (`retry` assigns a fresh attempt on the same
  row), unless the row is already `failed` with that new id, which may be our
  own failed start -> `blocked` (`start_uncertain`); the same id -> `armed` (refunded); the row missing -> `blocked`
  (`session_not_resumable`).

## 6. Settings (`config.json` -> `usageLimitResume`)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | master switch; off means no record, no resume |
| `marginMs` | 120000 | wait after the provider reset |
| `jitterMs` | 90000 | deterministic per-record spread |
| `maxChain` | 2 | consecutive automatic resumes per subject |
| `maxPerTick` | 3 | resumes started per tick |
| `catchUpMs` | 900000 | how late a resume may still start |
| `allowPremium` | `false` | allow tier-5 models |
| `resumeDelegations` | `true` | resume delegations, not only chats |

The resumed chat turn uses a short fixed prompt (`RESUME_CHAT_PROMPT`), never a
replay of the original one.

`PATCH /api/usage/limit-resume/settings` merges a partial body over the stored
block and runs it through `normalizeUsageLimitResumeSettings` (unknown keys are
dropped, numbers clamped to the bounds above); `GET` on the same path returns
the effective block. Both are refused for widget and MCP-integration access.

## 6b. Settings UI

Settings → Usage → "Auto-resume after limit reset" (`usageLimitResume.*` i18n
keys): the enable toggle, the numeric fields, `allowPremium` and
`resumeDelegations`, a Save button, and the list from `GET /api/usage/limit-resume`
(`harness/model`, subject model, reset time, state, reason). Only `armed` rows
have a Cancel action (`POST /api/usage/limit-resume/:id/cancel`). All row text is
escaped before it reaches the DOM.

### Generic wake-up API and Settings section

`lib/routes/wakeups-routes.js` (same access restriction as the usage-limit
routes: widget and MCP-integration callers get 403). The scheduler is read per
request (`getWakeupScheduler()`), because it boots after the routes register.

| Endpoint | Result |
| --- | --- |
| `GET /api/wakeups?kind=&state=` | `{ items: [{ id, kind, subjectType, subjectId, state, reason, attempts, dueAt\|null, createdAt, pausedAt }] }`; an unknown `kind` filter yields an empty list. |
| `GET /api/wakeups/kinds` | `{ kinds: [{ kind, label, description, enabled, settings, settingsSchema }] }` |
| `PATCH /api/wakeups/kinds/:kind/settings` | Delegates to the kind's settings module (`usage_limit_resume`: `usageLimitResume` in `config.json`, clamped like `/api/usage/limit-resume/settings`); 404 unknown kind, 400 `invalid_settings` / `unsupported_settings`. |
| `POST /api/wakeups/:id/cancel` | Cancels an `armed` row; 404 unknown id, 409 `not_armed` otherwise. |
| `GET /api/wakeups/status` | `{ running, tickMs, lastTickAt\|null, kinds: [{ kind, maxPerTick }], jobs: [] }` from `scheduler.getStatus()`. `lastTickAt` is the scheduler clock at the end of the last completed tick (null before the first tick or after `stop()`); `jobs` stays empty until periodic jobs exist. |

Settings → Wake-ups (`app_front/features/wakeups/`) lists the kinds (settings
rendered from `settingsSchema`), the rows with kind/state filters, Cancel for
`armed` rows, and the scheduler status. Decision: the usage-limit card **stays**
in Settings → Usage (`/api/usage/limit-resume*` is unchanged) and links to the
new section.

## 6c. Chat notices and notifications

Every settled state change produces at most one chat notice and one
notification; a disabled feature produces neither.

| Event | Chat notice (chat subjects only) | Notification (`system`) |
| --- | --- | --- |
| `armed` | "paused until HH:MM UTC" (written by the detection hook, only when the row is newly created) | none |
| `resumed` | "Resumed automatically after the usage limit reset" | `Run resumed after the usage limit reset` |
| `blocked` (`chain_exhausted`, `premium_model`, `session_not_resumable`, `unconfirmed_reset`, ...) | "blocked (<reason>)" | `Automatic resume blocked` |
| `blocked` / `start_uncertain` | "may have started before the restart; not repeated" | same title, uncertainty wording |
| `expired` | "reset while the server was offline" | `Usage limit reset was missed` |

- Notices go through `appendChatNotice` of `chat-history-service.js`
  (`lib/usage-limit-resume-notices.js`), awaited and best-effort; a failure is
  logged and never reaches the run path or the tick. The arm notice is
  fire-and-forget because `broadcastRoom` is synchronous.
- The scheduler calls `deps.notify` and `deps.announceChat` once per settled
  state (`resumed`, `blocked`, `expired`), from the same tick and the crash
  resolution path; `lib/delegation-runtime-boot.js` wires them. No second poller.
- Notifications use the fingerprint `usage-limit-resume:<pauseId>:<state>`, so a
  replay publishes nothing. The `usageLimitResume` notification-centre
  preference (default `true`, server-side only, no UI toggle yet) suppresses
  them; web push is best effort.

## 6d. Periodic jobs

Recurring, subject-less sweeps are not wake-up rows (rows are single-fire
episodes). They run on `lib/periodic-job-runner.js`, a separate runner with no
dependency on the wake-up scheduler, so it starts in both the normal and the
degraded boot path of `lib/delegation-runtime-boot.js` (`getPeriodicJobRunner()`).
A job has `id`, `label`, `intervalMs`, `settingKey`, `isEnabled()` and `run()`;
a boot run fires right after start, a disabled tick only reads settings, a run
still in flight makes the next tick count as `skipped`, and a throwing run is
recorded in `lastError` without stopping the timer.

`GET /api/wakeups/status` returns them in `jobs` (`id`, `label`, `intervalMs`,
`enabled`, `settingKey`, `running`, `lastRunAt`, `lastResult`, `lastError`,
`skipped`). The first job is `chat_auto_archive` (`chatAutoArchive`; result is
`{ archived, scanned }` counts only). The Wake-ups tab lists jobs read-only;
they are edited in Settings -> Chat & agents -> Archiving.

## 7. Watcher interaction

When every `policy.allowedHarnesses` entry is whole-harness limited, the
watcher's `nextCycleAt` equals the earliest reset instead of a past-due time
(`wait_harness_usage`, see `docs/workspace-watcher.md`).

A second, LLM-free kind built on this substrate is documented in
`docs/wakeup-condition-check.md` (`condition_check`).
