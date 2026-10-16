# Workspace Watcher review gate — contract

Status: **implemented contract** (`lib/workspace-watcher-review-gate.js`,
`lib/workspace-watcher-review-gate-guard.js`; deviations listed in §11). Companion documents:
[workspace-watcher.md](workspace-watcher.md) (watcher architecture),
[todo-review-contract.md](todo-review-contract.md) (the `todo.review` snapshot
this gate reads).

All `file:line` references were re-checked against the tree this document ships
in. They are anchors for the implementer, not a promise that the lines never
move; when code changes, re-check with the symbol name.

## 0. Purpose and non-goals

Today the rule "a leaf is `done` only after an independent review PASS" is a
prompt instruction (`lib/workspace-watcher-prompt.js:575`, `:592`, `:606`). Any
caller of `updateTodo` can still write `status: done`. This contract replaces
the instruction with a **server-side check**, scoped to Workspace Watcher
cycles.

Non-goals:

- Manual `done` by a human in the browser session is never blocked.
- Plan-only cycles, Scout scans, `model_pick`, rankings, the semantics of
  `todo.review`, and scheduler selection/claim logic do not change.
- Automatic resumption of worktree leaves after `review_missing` is out of
  scope (a separate todo if needed).

**Default is `off`: with the default policy no existing flow changes** (§3).

## 1. Facts the design rests on (verified)

| # | Fact | Where |
|---|------|-------|
| F1 | `updateTodo` does not know its caller and runs under the shared watcher/todos file lock. | `lib/persist/todos-persist.js:1298-1299` |
| F2 | Any `patch.status` clears `blockedReason`. | `lib/persist/todos-persist.js:1454` |
| F3 | A `done` todo drops its claim; the only `done` validation is "all subtasks done". | `lib/persist/todos-persist.js:1474`, `:1544-1550` |
| F4 | A transition to `done` triggers the leaf-material checkpoint. | `lib/persist/todos-persist.js:1565-1572` → `lib/todo-leaf-material.js:757-768` → `:547` |
| F5 | REST `PATCH /api/todos/:id` forwards `body.chatId` as a **data** field, not as identity. | `lib/routes/todos-routes.js:460-466` |
| F6 | MCP `todo_update` reaches `client.updateTodo` without passing the caller chat as a parameter (only as `linkedChatId`/changelog `chatId`). | `lib/mcp/builtin/todo-tools.js:531-552`; in-process client `lib/mcp/mcp-inprocess-client.js:321-322`; remote client `lib/remote-api-client.js:352-373` (HTTP PATCH, no chat id in body) |
| F7 | Bearer auth: an MCP token sets `req.mcpIntegration` (HMAC-signed payload incl. `chatId`), any other Bearer is a widget token → `req.widgetAccess`; a browser session sets neither. | `lib/auth.js:393-408`; `lib/mcp/mcp-integration-token.js:48-58`; mint at `lib/mcp/mcp-session.js:250` |
| F8 | Precedent for rejecting integration/widget callers on a route. | `lib/routes/usage-routes.js:259` |
| F9 | Scheduler picks only `status === 'ready'` leaves with no `blockedReason` on the branch. | `lib/todo-tree.js:292`, `:359-367`; snapshot `lib/workspace-watcher.js:618-622`; selection `lib/workspace-watcher-cycle.js:515-524`; reservation re-check `:586-598`; claim `lib/workspace-watcher.js:2344-2351` |
| F10 | Recovery treats any `blockedReason` on a `doing` todo as `user_action`; an integration-ready todo and a live worktree are also `user_action`. | `lib/workspace-watcher-recovery.js:75-78`, `:186-196`, `:240-242` |
| F11 | Cycle close releases the claim (`doing` → `ready`, clears `blockedReason` unless failure ceiling). | `lib/workspace-watcher-cycle-close.js:797-860` (status flip at `:843`) |
| F12 | The release is called **after** the row mutation that closes the cycle (report path), not inside it. | `lib/workspace-watcher-cycle.js:1354` (mutation) … `:1556`, release at `:1563-1582`; reconcile `:1919-1921`; boot `lib/workspace-watcher.js:2127-2135` |
| F13 | The file lock is re-entrant and shared by the todos store and the watcher row. | `lib/persist/workspace-watchers-persist.js:2980-3004`; `lib/persist/todos-persist.js:1298` |
| F14 | A worktree PASS currently produces the integration result with `testOutcome: 'passed'` **regardless of review verdict**; the evidence is honest (`unknown`) but the result is still created and the todo forced to `doing`. | `lib/workspace-watcher-cycle.js:1461-1500`; `lib/workspace-watcher-integration.js:172`, `:241` |
| F15 | `integrationReady` short-circuits the close outcome to `success`. | `lib/workspace-watcher-cycle-close.js:186-192` |
| F16 | Close patch **deletes** `failures[todo]` on any non-`failure` outcome and resets blocked backoff except for `phase_disabled`. | `lib/workspace-watcher-cycle-close.js:563-564`, `:571-583` |
| F17 | Closed dictionaries of block reasons. | `lib/persist/workspace-watcher-cycle-metrics-persist.js:71-83`; resolver `lib/workspace-watcher-cycle-close.js:487-` |
| F18 | Review state contract: `passed` with `implementer === null` is **not** gate-qualifying; `manual` is human acceptance. | `docs/todo-review-contract.md` §3.5 (lines 167-177), §7 (line 580) |

