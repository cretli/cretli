# Approval broker MVP (OpenCode, local policy)

Status: implemented in the working tree. The optional external advisor is
documented separately in `docs/APPROVAL-BROKER-PHASE-2.md` and remains disabled
unless explicitly configured and enabled.

## Scope

The broker is an **overlay** on top of the existing OpenCode permission flow. In
`off` and `shadow` it can only *reduce* automation; `local_reads` is an explicit
opt-in mode that adds automation for confined, low-risk reads. It never adds a
second command allowlist and never widens the existing plan/review guard.

Included:

- OpenCode `permission.asked` / `permission.v2.asked` only.
- Local, deterministic policy (`approvalBroker.mode`):
  - `off` (default) — no broker decision; the manual `opencodePermissionReply`
    path is unchanged. The existing delegated read-only auto-allow is preserved.
  - `shadow` — computes a recommendation and writes an audit entry, but never
    sends a reply to the harness.
  - `local_reads` (opt-in) — auto-replies `once` **only** for safe read-only
    actions whose explicit resources and absolute command paths are inside the
    assigned workspace; everything else stays on the human card.
- Audit log with secret redaction (`data/approvals/approval-audit.jsonl`).

Excluded (out of scope for this round):

- Qwen / CodeBuddy / Cursor SDK / Codex / OpenRouter / DeepSeek hooks.
- SDK Ask mode (conversation mode, not a permission broker).
- Any `always` reply (only `once` is ever sent automatically).
- Cross-provider retry.

## Decision contract

Input (redacted before audit/provider use):

```json
{
  "requestId": "...",
  "harness": "opencode",
  "mode": "agent",
  "assignment": "review|implement|\"\"",
  "permission": "bash|read|edit|...",
  "command": "...",
  "policyVersion": "opencode-local-1"
}
```

Output:

```json
{
  "decision": "allow|deny|ask_user",
  "reply": "once|reject|null",
  "risk": "low|medium|high",
  "reason": "...",
  "categories": ["mutation", "network", "secrets", "privilege", "destructive"],
  "confidence": 1,
  "policyVersion": "opencode-local-1"
}
```

`allow` maps to a one-shot `once`; `deny` to `reject`; `ask_user` to `null`
(manual card + push). `always` is never emitted.

## Safety invariants

1. Local deterministic policy is reusing `isMutatingPlanModeShellCommand`,
   `isPlanModeMutatingToolName`, `shouldRejectOpenCodePlanPermission` and
   `shouldAutoAllowOpenCodeDelegationPermission`. The only extra classifier is a
   **denylist overlay** for network / secrets / production-privilege /
   destructive commands.
2. Edits, deletes, network, secrets, production, privilege changes and git
   writes are never auto-approved, in any mode.
3. In plan / review, the guard deny always wins (`local_reads` cannot override
   it). `node scripts/review-verify.js` stays allowed for review children.
4. At most one reply per `requestId`, whether from the broker or the human card
   (`lib/opencode/opencode-permission-reply-guard.js`).
5. If the automatic `once` POST fails, the card is restored and the user is
   notified instead of losing the permission.
6. A broker `ask_user` keeps the delegation in `waiting_for_input`; an idle
   harness is not finished as `adapter_incomplete` while the card is pending.
7. Missing workspace context or a path outside the assigned workspace fails
   closed for `local_reads`.

## Integration points

- `lib/approval/approval-broker.js` — modes, settings normalization, audit.
- `lib/approval/approval-audit.js` — bounded JSONL audit with redaction.
- `lib/opencode/opencode-permission.js` — `classifyOpenCodePermissionRisk`,
  `resolveOpenCodeApprovalAction` (pure decision),
  `isOpenCodePermissionWithinWorkspace` (path confinement).
- `lib/opencode/opencode-permission-reply-guard.js` — replyId idempotency.
- `lib/opencode/opencode-agent-ws.js` — `handleOpenCodeStreamEvent` wiring after
  the plan/review guard; `allowOpenCodeReviewPermissionOnce` (once) and the
  manual `replyOpenCodePermission` both claim the guard.
- `lib/delegation-run-bridge.js` — pending OpenCode input defers run finish.
- `lib/persist/settings.js`, `lib/routes/settings-routes.js` — `approvalBroker`
  settings, default `off`.

## Settings

`data/config.json` may contain:

```json
{ "approvalBroker": { "mode": "shadow" } }
```

`off` is represented by the absence of the block. The Settings API exposes
`approvalBroker: { mode, policyVersion }` and accepts a patch. A dedicated UI
toggle is a follow-up; the HTTP setting is the MVP opt-in.

## Phase 2 external advisor

Phase 2 is implemented as an opt-in external advisor. Its contract, SSRF/DNS
pinning, redaction, quota and rollout limits are documented in
`docs/APPROVAL-BROKER-PHASE-2.md`.

## Tests

- `tests/approval-broker.test.js` — settings default off, shadow no-reply,
  once-not-always, deny mutating/network/secret actions, audit redaction,
  idempotency guard.
- `tests/opencode-permission.test.js` — decision precedence and delegation
  read auto-allow regression.
- `tests/plan-mode-enforcement.test.js` — broker never overrides plan/review.
- `tests/delegation-adapter-incomplete.test.js` — broker `ask_user` stays
  `waiting_for_input`, not `adapter_incomplete`.
