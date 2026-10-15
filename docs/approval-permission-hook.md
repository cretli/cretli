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

Advisory-only scope (`riskScope=advise_all`, advisor role `advisory`) uses
`buildAdvisoryPermissionTuple`: by default the outbound tuple is minimal (request
id, controlled action name, local risk, categories — no command, no resources).
The settings toggle **`sendSensitiveCommand`** applies **only to this advisory
role**. When `true`, a bounded redacted command snippet and resource basenames
are added only for lower-risk advisory requests (low/medium risk without secrets,
network, privilege, destructive, or expansion categories). High or unknown risk
and those sensitive categories keep a minimal payload even when the toggle is on
(see `needsMinimalAdvisorPayload` in `lib/approval/permission-request.js`).

Authority role (`low_only`, `advisor_assessed`) uses `buildAdvisorPermissionTuple`
and always sends the documented redacted tuple (including command and basenames from
`normalizePermissionRequest`) **regardless of `sendSensitiveCommand`**.

The advisor never executes harness replies; it only feeds the OpenCode permission
card UI (or, in authority mode, may widen a narrow allow into a single `once`
under existing broker rules).

Audit rows (`lib/approval/approval-audit.js`) correlate assessments
(`kind=advisor_assessment`) with human card replies (`kind=human_permission_decision`)
via `requestId`. Assessments record `policyVersion` from the table above; advisor
wire evolution is tracked separately as `advisorPolicyVersion` on assessment lines.
`human_permission_decision` rows are appended only after a successful human reply
POST (`once` / `always` / `reject`). **`ask_user` is never written as a final
human decision.**