## 2. Decisions (plan items 1–7)

### 2.1 Enforcement boundary (plan item 1)

**(a) Write of `status: done` — guard before `updateTodo`.**

A function `guardCycleDoneWrite({ todo, caller, row, policy })` runs before
`updateTodo` on both entry points (REST handler `todos-routes.js:460` and the
MCP tool `todo-tools.js:531`). It cannot live inside `updateTodo` because F1:
`updateTodo` has no caller.

- **Identity** comes only from the signed token, never from request data:
  - REST: `req.mcpIntegration.chatId` (F7). `body.chatId` is ignored (F5).
  - In-process MCP: `ctx.chatId` of the tool handler (`todo-tools.js:365`,
    `:546` already read it). It is passed to `client.updateTodo` as a **new
    explicit parameter** (`callerChatId`) because F6 shows it is not passed
    today. The remote client needs no change: it reaches the REST route with
    the MCP bearer token.
- **Gated target** = leaves in `todoIds` of a live cycle (and their
  descendants) ∪ leaves that have a `reviewWaits` entry (§4.1). The marker
  alone decides membership of the second set — never `blockedReason` or
  `status` (F2).
- **Gated caller under `enforce`** = any request carrying `req.mcpIntegration`
  (with or without `chatId`) or `req.widgetAccess`. For logging the caller is
  classified as `cycle_chat` (the cycle orchestrator or a delegation child of
  it, transitively), `other_chat`, or `unknown_caller`. A plain browser
  session (human) is never gated. Precedent: F8.
- **Status changes other than `done`** on a gated target are allowed but do
  **not** remove the marker. This closes the bypass "write `doing` (which
  clears `blockedReason`, F2), then `done`": the second write is still a gated
  target.
- **Trust boundary:** another person's browser session is outside the threat
  model (same as `manual` acceptance, review contract §7).

**(b) Integration result in a worktree.** The check runs in
`lib/workspace-watcher-cycle.js` before `prepareWorktreeIntegrationResult` /
`markTodoIntegrationReady` (`:1475`, `:1491`), and again defensively at the top
of `markTodoIntegrationReady` (`lib/workspace-watcher-integration.js:172`),
and it also feeds `integrationCandidate` (`:1427-1439`) so
`resolveWorkspaceWatcherCycleCloseOutcome` never sees `integrationReady: true`
(`lib/workspace-watcher-cycle-close.js:186`) for an unsatisfied gate. Reason
(F14): without this, a worktree leaf would reach `integration.state=ready`
with `unknown` review evidence.

### 2.2 Condition (plan item 2)

A leaf satisfies the gate iff **all** hold on a fresh read of `todo.review.code`:

1. `state ∈ {passed, manual}`;
2. `material.current === true` (a later implement/fix makes the state `stale`,
   which is never satisfying);
3. for `passed`: `implementer !== null` (F18);
4. for `manual`: no implementer requirement (human acceptance, §7);
5. if `policy.requireIndependentReview === true`: for `passed`,
   `independence.independent === true` (`class: unknown` does **not** satisfy);
   `manual` is exempt (a human accepted it).

`none`, `pending`, `stale`, `unknown`, `failed`, a `plan`-subject review, and an
agent's own "review passed" statement never satisfy. Only `review.code` is
consulted; `review.plan` is ignored.

### 2.3 Policy (plan item 3)

