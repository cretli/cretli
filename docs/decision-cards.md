# Decision cards (ADR)

Status: accepted for the server registry, request protocol, UI and host-gate adapters. Push actions are covered by `lib/decisions/decision-push.js`; the autonomy ladder is described below.

## Contract

The server stores decisions in the storage worker (`data/decisions/decisions.sqlite`, store `store.decisions`, handlers `lib/storage/decisions-store.js`, schema v8 in `lib/storage/schema/0008-decisions.js`, runtime `lib/persist/decisions-runtime.js`). Mutations are receipt-wrapped worker commands: `decisions.create` (dedupe lookup, superseding older pending cards of the same gate and insert in one transaction) and `decisions.change` (compare-and-swap on the card `revision`). The runtime bootstraps the file on first use (there is no legacy dataset) and then starts the worker with `create: false`. A card has `id`, `kind`, a subject identifier and its `updatedAt` compare-and-swap token, `title`, `summary`, `evidence[]`, two to four `options[]` (`id`, `label`, `effect`, server-classified `risk` and `reversible`), `recommended`, `why`, `confidence`, `expiresAt`, `onTimeout`, `dedupeKey`, `producer`, `status`, and `revision`. `GET /api/decisions` returns pending cards and the store revision; `POST /api/decisions/:id` takes `{optionId, expectedRevision}`. Any changed subject is stale and disappears from the pending list. The same gate and subject revision create one card. A resolution writes an independent audit line to `data/approvals/decisions-audit.jsonl`, never the existing approval audit. `decisionsChanged` carries the store revision on the chat-list WebSocket channel.

The first producers derive cards from a todo whose plan awaits approval or whose integration is awaiting. Plan approval executes the same `updateTodo` plus plan-review synchronization as `PATCH /api/todos/:id`; integration uses the same confirm, reject, and no-code service methods as `POST /api/todos/:id/integration`. Confirmation and no-code pass `humanAttested: true` only after the decision route verifies the human channel. Agents may create cards; they cannot resolve them through MCP.

## Server risk policy

| Kind | Minimum risk | Reversible | Human only |
| --- | --- | --- | --- |
| `plan_approval` | high | no | yes |
| `integration` | high | no | yes |
| `policy_upgrade` | high | no | yes |
| `doc_proposal` | medium | no | yes |
| `operator_proposal` | medium | no | no (never auto-decided, no metacard, no push token) |
| `needs_human`, `permission`, `question`, `browser_consent`, `scout_finding`, `lesson_candidate`, `rescope` | medium | no | no |

A producer may raise risk or mark a card irreversible; it cannot lower risk or make a kind reversible. Each option receives at least the card's risk and no more reversibility than its kind. `onTimeout=recommended` requires server-classified low risk, reversibility, and a non-human-only kind; with the current table, no kind qualifies. Human-only cards must be decided by an explicit UI action, with no gesture, push action token, timeout recommendation, automatic decision, or autonomy policy.

