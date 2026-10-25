# Harness parity: Claude vs Codex, prompt inventory and unification plan

Status: research document, no code changes. Proposal only; nothing here is approved or scheduled.
Verified against the worktree base commit `5940e763` (all `file:line` references were read or grepped at that commit; line numbers drift, so re-grep the symbol name if a line no longer matches).

Origin: a Codex reviewer ran in a read-only sandbox that also blocks `/tmp`, while every reviewer prompt told it to run tests. That was fixed in `90b351dc` (`REVIEW_HOST_VERIFY_HINT`, `lib/delegation-prompt.js:227`). This document asks the wider question: where else do the two harnesses diverge for no good reason, and where do prompts live.

Legend for the "Why" column:

- **Justified**: a real limit of the harness or its SDK/CLI.
- **Accidental**: grew independently, no harness limit explains it; candidate for unification.
- **Mixed**: part limit, part drift.

Scope of "Claude" = `lib/claude/*`, `lib/agent-harness/claude-event-normalizer.ts`. "Codex" = `lib/codex/*`, `lib/agent-harness/codex-event-normalizer.ts`. Both share the room kernel (`lib/agent-harness/room-kernel.ts`), the plan guard (`lib/sdk/sdk-plan-guard.ts`) and the prompt decorator (`lib/sdk/harness-plan-prompt.ts`). The `harnesses/*` directory holds the optional harnesses (opencode, qwen, deepseek, ...); they are not Claude or Codex, but they are the third party in several comparisons below.

---

## 1. Difference matrix