New fields in `normalizeWorkspaceWatcherPolicy`
(`lib/persist/workspace-watchers-persist.js:1600`, defaults object near `:1534`)
and the control patch path (`lib/workspace-watcher-control.js:255-272`):

| Field | Values | Default |
|-------|--------|---------|
| `requireReviewForDone` | `off` \| `warn` \| `enforce` | `off` |
| `requireIndependentReview` | boolean | `false` |
| `reviewGateMaxAttempts` | integer `1..5` | `2` |

Unknown values normalize to the default. `warn`: the write passes, a
`review_missing` entry is appended to the changelog / "Why?" decision log, and
the cycle `closeOutcome` is unchanged. `enforce`: the write is rejected
(`VALIDATION`-class error with reason `review_missing`) and the cycle follows
§4.

### 2.4 Waiting path (plan item 4) — see §4 (marker, tables A and B).

### 2.5 FAIL handling (plan item 5)

A review `failed` is not a stop. The next cycle for that leaf is a **fix**
cycle, not another review of the same material. Re-review requires a changed
`materialRevision`. After `reviewGateMaxAttempts` unsatisfied closes for one
`materialRevision` the leaf stops for a human (§4.3). No review-only loop.

### 2.6 Close and `done` paths (plan item 6) — see §6.

### 2.7 New reason `review_missing` (plan item 7) — see §7.

## 3. Policy × state matrix

Entry: an agent/widget caller writes `status: done` on a gated target (or a
worktree cycle tries to produce the integration result). "Allowed" means the
write/result proceeds exactly as today.

| Review state of the leaf | `off` | `warn` | `enforce` |
|--------------------------|-------|--------|-----------|
| `passed`, implementer present, material current | allowed | allowed | **allowed** |
| `passed`, **no implementer** (review without implement) | allowed | allowed + `review_missing` log | **rejected** |
| `manual` (human accepted in UI) | allowed | allowed | **allowed** (no implementer needed) |
| `none` (no code review) | allowed | allowed + log | **rejected** |
| `stale` (material changed after PASS) | allowed | allowed + log | **rejected** |
| `unknown` | allowed | allowed + log | **rejected** |
| `failed` | allowed | allowed + log | **rejected** |
| `pending` (review running) | allowed | allowed + log | **rejected** |
| Only a **plan** review passed (`review.plan`), code `none` | allowed | allowed + log | **rejected** |
| `passed`, implementer present, **same model** as implementer, `requireIndependentReview=true` (`independence.independent=false` or `class: unknown`) | allowed | allowed + log | **rejected** |
| Same row with `requireIndependentReview=false` | allowed | allowed | allowed |
| `manual` with `requireIndependentReview=true` | allowed | allowed | **allowed** |

Notes: `off` never reads `todo.review`. A browser-session write is allowed in
every cell. Writes outside the gated target are allowed in every cell.

## 4. Waiting path for review (marker and transitions)

### 4.1 Durable marker `reviewWaits`

Stored on the watcher row (sibling of `failures` / `blockedBackoff`; normalizer
modelled on `normalizeBlockedBackoff`,
`lib/persist/workspace-watchers-persist.js:2574-2586`, wired at `:2681`).

```
reviewWaits: {
  "<todoId>": {
    since: ISO-8601 string,        // first unsatisfied close
    attempts: integer,             // 0..reviewGateMaxAttempts+1
    materialRevision: string,      // leaf material at the last unsatisfied close
    phase: "review" | "fix",       // what the next cycle must do
    worktree: boolean              // leaf runs in a worktree
  }
}
```

Normalization: ids must be non-empty strings; unknown keys dropped; `attempts`
clamped; entries for missing or `done` todos pruned at boot reconcile.

Semantics (resolves round-5 objection 1):

- The marker is the **only** thing that decides gated-target membership for a
  waiting leaf. It is independent of `todo.blockedReason` (which F2 lets any
  status patch clear) and of `todo.status`.
- `blockedReason = review_missing` is a **label** for the UI and for recovery
  (`user_action`, F10). It never decides gating.
- The marker is removed **only** by: (1) a qualifying PASS (§2.2) observed by
  the gate; (2) a **human action over a browser session** (done, retry,
  integrate/reject) — the same trust boundary as review acceptance
  (`docs/todo-review-contract.md` §7); (3) a `materialRevision` change after a
  fix (the entry is reset to `attempts: 0, phase: review`, not deleted, until a
  PASS arrives).