Docs proposals are reserved for the Docs service and `doc_propose_*` tools;
`decision_request` refuses this kind. Their payload is stored in the card (up to
128 KiB), with note hash, root identity and link revision preconditions. Human
apply uses the Docs service; rejection changes nothing. Conflicts mark the card
stale. See [Workspace Docs](docs-module.md#agent-proposals-and-human-approval).
They never get autonomy metacards, gestures, voice approval or push action tokens.

## Operator proposals

`operator_proposal` cards carry a typed proposal about a todo (`lib/decisions/operator-proposal.js`). An operator (agent, MCP bearer) can only **create** one, with `operator_propose` (or `createOperatorProposalCard`); it cannot resolve it. The owner resolves it on the human route `POST /api/decisions/:id` (cookie session + CSRF, `isAgentSessionRequest` is rejected with 403). The route claims the card (`pending` to `deciding`, CAS on `revision`) and `executeDecision` dispatches the kind to `executeOperatorProposal`; no new route and no LLM rerun. Options: `approve`, `reject`.

| Action | Params | Effect on approve |
| --- | --- | --- |
| `extend_scope` | `files?`, `reason?` | `acceptWorkspaceWatcherScopeRequest` for the open scope request (fails if none) |
| `defer_todo` | `reason`, `until?` | status `deferred` with reason / date |
| `mark_ready_for_integration` | `reason?` | changelog mark only; confirmation stays the human-only `integration` card |

Params are validated at creation and again at execution. Unsupported actions, and human-only matters (`approve_plan`, `confirm_integration`, `policy_upgrade`, `doc_proposal`), are refused (`VALIDATION` at creation, `unsupported_action` at execution); for those the operator uses the existing `plan_approval` / `integration` cards. The subject holds the todo `updatedAt`; every effect compares it with the current todo, and a changed todo makes the card `stale` with no effect (the pending-card sync also stales it). `dedupeKey` is `operator_proposal:<workspace>:<todoId>:<hash(action, params)>`, so the same todo revision and matter give one card. Approval and rejection are written to the operator journal (`decision` note) in addition to `decisions-audit.jsonl`. The kind is excluded from autonomy promotion (`AUTONOMY_EXCLUDED_KINDS`) and from push tokens.

## Human channel and threat model

The UI resolution route accepts a valid cookie session with a valid CSRF token and rejects `isAgentSessionRequest(req)`. This matches the current plan approval and integration confirmation boundary. Existing `requireAuth` returns 401 without a session and 403 for a missing or invalid CSRF token. Bearer MCP, widget tokens, and agent sessions pass `requireAuth` but the decision route returns 403. `decidedBy` is set by the server from this channel, never from the request body. A single route helper owns this check so later hardening can change it in one place.

An agent with shell access cannot normally call the resolution route without a human session cookie. Session cookies are persisted in `data/sessions.json`; the host permission classifier treats that file as secret. Residual risk remains for harnesses without the host permission gate: they may read the session file and impersonate the human. This is a pre-existing risk across human-only routes. Step-up verification and protection against a stolen cookie are tracked separately as todo `491d57e3`.

## Claims and crash recovery

Resolving a card first claims it with a database compare-and-swap (`pending` to `deciding`, stored with `claimedAt`); only the winner runs the side effect, then moves the card to `decided`, or to `stale` when the subject changed, or back to `pending` when the effect failed without a conflict. A `deciding` card is persistent and is **never reset automatically**: the owner may be another request or another server process still running the effect, and a process-local liveness set cannot tell. If the owner crashes between the claim and the outcome, the card stays `deciding` (hidden from the pending list) until a human calls `POST /api/decisions/:id/reopen {expectedRevision}` (same human-channel check as resolution), which is accepted only after a lease (5 minutes) from `claimedAt`. Re-running the effect afterwards is safe because every effect re-checks the subject compare-and-swap: if it already took effect, the retry ends as `stale` instead of applying twice. The tradeoff is that a crashed claim needs one manual action instead of silently retrying.

## Structured human requests

`watcher_report` and `watcher_update action=report` accept `options`, `recommended`
and `why` for `outcome=blocked, reason_code=needs_human`. Supply 2–4 options with
`label` and `effect`, optionally `id` (otherwise `option_1`, `option_2`, …).
`recommended` identifies one option; `why` explains the recommendation in one
sentence. Risk and reversibility come from the server registry, never from a
producer's assertion that an action is safe.

Validation is soft for Watcher reports: missing/incomplete options, an invalid
recommendation or missing justification still close the cycle. The card uses
“Odpowiedz w czacie” and “Odłóż”, the MCP result includes `warning`, and the durable
`watcher.decisionProducerViolations[chatId]` counter increases once. Replaying a
report neither increments this counter nor creates another card. The report is
stored before card creation; a card storage failure returns a warning and the
same report can be retried to create the card.

`decision_request` is available in Agent, Plan, Ask and Scout contexts. It only
creates or reads cards; it cannot resolve them. Creation requires `title`, a
stable `idempotency_key`, 2–4 complete options, `recommended` and `why`. Unlike
Watcher reporting, invalid direct requests are rejected. `kind` defaults to
`question`. `onTimeout=recommended` is refused for every `humanOnly` kind and
any kind not classified as low risk and reversible. Repeat with the same key,
or pass `decision_id` to read an existing request owned by the calling chat.
`wait_ms` optionally polls for completion, capped at 24 seconds per call; repeat
calls to keep waiting. A timeout returns a pending card and does not choose an
option. Workspace and source-chat scope apply to reads as well as creation.

Cards expose `otherOption` (“Inna odpowiedź…”) separately from the 2–4 choices.
The human resolution route accepts `optionId=__other__` with non-empty `reason`.
For request and Watcher cards, a selection or free-text answer is delivered to
the source chat as a notice with action `decision_response`; its JSON text
contains `decisionId`, `kind`, `optionId`, `option`, `text` and related `todoIds`.
The decided card also retains this structured `response`. Options describe work
for the source orchestrator; the adapter does not execute producer-supplied code.
The decision stack UI is implemented in a separate leaf.

## Decision graph foundation and continuation

A card may carry a versioned `origin` (`schemaVersion`, `kind`: `watcher_report`
with `cycleId`/`chatId`/`reportId`; absent on legacy cards, which read as
`origin.kind = "unknown"`) and `relations` (`todoIds`, `chatId`, `cycleId`,
`scopeVersion`, `supersedes`; `supersededBy` on the replaced card). References are
kept as recorded; the read model flags todos that no longer exist
(`todos[].missing`) and a changed scope (`scopeChanged`). No Git or patch evidence
is invented: only real evidence is attached.

Each card holds an append-only, idempotent `events[]` log (cap 200). Events are
keyed (`proposed`, `answered`, `superseded`, `continuation_*`); a key already
present changes nothing. The `proposed` and `answered` snapshots are written once
and never rewritten. The `proposed` snapshot is deliberately compact (title, option ids + short labels, recommendation, origin/relations) so it does not duplicate the card body into the pending byte budget. `GET /api/decisions/:id/events?cursor=<seq>&limit=<n>`
pages the log (`nextCursor` is the last seen `seq`).

`needs_human` options carry an explicit `continuation` intent (`resume`, `defer`,
`none`); “Inna odpowiedź…” on a structured card means `resume`. The `continuation`
record on a decided card moves `saved → applying → waiting | applied | none |
failed`, and `waiting → resumed` only when a Watcher cycle really started with the
answer in its prompt, tracked per todo (`resumedTodoIds`): a multi-todo card becomes
`resumed` once every todo got its context. When one todo's cycle prompt cannot carry the
answer (`prompt_too_long`), the continuation stays `waiting` and the error is recorded per todo in
`continuationState.deliveryErrors`; sibling todos and later cycles still receive the answer. Answer-only options (no explicit
`continuation`, legacy cards) also go to `waiting` (`waitingFor: next_cycle`) without
resuming or nudging the scheduler, so the choice and free text still reach the
next cycle of each blocked todo. `applying` is a compare-and-swap claim (`decisions.annotate`),
a stale claim (>60 s) can be taken over. `GET /api/decisions` (needs_human cards),
`GET /api/decisions/:id` and the resolve response return the read model:
`projectName` (last path segment, never a full path), `todos[{id,title,missing}]`,
`question`, `continuationState` (`status`, `waitingFor`, `error`, `retryable`,
`answer`). `POST /api/decisions/:id/continuation/retry` (human session + CSRF,
workspace-scoped, idempotent) re-runs a failed or stranded continuation without
changing the choice and without bypassing any scheduler gate. A decision never
approves plans, reviews, integration or permissions. See
[Workspace Watcher](workspace-watcher.md#durable-answer-and-continuation).

The Decisions panel renders the safe `projectName`, `todos`, `question`, option
labels/effects, recommendation and continuation state from this read model. A
free-text answer draft is kept in browser local storage by decision ID until a
successful response. The answered card displays the stored response and current
continuation state separately from task completion; `resumed` means the answer
reached a real cycle, not that the todo succeeded. Retryable continuation states
expose the retry route above, and failures remain visible if retry fails.

For `needs_human` cards, Details loads `GET /api/decisions/:id/events` in pages
of 50 using `nextCursor`. The timeline shows proposal, answer and continuation
events, provenance, related todos and typed references. Missing todo or source
records are labeled unavailable; the UI does not reconstruct deleted artifacts.
The history is a linear list rather than a full relation graph. Existing
non-`needs_human` cards keep their current details and resolution flow.

## Host-gate adapters

`lib/decisions/gate-adapters.js` mirrors six existing human gates as cards (`producer: host-gate-adapter`). Every effect runs only after the registry route has verified its existing human session and CSRF channel. Browser and cancellation adapters invoke the same handlers as their REST routes, preserving their scope checks. Permission/question adapters invoke the existing harness reply functions, and Scout/lesson adapters use the same domain functions as `scout_findings`/`lesson_update`. No adapter adds an authorization channel. A card for a gate that is no longer open becomes stale. Fixed-action gates set `otherOption: null`; question cards also accept a validated Other answer through the original harness question payload.

| Gate | Card options | Resolved through |
| --- | --- | --- |
| Agent permission (Claude, OpenCode, Qwen) | `once`, `reject` | the harness permission reply handler (`handleClaudePermissionReply`, `opencodePermissionReply`) |
| Agent question (OpenCode, Claude, Qwen) | up to four complete answer sets; `reject` when space permits; Other answer | the harness question reply handler (`opencodeQuestionReply`, `handleClaudeOpenCodeQuestionReply`) |
| Browser consent | `once`, `allow`, `deny` | `POST /api/browser/consent/:id` with the `chatId` carried in the card subject |
| Scout proposal | `accept`, `reject` | `acceptScoutFindings` / `rejectScoutFindings` (todo creation still follows `scoutAutoCreate`) |
| Lesson candidate | `activate`, `withdraw` | `updateLesson` with the `expected_revision` stored in the subject |
| `cancel_unconfirmed` slot | `confirm`, `wait` | `POST /api/delegations/:id/confirm-stop` (`delegation_stop_ok`); `wait` changes nothing |

First answer wins: the chat reply and the card reply share the harness waiter or reply claim, so a late card reply gets `stale` (HTTP 409), and a late harness callback returns `false`. OpenCode claims a question synchronously before awaiting its HTTP reply and releases the claim on failure so the human can retry. Permission replies retain the existing approval guard and audit.

Question cards retain the full question form as evidence. Larger forms show a compact subset of complete answers plus Other; a single answer can be entered as a label, while multiple questions or multiple selections accept an array of label arrays. The adapter validates question count, selection cardinality and allowed labels before calling the harness. Custom text is allowed only for a custom or open question. The existing chat form remains available for richer interaction. The old views (`openCodeInteractive.js`, `browserConsentCard.js`, `scoutFindingsInboxView.js`) are unchanged.

### Unsupported harnesses

Codex and Cursor SDK have no verified host permission gate (see [the permission-hook ADR](approval-permission-hook.md#codex-and-cursor-sdk-no-verified-host-gate)). Native permission/question host-gate cards are unsupported for those harnesses; the adapters do not infer a pending gate from assistant text or replace harness policy. Their native approval behavior remains with the harness. Explicit `decision_request` cards remain available independently of host permission support.

Source changes schedule coalesced, best-effort card synchronization; failure leaves the original gate and fallback view intact. A decisions GET reconciles the current source state as well. Gate cards follow the chat's logical workspace, including runs in a worktree. Browser subjects retain both `consentId` and `chatId`; replies always supply that `chatId`. Lesson subjects retain `expected_revision`, and activation or withdrawal uses that CAS value. Cancellation subjects use the delegation revision; confirm-stop checks it before releasing the slot. Choosing `wait` only dismisses that revision of the card and leaves the slot occupied.

## Autonomy ladder, metacards and metrics

`lib/decisions/decision-autonomy.js` holds the policy (`data/decisions/autonomy.json`: `upgradeThreshold` 20, `dailyGestureLimit` 50, `controlEvery` 20, `undoWindowMs` 5 min, `autoDecideKinds`) and the statistics. Humans edit the thresholds with `PUT /api/decisions/policy`; `autoDecideKinds` changes only when a `policy_upgrade` card is accepted.

- **Statistics.** `computeDecisionStats` groups human-decided cards by kind, producer `harness` and diff-size bucket (`small` < 50, `medium` < 300, `large`; producers pass `diffSize`/`harness` to `createDecision`): recommendation vs other option, median time to decision (`decidedAt - createdAt`) and median time on card (`decisionMeta.openedMs`, sent by the UI).
- **Metacard.** After `upgradeThreshold` consecutive human decisions of one kind that chose the recommendation, `proposePolicyUpgrades` creates a `policy_upgrade` card (one per kind, deduplicated). Accepting it adds the kind to `autoDecideKinds` and restarts the streak; rejecting only restarts the streak. Nothing else changes the policy. `plan_approval`, `integration` and `policy_upgrade` (the human-only kinds, see `docs/workspace-watcher.md`) never get a metacard and are stripped from `autoDecideKinds` on read.
- **Automatic decisions.** `canAutoDecide` requires a promoted kind, server-classified `low` risk and `reversible`, a recommended low/reversible option, and no hard exception. The decision is stored with `decidedBy.kind = auto` and `undoUntil`; it is listed in `GET /api/decisions/history` and `POST /api/decisions/:id/undo` (human session only) reopens the card as pending inside the window, keeping the automatic choice in `undoneAuto`. Undo does not run a compensating effect: only reversible kinds are eligible, and their producers must react to the reopened card. With the current registry table no kind is low-risk and reversible, so no card is auto-decided yet.
- **Hard exceptions** are never automated, whatever the policy: a new dependency in `package.json`, secrets/auth, push or merge to the main branch, data deletion and payments (text match over title, summary, options and evidence, plus explicit `hardExceptions` tags from the producer).
- **Anti-reflex.** At most `dailyGestureLimit` gesture decisions per UTC day (then the API answers 429 `GESTURE_LIMIT` and the UI shows buttons only). Every `controlEvery`-th human decision is a control card: no gestures, and the request needs `detailsOpened: true` (400 `DETAILS_REQUIRED` otherwise). `GET /api/decisions` returns `autonomy: {gesturesLeft, nextIsControl}`.
- **Metrics.** `GET /api/decisions/metrics` returns `metrics` (`medianTimeToDecisionMs`, `recommendationAgreement`, `cardsPerDay` for the last 7 UTC days) and per-kind `stats`; the Decisions panel shows them above the history.
