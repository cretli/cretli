# ADR: Harness-neutral permission hook and one tokenizer

## Status

Accepted (2026-10-10). Implements the contract seam and shared token estimation;
per-harness adapters are a follow-up leaf.

## Context

OpenCode integrates an approval broker and optional external advisor
(`lib/approval/approval-broker.js`, `lib/approval/approval-advisor.js`).
Other harnesses use SDK callbacks, plan guards, or headless policies. Token
counts for UI fallbacks and advisor billing used duplicated `chars / 4` math and
a private OpenAI-style usage parser in the advisor.

We need one canonical permission request shape before any harness decides
`ask_user`, and one shared chars/4 estimator plus one usage normalizer for
advisor completion payloads — without wiring new harness adapters in this
change.

## Decision

1. **D1 — Permission hook seam** — `lib/approval/permission-request.js` exports
   `normalizePermissionRequest` and `resolveApprovalPolicyVersion`. OpenCode
   advisor tuples and audit rows stay byte-compatible via thin wrappers.
2. **D2 — One tokenizer** — `estimateTokensFromText` in
   `lib/sdk/sdk-context-advisory.js` is the only chars/4 fallback. Reported
   usage from harnesses remains authoritative via `resolveExactTotalTokens` /
   `readReportedTokenCount`. Advisor HTTP usage uses
   `resolveOpenAiStyleCompletionUsage` in `lib/usage/usage-normalize.js`.
3. **Out of scope here** — Per-harness adapters calling
   `normalizePermissionRequest` (sibling leaf). Read-only classifier
   consolidation (sibling leaf).

## D1 — Canonical permission request

Shape returned by `normalizePermissionRequest`:

| Field | Type | Notes |
|-------|------|--------|
| `harness` | string | Caller-supplied harness id |
| `requestId` | string | Max 64 chars |
| `permission` | string | Redacted action name, max 120 |
| `command` | string | Redacted/sanitized command, max 300 |
| `resources` | string[] | Basenames only, max 8 × 120 |
| `risk` | string | From approval action |
| `categories` | string[] | Max 8 |
| `policyVersion` | string | Max 80; OpenCode default from `APPROVAL_BROKER_POLICY_VERSION` |

Policy versions:

- `opencode` → `opencode-local-1` (`APPROVAL_BROKER_POLICY_VERSION` in
  `lib/approval/permission-request.js`, re-exported from `approval-broker.js`).
- All other harnesses → `harness-neutral-0` (`HARNESS_NEUTRAL_POLICY_VERSION`)
  until a harness-specific ruleset exists.

Redaction uses `redactText`, path basenames, and the caps above — identical to
the pre-extraction OpenCode advisor tuple.

## D2 — Authoritative tokenizer naming

| Concern | Module / export | Role |
|---------|-----------------|------|
| Chars/4 fallback estimate | `lib/sdk/sdk-context-advisory.js` → `estimateTokensFromText` | UI meter, prompt decoration budget |
| Reported totals | `lib/sdk/sdk-context-advisory.js` → `resolveExactTotalTokens`, `readReportedTokenCount` | Wins over estimate |
| Advisor completion usage | `lib/usage/usage-normalize.js` → `resolveOpenAiStyleCompletionUsage` | Tokens + cost from HTTP JSON |

No BPE tokenizer and no new npm dependency.

## Per-harness permission capability matrix

Rows reflect code as of this ADR. “Pre-exec hook” means an interactive or
host-side gate before the tool runs; plan-only prompts are noted separately.

| Harness | Pre-exec hook / policy | Primary location | Notes |
|---------|------------------------|------------------|-------|
| OpenCode | Broker + advisor on `permission.asked` | `lib/approval/approval-broker.js`, `lib/approval/approval-advisor.js` | Only harness wired to `normalizePermissionRequest` via advisor tuple and `recordOpenCodeApprovalAudit` today |
| Claude | `canUseTool` + `PreToolUse` deny | `lib/claude/claude-agent-ws.js:477`, `PreToolUse` deny `:437` | `permissionMode` from `resolveClaudePermissionMode`; no Cretli ask_user card |
| Qwen | `canUseTool` | `lib/qwen/qwen-agent-ws.js:635` | `permissionMode` `plan` \| `yolo` at `:630` |
| CodeBuddy | `canUseTool` (plan guard) | `lib/codebuddy/codebuddy-live-session.js:186` | Agent WS sets `permissionMode` `plan` \| `bypassPermissions` at `lib/codebuddy/codebuddy-agent-ws.js:265` |
| Codex | `approvalPolicy: 'never'` (headless) | `lib/codex/codex-thread-options.js:53`, `docs/codex/SETUP.md:24` | No interactive Once/Always; plan is prompt-only |
| SDK (Cursor) | Host plan guard in tool executor | `lib/agent-harness/tool-executor.js:172-196` | No `canUseTool` in Cretli SDK path; Cursor runtime handles its own approvals |
| DeepSeek (DSH) | Same as generic harness loop | `lib/agent-harness/llm-tool-loop.js:230` → `executeTool` | Plan/read-only guards only; no ask_user seam |
| OpenRouter | Same | `lib/agent-harness/llm-tool-loop.js:230` | No dedicated permission callback |
| Mistral | Same | `lib/agent-harness/llm-tool-loop.js:230` | No dedicated permission callback |

Future harness adapters should call `normalizePermissionRequest` at the row’s
pre-exec decision point before emitting `ask_user` to the user or harness.