- MCP `todo_start`, MCP `watcher_recover` / `watcher_update` `recover_todo`, and
  any REST call carrying an MCP integration token or widget bearer are
  agent-callable and **MUST preserve** the marker (and the `review_missing` /
  `review_gate_exhausted` label), even though they may move status or release a
  worktree. Only the same actions issued from a browser session clear it.
- A caller changing status does not remove it (§2.1).

### 4.2 Order inside one close (resolves objection 1a and 2)

Today (F12) the claim release runs **after** the row mutation. The contract
requires one outer `withWorkspaceWatchersFileLock` (re-entrant, F13) around the
whole close with this order:

1. Inside the row mutation (`mutateWorkspaceWatcherRow`): resolve leaf outcomes
   (todo still `doing` → `attempted`), evaluate the gate, and when
   unsatisfied write the **marker** (`attempts + 1`, `phase`, `worktree`)
   together with the close patch. The close outcome is `blocked`, reason
   `review_missing` (§6/§7), **not** `failure` (so `cycle_incomplete`,
   `lib/workspace-watcher-cycle-close.js:193-199`, is not reached).
2. **Release** the claim (`releaseWorkspaceWatcherCycleTodoClaim`,
   `cycle-close.js:797`). The release itself never touches the marker or
   `attempts`.
   - non-worktree leaf: `doing` → `ready` exactly as today (`:843`);
   - worktree leaf: claim release only; status stays `doing`
     (a new branch next to the integration-ready branch at `:822-830`).
3. For a worktree leaf only: **after** the release, set
   `blockedReason = review_missing` through an `updateTodo` call **without**
   `status` in the patch (a status in the patch would clear it, F2).
   Non-worktree leaves get **no** `todo.blockedReason` here: it would make the
   branch non-schedulable (`todo-tree.js:292`) and defeat the review-only
   cycle.

Leaf checkpoint and `todoOutcomes` (objection 2): `todoOutcomes` are computed
in step 1 from the todo as it was at close, before any release. The leaf
checkpoint is **not** part of the close at all: it fires only on a transition to
`done` (F4), which happens after a qualifying PASS (orchestrator `done` in a
non-worktree cycle, or human integration, `workspace-watcher-integration.js:868`).
A `review_missing`/FAIL close therefore never checkpoints, and the marker write
and release always precede `todoOutcomes` consumers (metric finalization,
notifications) that run after the mutation.

Crash safety: marker written + claim still held by a dead chat + no live cycle
(crash between 1 and 2) is closed by boot reconcile (`workspace-watcher.js:2183`
→ `:2044`), which performs steps 2–3 idempotently from the marker.

Counters (F16): a `review_missing` close **preserves** `failures[todo]` (does
not increment and does not delete — attempts live in the marker). This is a
**deliberate deviation** from `cycle-close.js:563-564`, which deletes
`failures[todo]` on every non-`failure` outcome, and it extends the
`phaseDisabledClose`-style backoff exemption (`cycle-close.js:571-583`, today
only `phase_disabled`) to `review_missing`. A `review_missing` close is exempt
from the growing blocked backoff, like `phase_disabled`
(`cycle-close.js:571`). The `maxConsecutiveFailures` filter
(`workspace-watcher.js:930`) therefore never parks the leaf for review reasons;
the attempt cap does.

### 4.3 Transition table A — leaf without worktree

| Event | Todo status | Claim | Marker |
|-------|-------------|-------|--------|
| Agent/widget `done` write rejected (`enforce`) | `doing` | unchanged | unchanged; the review may run and the write be retried in the **same** cycle |
| Cycle closes unsatisfied (report, deferred report, runtime/boot reconcile, budget/deadline-driven report) | `ready` (release, §4.2) | released | created or `attempts+1`, `phase=review`; close = `blocked`/`review_missing`; no todo `blockedReason` |
| Next cycle starts | `ready` → `doing` (ordinary claim) | taken | read by the prompt builder: review-only / fix prompt |
| Review verdict `failed` (**at verdict time**) | stays `doing` | held by the running cycle | unchanged; orchestrator may fix in-cycle |
| Cycle closes after FAIL (**cycle close**, not verdict moment — objection 3) | `ready` (release) | released | `phase=fix`, `attempts+1`; next review only after `materialRevision` changes |
| Qualifying PASS, orchestrator writes `done` | `done` | released | removed; checkpoint fires (F4) |
| `attempts > reviewGateMaxAttempts` for current `materialRevision` | `doing` (release is claim-only; status is **not** reset to `ready`, see below), `blockedReason=review_gate_exhausted` | released | kept (still gates) |
| Restart / recovery cleanup of `doing` | `ready` | released | kept |
| Human UI `done` / retry (browser session only) | per UI action | cleared | removed |
| Agent `todo_start` / `watcher_recover` (MCP / MCP-token REST) | per existing path | per path | **preserved** (§4.1) |