When a permission card disappears without a human answer — for example the
permission stream resolves on its own, the OpenCode session resets, or the run
aborts — **no closing audit event is written**. Correlation therefore treats a
missing `human_permission_decision` for a given `requestId` as **no human
decision recorded** (not an implicit deny or allow). An `advisor_assessment` or
`advisor_skip` line may still exist for the same `requestId`.

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
| Claude | `canUseTool` + shared Cretli permission card | `lib/claude/claude-agent-ws.js`, `lib/approval/can-use-tool-permission.js` | `off`/`shadow` keep legacy behavior; `local_reads` gates `ask_user` calls with Once/Reject (no Always) |
| Qwen | `canUseTool` + shared Cretli permission card | `lib/qwen/qwen-agent-ws.js`, `lib/approval/can-use-tool-permission.js` | `plan` \| `yolo` remains; broker `local_reads` adds Once/Reject (no Always) |
| CodeBuddy | `canUseTool` (plan guard) | `lib/codebuddy/codebuddy-live-session.js:186` | Agent WS sets `permissionMode` `plan` \| `bypassPermissions` at `lib/codebuddy/codebuddy-agent-ws.js:265` |
| Codex | `approvalPolicy: 'never'` (headless) | `lib/codex/codex-thread-options.js:53`, `docs/codex/SETUP.md:24` (`sandboxMode` and `approvalPolicy`) | No host pre-exec gate; see [Codex and Cursor SDK: no verified host gate](#codex-and-cursor-sdk-no-verified-host-gate) |
| SDK (Cursor) | Host plan guard in tool executor | `lib/agent-harness/tool-executor.js:172-196` | No host pre-exec gate; see [Codex and Cursor SDK: no verified host gate](#codex-and-cursor-sdk-no-verified-host-gate) |
| DeepSeek (DSH) | Same as generic harness loop | `lib/agent-harness/llm-tool-loop.js:271` → `executeTool` | Plan/read-only guards only; no ask_user seam |
| OpenRouter | Same | `lib/agent-harness/llm-tool-loop.js:271` | No dedicated permission callback |
| Mistral | Same | `lib/agent-harness/llm-tool-loop.js:271` | No dedicated permission callback |

Future harness adapters should call `normalizePermissionRequest` at the row’s
pre-exec decision point before emitting `ask_user` to the user or harness.

### Codex and Cursor SDK: no verified host gate

Verified against `@openai/codex-sdk` 0.160.0 (bundled `codex` binary) and
`@cursor/sdk` 1.0.37. Cretli does **not** claim a host approval gate for either
harness, and the shared `can-use-tool-permission.js` flow is not wired to them.

**Codex**

- Threads run with `approvalPolicy: 'never'` and `sandboxMode:
  'danger-full-access'` (`lib/codex/codex-thread-options.js`). The SDK spawns
  `codex exec --json`; its `ThreadEvent` stream (`item.started` /
  `item.updated` / `item.completed`, `turn.*`, `error`) has no approval-request
  event and no reply channel, so `on-request` / `untrusted` would only make
  tools fail, not ask the host.
- Codex CLI does expose config-defined `PreToolUse` / `PermissionRequest`
  command hooks (`[hooks]` in the Codex config, gated by persisted hook trust
  via `trusted_hash`, or `--dangerously-bypass-hook-trust`). That would be a
  separate out-of-process hook script that has to call back into the server
  with a per-run secret. It is not implemented: it needs Cretli to write hook
  config and trust state into the Codex home (a harness-settings change that
  must be an explicit user action), and its behaviour in `codex exec` could not
  be exercised end to end here (no authenticated run available).
- Safe fallback (current behaviour): the plan/review/scout guards in
  `lib/sdk/sdk-plan-guard.js` (prompt hint plus post-hoc event guard) and
  `sandboxMode: 'read-only'` for Scout runs. Nothing is auto-approved.

**Cursor SDK**

- `AgentOptions` / `LocalSendOptions` expose no `canUseTool`, permission
  callback or pre-tool hook. The only host-side seams are `customTools`
  (in-process tools; they explicitly never require approval), `sandboxOptions`
  and `autoReview`, which are Cursor-runtime policy, not a host decision point.
- Safe fallback: host plan guard in `lib/agent-harness/tool-executor.js`; the
  Cursor runtime keeps its own approval behaviour. Cretli does not change
  `sandboxOptions` / `autoReview` autonomously.
- `settingSources` and repo or user config hooks (Cursor-side configuration
  files) are configuration routes outside the host: they are not an SDK
  callback, give Cretli no per-request decision point, and are not used as a
  gate.

`tests/codex-cursor-no-host-gate.test.js` pins these facts: if an SDK upgrade
adds an approval event, a `canUseTool` option, or someone wires the permission
flow into these harnesses, the test fails and this section must be revisited
(a new gate must be default off, fail closed, once/reject only, bound to a
`requestId` card, and covered by a real runtime-path test).

### OpenCode edit size evidence

The installed OpenCode 1.19.0 runtime emits edit and write permission requests
with `permission: "edit"`, a workspace-relative `patterns` entry, and
`metadata.filepath` plus the proposed patch in `metadata.diff`. The SDK's
`PermissionRequest` type exposes `metadata` as an extensible object; it does not
define a separate byte-count field. The workspace edit policy therefore
measures the UTF-8 byte length of the supplied diff and keeps the request with a
human when no recognized content or diff field is present. This is a bound on
the proposed patch data, not the final file size; the path and symlink checks
remain separate gates.

### Persistent human grants for Claude and Qwen

Callback permission cards offer **Always** for the exact tool and arguments,
plus **Always allow this harness in this workspace** for all tools in that
workspace. These are explicit human choices; the advisor can only allow once.
Grants survive server restarts and apply across chats using the same harness
and workspace. They never override Plan, review, or Scout denials.

Manage these grants under Settings → Harness → Claude/Qwen → Permissions.
The panel lists each grant, its workspace and scope, and lets you revoke one or
all listed grants. Older hashes without display metadata remain revocable.

Cretli stores grant hashes and display metadata in
`data/approval-human-grants.json`; commands, arguments and absolute workspace
paths are not stored in this file. Delete the file to revoke all these grants. Revocation takes effect on the next tool call, without a restart.
An already allowed tool call continues running.


### Per-harness approval categories

Settings → Harness → Claude/Qwen/OpenCode → Permissions offers an overall
approval-check toggle and individual toggles for files, MCP tools, shell
commands, web tools and other tools. These preferences are stored per harness
in `harnessPermissionControls` through GET/PATCH `/api/settings`. Partial patches
preserve other categories and harnesses. Missing settings keep checks enabled.

Disabling a category explicitly permits its tool calls without broker or
advisor approval, including writes and commands. This applies to every chat
and workspace for that harness starting with the next tool call; already
pending approval cards keep their existing decision flow. Plan, review and
Scout guards remain enforced independently. Enabled categories follow the
broker mode and existing human grants. Re-enabling a category does not revoke
previously saved human grants; revoke those separately in the same panel.

A tool is classified by its name, with MCP prefixes checked first. A shell
command that edits files belongs to the shell category; an MCP tool that edits
files belongs to MCP. Unknown tool names belong to the other-tools category.


### Harness coverage

Every harness has a Settings → Harness → Permissions tab. Category approval
checks are implemented for Claude, Qwen, OpenCode, OpenRouter, Mistral, Z.AI SDK
and MiMo. The latter four execute tools through Cretli's shared tool executor:
consent is requested before execution, after the existing read-only guards.
Their cards support Once, Reject, exact Always and persistent workspace grants.
Cancelling a run also cancels a pending permission request.

Cursor SDK, Codex, CodeBuddy and DeepSeek currently execute native tools without
a verified Cretli pre-execution approval/reply channel. Their Permissions tabs
explain this limitation instead of offering switches that cannot control those
native tools. Their existing mode restrictions continue to apply. Adding a tab
or saving category preferences does not introduce a native approval channel.
