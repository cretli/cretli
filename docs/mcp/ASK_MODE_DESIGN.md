# External MCP "ask" mode — design proposal

Status: proposal, no code changed. Audience: maintainers deciding whether and how to add a fourth external-client mode.

## 1. Problem

External MCP clients (`/mcp`, [`lib/routes/mcp-external-routes.js`](../../lib/routes/mcp-external-routes.js)) have one of three modes, listed in `EXTERNAL_MCP_MODES` ([`lib/mcp/mcp-external-clients.js`](../../lib/mcp/mcp-external-clients.js)):

| Mode | Effect today |
| --- | --- |
| `plan` | Read-only builtin tools. |
| `agent` | Whole builtin catalog, writes run immediately. |
| `operator` | `agent` plus `operator_*` tools that act as the user ([`lib/mcp/mcp-external-operator-tools.js`](../../lib/mcp/mcp-external-operator-tools.js)). |

There is no middle ground between "cannot write" and "writes without anyone looking". **Ask mode**: the client may call mutating tools (`todo_create`, `todo_update`, `delegation_start`, chat archive/delete, ...), but each call is held until a human approves it.

Current request flow (grounded in the route): bearer token → `verifyExternalMcpToken` → rate limit (60 calls/min/client, [`lib/mcp/mcp-external-audit.js`](../../lib/mcp/mcp-external-audit.js)) → a fresh `Server` + `StreamableHTTPServerTransport` per request (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) → `CallToolRequestSchema` handler: durable `started` audit record (fail-closed) → run tool → `ok`/`error` audit record. The mode is re-read from the client on every request, so a mode switch applies from the next call.

## 2. Proposed behaviour

### (a) Who approves, and through which channel

- The approver is the Cretli user who owns the client (the logged-in session in Settings → MCP → external clients). Cretli is single-user per instance, so "anyone logged in" is the approver; no per-client approver identity is needed in v1.
- Channel: a pending-approval card in the web UI, plus a push notification so the user does not have to watch the screen.
  - The UI card shows client name, tool name, a redacted summary of the arguments, the age of the request, and **Approve once / Reject** (no "always" — see §4).
  - Notification reuses the existing push path pattern in [`lib/agent-needs-input-push.js`](../../lib/agent-needs-input-push.js) (`buildAgentNeedsInputPushPayload` / `notifyAgentNeedsInput`) with a new payload kind such as `mcp_ask_approval`.
  - Settings → MCP lists pending requests too, so a missed push is recoverable.
- Approval is a decision on one concrete call (tool + argument hash), never a standing grant.

### (b) Timeout and behaviour on timeout

- Default approval window: **55 s**, configurable per client (suggested range 15 s – 15 min); windows above ~55 s need a longer proxy/client timeout or option B/C (see §2(f)). The pending request is then **rejected as `timeout`**: the tool never runs. Silence is never consent.
- A decision that arrives after the timeout is ignored (the card shows "expired"). The client must retry, which creates a fresh request (see §2(e) for dedup).
- If the server restarts, all pending approvals are dropped (in-memory); the client sees a connection error and retries.
- A client disconnect (`extra.signal` aborted) cancels the pending request and writes a `timeout`/`cancelled` audit record.

### (c) What the client sees on reject / timeout

The route already uses `McpError`/`ErrorCode` from the MCP SDK and a custom HTTP error body `{ jsonrpc: '2.0', error: { code: -32001, message }, id: null }` for pre-handler failures. Two options exist for tool-level refusals; the recommendation is a **tool result with `isError: true`**, matching what operator tools already do (`callExternalOperatorTool` returns `"CODE: message"` text with `isError: true`), so LLM clients see the reason instead of a protocol failure:

| Situation | Result | Text |
| --- | --- | --- |
| Rejected by user | `isError: true` tool result | `APPROVAL_REJECTED: the user rejected this call; do not retry unless asked` |
| Timeout | `isError: true` tool result | `APPROVAL_TIMEOUT: no decision within <window> s; the call was NOT executed. Retry with the same idempotency_key to ask again` |
| Too many pending | `isError: true` tool result | `APPROVAL_BUSY: too many pending approvals for this client` |
| Audit write failed | unchanged: `McpError(InternalError)` (JSON-RPC `-32603`) | `Audit log unavailable; tool call refused and not executed` |
| Rate limited | unchanged: HTTP 429 + `Retry-After: 60`, code `-32001` | existing message |