**Exhaustion on a non-worktree leaf.** When the close would take `attempts`
past `reviewGateMaxAttempts`, step 2 of §4.2 takes the worktree-style branch
instead of `doing` → `ready` (`cycle-close.js:843`): the claim is released but
the status is left `doing`. Step 3 of §4.2 is then also executed: the **close
path itself** (the same outer lock, after the release, C1/C3/C4 alike; boot
reconcile repairs it idempotently from `attempts > cap`) calls `updateTodo`
without `status` to set `blockedReason = review_gate_exhausted`. This is the
**only** case where a non-worktree leaf receives a `blockedReason` label; it is
intentional and reconciles with the `todo-tree.js:292` scheduling note
(label ⇒ non-schedulable) because a human must now intervene. Below the cap a
non-worktree leaf never gets a label, so the review-only cycle stays
schedulable. Only a browser-session action clears label and marker (§4.1).

### 4.4 Transition table B — leaf in a worktree

| Event | Todo status | Integration | Marker / label |
|-------|-------------|-------------|----------------|
| Qualifying PASS at close | `doing` | result created (`workspace-watcher-integration.js:241`), `integration.state=ready`, waits for a human | removed |
| Cycle closes unsatisfied or after FAIL | `doing`; worktree record kept; claim released | result **not** created | `worktree:true`, `attempts+1`; `blockedReason=review_missing` set after release (recovery → `user_action`, F10) |
| Agent writes `status: doing` (clears label, F2) then `done` | — | — | marker survives; second write is still gated |
| Human retries from a browser session (UI) | per existing path (`patch.status` clears label) | — | removed by the human action |
| Agent retries (MCP `todo_start`, MCP `watcher_recover`, REST with MCP token) | per existing path, but the label is re-applied | — | **preserved**; only a browser-session action clears it (§4.1) |
| Leaf already `integration.state=ready` (incl. legacy) | never touched by the gate | — | ignored |

The worktree leaf is **not** returned to `ready` and is not picked
automatically; resumption is a human action.

Attempt counting: per leaf and `materialRevision`; reset on a material change
or a human action.

## 5. Interaction with existing flows

- **Default `off`:** the guard returns immediately on `off` without reading
  `todo.review`; no marker is ever written; prompts, scheduler, closes and
  integration are byte-for-byte as today.
- **Manual UI `done`:** browser sessions are not gated callers (§2.1); a human
  `done` on a leaf with a marker clears the marker.
- **Parent status:** derived `done` for containers
  (`lib/todo-tree.js:247`) is not a write by a gated caller; it still requires
  all children `done` (F3), so a gated leaf blocks its ancestors.
- **Plan gate:** unchanged and independent (`requirePlanApproval`).

## 6. All `done`-write paths and all cycle-close paths

### 6.1 Paths that can write `status: done`

| # | Path | Gate treatment |
|---|------|----------------|
| D1 | REST `PATCH /api/todos/:id` (`lib/routes/todos-routes.js:460`) | **gated** for MCP/widget bearer; browser exempt |
| D2 | MCP `todo_update` (`lib/mcp/builtin/todo-tools.js:531`) → in-process client (`mcp-inprocess-client.js:321`) or remote client (`remote-api-client.js:352` → D1) | **gated** via `callerChatId` / bearer token |
| D3 | Flag-gated auto-close after a code review PASS: `closeTodoLeafAfterReview` (`lib/todo-review-sync-hooks.js:313`) → `closeTodoLeafIfEligible` (`lib/persist/todos-persist.js:1678`, write at `:1685`), predicate `evaluateTodoLeafAutoClose` (`lib/todo-review-sync.js:842`, flag `:828`) | already requires `review.code` passed and refuses worktree leaves; **must additionally** require `implementer !== null` (F18) and clear the marker; not caller-based |
| D4 | `todo-plan-sync` `markDone` (`lib/todo-plan-sync.js:211`, option wired at `:311`) | not caller-based; **no non-test caller of `markImplementationDone` found in `lib/`** at the time of writing — treat as dormant; if it gains a caller it must pass through the same predicate |
| D5 | Human integration confirm (`lib/workspace-watcher-integration.js:868`) | exempt (human, proof-verified); clears marker only from a browser session — an MCP-token call preserves it (§4.1) |
| D6 | Parent status derivation (`lib/todo-tree.js:247`) | derived for containers, not a leaf write |
| D7 | Browser-session `done` through D1 | exempt (human); clears marker |

