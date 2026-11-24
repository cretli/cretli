# Internal operator — runs, briefing, limits (stage 2c)

Decision record: [operator-internal-decision.md](operator-internal-decision.md). This page
describes what the code in `lib/operator/` does today. The internal operator is **off by
default** (`operatorInternal.enabled = false`); the owner switches it on.

## Variant B: the owner thread is a view

The single owner thread (`ensureOperatorChat`, row flag `operatorChat: true`, id in
`operator_meta.internal_operator_chat_id`) only receives host notices (`appendChatNotice`).
Conversation continuity is kept per adapter session, so instead of re-using one session the
**scheduler starts every run in a new hidden chat** (`pickPurpose: operator_run`,
`operatorRunId`, `operatorParentChatId`, `isTemporary`). A run never sees a raw transcript,
only the briefing.

`ensureOperatorChat` is idempotent and safe under concurrency (one in-flight resolution). The id
is reserved durably before the row is created, so a crash between the two steps, or the owner
deleting the thread, converges on the same id on the next call (the thread comes back empty).

## Scheduler (`operator-scheduler.js`)

- One tick = ingest journal events → supervise our running run → start the next run. Ticks run
  every 15 s and ~250 ms after a journal write. Boot (`delegation-runtime-boot.js` →
  `operator-boot.js`) starts the scheduler **only when `enabled` is true at boot**.
- At most one run in the whole Cretli (the single `running` row of `operator_runs`), one
  workspace per run. A batch is ready after `coalesceMs`, or at once for priority 0–1 events.
- Priority: 0 `owner_message`; 1 `watcher_stopped`, `server_restarted`; 2 `review_failed`,
  `needs_rescope`, `needs_human`, `blocked`, `operator_test`; 3 `integration_ready`.
- Executors are limited to `claude` and `sdk` (the harnesses with a hard read-only gate).
  Any other pick ends the run as `failed/no_safe_harness`; no pick is `failed/no_model`. There
  is no fallback to an unsafe harness, and no chat is created.
- The run starts through `startChatRun({ mode: 'plan', origin: { kind: 'system', subtype: 'operator' } })`.
- End: `operator_report` recorded → `done` (events `acked`); `runDeadlineMs` (15 min) →
  `deadline`; chat idle without a report → `missing_report`; per-run token cap → `token_cap`.
  A failed run returns its events once, the next failure parks them. A restart leaves the lease
  to expire; the next process interrupts the run (`recoverInterruptedWork`) with the same
  once-then-park rule.
- After every run the owner thread gets one notice: the report summary, proposal titles, a
  one-line **tool-call summary** (from `operator_audit`, denied calls counted) and the tokens.

## Briefing (`operator-briefing.js`)

At most 24,000 characters. Fixed English prompt (observe and propose, finish with
`operator_report`), then trigger events, workspace state, the last 20 owner messages (for owner
messages), open notes, summaries of the last 3 runs and open proposals. Everything that is not
fixed host text — notes, summaries, proposals, owner text, event summaries and the results of
`chat_history` / `chat_search` — sits in
`<untrusted source=… id=…>` envelopes: control and bidi characters removed, `<`/`>` escaped (no
tag break-out), attributes restricted to a safe alphabet, 2,000 characters per item, and only
whole envelopes are added until the limit. The refs are stored in `operator_runs.untrusted_refs`.

### Tool results

Results of text-bearing builtin reads (`chat_history`, `chat_search`, `chat_show`, `todo_list`,
`todo_show`, `todo_next_ready`, `wmem_list`, `lesson_list`, `scout_findings`) returned to an
operator run chat are wrapped on the result path of the builtin catalog
(`wrapOperatorBuiltinResult`, after the gate allowed the call): same escaping and control-character
removal, 8,000-character cap, and the structured copy is dropped so the raw text cannot be read
around the envelope. Other callers and other tools are unchanged.

### Executor selection and failure handling

The picker is called with a hard `excludeHarnesses` list (every known transport except `claude`
and `sdk`); `harnesses` alone only seeds the cold-start catalog and does not filter. An exception
after the run slot was claimed ends the run as `failed/start_failed` and returns its events. A
running row with no chat/deadline is bounded from `started_at`. Turning the operator off at
runtime stops new runs but the live run keeps being supervised until it ends.

