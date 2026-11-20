# Scheduled checks (`condition_check` wake-up kind)

A scheduled check is a deterministic, LLM-free follow-up on the generic wake-up
scheduler (`lib/wakeup-scheduler.js`, see `docs/usage-limit-resume.md`). The
server evaluates a **named predicate** every tick (60 s). Only when it holds,
the kind starts **one fresh chat** for a todo with a short brief. The chat that
created the check is never resumed, and no model is called while the condition
is unmet.

Code: `lib/wakeup-condition-check.js` (kind),
`lib/wakeup-condition-predicates.js` (registry),
`lib/wakeup-condition-check-service.js` (create/list/cancel/run-now),
`lib/wakeup-condition-check-notices.js` and
`lib/notifications/condition-check-producer.ts` (notifications),
`lib/condition-check-settings.js` (settings),
`lib/mcp/builtin/check-tools.js` (MCP).

## Row shape

Stored flat in `data/wakeups.json` with `kind: "condition_check"`: `title`,
`predicate { id, params }`, `action { type: "start_todo_chat", todoId, brief
(<= 1500 chars), workspaceFolder }`, `createdAt`, `expiresAt` (default 14 days,
clamped to 1 minute..90 days), `startedChatId`, plus the common envelope
(`state`, `reason`, `attempts`, ...).

## Behaviour

- `prepare` evaluates the predicate read-only and keeps `{ at, met, current,
  target, error }` in an **in-memory** map (exposed as `details.progress` by the
  read API; empty after a restart until the next tick). `prepare` and `decide`
  perform no store writes.
- `decide`: setting disabled -> `skip`; past `expiresAt` -> `expire`; unknown
  predicate -> `block` (`unknown_predicate`); predicate error -> `defer`
  (`predicate_error: ...`, never stops the tick); not met -> `defer`; met but
  the configured harness is under a usage-limit lockout -> `defer`; otherwise
  `resume`.
- `execute` reuses the todo-start primitive (`startTodoAgent` with
  `forceNew: true`, the same path as `todo_start` / "Continue in a new chat"),
  persists `startedChatId`, then sends `brief` + the standard todo preamble
  with `startChatRun`. Exactly-once comes from the persisted `startedChatId`:
  a retry after a refund reuses that chat, and crash resolution
  (`resolveCrash`) only accepts proof (accepted request or busy run); an unknown
  state becomes `blocked` / `start_uncertain` and never starts a second chat.
- Request id: `condcheck:<id>:<attempt>`, with an `:r<n>` suffix after every
  refund (a refund hands the attempt back, so the suffix keeps the retry from
  deduping into the refused request).
- Refusals: `recipient_busy`, `adapter_unavailable`, `update_in_progress`,
  `runtime_not_ready`, `slot_*`, tree-blocked / worktree-busy -> refund;
  `todo_not_found`, `chat_archived`, `chat_not_found`, `start_failed` and other
  start errors -> `blocked`.

## Predicate registry

Closed registry in `lib/wakeup-condition-predicates.js`; a stored row only
names a predicate id plus plain-JSON params, never code.

| id | params | holds when |
| --- | --- | --- |
| `delegations_finished_since` | `transport`, optional `assignment`, `sinceMs`, `minCount` (1..1000) | at least `minCount` delegation records of that transport have `finishedAt` after `sinceMs` |

Predicates read delegation records only (no usage-journal scans per tick).

### Adding a predicate

1. Add an entry to `CONDITION_PREDICATES` with `description`,
   `validate(params) -> { ok, value } | { ok: false, error }` and
   `evaluate(params, deps) -> { met, current, target }`. It must be pure,
   read-only and cheap (one bounded pass per tick); a throw is treated as
   `defer`.
2. Take new data sources through `deps` (wired in
   `lib/delegation-runtime-boot.js`), never by importing stores directly.
3. Add tests next to `tests/wakeup-condition-check.test.js` (met, unmet,
   invalid params) and mention the predicate in the table above.

## Settings

`conditionCheck` block in `data/config.json`, edited through
`PATCH /api/wakeups/kinds/condition_check/settings`: `enabled` (default `true`;
`false` suppresses evaluation, execution and notifications), `maxPerTick`
(1..5, default 2), optional `harness` / `model` for the started chat (empty =
workspace default; a locked-out harness defers the check).

## REST

All routes reject widget and MCP-integration callers with 403.

- `POST /api/wakeups/condition-check` - create. Body: `{ todoId, predicate:
  { id, params }, brief?, title?, expiresInMs?, workspaceFolder? }`. Returns
  201 with the item; 400 with a `code` (`unknown_predicate`, `invalid_params`,
  `brief_too_long`, `todo_not_found`, ...).
- `GET /api/wakeups?kind=condition_check` - list (`details.progress`,
  `details.startedChatId`, `details.expiresAt`).
- `POST /api/wakeups/:id/cancel` - cancel an armed check.
- `POST /api/wakeups/:id/run-now` - evaluate immediately through the scheduler
  (same `prepare` + `decide` + persist-before-call as a tick). Predicate met ->
  the chat starts once and the item is returned. Not met -> 409
  `condition_not_met` with the current `progress`, no state change. Not armed
  -> 409 `not_armed`. It never bypasses the predicate.

Example (placeholder ids):

```json
POST /api/wakeups/condition-check
{
  "todoId": "<todo-id>",
  "title": "Measure usage coverage",
  "predicate": {
    "id": "delegations_finished_since",
    "params": { "transport": "codex", "sinceMs": 1767225600000, "minCount": 20 }
  },
  "brief": "Re-measure usage coverage now that enough delegations finished."
}
```

## MCP

`check_schedule` (create), `check_list`, `check_cancel`. None of them calls a
model. `check_schedule` and `check_cancel` are mutating (blocked in Plan/Ask);
`check_list` is read-only.

## Notifications

Kind-owned `system` notifications, once per settled state (store dedupes by
fingerprint, so a replay publishes nothing). No chat notice is written: a check
has no subject chat, the started chat's first message is the brief.
`armed` and `cancelled` publish nothing. `conditionCheck.enabled=false`
publishes nothing; the notification-centre `system` preferences apply
unchanged.

| State | Severity | Title | Fingerprint |
| --- | --- | --- | --- |
| `resumed` | info | Scheduled check met: started a chat | `condition-check:<id>:resumed` |
| `blocked` | warning | Scheduled check blocked | `condition-check:<id>:blocked` |
| `expired` | info | Scheduled check expired without firing | `condition-check:<id>:expired` |

Boot wiring composes the usage-limit and condition-check announcers with
`composeAnnouncers` (`lib/wakeup-announcers.js`); each ignores foreign kinds.

## UI

Settings -> Wake-ups shows a "Scheduled checks" strip above the generic rows
(hidden when there are no checks): title, progress `current / target` ("Not
evaluated yet" after a restart), expiry, `Run now` and `Cancel`; finished rows
link to the started chat. A 409 `condition_not_met` shows the progress instead
of an error.