Not a `done` write but adjacent: the integration result writer forces
`doing` (`workspace-watcher-integration.js:241`).

### 6.2 Cycle-close paths (plan-only cycles and Scout excluded)

| # | Path | Code | Gate point |
|---|------|------|------------|
| C1 | Orchestrator report (`watcher_report`) | `reportWorkspaceWatcherCycle`, `lib/workspace-watcher-cycle.js:1320`; mutation `:1354-1556`; release `:1563-1582` | gate evaluated before `integrationCandidate` (`:1427`) and close outcome (`:1445`) |
| C2 | Deferred report (children still active) | stored at `:1402-1417` with `reportedOutcome`; no close of its own; resolved by `resolveDeferredWorkspaceWatcherReports` (`cycle-close.js:868`) at C3/C4 | gate runs at C3/C4 |
| C3 | Runtime reconcile of a dead cycle | `reconcileWorkspaceWatcherCycleSlot`, `workspace-watcher-cycle.js:1784`; close outcome `:1813-1826`; mutation `:1829`; release `:1919-1921` | same function, same tables |
| C4 | Boot reconcile | `reconcileWorkspaceWatchersOnBoot`, `lib/workspace-watcher.js:2183` → `reconcileWorkspaceWatcherRow` `:2021` → slot `:2044`; release `:2127-2135` | same function, same tables |
| C5 | Start abort (reservation rolled back before work) | `clearCycleRow`, `workspace-watcher-cycle.js:237`, `closeSource: 'abort'` | no leaf outcome; marker untouched |

Budgets and deadlines have **no dedicated close code**: the daily budget is a
start guardrail (`lib/workspace-watcher-guardrails.js:451`, `wait_budget`), the
start deadline only protects the `starting` phase
(`workspace-watcher-cycle.js:439`, `:636`; `workspace-watcher.js:1940`), and a
delegation budget/deadline cancels children so the cycle ends through C1 (a
`blocked` report) or C3/C4. They therefore use the same evaluation.

All close paths share one evaluation function
(`resolveWorkspaceWatcherCycleCloseOutcome` gains the gate result as an input
and returns `closeOutcome: 'blocked'`, `closeReason: 'review_missing'`), so the
tables in §4 hold for C1, C3 and C4 alike. Plan-only cycles keep their own
branch (`cycle-close.js:80`, `:169`).

## 7. New reason `review_missing`

- Add to **both** closed dictionaries:
  `WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES`
  (`lib/persist/workspace-watcher-cycle-metrics-persist.js:71`) and the
  resolver `resolveWorkspaceWatcherCycleBlockedReasonCode`
  (`lib/workspace-watcher-cycle-close.js:487`, returns it before `unknown`).
- `lib/workspace-watcher-blocked-reason.js`: label constants for
  `review_missing` / `review_gate_exhausted`; `isWorkspaceWatcherBlockedReason`
  must **not** classify them as retryable-by-clear-stop (a human must review).
- `lib/workspace-watcher-guardrails.js`: no new wait kind (scheduler is
  unchanged); only add the reason to any decision-reason list it keeps
  (not confirmed to exist — see open questions).
- UI/i18n: label in `app_front/i18n/{pl,en}.js`; settings controls for the
  three policy fields; `docs/workspace-watcher.md` policy table.

## 8. Prompt change (implementation leaf)

`lib/workspace-watcher-prompt.js:573-575` / `:590-592` / `:606`: under
`enforce` the text states that a `done` write is rejected without a passed
`code` review that has an implementer. A marker leaf gets a review-only
(`phase=review`) or fix (`phase=fix`) prompt; the scheduler and claim are
unchanged.

## 9. Test matrix (implementation leaf)