## Budgets and circuit breaker (`operator-limits.js`, settings `operatorInternal`)

| Setting | Default |
| --- | --- |
| `runsPerHour` / `runsPerHourPerWorkspace` | 12 / 6 (priority 0–1 skip the hourly limit) |
| `perRunTokens.triage` / `.diagnosis` | 60,000 / 250,000 |
| `dailyTokenBudget` | 1,500,000 |
| `triageOnlyAt` | 0.8 — at 80% every run is triage |
| `reserveFraction` | 0.1 — after 100% only priority 0–1 may use the reserve |
| `circuitBreakerFailures` | 3 |
| `runDeadlineMs` | 900,000 |

**The token numbers are estimates to be confirmed by the owner after a week of real usage.**
`integration_ready` (and `operator_test`) runs are always triage-only.

Tokens come from the usage ledger per run chat. **The ledger lags a run** (seconds to minutes),
so the per-run cap is re-read at every supervision tick, but the daily figure can undercount the
newest run; a burst can therefore overshoot the daily budget by roughly one run.

Circuit breaker: a **persistent** counter (`operator_meta`) of consecutive counted failures
(`deadline`, `missing_report`, `token_cap`, `start_failed`). Not counted: restart
interruptions, `no_safe_harness`, `no_model`, owner cancel, budget skips. A completed run resets
the counter; each run counts once. At the threshold the operator pauses event-triggered runs
(priority 0 owner messages still run) and posts one notice; `clearBreaker` resumes.

## Retention

`operator_events` follow the journal retention; `operator_audit` keeps 30 days / 50,000 rows;
run rows and owner messages are kept; hidden run chats are temporary chats and follow the
regular chat auto-archive/retention. The queue holds at most `maxPending` (200) pending events.

## Owner thread, routes and UI (stage 2d)

All routes live under `/api/operator/internal/` (`lib/routes/operator-internal-routes.js`) and are
**human-only**: a signed-in browser session, and for every mutating call the CSRF token. Agent
sessions, MCP integrations and widget callers get `403 operator_human_only` on every route,
including `GET`. Nothing here is exposed as an agent tool.

| Route | Effect |
| --- | --- |
| `GET /status` | Chip data: `state` (`off`, `paused`, `budget`, `running`, `queued`, `idle`), `queued`, breaker, running run |
| `POST /message` `{ text, source? }` | Stores an owner message (≤ 4000 chars), shows it in the thread, records an `owner_message` event (priority 0). `409 operator_disabled` while the operator is off. `source: voice` is reserved for stage 6 |
| `POST /pause`, `POST /resume` | Owner pause: event-triggered runs wait (`skipped: owner_paused`), owner messages still run. Resume also clears the circuit breaker |
| `POST /test-event` `{ workspaceFolder }` | Synthetic `operator_test` event only (the kind is not an input). Needs an enabled operator, a loopback peer and a workspace of the registry; at most 10 per rolling hour (`429 test_event_rate_limited`). The run it triggers counts toward the hourly run limit and the daily token budget |

### Pinned thread

* Archiving the thread through the API answers `409 operator_chat_pinned` (guard in
  `chat-archive-guard.js` plus an early check in `PATCH /api/chats/:id`); auto-archive skips it.
* `chat_archive` / `chat_delete` on it from an agent are refused (`operator_chat_pinned`), and
  `DELETE /api/chats/:id` refuses agent sessions, MCP clients and widgets for it. The owner may
  still delete it; it comes back empty under the same id (stage 2c).
* Deleting a **run** chat while its run is live ends the run as `interrupted/chat_deleted`: its
  events return once (then park), the slot is freed and the circuit breaker is not touched. The
  scheduler does the same when it finds the run chat missing.

### UI (`app_front/features/chat/operatorChat.js`)

The thread is pinned above the Workspace section with an “Operator” badge and the state chip,
is hidden from the regular chat lists and has no archive/delete control (sidebar, toolbar,
mobile action bar). The composer sends through `POST /message` and never starts an agent run.
Texts are in `operatorChat.*` (pl/en).