Alternative (not recommended): throw `McpError` with a custom code in the implementation-defined range (e.g. `-32010` rejected, `-32011` timeout). It is stricter protocol-wise but many MCP clients surface only a generic failure for protocol errors and hide `message` from the model.

### (d) Reuse of `lib/approval/`

Not directly reusable as a queue; reusable in pieces.

- [`lib/approval/approval-broker.ts`](../../lib/approval/approval-broker.ts) is a *local policy engine for agent permission requests* (modes `off|shadow|local_reads`, optional advisor). Its subject is a harness permission tuple (command, path), not an MCP tool call, and by design it only ever auto-answers `once` for safe reads. Ask mode needs the opposite: a human-only gate on writes. Do **not** route ask-mode calls through the advisor or auto-approve.
- Reusable:
  - [`lib/approval/approval-audit.ts`](../../lib/approval/approval-audit.ts) — append-only JSONL with rotation and `kind=human_permission_decision` entries correlated on `requestId`. Ask-mode decisions should write a `human_permission_decision`-style entry there too, so the approval timeline stays in one place.
  - [`lib/approval/permission-request.ts`](../../lib/approval/permission-request.ts) — `sanitizePermissionCommand` and redaction helpers for the card's argument summary.
  - [`lib/approval/permission-decision.ts`](../../lib/approval/permission-decision.ts) and [`lib/approval/can-use-tool-permission.ts`](../../lib/approval/can-use-tool-permission.ts) — the existing "agent asks, human card answers" flow; the UI card component and reply path can be generalised instead of building a second card.
- New: a small in-memory `pending-ask-approvals` registry (id, client id, tool, args hash, createdAt, deadline, resolver promise) next to `lib/mcp/`, plus two UI routes (list, decide).

### (e) Idempotency and audit