| Area | Cases |
|------|-------|
| Policy | defaults `off`/`false`/`2`; invalid values normalize; round-trip through `normalizeWorkspaceWatcherRow` |
| Matrix §3 | every row × `off`/`warn`/`enforce`, incl. `passed` without implementer, `manual`, plan-only review, same model with and without `requireIndependentReview` |
| Identity | MCP bearer with and without `chatId`, widget bearer, browser session, forged `body.chatId` ignored, in-process `callerChatId` |
| Bypass | `status: doing` then `done`; marker survives label clear (F2); write after cycle closed |
| Close paths | C1 report, C2→C3 deferred, C3 runtime reconcile, C4 boot reconcile: each yields `blocked`/`review_missing`, marker `attempts+1`, failure counter preserved, no blocked-backoff growth |
| Marker clearing | MCP `todo_start` / `watcher_recover` / MCP-token REST preserve marker and label; browser-session retry/done clears; exhausted non-worktree leaf stays `doing` with `review_gate_exhausted` and no `ready` reset |
| Order | marker before release; worktree label set after release and survives; crash between marker and release repaired at boot; no checkpoint on FAIL/missing; checkpoint on PASS-then-done |
| Table A | review-only next cycle; FAIL → fix → re-review only after `materialRevision` change; cap → `review_gate_exhausted`; scheduler picks unchanged |
| Table B | no integration result, status `doing`, not auto-picked, `integration.state=ready` never modified |
| Auto-close D3 | refuses `passed` without implementer under `enforce`; clears marker |
| Dictionaries | `review_missing` accepted by metric persistence and resolver; unknown still `unknown` |
| Regression | `off` leaves all existing watcher/close/integration tests green; manual UI `done` unaffected |

## 10. Open questions

1. D3 (flag-gated auto-close) currently accepts `passed` without an
   implementer; the contract tightens it only when `requireReviewForDone` is
   not `off`. Confirm that is acceptable for the experimental flag.
2. Is `lib/workspace-watcher-guardrails.js` required to change at all? No
   reason list that would need `review_missing` was found; the implementer must
   confirm.
3. `todo_update` via the in-process client needs a new `callerChatId`
   parameter; the remote client relies on the bearer token only. Confirm no
   other in-process caller of `client.updateTodo` needs the same.
4. `markImplementationDone` (D4) has no caller in `lib/`; confirm it is dead
   before relying on §6.1.

## 11. Implementation notes (deviations and decisions)

1. Open question 1: D3 (flag-gated auto-close) requires an implementer only when
   `requireReviewForDone !== 'off'`; it clears the marker on a successful close.
2. Open question 2: `workspace-watcher-guardrails.js` needed no change.
3. Open question 3: the in-process `client.updateTodo` is the only caller of the
   in-process path; it gained `callerChatId`. The remote client relies on the
   bearer token.
4. Open question 4: `markImplementationDone` still has no caller in `lib/`; D4
   is dormant and not wired to the gate.
5. C3/C4 apply the gate only to a stored `reportedOutcome: success` (a deferred
   report resolved at reconcile). A cycle with no report remains
   `failure` / `missing_report` — the gate does not reinterpret a crash.
6. `warn` outside a close (REST/MCP `done`) records the decision and a todo
   changelog note; it never blocks.
7. A leaf already `done` at close drops its marker only when the gate is
   satisfied; an unreviewed `done` written through an unguarded path keeps it.
8. Status comparison in the guard uses `normalizeStatus` from `todos-persist.js`
   (trim + lowercase), the same normalization `updateTodo` applies, so `Done` /
   `DONE` cannot bypass the gate.
9. `warn` records its changelog note in the `afterWrite` callback, after the
   caller's write succeeded; it never bumps the CAS token before the write.
10. C1/C3 evaluate the gate for `success` and `failure` reports. An
    unsatisfied `enforce` gate writes the marker for both (FAIL -> `phase=fix`).
    A reported `blocked` is never reinterpreted: it keeps `cycle_blocked`
    (`reported_blocked`) and the blocked backoff, writes no marker and consumes no
    attempt, because the real cause may not be review-related (e.g. no access). A
    `failure` report keeps outcome `failure` and its failure count, but the marker
    and release rules (tables A/B) still apply. `warn` only judges `success`.
11. `releaseWorkspaceWatcherCycleTodoClaim` returns whether it released; boot
    reconcile lists a leaf in `released` only then.