### 1.1 Prompt and system prompt construction

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 1 | System prompt | Explicit preset `{ type: 'preset', preset: 'claude_code' }`, passed as `Options.systemPrompt` (`lib/claude/claude-agent-ws.ts:380`, used at `:659`). Without it the SDK would send an empty prompt (comment `:373-378`). | None. `buildCodexClientOptions` sets no instructions field (`lib/codex/codex-thread-options.ts:47-91`). Codex loads its own built-in prompt and `AGENTS.md`. | Justified. The Codex SDK has no system-prompt option Cretli uses. |
| 2 | Project rules (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`) | Read-only runs set `settingSources: ['project']` (`claude-agent-ws.ts:372`, applied `:668-673`); agent mode leaves it unset so user/project/local sources load. Cretli adds shared rules through the decorator. | Codex loads `AGENTS.md` itself. Cretli appends workspace rules in the decorated user prompt. | Mixed. Delivery differs by SDK, but the decision "which rules reach which harness" is split across `settingSources` and `buildDecorationBlocks` (`lib/sdk/harness-plan-prompt.ts:99`). |
| 3 | Per-turn prompt decoration | `decorateHarnessPrompt(room, text, 'claude')` in both the streaming turn (`claude-agent-ws.ts:1629`) and the one-shot path (`:1649`). | `decorateHarnessPrompt(room, text, 'codex')` for app-server (`lib/codex/codex-agent-ws.ts:477`) and SDK thread (`:487`). | Shared. Same function, same blocks (skills, rules, page context, plan, delegation reports, title hint). `decorateHarnessPrompt` is `lib/sdk/harness-plan-prompt.ts:502`. |
| 4 | Textual mode hint | `claude` policy has `promptHint: false` (`lib/agent-harness/harness-plan-policy.ts:75-80`): Plan is native (`permissionMode: 'plan'`), so no `HARNESS_PLAN_MODE_HINT` is injected. Ask still gets `HARNESS_ASK_MODE_HINT` (`harness-plan-prompt.ts:48`, chosen in `buildModeHint` `:151`). | `codex` policy has `promptHint: true` (`harness-plan-policy.ts:63-68`), so Plan gets `HARNESS_PLAN_MODE_HINT` (`harness-plan-prompt.ts:45`). | Justified for Plan (Codex has no native plan mode). |
| 5 | Delegation executor prompt | One builder for all harnesses: `buildDelegationExecutorPrompt` (`lib/delegation-prompt.js:294`). The only harness-specific input is `reviewCanRunTests`, which swaps the review hint (`buildModeHint`, `:239-250`). | Same. Codex gets `REVIEW_HOST_VERIFY_HINT` because its trait is `false` (`lib/delegation-adapter-capabilities.js:205`). | Good: one builder. See 1.4 for the remaining leak. |
| 6 | Harness-specific text inside a shared hint | `REVIEW_VERIFY_PROMPT_HINT` (`lib/sdk/sdk-review-verify.ts:603`) is sent to every harness that can run tests, including Claude. Two of its sentences describe DeepSeek only (`:609`, `:610`). | n/a (Codex gets the other hint). | Accidental. A Claude reviewer reads DeepSeek sandbox notes. Should be a capability-conditional block. |

### 1.2 Modes (plan / agent / ask / review / scout)

| # | Mode | Claude | Codex | Why |
|---|---|---|---|---|
| 7 | Agent | `permissionMode: 'acceptEdits'` (`claude-agent-ws.ts:297-304`); never `bypassPermissions` (header `:12-16`). | `sandboxMode: 'danger-full-access'`, `approvalPolicy: 'never'` (`codex-thread-options.ts:29`, `:66-71`). | Justified. Different permission models. |
| 8 | Plan | Native `permissionMode: 'plan'` plus `disallowedTools` (Edit, Write, MultiEdit, NotebookEdit, `:347-352`) and `settingSources` (`:670-673`). Guard denies before exec. | `sandboxMode: 'read-only'` when `sdkMode === 'plan'` (`codex-thread-options.ts:67`) plus prompt hint. Policy says `denyMutatingTools: false` (`harness-plan-policy.ts:65`), i.e. the host guard is idle in Plan; the sandbox is the enforcement. | Justified (no pre-exec hook), but see #9 and the stale comment below. |
| 9 | Ask | `permissionMode: 'default'` (`claude-agent-ws.ts:300`), `canUseTool` + `PreToolUse` deny mutations, `disallowedTools` set (`:671-673`). | **Sandbox is `danger-full-access`.** The read-only condition checks `sdkMode === 'plan'` only (`codex-thread-options.ts:66-70`) and Ask is not covered. Enforcement is the prompt hint plus the post-hoc guard that aborts the turn (`resolveHarnessAskPolicy`, `harness-plan-policy.ts:119-126`; abort in `codex-agent-ws.ts:237-246`). | **Accidental.** `isReadOnlySdkMode` already treats plan and ask together (`lib/sdk/sdk-mode.ts:50-53`), but the Codex sandbox does not use it. A write can start before the guard aborts. |
| 10 | Review | `permissionMode: 'default'` (`claude-agent-ws.ts:298`); `canUseTool` and `PreToolUse` deny pre-exec (`:420`, `:615`); `allowReviewVerify` lets the test catalog runner through (`lib/sdk/sdk-plan-guard.ts:864-867`). | `sandboxMode: 'read-only'` iff `reviewReadOnly` and `isCodexReviewSandboxEnabled(env)` (`codex-thread-options.ts:68`, `lib/codex/codex-review-sandbox.ts:11`). Guard cannot deny pre-exec: it aborts the turn, then queues up to 2 resumes (`codex-review-guard-resume.ts:12`, `:17`; `codex-agent-ws.ts:274-290`, `:534-548`). | Justified: Codex exec cannot reject one call and keep the process (comment `codex-review-guard-resume.ts:1-6`). |
| 11 | Review predicate | `isReviewReadOnlyAssignment(assignment)` (trim + lowercase, `lib/delegation-review-policy.js:11-13`). | Passes `reviewReadOnly: room.delegationAssignment === 'review'` (`codex-agent-ws.ts:384`), a strict compare. | Accidental, low risk today (assignment values are normalised upstream), but it is a second definition of "review". |
| 12 | Scout | `isScoutReadOnlyChatId` -> `settingSources` + `CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS` (adds Monitor, EnterWorktree, CronCreate, RemoteTrigger, SendMessage, Agent, Task; `claude-agent-ws.ts:355-363`, `:666-670`). | `scoutReadOnly` -> `sandboxMode: 'read-only'` (`codex-thread-options.ts:66`, passed at `codex-agent-ws.ts:383`). | Justified. Each uses its strongest native block. |
| 13 | Stale comment | n/a | The doc comment says Plan relies on "the prompt hint plus sdk-plan-guard" (`codex-thread-options.ts:17-19`) while the code puts Plan in `read-only` (`:67`) and the same comment later says so (`:20-23`). | Accidental documentation drift. |

### 1.3 Sandbox and permissions

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 14 | Enforcement point | Pre-exec: `canUseTool` (`claude-agent-ws.ts:420`) and `PreToolUse` hook (`:615`). The hook exists because `canUseTool` misses tools auto-approved by `permissions.allow` (comment `:611-614`). Capability `preExecDeny: true` (`delegation-adapter-capabilities.js:133`). | Sandbox (bwrap) for hard block; event-stream guard for the rest. `preExecDeny: false`, `sandboxReadOnly: true` (`delegation-adapter-capabilities.js:119-124`). | Justified. The review gate accepts either a pre-exec deny or a read-only sandbox (`hasHardReviewGuarantee`, `delegation-adapter-capabilities.js:306`). |
| 15 | Why not `workspace-write` | n/a | bwrap carves out `cwd/.git`; without a git repo every command dies (`codex-thread-options.ts:13-27`). So the choice is binary: full access or read-only. | Justified (upstream issue linked in the comment). |
| 16 | Operator escape hatch | none needed | `CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX=0` removes the sandbox and un-certifies Codex reviews (`codex-review-sandbox.ts:11-17`, `fallbackCaps` `delegation-adapter-capabilities.js:282-285`). | Justified. |
| 17 | Mode switch during a live session | `setPermissionMode` on the live `Query`; falls back to a session restart and records a context restart (`claude-agent-ws.ts:1474-1482`). | New thread options are built per run (`codex-agent-ws.ts:376-385`); the sandbox follows the next run. | Justified (different session models). |

### 1.4 Tests in review (`review_can_run_tests`)

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 18 | Static trait | `true` (`delegation-adapter-capabilities.js:207`): default permission mode + read-only hook, runner allowed through `allowReviewVerify`. | `false` (`:205`): the read-only sandbox blocks the runner's temp data dir (comment `delegation-adapter-capabilities.js:171-172`, and `codex-thread-options.ts:20-25`). | Justified. |
| 19 | Consumers | Same chain for both: `resolveDelegationReviewVerifyPlan` (`lib/delegation-review-verify-plan.js:39`) -> `delegation-service.js:3439` -> prompt (`delegation-prompt.js:244`) -> host verify (`delegation_verify`). Trait can flip by observation (`REVIEW_TEST_OBSERVATION_MIN_SIGNALS`). | Same. | Good. This is the one place where harness difference is already a data-driven capability. |
| 20 | Capability data is split four ways | `DEFAULTS` caps (`delegation-adapter-capabilities.js:12-148`), `HARNESS_DELEGATION_TRAITS` (`:196`), `HARNESS_PLAN_POLICIES` (`harness-plan-policy.ts:14`), `REVIEW_PRE_EXEC_DENY_TRANSPORTS` (`:96`). | same four tables | Accidental. See section 3. |

### 1.5 Session resume and compaction

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 21 | Resume handle | `claudeSessionId` -> `options.resume` (`claude-agent-ws.ts:690-692`), persisted by `setChatClaudeSessionId` (`:724`). | `codexThreadId` -> `resumeThread` (`codex-agent-ws.ts:425-427`), persisted by `setChatCodexThreadId` (`:497`). | Justified. |
| 22 | Stale resume recovery | Detects "no conversation found" / "session X not found" (`:707-717`), drops the id, retries once without resume and shows a `session_reset` notice (`shouldRetryClaudeRunWithoutResume` `:734`; retry `:1979-1999`). | None found. A stale `codexThreadId` surfaces as an exec error through `formatCodexExecFailure` (`codex-agent-ws.ts:504`, `:520`) and the id is not cleared. | **Accidental gap** (worth verifying with a stale-thread repro before fixing; Codex may report a different error text). |
| 23 | Instruction delivery epoch | `noteNativeSession` and `bumpInstructionEpoch` on session id change, resume failure, model change (`claude-agent-ws.ts:727`, `:1188`, `:1431-1436`), so static blocks are re-sent after a rebuild. | No direct use in `codex-agent-ws.ts`; relies on the shared `resolveInstructionDeliveryForTurn` (`harness-plan-prompt.ts:511`). | Possibly accidental. Needs a check that a Codex thread replacement re-delivers the static skills/rules block. |
| 24 | Compaction signal | `compact` notice from the SDK -> `advanceRoomContextEpoch(room, 'compact_boundary')` (`claude-agent-ws.ts:1145-1147`). | Rollout-log watcher (`watchCodexContextUsage`, `codex-agent-ws.ts:452`) plus app-server notification, deduped within 10 s (`CODEX_COMPACTION_DEDUPE_MS`, `:163`; `emitCodexCompaction` `:169-179`). | Justified (different signals). |
| 25 | Compaction tuning | Opt-in env knobs from unofficial sources (`lib/claude/claude-cache-settings.ts:1-17`). | Opt-in `--config` keys, documented in `docs/codex/COMPACTION.md` (`lib/codex/codex-compaction-config.ts:1-17`). | Justified; Codex side is better sourced. |
| 26 | Process lifetime | One long-lived `Query` per room, idle timer, `CRETLI_CLAUDE_STREAMING_SESSION=0` kill switch (`claude-session.ts:65-69`). | New client per run; app-server driver is opt-in `CRETLI_CODEX_APP_SERVER=1` (`codex-app-server.ts:34-36`, used `codex-agent-ws.ts:369`). | Justified. |

### 1.6 Usage and context

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 27 | Token usage | Normalised `usage` item with cost, model usage, last-call usage and window (`buildClaudeUsageSdkEvent`, `claude-agent-ws.ts:972-988`). | `usage` item -> `{type:'usage', final:true}` (`codex-agent-ws.ts:205-210`); richer numbers come from the rollout log (`lib/codex/codex-context-usage.ts`). | Justified. |
| 28 | Context occupancy | `readClaudeContextBreakdown` (`claude-agent-ws.ts:89`), reported window (`noteClaudeReportedContextWindows`). | Rollout-log based (`codex-context-usage.ts:1`, `codex-context-breakdown.ts`). | Justified. |
| 29 | Plan limits | Live SDK usage request or stored `rate_limit_event` snapshots (`lib/claude/claude-plan-limits.ts:1-5`). | Spawns app-server to read ChatGPT quota without a turn (`lib/codex/codex-plan-limits.ts:1`). | Justified. |

### 1.7 Interrupt and restart

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 30 | Interrupt | Two stage: `Query.interrupt()` with 3 s timeout, then abort + close after 5 s (`interruptActiveQuery` `claude-agent-ws.ts:816`; constants `:383`, `:390`). Keeps MCP connections alive. | `AbortController.abort()` on the stream (`abortCurrentTurn`, `codex-agent-ws.ts:105-119`); `abortCodexRoom` `:121`. | Justified. |
| 31 | Steering mid-turn | Streaming input: steer messages are pushed into the live session and reclaimed to `pendingPrompts` if unconsumed (`claude-agent-ws.ts:1219-1270`). | Only with the experimental app-server (`room.steerViaInput = isCodexAppServerEnabled()`, `codex-agent-ws.ts:571`); otherwise a steer degrades to a normal send (`:718`). | Justified (opt-in driver). |
| 32 | Guard abort | Guard sets `_planGuardTriggered` and interrupts; status `plan_guard_cancelled` (`claude-agent-ws.ts:1207-1212`, `:1967-1968`). | Same status, plus automatic read-only resume (max 2) and a distinct error code `review_guard_exhausted` (`codex-review-guard-resume.ts:32`, `codex-agent-ws.ts:539-557`). Claude denies pre-exec and never needs this. | Justified. |
| 33 | Server restart recovery | Both go through the shared recovery path (`lib/recovery/recovery-resume.ts:54`, `RESUME_CONTINUATION_PROMPT`) and `lib/chat-run/start-prompt-args.ts` (Claude has its own arg tuple, `:28`). | same | Shared. |

### 1.8 MCP bridge

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 34 | Server config format | `toClaudeMcpServers` (`lib/mcp/mcp-vendor-map.js:116`), passed as `options.mcpServers` with `strictMcpConfig: true` (`claude-agent-ws.ts:685-689`). | `toCodexMcpServers` (`mcp-vendor-map.js:31`), passed in the client `config.mcp_servers` (`codex-agent-ws.ts:419-423`). | Justified. |
| 35 | Hot update | `setMcpServers` on the live query; restart + `MCP_REVISION` context restart if it fails (`claude-agent-ws.ts:1491-1505`). | New client every run; records `MCP_REVISION` / `MCP_CONTENT_CHANGE` context restarts by comparing revisions (`codex-agent-ws.ts:396-412`). | Justified. |
| 36 | Watcher orchestrator gate | `enforceWatcherOrchestratorMcpGate` after the session is alive (`claude-agent-ws.ts:1610`) and for the one-shot path (`:1904`). | Same gate, probing the bridge catalog directly because the CLI starts only inside `runStreamed` (comment `codex-agent-ws.ts:428-431`; call `:432`). | Justified. |

### 1.9 Question and plan tools

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 37 | Ask the user | Native `AskUserQuestion` handled in `canUseTool` (`createAskUserQuestionCanUseTool`, `lib/approval/ask-user-question.ts:105`; wiring `claude-agent-ws.ts:429-470`), 30 min timeout (`:265`), session idle paused while waiting (`claude-session.ts:392-394`), cards replayed on reconnect (`claude-agent-ws.ts:574`). | No question channel: grep of `lib/codex` and the Codex normalizer finds no question/elicitation handling; `approvalPolicy` is fixed to `never` (`codex-thread-options.ts:71`). | Justified (Codex exec has no interactive tool). Consequence: Plan-mode "question UI approval" in the hint text (`HARNESS_PLAN_MODE_HINT`, `harness-plan-prompt.ts:46`) is not available to Codex. |
| 38 | Plan approval | `shouldExitPlanModeOnQuestionReply` (`lib/sdk/plan-approval-reply.ts:89`) switches Claude out of plan mode on an approval reply. | Plan is approved by the user switching Cretli mode; no in-run exit. Shared plan persistence for both: `bindHarnessPlanSync` (`claude-agent-ws.ts:2185`, `codex-agent-ws.ts:653`). | Justified. |
| 39 | Hint text mismatch | n/a | `HARNESS_PLAN_MODE_HINT` mentions a "question-UI approval (implement / yes)" confirmation (`harness-plan-prompt.ts:46`) that Codex cannot produce. | Accidental. The hint is one string for every prompt-hint harness. |

### 1.10 Errors and retry

| # | Aspect | Claude | Codex | Why |
|---|---|---|---|---|
| 40 | Run retry | Exactly one retry, only for stale resume (`shouldRetryClaudeRunWithoutResume`, `claude-agent-ws.ts:734-745`). SDK `api_retry` notices are surfaced as `phase: 'retry'` (`:917`). | No in-adapter retry. Guard resume is not a retry of failures (see #32). Startup failures are retried by the delegation layer (`delegation_start` docs), not by the adapter. | Mixed. |
| 41 | Error text | Raw error, or last stderr line (`claude-agent-ws.ts:1975`, `:2012`). | `formatCodexExecFailure` digs the real API error out of exec output and the rollout log (`lib/codex/codex-exec-error.ts:54-156`). | Justified; Codex needs it because the CLI wraps errors. |
| 42 | Usage-limit handling | Error candidates are de-duplicated for the shared usage-limit parser (`claude-agent-ws.ts:1038-1041`). | `known_failure_modes: ['usage_limit']` for Codex (`delegation-adapter-capabilities.js:205`). | Shared downstream. |

### 1.11 Summary of accidental differences worth acting on

1. **#9 Codex Ask mode runs `danger-full-access`** (`codex-thread-options.ts:66-70`). Small, testable fix: use `isReadOnlySdkMode`.
2. **#6 / #39 harness-specific sentences inside shared prompt strings** (DeepSeek notes in `REVIEW_VERIFY_PROMPT_HINT`, question-UI wording in `HARNESS_PLAN_MODE_HINT`).
3. **#20 capability data in four tables** with no single owner.
4. **#22 / #23 Codex lacks the stale-resume recovery and the explicit instruction-epoch calls** Claude has; verify before treating as a bug.
5. **#11 two definitions of "review"**.
6. **#13 stale comment** in `codex-thread-options.ts`.

---

## 2. Prompt inventory

### 2.1 The registry today

- `lib/prompts/blocks.js`: eight blocks, `PROMPT_BLOCKS` frozen (`:39-48`): `planGateAncestor`, `noCommitPush`, `noPushDestructive`, `noDataDir`, `mcpFirst`, `curlFallback`, `reviewerPolicy`, `pickForwarding`.
- `lib/prompts/overrides.js`:
  - hard keys, read-only and rejected by the API with 403 `HARD_BLOCK`: `planGateAncestor`, `noCommitPush`, `noPushDestructive`, `noDataDir`, `reviewerPolicy` (`HARD_PROMPT_BLOCK_KEYS`, `lib/prompts/overrides.js:12-18`; 403 check `:58`);
  - editable: `mcpFirst`, `curlFallback`, `pickForwarding` (`isEditablePromptBlock`, `:31`);
  - `MAX_OVERRIDE_CHARS = 1200` (`:20`), enforced in `setPromptOverride` (`:61`);
  - overrides live in a module-level `Map` (`:23`) and resolve synchronously through `getPromptBlock` (`:41`);
  - no versioning, no history, no per-block validation beyond non-empty and length.
- `lib/prompts/overrides-store.js`: one file `data/prompt-overrides.json`, global to the server (not per workspace), written with a plain `writeFileSync` (`lib/prompts/overrides-store.js:31`), loaded by `loadPromptOverrides` (`:19`; an unreadable file silently falls back to defaults, `:22-25`).
- `lib/routes/prompt-registry-routes.js`: `GET /api/prompt-registry` (blocks with `hard`, `defaultText`, `text`, `overridden`, `:25-35`), `GET /api/prompt-registry/preview` (`:37-43`), `PUT` and `DELETE /api/prompt-registry/blocks/:key` (`:45-59`). Registered at `lib/register-app-routes.js:202`.
- `lib/prompts/preview.js`: renders four sample prompts: watcher, todoExecution, delegationExecutor, bulkIntegrate (`renderPromptPreviews` `:27-36`), soft budget 24000 chars (`lib/prompts/preview.js:12`). No other prompt is previewed.
- UI: `app_front/features/settings/agentPromptsSettings.js` (172 lines): hard blocks are `readonly`, editable ones get save and reset (`:77-91`, `:153`).
- Tests: `tests/prompt-registry-consistency.test.js`, `tests/prompt-registry-routes.test.js`.

Which builders actually call the registry:

| Block | Used by |
|---|---|
| `mcpFirst` | `lib/todo-execution-prompt.js:18`, `lib/integrate-batch.js:357` |
| `curlFallback` | `lib/integrate-batch.js:361` |
| `pickForwarding` | `lib/todo-execution-prompt.js:25`, `lib/workspace-watcher-prompt.js:637` |
| `noCommitPush`, `noDataDir` | `lib/delegation-prompt.js:94` (import-time constant), `lib/todo-execution-prompt.js` orchestrator hard rules |
| `planGateAncestor`, `reviewerPolicy` | `lib/todo-execution-prompt.js` |
| `noPushDestructive` | `lib/workspace-watcher-integration.js:59`, `lib/integrate-batch.js` (via that constant) |

### 2.2 All places that assemble agent prompts

"Registry" = composes at least one registry block. "Editable" = a user can change any of its text through Settings today. Almost everything is **hardcoded**; only the three editable blocks are user-changeable, and each appears in a handful of sentences.

| Place | What it builds | Registry blocks | Editable text | Notes |
|---|---|---|---|---|
| `lib/delegation-prompt.js:294` `buildDelegationExecutorPrompt` | Every delegated child: role, mode hint, decision boundary, completion, report contract, review blocks | `noCommitPush`, `noDataDir` (`:94`) | none | Inline constants: `DECISION_BOUNDARY` `:47`, `COMPLETION_DEFINITION` `:56`, `REPORT_BULLETS` `:96`, `BOUNDED_EXECUTION` `:110`, `REVIEW_HOST_VERIFY_HINT` `:227`, `NO_NESTED_DELEGATION_SENTENCE` `:33`, `REPORT_TAIL_REMINDER` `:171`. Prompt order is a cache contract (comment before `stableHead`, `:345-349`). |
| `lib/delegation-review-gate.js:39,78,130` | Fix findings, regression gate, leaf acceptance blocks | none | none | Appended to the delegation prompt. |
| `lib/delegation-code-review-phase.js:670,690` | Audit / closure review blocks | none | none | |
| `lib/delegation-prompt.js:407` `buildReviewLessonsPromptBlock` | Lessons injected into reviewer/implementer prompts | none | none (content is a user-managed store, `lib/review-lessons-select.js`) | Budget `REVIEW_LESSONS_PROMPT_CHAR_BUDGET` `:24`. |
| `lib/delegation-session-resume-record.js:50` | Session-resume block | none | none | |
| `lib/sdk/sdk-review-verify.ts:603` | `REVIEW_VERIFY_PROMPT_HINT` | none | none | Contains harness-specific text (#6). |
| `lib/workspace-watcher-prompt.js:560` `buildWorkspaceWatcherCyclePromptPlan` | Watcher cycle orchestrator prompt (762 lines in file, budget `WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET` `:214`) | `pickForwarding` (`:637`) | `pickForwarding` only | Also memory block (`:417`), previous-chats block (`:154`), review-gate lines (`:492`). |
| `lib/todo-execution-prompt.js:15` `buildTodoExecutionWorkflow` | TODO orchestrator protocol, about 25 long inline sentences | `mcpFirst`, `pickForwarding`, `planGateAncestor`, `reviewerPolicy`, `noCommitPush`, `noDataDir` | `mcpFirst`, `pickForwarding` | `TODO_EXECUTION_WORKFLOW` is evaluated at import (`:48`). `stripTodoExecutionWorkflow` (`:177`) removes the instructions from history by `endsWith` match against the current builder output. |
| `lib/todo-execution-prompt.js:51,66,85,123,155` | Continue instructions, reviewer pool, reviewer/work policy lines | none | none | |
| `lib/todo-agent.js:78,120,174` | Initial prompts for todo agent, refine, full orchestrator | none | none | Line 101 tells the agent to **read the source file** `lib/todo-execution-prompt.js` and follow `TODO_EXECUTION_WORKFLOW` (see risk R2). |
| `lib/integrate-batch.js:340` `buildBatchWrapperPrompt` | Bulk integrate wrapper | `mcpFirst`, `curlFallback`, `noDataDir`, `noPushDestructive` | `mcpFirst`, `curlFallback` | |
| `lib/worktree-merge.js:234` | Smart-merge prompt | none | none | |
| `lib/workspace-watcher-scout.js:848,1328` | Scout scan prompt (profile + default) | none | none | Read-only guarantee comes from the harness, not the text. |
| `lib/plan-reviewer-cooperation.js:254,272,287`; `lib/plan-reviewer-cooperation-service.js:376` | Plan-review exchange / read-only / collaborative blocks | none | none | |
| `lib/watcher-phases.js:153` | Phase-scope lines | none | none | |
| `lib/delegation-verdict-followup.js:11` | `VERDICT_FOLLOWUP_PROMPT` | none | none | The server parses the reply; text is part of a contract. |
| `lib/delegation-mailbox.js:242` | Mailbox delivery prompt | none | none | |
| `lib/sdk/harness-plan-prompt.ts:45,48` | `HARNESS_PLAN_MODE_HINT`, `HARNESS_ASK_MODE_HINT` | none | none | Per-harness switch lives in `harness-plan-policy.ts`. |
| `lib/sdk/harness-plan-prompt.ts:99,502` | Decorator: skills, rules, AGENTS.md, page context, plan, reports, title hint | none | none | Dedupe by `prompt-decoration.ts` state; static block re-sent per instruction epoch. |
| `lib/sdk/sdk-plan-guard.ts:812`, `lib/workspace-scout-chat.js:14` | Guard user messages (`resolveReadOnlyGuardUserMessage`, `SCOUT_READ_ONLY_MESSAGE`) | none | none | Shown to the model after a denial. |
| `lib/codex/codex-review-guard-resume.ts:14-29` | Codex guard resume prompt and display text | none | none | Codex only. |
| `lib/recovery/recovery-resume.ts:54`, `lib/usage-limit-resume-executor.js:23`, `lib/usage/keep-alive-scheduler.ts:49` | Auto-resume / keep-alive prompts | none | none | |
| `lib/conversation-fork.js:170,218,263,375` | Fork / handoff / analysis prompts | none | none | |
| `lib/fork-title.js:60,64,234,253`; `lib/chat-title-agent.js` | Title and summary prompts | none | none | |
| `lib/chat-plan-persist.js:168`, `lib/chat-plan-path.js:33` | Chat plan context and "implement approved plan" prompt | none | none | |
| `lib/context/history-summary.ts:348,644`, `lib/context-compression.js:354-390` | Summarisation / compression / new-session seed | none | none | |
| `lib/agent-harness/llm-tool-loop.ts:25` | `buildLlmSystemPrompt` for the host-driven LLM harnesses (openrouter, mistral, zai, mimo) | none | none | The only real system prompt Cretli itself writes. |
| `lib/claude/claude-agent-ws.ts:380` | `CLAUDE_SYSTEM_PROMPT` preset | none | none | A preset reference, not text. |
| `harnesses/*` (opencode, qwen, deepseek, codebuddy, ...) | Adapters call `decorateHarnessPrompt` (for example `harnesses/deepseek/deepseek-agent-ws.js:590`, `harnesses/qwen/qwen-agent-ws.js:791`) | none | none | No harness-specific prompt text of their own beyond the shared hints. |

### 2.3 Gaps in the current registry design

- **R1: only 3 of 8 blocks are editable and they are one sentence each.** The long, behaviour-shaping text (decision boundary, report contract, workflow steps) is outside the registry.
- **R2: `todo-agent.js:101` and `lib/mcp/builtin/todo-tools.js:376` send agents to read the source file** `lib/todo-execution-prompt.js` and follow `TODO_EXECUTION_WORKFLOW`. An agent reading the file sees the **default** text, so an override of `mcpFirst` or `pickForwarding` is invisible on that path.
- **R3: `stripTodoExecutionWorkflow` matches the current output.** After an override change, stored prompts built with the old text no longer match and the instructions leak into the chat UI. Versioned history of previous texts is needed to keep stripping working.
- **R4: import-time capture.** `REPOSITORY_SAFETY` (`delegation-prompt.js:94`) and `TODO_EXECUTION_WORKFLOW` (`todo-execution-prompt.js:48`) freeze default text at import. Fine for hard blocks, wrong for editable ones.
- **R5: global scope, no audit trail, non-atomic write** (`overrides-store.js:31`), and an unreadable file silently resets everything (`:22-25`).
- **R6: a protocol sentence can be edited into breaking the protocol.** `pickForwarding` contains `pick_id`; an override that drops it makes the server reject `delegation_start` links. No required-token validation exists.
- **R7: preview covers 4 prompts**, none of them per harness or per assignment (review with and without tests, plan, scout).

---

## 3. Architecture proposal

### 3.1 One harness-capabilities layer

Today the same facts are spread over: `DEFAULTS` caps and `HARNESS_DELEGATION_TRAITS` (`delegation-adapter-capabilities.js:12`, `:196`), `HARNESS_PLAN_POLICIES` and `REVIEW_PRE_EXEC_DENY_TRANSPORTS` (`harness-plan-policy.ts:14`, `:96`), `HARNESSES_SUPPORTING_VERDICT_FOLLOWUP` (`delegation-adapter-capabilities.js:215`), `PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS` (`harness-plan-prompt.ts:61`), plus the Codex sandbox selection inline in `codex-thread-options.ts:66-70` and the Claude permission mapping in `claude-agent-ws.ts:297`.

Proposal: a single declarative module, for example `lib/harness-capabilities/` (JS with JSDoc types or strict TS, matching the neighbours), exporting one frozen record per transport:

```
{
  enforcement: { planMode: 'native' | 'sandbox' | 'host-guard' | 'prompt',
                 askMode: ..., reviewMode: ..., scoutMode: ... },
  preExecDeny, sandboxReadOnly, abortOnMutation,
  review: { canRunTests, hostVerifyRequired, guardResumeMax },
  questions: { interactiveTool: boolean },
  plan: { nativeMode, promptHint },
  session: { resume: 'id' | 'none', staleResumeRetry: boolean, steerMidTurn: 'live' | 'opt-in' | 'none' },
  prompt: { staticDelivery: 'dedupe' | 'always', modeHint: boolean },
}
```

Rules:

- The old tables become **derived views** (`resolveHarnessPlanPolicy`, `resolveHarnessDelegationTraits`, caps) computed from the record, so callers do not change in the first step.
- Adapters read the record instead of hardcoding conditions: `buildCodexClientOptions` asks "is this run read-only?" through one function `isReadOnlyRun({ mode, assignment, scout })` shared with Claude's `isClaudeReadOnlyRunMode` (`claude-agent-ws.ts:392`). That fixes #9 and #11 structurally.
- Observation overrides (`resolveHarnessDelegationTraits`) stay as an overlay on top.
- A parity test asserts that every transport present in `registry.ts` has a record and that the derived views equal today's tables (golden snapshot), so the refactor is provably behaviour-neutral.

### 3.2 One prompt assembler on registry blocks

Goal: every sentence that shapes agent behaviour is a named block; builders only order and join blocks. Not goal: moving data-bearing builders (watcher memory, previous chats) into the registry; those are inputs, not policy text.

- Extend `PROMPT_BLOCKS` from 8 to the policy blocks now inline (see table 3.3). Each block entry grows from a bare string to `{ key, text, kind: 'hard' | 'protocol' | 'soft', requiredTokens?, appliesTo?, since }`. `PROMPT_BLOCKS` keeps its string view for current callers.
- Add a small assembler `lib/prompts/assemble.js`: `assemblePrompt(spec, ctx)` where `spec` is an ordered list of block keys, literals and data providers, and `ctx` carries `{ harness, assignment, mode, capabilities }`. Blocks may be conditional on capabilities (`appliesTo: { reviewCanRunTests: false }`), which replaces the `reviewCanRunTests === false ? A : B` branch in `buildModeHint` (`delegation-prompt.js:244`) and splits the DeepSeek sentences out of `REVIEW_VERIFY_PROMPT_HINT` (#6).
- Keep **prompt order as a cache contract**: the assembler must preserve the stable-prefix / volatile-tail split documented at `delegation-prompt.js:345-349`. Byte-identical golden tests for default text come first, before any block moves.
- `decorateHarnessPrompt` (`harness-plan-prompt.ts:502`) stays the per-turn wrapper; its two hint strings become registry blocks selected through the capability record (`modeHint`).
- Fix R2 by making the file-read path serve the effective text: agents should call a server endpoint or MCP tool that returns the rendered workflow (the `execution_protocol_path` consumers, `todo-tools.js:376` and `todo-agent.js:101`), not the source file.

### 3.3 Which blocks may be user-editable

Three tiers. Tier decides UI and API behaviour.

| Tier | Meaning | Editing | Examples (existing blocks first) |
|---|---|---|---|
| **Hard** | Safety or server-parsed contract. Shown read-only with the reason. | Never | `noCommitPush`, `noPushDestructive`, `noDataDir`, `planGateAncestor`, `reviewerPolicy` (already hard, `overrides.js:12`); proposed hard: report contract `REPORT_BULLETS` + `REPORT_TAIL_REMINDER` (the server parses `TASK:` and `VERDICT:`), `VERDICT_FOLLOWUP_PROMPT`, `NO_NESTED_DELEGATION_SENTENCE`, all read-only guard messages, review hints that describe the sandbox (`REVIEW_HOST_VERIFY_HINT`, `REVIEW_VERIFY_PROMPT_HINT`), the MCP contract lines in the watcher prompt (`workspace-watcher-prompt.js` head), `FEEDBACK_UNTRUSTED_RULE` (`todo-execution-prompt.js:170`), Plan/Ask mode hints (they back a guard). |
| **Protocol-soft** | Editable wording, but must keep named tokens. Saved only if every `requiredTokens` entry is still present. | Yes, with validation | `pickForwarding` (must keep `pick_id`, `model_pick`, `delegation_start`), `mcpFirst`, `curlFallback`; proposed: `DECISION_BOUNDARY`, `COMPLETION_DEFINITION`, `BOUNDED_EXECUTION` (the verification-scope text), the autonomy and completion paragraphs of the todo workflow. |
| **Soft** | Tone and process preferences with no machine contract. | Yes | Proposed: title/summary prompts, fork/handoff intros, scout objective wording, "language of the report" bullet, extra user-defined project block (appended, never replacing a hard block). |

Editing mechanics:

- **Preview**: per block, show the effective text, the default, a diff, and the **rendered prompt per harness and assignment** (implement, review with tests, review without tests, plan, scout) with size against `PROMPT_BUDGET_CHARS` (`preview.js:12`). Extends the four-row preview in `preview.js:27-36`.
- **Reset to default**: already present (`DELETE /api/prompt-registry/blocks/:key`); add "reset all" and a "differs from default" badge.
- **Versioning**: replace the single `prompt-overrides.json` map with an append-only history (`{ key, version, text, at, actor }`), current version = last entry. Needed for R3 (keep stripping old prompts), for rollback, and for stamping the prompt version into the delegation record so a review round can be traced to the text it ran with. Atomic write (temp file + rename), keep corrupt-file backup instead of silent reset (R5).
- **Safety protection**: hard keys stay rejected server-side (403, as in `setPromptOverride`, `overrides.js:58`), the UI is not the guard. Protocol-soft blocks validate `requiredTokens`. A global "restore all defaults" switch for the operator. Per-block limit replaces the single `MAX_OVERRIDE_CHARS = 1200` (`overrides.js:20`), and the total prompt budget check blocks a save that pushes any previewed prompt over budget.
- **Scope**: start global (as today). Per-workspace override can follow once versioning exists; do not do both in one step.
- **Consistency test**: extend `tests/prompt-registry-consistency.test.js` so that each registry block appears exactly once in every prompt that composes it, hard blocks cannot be overridden, and every protocol-soft default contains its required tokens.

### 3.4 What stays out of the registry on purpose

Data-bearing blocks (watcher memory and previous chats, delegation reports, leaf material, plan context, lessons) and guard messages tied to code paths. They are produced from state, not authored policy; make them testable, not editable.

---

## 4. Proposed leaves (for approval; none created)

Order is dependency order. Each leaf is meant to be independently reviewable and byte-neutral for default prompts unless stated.

| # | Leaf | File scope | Risk | Depends on |
|---|---|---|---|---|
| L1 | Codex Ask mode read-only sandbox, one shared "is read-only run" predicate, fix stale comment, unify the review predicate (#9, #11, #13). Behaviour change: Codex Ask loses write access at sandbox level. | `lib/codex/codex-thread-options.ts`, `lib/codex/codex-agent-ws.ts` (one line), `lib/sdk/sdk-mode.ts` or `lib/delegation-review-policy.js` (reuse), `tests/codex-thread-options.test.js` | Low. Check that Ask mode in Codex does not need `/tmp` or network writes for ordinary reads; run the Ask-mode flow once. | none |
| L2 | Capability record + derived views (section 3.1), golden parity test. No behaviour change. | new `lib/harness-capabilities/*`; `lib/delegation-adapter-capabilities.js`, `lib/agent-harness/harness-plan-policy.ts` (become views); `tests/` parity test | Medium. Many importers of the old tables; keep exports stable. Optional harness plugins register traits through `harness-plugin-contract.ts`; the record must accept plugin entries. | L1 optional |
| L3 | Move inline policy text into registry blocks with `kind` and `requiredTokens`; golden byte-identical tests for `buildDelegationExecutorPrompt`, the watcher prompt, the todo workflow, the batch prompt. No behaviour change. | `lib/prompts/blocks.js`, `lib/prompts/overrides.js`, `lib/delegation-prompt.js`, `lib/todo-execution-prompt.js`, `lib/workspace-watcher-prompt.js`, `lib/integrate-batch.js`, `lib/sdk/harness-plan-prompt.ts`, `tests/prompt-registry-consistency.test.js` | Medium-high. Prompt order is a cache contract; a one-character change breaks cache and the `stripTodoExecutionWorkflow` suffix match. Golden tests are the mitigation. | L2 (for conditional blocks) |
| L4 | Capability-conditional prompt blocks: split DeepSeek sentences out of `REVIEW_VERIFY_PROMPT_HINT`, make the Plan hint accurate for harnesses without a question UI (#6, #39). Behaviour change in prompt text for Claude/Codex reviewers. | `lib/sdk/sdk-review-verify.ts`, `lib/sdk/harness-plan-prompt.ts`, `lib/delegation-prompt.js`, tests | Medium. Changes reviewer prompts; compare before/after on one review per harness. | L2, L3 |
| L5 | Override store v2: versioned history, atomic write, corrupt-file backup, per-block limits, token validation, serve rendered workflow to agents instead of the source-file path (R2, R3, R5, R6). | `lib/prompts/overrides.js`, `lib/prompts/overrides-store.js`, `lib/routes/prompt-registry-routes.js`, `lib/todo-agent.js`, `lib/mcp/builtin/todo-tools.js`, `lib/todo-execution-prompt.js`, tests | Medium. Data migration from `prompt-overrides.json`; do not touch `data/` in tests, use a temp dir. | L3 |
| L6 | Settings UI: tier badges, diff, per-harness rendered preview, history and rollback, restore-all. New copy goes through `app_front/i18n/en.js` and `pl.js`; use `cr-*` primitives and `.cr-form` recipes. | `app_front/features/settings/agentPromptsSettings.js`, `lib/prompts/preview.js`, `app_front/i18n/*`, `public/` if the PWA shell lists assets, tests (including `tests/fixtures/i18n-snapshot-*.json`, `tests/fixtures/front-size-baseline.json`) | Low-medium. Front size baseline and i18n snapshots must be updated deliberately. | L5 |
| L7 | Codex session parity: stale-thread recovery with a single retry, explicit instruction-epoch calls on thread replacement (#22, #23). Needs a repro first; if Codex already recovers through another layer, drop or shrink this leaf. | `lib/codex/codex-agent-ws.ts`, `lib/codex/codex-exec-error.ts`, tests | Medium. Wrong detection could drop a healthy thread; keep patterns narrow like `CLAUDE_RESUME_FAILURE_PATTERNS` (`claude-agent-ws.ts:707`). | independent |
| L8 | Optional: bring scout, plan-reviewer and fork/title prompts into the registry as soft blocks. | `lib/workspace-watcher-scout.js`, `lib/plan-reviewer-cooperation.js`, `lib/fork-title.js`, `lib/conversation-fork.js` | Low value until L5/L6 land; defer. | L5 |

Suggested first cut for approval: **L1** (real gap, tiny), **L2 + L3** (foundation), then **L5 + L6** (the user-visible Settings feature). L4 and L7 are small follow-ups; L8 is optional.

Open questions for the user:

1. Should overrides stay global, or do you want them per workspace from the start?
2. Is it acceptable that the report contract (`TASK:` / `VERDICT:`) stays hard? Editing it would break server parsing.
3. Do you want an "extra project instructions" soft block appended to every delegated prompt (never replacing a hard block)?
