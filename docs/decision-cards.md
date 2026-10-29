# Decision cards (ADR)

Status: accepted for the first server slice. Later adapters, UI, push actions, and autonomy are separate work.

## Contract

The server stores decisions in the storage worker (`data/decisions/decisions.sqlite`, store `store.decisions`, handlers `lib/storage/decisions-store.js`, schema v8 in `lib/storage/schema/0008-decisions.js`, runtime `lib/persist/decisions-runtime.js`). Mutations are receipt-wrapped worker commands: `decisions.create` (dedupe lookup, superseding older pending cards of the same gate and insert in one transaction) and `decisions.change` (compare-and-swap on the card `revision`). The runtime bootstraps the file on first use (there is no legacy dataset) and then starts the worker with `create: false`. A card has `id`, `kind`, a subject identifier and its `updatedAt` compare-and-swap token, `title`, `summary`, `evidence[]`, two to four `options[]` (`id`, `label`, `effect`, server-classified `risk` and `reversible`), `recommended`, `why`, `confidence`, `expiresAt`, `onTimeout`, `dedupeKey`, `producer`, `status`, and `revision`. `GET /api/decisions` returns pending cards and the store revision; `POST /api/decisions/:id` takes `{optionId, expectedRevision}`. Any changed subject is stale and disappears from the pending list. The same gate and subject revision create one card. A resolution writes an independent audit line to `data/approvals/decisions-audit.jsonl`, never the existing approval audit. `decisionsChanged` carries the store revision on the chat-list WebSocket channel.

The first producers derive cards from a todo whose plan awaits approval or whose integration is awaiting. Plan approval executes the same `updateTodo` plus plan-review synchronization as `PATCH /api/todos/:id`; integration uses the same confirm, reject, and no-code service methods as `POST /api/todos/:id/integration`. Confirmation and no-code pass `humanAttested: true` only after the decision route verifies the human channel. Agents may create cards; they cannot resolve them through MCP.

## Server risk policy

| Kind | Minimum risk | Reversible | Human only |
| --- | --- | --- | --- |
| `plan_approval` | high | no | yes |
| `integration` | high | no | yes |
| `policy_upgrade` | high | no | yes |
| `needs_human`, `permission`, `question`, `browser_consent`, `scout_finding`, `lesson_candidate`, `rescope` | medium | no | no |

A producer may raise risk or mark a card irreversible; it cannot lower risk or make a kind reversible. Each option receives at least the card's risk and no more reversibility than its kind. `onTimeout=recommended` requires server-classified low risk, reversibility, and a non-human-only kind; with the current table, no kind qualifies. Human-only cards must be decided by an explicit UI action, with no gesture, push action token, timeout recommendation, automatic decision, or autonomy policy.

## Human channel and threat model

The UI resolution route accepts a valid cookie session with a valid CSRF token and rejects `isAgentSessionRequest(req)`. This matches the current plan approval and integration confirmation boundary. Existing `requireAuth` returns 401 without a session and 403 for a missing or invalid CSRF token. Bearer MCP, widget tokens, and agent sessions pass `requireAuth` but the decision route returns 403. `decidedBy` is set by the server from this channel, never from the request body. A single route helper owns this check so later hardening can change it in one place.

An agent with shell access cannot normally call the resolution route without a human session cookie. Session cookies are persisted in `data/sessions.json`; the host permission classifier treats that file as secret. Residual risk remains for harnesses without the host permission gate: they may read the session file and impersonate the human. This is a pre-existing risk across human-only routes. Step-up verification and protection against a stolen cookie are tracked separately as todo `491d57e3`.

## Claims and crash recovery

Resolving a card first claims it with a database compare-and-swap (`pending` to `deciding`, stored with `claimedAt`); only the winner runs the side effect, then moves the card to `decided`, or to `stale` when the subject changed, or back to `pending` when the effect failed without a conflict. A `deciding` card is persistent and is **never reset automatically**: the owner may be another request or another server process still running the effect, and a process-local liveness set cannot tell. If the owner crashes between the claim and the outcome, the card stays `deciding` (hidden from the pending list) until a human calls `POST /api/decisions/:id/reopen {expectedRevision}` (same human-channel check as resolution), which is accepted only after a lease (5 minutes) from `claimedAt`. Re-running the effect afterwards is safe because every effect re-checks the subject compare-and-swap: if it already took effect, the retry ends as `stale` instead of applying twice. The tradeoff is that a crashed claim needs one manual action instead of silently retrying.