- Audit today: [`lib/mcp/mcp-external-audit.js`](../../lib/mcp/mcp-external-audit.js) records `started | ok | error | rejected` in `mcp-external-audit.jsonl` (time, client id, tool, outcome only; never arguments). Ask mode adds outcomes `ask_pending`, `ask_approved`, `ask_rejected`, `ask_timeout` (extend the `ExternalMcpAuditOutcome` typedef). Sequence for an approved call: `started` → `ask_pending` → `ask_approved` → `ok`/`error`. For a rejection: `started` → `ask_pending` → `ask_rejected` (or `ask_timeout`); the existing `rejected` outcome is reserved for pre-handler refusals (rate limit, disabled server) and stays as is.
- Fail-closed stays: `started` must be durable before the request is queued. The decision record (`ask_approved`) must also be durable **before** the tool executes; if that write fails, refuse the call.
- Idempotency: operator tools already require `idempotency_key` for `operator_chat_send` and map it to `requestId: external:<clientId>:<key>`. Builtin write tools do not take such a key uniformly. Proposal: in ask mode the server derives a dedup key = `clientId + tool + sha256(canonical args)` (plus the client's `idempotency_key` when provided). Rules:
  1. Same key while pending → attach to the existing pending approval (no second card).
  2. Same key after `approved` and executed → return the cached result (bounded TTL, e.g. 10 min) instead of re-running.
  3. Same key after reject/timeout → creates a new approval (a rejected call may legitimately be retried); a rejection TTL of ~30 s may be added to stop an LLM spamming the user after "no".
- `recipient_busy` (operator chat send refusing while a chat runs) is orthogonal: approval happens first, then the tool's own busy check runs on execution and may still return `recipient_busy`. The user approved a send that then bounced; the client retries with the same key and needs a fresh approval unless rule 2 applies. This is acceptable, but should be documented in the card text.

### (f) Impact on the stateless `/mcp` transport

The transport is built per request with no session and JSON responses, so there is no server-initiated message channel and no resumable stream. Consequences:

- **Long-held request (v1 recommendation):** the `tools/call` HTTP request stays open until the decision or the timeout. Works with the current code (the handler is simply `await`ed). Risks: reverse proxies and clients commonly cut idle requests at 30–60 s (nginx default `proxy_read_timeout` 60 s; many MCP clients have 60 s tool timeouts; `operator_chat_wait` already caps itself at 55 s via `WAIT_MAX_MS` for this reason). A window above ~55 s therefore needs either a longer proxy timeout or option B/C. No SSE keep-alive is available in `enableJsonResponse` mode.
- **Poll/retry pattern:** return quickly (≤ 25 s) with `APPROVAL_PENDING: approval <id> requested; retry the same call with the same idempotency_key` and let the client re-issue. Because dedup (§e rule 1) attaches the retry to the pending card, and rule 2 returns the cached result once approved, this works on a stateless transport and survives proxies. Cost: relies on the client (or its model) retrying; each retry consumes rate-limit budget (60/min), so pending retries should not count against `consumeExternalMcpRateLimit`.
- Hybrid: hold up to ~25 s, then fall back to `APPROVAL_PENDING` polling. Best compatibility, most code.
- No change needed to token auth, loopback/LAN gating, or the per-request `Server` lifecycle. Pending state lives outside the per-request objects (module-level registry), because `res.on('close')` tears the transport down at the end of each request.
- `externalMcpInstructions(client.mode)` should gain an ask-mode paragraph telling the model how to read the `APPROVAL_*` results.

## 3. Which tools are gated

Gate by an allowlist of *mutating* tools, not by name heuristics: `todo_create`, `todo_update`, `todo_integration`, `todo_move`, `todo_start`, `delegation_start`, `delegation_cancel`, `delegation_reply`, chat archive/rename/delete, `watcher_set`/`watcher_update`, lessons/wmem writes, `billing_create`/`billing_update`. Reads pass through as in `plan` mode. Operator-only tools stay `operator`-mode only; ask mode does not expose `operator_*`. Unknown tools default to gated (safe default).

## 4. Non-goals

- No "always allow" in v1 (it would turn ask into agent); a later "allow this tool for 1 h" is an open question.
- No approval by the external client itself, and no auto-approval via the approval advisor.
- Plan approval (`operator_plan_approve`) semantics are unchanged.

## 5. Options

| # | Option | Pros | Cons |
| --- | --- | --- | --- |
| A | New mode `ask`, long-held request (≤ 55 s default, configurable), UI card + push | Simplest; fits stateless handler; client sees one result | Proxy / client timeouts; one open connection per pending call |
| B | New mode `ask`, short hold + `APPROVAL_PENDING` poll/retry with dedup | Proxy-safe; survives restarts better | Needs client retry; more server state (cache, TTLs) |
| C | A with fallback to B after ~25 s (hybrid) | Best compatibility | Most code and tests |
| D | No new mode; per-tool "require approval" flag on `agent` clients | Finer control | Mode matrix explodes; harder to reason about |
| E | Do nothing; use `plan` + `operator` | Zero work | No safe write path for untrusted-ish clients |

**Recommendation: A first, with a path to C.** Concretely: implement the registry + dedup (needed by every option), ship **A with a 55 s default window** (the same ceiling `operator_chat_wait` already respects) returning `APPROVAL_TIMEOUT` with a retry hint, and add the polling fallback only if real clients hit proxy limits. Use `isError` tool results (§c), gate by allowlist (§3), reuse `approval-audit.ts` and the push helper (§d).

## 6. Open questions for the user

1. Is a 55 s default window acceptable, or do you need minutes (then proxy/client timeouts must be raised or option B/C chosen)?
2. Should rejection/timeout be a tool result with `isError` (recommended) or a JSON-RPC error with custom codes?
3. Which mutating tools should be gated — the full allowlist in §3, or a smaller starter set (todo + delegation only)?
4. Is "allow this tool for the next N minutes" wanted later, or should ask mode never grant standing approval?
5. Should approvals also be possible from the push notification itself (action buttons), or only inside the UI?
6. Should the argument summary on the card be shown in full (redacted) or only tool name + hash? The audit file keeps no arguments today.
7. Should retries after reject be throttled (e.g. 30 s cool-down) to prevent an LLM from spamming approval prompts?
8. Cached results for idempotent replays: acceptable to hold tool results in memory for ~10 min?
