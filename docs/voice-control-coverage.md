# Voice control coverage, registry design and measurement protocol

Status: leaves 1-6 implemented. Offline thresholds (schema tokens, scenario
cost) are met; the live thresholds (accuracy, p95) are **PENDING a human-run
paid session** (todo de394295), see §10. Leaf 1 added the audit, design and
measurement harness (`scripts/voice-control-benchmark.mjs`, corpus in
`tests/fixtures/voice-control-corpus.json`); leaves 2-5 added the registry,
state sync, panel/settings/status, approval and work tools; leaf 6 is the final
measurement and docs (§10).

## 1. Coverage matrix

Baseline: the 27 tools in `REALTIME_TOOLS` (`lib/voice/realtime-session-config.ts`):
`send_prompt, stop_agent, read_last_answer, get_chat_status, list_chats,
switch_chat, delete_chat, create_chat, open_chat_sidebar, close_chat_sidebar,
set_chat_mode, run_task, list_tasks, list_workspaces, switch_workspace,
list_folders, switch_folder, close_chat, rename_chat, send_nav, list_models,
set_model, switch_harness, fork_chat, set_read_mode, get_cost, end_voice_mode`.
Since §9d the single-purpose chat / workspace / task / sidebar / status tools above are folded into the family tools `chat_ops`, `workspace`, `sidebar` and `app_status`; the matrix below keeps the old names as the actions' spoken names.
`cycle_agent` (next/previous open chat), `car_mode`, `choose_option`, `confirm_choice`, `orchestrator`, `list_agents`, `switch_agent` and `whats_new` were added with browser voice mode and car mode (§12).

Status: **covered** (reachable by voice today), **gap** (suitable for voice, no
tool), **not-for-voice** (with justification). The audit is based on the modules
under `app_front/` and `app_front/features/`; "voice-suitable" actions are the
denominator of the coverage metric (§5).

| Area (module) | UI actions | Status | Tools / notes |
|---|---|---|---|
| Chat (`chat.js`, `features/chat`) | send prompt, stop run, read answer, status | covered | `send_prompt`, `stop_agent`, `read_last_answer`, `get_chat_status` |
| Chat | mode plan/agent, model, harness, fork, rename, close, delete, create, switch | covered | `set_chat_mode`, `set_model`, `list_models`, `switch_harness` (confirm), `chat_ops` `fork` / `rename` / `close` / `create` / `list`, `delete_chat` (confirm, two-step with id and driver speech), `switch_chat` |
| Chat | search chats by content/topic | gap | needs `chat.search` (capped results); title match exists only in `switch_chat` |
| Chat | attach images/files, paste, per-message actions | not-for-voice | needs pointer/file picker; spoken equivalent is unreliable |
| Send bar (`sendBar.js`, `features/sendBar`) | send, queue/steer a message, special keys | partial | `send_prompt` covers send; steer/queue while running = gap (`chat.steer`); special keys covered by `send_nav` only for prompts |
| Sidebar / archive (`features/sidebar`) | open/close sidebar, archive chat, switch workspace | covered | `open/close_chat_sidebar`, `close_chat`, `switch_workspace` |
| Sidebar | restore from archive, drag & drop, reorder | gap / not-for-voice | restore = gap (`chat.restore`, safe); drag & drop not-for-voice (pointer-only) |
| Todo (`todoPanel.js`, `features/todo`) | list, show, start, change status | gap | `todo.list/show` safe; `todo.start`, `todo.set_status` confirm |
| Files (`features/files`) | open panel, open a file | gap (panel open) | open panel = `panel.open`; file editing/browsing trees not-for-voice (paths must not be read aloud) |
| Git (`gitPanel.js`, `features/git`, `gitContextBadge.js`) | status, branch, diff summary | gap | read-only `git.status` (capped summary); commit/push/checkout = confirm, later leaf |
| GitHub (`githubPanel.js`) | PR/issue list, CI state | gap | read-only summary (`github.summary`); mutating actions not in scope |
| Browser (`features/browser`) | open panel, navigate | gap (open) / not-for-voice (driving pages) | only `panel.open browser`; page interaction is pointer-driven |
| Tasks (`tasks.js`) | list, run, stop a run | covered / gap | `workspace` `tasks` covered; `task_run` is confirm (two-step, §9d); stop = `ops` `task_stop` (§9c) |
| Terminal (`features/terminal/`) | typing, special keys | not-for-voice | free-form shell input by voice is a safety/accuracy risk; `send_nav` handles prompt keys only |
| Logs / debug (`logger.js`) | open log panel | gap (open only) | `panel.open logs`; content is not-for-voice (long, sensitive) |
| Tests (`statusTests.js`) | run/status of test suites | gap | `tasks`-like read of last result; low priority |
| Instances (`features/instances`) | list/switch client instances | gap (low) | `instances.list` safe; commands to other devices = confirm |
| Watcher + Scout inbox (`features/watcher`, `scoutFindingsInboxView.js`) | status, list findings, accept/reject, start cycle | covered (§9, §9d) | `work` (watcher status / pause / resume; `todo_start` / `delegation_cancel` need driver speech after the question in Realtime); `inbox` `list_scout` safe, `scout_accept` / `scout_reject` confirm (proposal listed in this session, bound to id + revision); mode changes (autopilot) stay UI-only |
| Delegations (`features/delegations`) | list, status, cancel | gap | `delegations.list` safe; `cancel` confirm |
| Approval / grants (`features/approval`) | approve once, reject, always-allow grants | covered (once/reject) | once/reject via `approval` (bound to requestId + chat; Realtime also needs driver speech after the question); always-allow / grants = not-for-voice (persistent privilege) |
| Notifications (`features/notifications/notificationCenter.js`) | list, open, dismiss, mark read | covered (§9d) | `inbox` `list_notifications` (capped, untrusted), `mark_read` (one or all), `dismiss` (one): safe; counts also in `app_status` |
| Connection status / harness health (`features/connection/connectionStatus.js`, `features/harness-health`) | connection state, harness errors/limits | gap | one read-only `status.summary`; diagnostics/benchmarks panels not-for-voice |
| Quick commands (`quickCommands.js`) | run a saved command | covered (§9c) | `ops` `quick_list`, `quick_run` (confirm when it sends keys) |
| Widgets (`features/widgets/views/widgetPanel.js`) | open widget panel | gap (open) | `panel.open widgets`; widget content not-for-voice |
| Settings (`features/settings`) | theme, read mode, voice prefs, harness keys | partial | `set_read_mode` covered (`off|final|stream|agent`; `agent` reads only the agent's `voice_reply` summary and is independent of the Realtime session, whose `read_last_answer` still reads the full text); theme, language, mic via `app_settings`; reading engine / voice / rate via `app_settings` `tts_engine` / `tts_voice` / `read_rate` (§9d, safe); API keys, auth, LAN not-for-voice (secrets, network exposure) |
| Voice meta | cost, end session | covered | `app_status` `cost`, `end_voice_mode` |
| Workspace/folder | list/switch | covered | `workspace` `list`, `switch`, `folders`, `folder` (safe); `task_run` confirm |

Summary: of ~45 voice-suitable actions identified, 24 are reachable today (the
chat/workspace/task/voice core above), ~21 are gaps; roughly 10 further actions
are not-for-voice. Re-count when the registry lands: coverage = registry actions
with a voice handler / audit rows marked voice-suitable.

## 2. Action registry spec

One source of truth, `lib/voice/action-registry.ts` (plain ESM data + pure
helpers, no Node-only imports). Each entry:

```js
{
  id: 'chat.switch',            // family.action, stable, used in logs and the corpus
  family: 'chat',               // tool exposed to the model
  action: 'switch',             // value of the family's `action` enum
  description: 'Switch to another chat by id or spoken title.',
  params: { chat_id: 'string', title: 'string' },   // flat, primitives only
  required: [],
  risk: 'safe',                 // 'safe' | 'confirm'
  handler: 'chatSwitch',        // key into the client handler table (not stored in the shared module)
  aliases: { pl: ['przełącz czat', 'wróć do czatu'], en: ['switch chat', 'go to chat'] },
}
```

**Sharing decision: shared ESM module, no generation step.** Precedent:
`app_front/features/voice/voiceCost.js` already imports from
`../../../lib/usage/*`, so webpack resolves `lib/` ESM. The registry holds only
serializable data; the client binds `handler` ids to functions in
`realtimeTools.js` (a table keyed by `handler`). A conformance test asserts every
registry `handler` has a client implementation and that every server-emitted tool
name exists in the registry, replacing today's comment "names must stay in sync".
`gemini-live-config.js` and `realtime-session-config.js` both derive their tool
lists from the registry.

## 3. Tool shape: core + action-enum families

- **Core (always loaded, standalone tools):** `send_prompt`, `stop_agent`,
  `read_last_answer`, `get_status`, `get_cost`, `end_voice_mode` — the highest
  frequency and latency-sensitive calls keep a dedicated, trivial schema.
- **Families:** one tool per area (`chat`, `workspace`, `tasks`, `panel`,
  `todo`, `git`, `watcher`, `delegations`, `notifications`, `approval`,
  `status`, `settings`) with a required `action` enum plus **flat** optional
  params (`chat_id`, `title`, `query`, `mode`, `confirm`, …). Per-action required
  fields are validated by the handler and returned as a concise error.
- **Flat params, no nesting/oneOf:** `toGeminiFunctionDeclarations`
  (`gemini-live-config.js:45`) only strips `additionalProperties` at the top level
  of `parameters`; nested objects would keep it and be rejected. Registry output
  must be flat and the Gemini conversion should be tested for that.
- **Fixed tool set per session.** Tools never change mid-session: altering
  schemas invalidates OpenAI's prompt cache, and Gemini Live accepts `tools` only
  in `setup`. Lazy loading / a `find_actions` meta-tool is considered for OpenAI
  only, and only if the §5 measurement shows the extra round trip pays for itself.
- Rough size goal: core + ~12 families should stay within the +25% schema-token
  threshold of the current 27-tool baseline (§5.3) — verify with
  `--tokens` against a prototype before leaf 2 commits to it.

## 4. Session-state contract, confirmations, results

**State block** (compact, ≤ ~150 tokens): `active_chat {id, title, harness, mode,
running}`, `workspace`, `open_panel`, `pending_approval {kind, summary,
requestId?, count?}|null`, `read_mode`. Injected as a system/`conversation.item`
text at session start and whenever a field changes (debounced), not on every
turn. `summary` and `requestId` come from the pending-permission list;
`requestId` is present only when exactly one request is pending.

- **After history pruning:** `realtimeSession.js` (~287–294) deletes all but the
  last `KEEP_RECENT_ITEMS` items on every `response.done`, so a state item would
  be pruned. The state item must be tracked separately (never in `itemIds`) and
  re-sent after pruning if its id was deleted; the single latest state item
  replaces the previous one.
- **After reconnect:** a new socket has no history, so the full state block and
  the instructions are re-sent before the first user turn; pending approval is
  restored from client state, not from model memory.

**Confirmation policy.** `risk: 'safe'` runs immediately (reads, navigation,
panel open, mode/model change). `risk: 'confirm'` (delete, harness switch,
todo start, task stop, accept finding, cancel delegation, anything
destructive/persistent) uses the existing two-step contract: the first call
without `confirm` returns a summary; execution only on `confirm=true` after the
user agrees. **Approval via voice is limited to `once` and `reject`**; grants
and "always allow" are not available by voice.

**Results:** concise JSON, capped (lists ≤ 8 items, strings ≤ ~120 chars, total
≤ ~1.2 KB), with `ok`, a short `summary` and `truncated:true` when cut, so the
model neither reads nor pays for large payloads (see `list_models` 12 KB case in
`tests/voice-session-diagnose.test.js`).

## 5. Measurement protocol

### 5.1 Corpus
`tests/fixtures/voice-control-corpus.json`: 58 PL/EN utterances, each with the
expected current tool (`tool`/`args`, `null` for gaps) and the target
`family/action/args`; tags `ambiguous`, `diacritics` (e.g. „Refaktoryzacja
żądań”, „Zażółć gęślą jaźń”), `confirm`, `gap`, `no_call`.

**Matching rule.** A run scores when the tool name matches and every key listed
in `args` matches the model's argument, compared case- and
diacritic-insensitively by substring; a missing key fails the run. An entry may
instead carry `argsAny`, a list of alternative argument sets, and passes when
any one of them matches — this keeps inherently ambiguous spoken input scorable
(e.g. u12 "switch to chat number three" accepts `title: "3"` and
`title: "three"`, because the app accepts a number from the title). Entries with
neither field score on the tool name alone.

**Validation.** `node scripts/voice-control-benchmark.mjs --validate` checks the
corpus offline against the live `REALTIME_TOOLS`: unique ids, language, text,
target, known tool names, every expected argument key present in that tool's
schema, every enum value legal and every required argument present. A corpus
entry that could never score fails here instead of after a paid run.

### 5.2 Instrumentation
Existing: `tool.start`, `tool.call` (`durationMs`), `transcript`. New helper
`appendVoiceResponseTiming(kind, detail)` in `voiceSessionLog.js` writes the new
events `response.first_audio` and `response.end`; `diagnoseVoiceSessionLog`
returns `latency` with `{count, p50, p95}` for user→`tool.start`,
user→`tool.call`, user→`response.first_audio` and user→`response.end`, where the
end of an utterance is the user `transcript` event.

**Wired in leaf 2.** `voiceResponseTiming.js` (used by `realtimeSession.js` and
`geminiLiveSession.js`) emits exactly one `response.first_audio` (first audio
chunk) and one `response.end` (`response.done` / `turnComplete`) per response, so
real session diagnoses now carry `userToFirstAudio` / `userToResponseEnd` p95.
The benchmark harness still measures utterance → tool result itself.

### 5.3 Metrics and thresholds (per backend: OpenAI mini, OpenAI flagship, Gemini)
| Metric | How | Threshold vs baseline |
|---|---|---|
| Schema + instruction tokens | `--tokens` (offline estimate, chars/4); live runs record provider `usage` | ≤ +25% |
| 20-turn scenario cost | prefix tokens × (1 uncached + 19 cached) offline; live: ledger USD of a scripted 20-turn text session | ≤ +15% |
| Tool-selection accuracy | `--live` replay on the corpus (family/action/args match) | ≥ baseline − 2 pp |
| p95 latency | utterance → tool result, ≥ 5 repeats per utterance (`VOICE_BENCH_REPEATS=5..20`; lower values produce a warning and an incomparable p95) | ≤ +10% |
| Coverage | registry actions with voice handler / audit voice-suitable actions | report only |

### 5.4 Replay and budget
Text-input replay (deterministic, cheaper than audio):
`VOICE_BENCH_APPROVE_PAID=1 OPENAI_API_KEY=… node scripts/voice-control-benchmark.mjs --live openai-mini`
(also `openai-flagship`, `gemini` with `GEMINI_API_KEY`). Paid runs are executed
by a human or an explicitly approved script, never by an automated agent.

Budget enforcement (all of it offline-unit-tested; the paid path is never called
in tests):

- **Gate:** the run refuses to start without `VOICE_BENCH_APPROVE_PAID=1`.
- **Credential precheck:** the required key of the chosen backend
  (`OPENAI_API_KEY` for `openai-mini`/`openai-flagship`, `GEMINI_API_KEY` for
  `gemini`) must be set; an unknown backend is refused too, instead of silently
  scoring every session wrong.
- **Repeats bound:** `VOICE_BENCH_REPEATS` is validated as an integer 1..20
  (default 5).
- **Up-front estimate and refusal:** before any socket opens the harness prices
  `utterances × repeats` turns from the shared `TOKEN_RATES` (fixed schema +
  instruction prefix per language, the utterance, and an assumed 40-token tool
  call answer) and refuses a run whose estimate exceeds the cap.
- **Cap:** `$5` per run (`SESSION_CAP_USD`), overridable only through
  `VOICE_BENCH_CAP_USD`, which itself cannot exceed the hard maximum
  `MAX_SESSION_CAP_USD = $25`.
- **Running total and abort:** actual provider `usage` (OpenAI `response.usage`,
  Gemini `usageMetadata`) is priced after every session; a session that reports
  no usage is charged the planned per-turn estimate so the cap cannot silently
  undercount. The run stops as soon as the running total reaches the cap
  (exit code 3) and still writes its partial results — printed to stdout and,
  when `VOICE_BENCH_OUTPUT=<file>` is set, to that file.

Each replay opens a fresh session per utterance/repeat, so a 45 × 5 run is 225
sessions; with the flagship rate the estimate is ≈ $13 at 20 repeats, which the
`$5` cap refuses. The `--live` code path is written but **not exercised** here
(no keys, no paid calls).

## 6. Baseline

### 6.1 Measured offline (estimates, chars/4, commit at leaf start)
| Backend | Tools | Instructions (EN / PL) | Total (EN) | 20-turn prefix cost (text, cached) |
|---|---|---|---|---|
| OpenAI mini (`gpt-realtime-2.1-mini`) | 2595 | 831 / 830 | 3426 | ≈ $0.0060 |
| OpenAI flagship (`gpt-realtime-2.1`) | 2595 | 831 / 830 | 3426 | ≈ $0.0397 (rate of `gpt-realtime`) |
| Gemini (`gemini-3.1-flash-live-preview`) | 2278 (no `additionalProperties`) | 831 / 830 | 3109 | n/a (no Gemini text-token rate in `usage-rates.js`) |

These are lower-bound estimates of the schema+instruction prefix only; the
provider-reported prompt tokens will differ and must replace them in the first
live run.

### 6.2 Live baseline — PENDING
| Backend | Accuracy | p95 latency | 20-turn scenario cost |
|---|---|---|---|
| OpenAI mini | PENDING – requires human-run paid session (est. cost ≈ $0.5–1) | PENDING – same run | PENDING – requires human-run paid session (est. < $0.5) |
| OpenAI flagship | PENDING – requires human-run paid session (est. cost ≈ $3–4; ~6× mini) | PENDING – same run | PENDING – requires human-run paid session (est. < $1) |
| Gemini | PENDING – requires human-run paid session (est. cost ≈ $1) | PENDING – same run | PENDING – requires human-run paid session (est. < $0.5) |

Cost estimates assume ~3.5k prompt tokens × 225 sessions at text rates without
cross-session cache hits, plus short outputs; they are guesses to size the
approval, not measurements.

## 7. Leaf 3: safe panel / settings / status tools

Three family tools (risk `safe`, group `app`, required `action` enum, flat
params) were added to `lib/voice/action-registry.ts`; handlers live in
`app_front/features/voice/voiceAppTools.js` (dependency-injected, unit-tested in
`tests/voice-app-tools.test.js`) and are bound in `realtimeTools.js`.

| Tool | Actions | Notes |
|---|---|---|
| `panel` | `open` (chat, todo, files, git, github, browser, tasks, terminal, logs, tests, instances), `status` | `open` clicks the real `.tab[data-panel]` button, so the normal router path runs; hidden/unavailable tabs return an error. `status` returns the active panel (read from `.panel.active`) plus connection state for chat/terminal. |
| `app_settings` | `theme` (dark/light/system), `language` (en/pl), `mic` (mute/unmute) | Read-aloud mode stays `set_read_mode`. `mic` reaches the live session through the `cr-voice-mic-mute-request` window event handled by `cr-voice-panel`. Spoken aliases (incl. Polish with diacritics) are resolved in `voiceAppMatch.js`. |
| `app_status` | `notifications`, `scout`, `health`, `context` | Read-only: notification store state, `GET /api/workspace-watcher/scout?status=pending`, header connection snapshot + `GET /api/harnesses/health`, active chat context snapshot. |

**Result caps** (`capVoiceResult`): lists <= 8 items, strings <= 120 chars,
serialized <= 1200 bytes, `truncated: true` when anything was cut.

**State block.** `collectVoiceStateSnapshot` now fills `openPanel` from the
visible panel. Both provider sessions run `stateSync.sync()` after a tool
returns and before the tool output / `response.create` (OpenAI) or
`toolResponse` (Gemini) is sent, so the reply right after a state-changing tool
sees fresh state (leaf 2 review F1). Limitation: a tool whose effect lands
asynchronously after it returns (for example a panel whose router handler defers
work) can still be reflected one turn late; the `response.done` sync remains as
the backstop.

**Schema-token budget** (`node scripts/voice-control-benchmark.mjs --tokens`,
chars/4, threshold <= +25%):

| Backend | Before (27 tools) | After (30 tools) | Delta | Limit |
|---|---|---|---|---|
| OpenAI mini / flagship tools | 2595 | 2997 | +15.5% | 3244 |
| Gemini tools | 2278 | 2644 | +16.1% | 2848 |

Within budget, so no further family merging was needed. Corpus: u38, u40, u41,
u42 moved from `gap` to the new tools and u46-u52 added (52 utterances,
`--validate` passes).

## 8. Leaf 4: safe approval by voice

One small family tool `approval` (group `agent`, `risk: 'confirm'`, required
`action`, flat params) was added to `lib/voice/action-registry.ts`. Handlers live
in `app_front/features/approval/voiceApprovalTools.js` (dependency-injected,
unit-tested in `tests/voice-approval-tools.test.js`) and are bound in
`realtimeTools.js`.

| Tool | Actions | Notes |
|---|---|---|
| `approval` | `describe_pending` (tool, chat, short summary, requestId), `answer` (`once` / `reject`) | `describe_pending` lists up to 8 waiting permission cards with `requestId` + `chatId`. `answer` resolves exactly one request and requires that request to still be pending and its chat to still be active. |

**Why `risk: 'confirm'`.** Approving a permission is a security decision, so the
two-step contract is `describe_pending` → `answer`, never a single bare yes. The
answer itself is final for `once`/`reject`: there is no `confirm` argument.

**Driver speech in Realtime / Gemini Live.** `describe_pending` asks
`voiceConfirmGuard` once per described request; `answer` is refused with
`code: 'no_driver_answer'` (nothing sent, the described id is closed, so a fresh
`describe_pending` is needed) unless the driver spoke after that question (>= 700 ms,
<= 30 s). Speech before `describe_pending` does not count. Web Speech passes no
guard: the user's own speech is the input.

**Hard safety rules.**

- The answer enum contains only `once` and `reject`. `always` and `harness`
  (persistent grants) are absent from the schema and are rejected in the handler
  before any dependency runs, so no grant can be written from voice.
- An answer is bound to a concrete `requestId` and `chatId`. With more than one
  pending request (including requests the server counts but the client cannot
  name yet) a bare yes/no returns `needsClarification` and does nothing.
- The bound chat must still be the active chat at answer time. A chat switch
  between question and answer is a safe error; even switching to the chat that
  owns the request requires a fresh `describe_pending` before answering.
- The request must still be pending. Cards answered in the UI (`--answered`) or
  resolved by the server (`--resolved`) are excluded, so a late answer does
  nothing. The server-side permission guard remains the final duplicate-reply
  defence.
- Only `once` / `reject` are sent as the existing `opencodePermissionReply` wire
  message, on the bound chat's socket. `send_nav` is unchanged for terminal/TUI
  navigation.
- `collectVoiceStateSnapshot` now fills `pending_approval.summary` and, when
  exactly one request is pending, `pending_approval.requestId`, matching the
  state-block contract in §4.

**P3 fixes carried with this leaf** (`app_front/features/voice/voiceAppMatch.js`,
tested in `tests/voice-app-tools.test.js`):

- mic mute matching handles verb + noun: `włącz wyciszenie` = mute,
  `wyłącz wyciszenie` = unmute, `odcisz` = unmute (previously the unmute verb
  aliases matched first and inverted both phrases);
- The removed Agents panel has no voice aliases: `agent`, `panel agent`,
  `agent panel`, `agents`, `agenci`, `agentów` and `agenty` no longer select a panel.

**Schema-token budget** (`node scripts/voice-control-benchmark.mjs --tokens`,
chars/4, threshold <= +25%):

| Backend | Before (30 tools) | After (31 tools) | Delta | Limit |
|---|---|---|---|---|
| OpenAI mini / flagship tools | 2997 | 3186 | +6.3% | 3244 (from 2595 baseline) |
| Gemini tools | 2644 | 2821 | +6.7% | 2848 (from 2278 baseline) |

The total prompt estimate moved from 3828 to 4080 tokens for OpenAI (baseline
3426, +19.1%) and from 3475 to 3715 for Gemini (baseline 3109, +19.5%), still
within the +25% threshold. Corpus: u53-u56 move approval from `gap` to the new
tool, u57-u58 record the not-for-voice `always` request (58 utterances,
`--validate` passes).

## 9. Leaf 5: Todo, Watcher and delegations by voice

One small family tool `work` (group `agent`, `risk: 'confirm'`, required
`action`, flat params `id`, `query`, `confirm`) was added to
`lib/voice/action-registry.ts`. Handlers live in
`app_front/features/voice/voiceWorkTools.js` (dependency-injected, unit-tested
in `tests/voice-work-tools.test.js`) and are bound in `realtimeTools.js`.

| Action | Risk | Notes |
|---|---|---|
| `todo_ready` | safe | Ready leaves (`listReadyTodoLeaves`), capped. |
| `todo_status` | safe | By `id` or a diacritic-insensitive title fragment; several matches return candidates, never a silent pick. |
| `todo_start` | confirm | Only `idea`/`ready` unblocked leaves. Harness comes from the todo assignee / new-chat harness select and the model is `auto`: no catalog listing. |
| `watcher_status` | safe | mode, paused, stopReason, active cycles. |
| `watcher_pause` / `watcher_resume` | safe | Reversible; the same endpoints as the Todo bar. |
| `delegation_status` | safe | Active delegations, or one by `id`. |
| `delegation_cancel` | confirm | Cancels one running delegation (no tree cancel by voice). |

**Two-step confirm (like `requestId` in leaf 4).** Step one resolves ONE todo /
delegation and binds the confirmation to its id, the workspace folder and the
active chat. Step two needs `confirm=true` AND the same id. A bare yes, another
id, a first call that already carries `confirm`, a workspace/chat change, a
different intervening action or a window older than 60 s does nothing, and the
first confirm attempt (successful or not) consumes the window. Todo and
delegation text is returned with `untrusted: true` plus a note and is capped by
`capVoiceResult` (<= 8 items, 120 chars, ~1.2 KB).

**Driver speech in Realtime / Gemini Live.** `todo_start` and `delegation_cancel`
also get `driverConfirm` (`voiceConfirmGuard`): step one asks, and step two is
refused with `code: 'no_driver_answer'` (nothing started or cancelled, binding
closed) unless the driver spoke after the question (>= 700 ms, <= 30 s). Speech before
step one does not count. Web Speech passes no guard.

**No plan approval by voice.** `plan.approvedAt` is human-only. The `work` enum
has no such action, and `tests/voice-work-tools.test.js` asserts that the
registry, OpenAI tools and Gemini declarations contain no approval/plan action.

**Schema-token budget.** `work` costs about 170 tokens, so descriptions of
existing tools were shortened (behavior and parameters unchanged; hints that
duplicated the instructions were dropped). No tool was merged. The registry
test expectation changed only from 31 to 32 tools and the tool-name list in
`tests/voice-realtime-config.test.js` gained `work`.

| Backend | Before (31 tools) | After (32 tools) | Limit |
|---|---|---|---|
| OpenAI mini / flagship tools | 3182 | 2698 | 3244 |
| Gemini tools | 2818 | 2322 | 2848 |

The total prompt estimate is 3685 (OpenAI) and 3309 (Gemini) tokens, below the
+25% totals (4282 / 3886). Corpus: u59-u70 cover the new actions (PL and EN,
with diacritics), u71-u72 record the not-for-voice plan approval request
(72 utterances, `--validate` passes).

**P3 from the leaf-4 review.** `describedRequestIds` in
`voiceApprovalTools.js` is now built from the capped `describe_pending` result,
so the model can only answer requests it was actually shown (test: "only
requests shown in the capped describe result are answerable").

## 9b. Chat search, restore and queue / steer by voice

One family tool `chat_ops` (group `chat`, `risk: 'safe'`, required `action` in
`search | restore | queue | steer`, flat params `query`, `text`, `chat_id`,
`workspace`). Handlers live in `app_front/features/voice/voiceChatOpsTools.js`
(dependency-injected, `tests/voice-chat-ops.test.js`) and are reached through
`commandHandlers.chatOps(args, { submit })`; Web Speech, OpenAI Realtime and
Gemini Live all call it, each supplying its own `submit`.

| Action | Behaviour |
|---|---|
| `search` | Title and workspace-name search over the chat list the app already holds (live + archived rows, the sidebar's data; no new index). Current workspace by default, `workspace` fragment or `all`. Ranked, at most 8 rows of `{n, chat_id, title, workspace, info}` (`info` is metadata only, harness and `archived`; it is NOT a fragment of the conversation), `untrusted: true`. Open a hit with `switch_chat` and its `chat_id`. |
| `restore` | Archived chats only, matched like `switch_chat` (`matchChatBySpokenTitle`). Several matches return `candidates` (with `chat_id`) and restore nothing; the model repeats with `chat_id`. Uses `requestRestoreChat`, which also opens the chat. A live chat is reported as not archived. |
| `queue` / `steer` | Message to the agent of the active chat while a run is active. `queue` (default) is the send bar's normal busy-chat send; `steer` is the send bar's Steer action (`sendBar.submit({ actionId: 'steer' })`), only when `canSteerSdkChat`. No active run: `not_running`, nothing sent. A steer is never downgraded to a queue (`steer_unsupported`). |

**Send safety.** The message goes through the shared voice send gate
(`voiceSendGate.submit(text, { source, steer })`), the same door as
`send_prompt`: in car mode it waits in the undo window and the Realtime source
notes the submit in `voiceConfirmGuard`, so `send_now` needs fresh driver speech.
The gate carries the `steer` flag to `commandHandlers.sendPrompt`. Outside car
mode the send is immediate, as for `send_prompt`.

**Local phrases (no key).** `szukaj czatu ...`, `przywróć czat ...`,
`dopisz do kolejki ...`, `steruj agentem ...` and `search chats for ...`,
`restore chat ...`, `add to the queue ...`, `queue this ...`, `steer the agent ...`.
A bare "queue ..." / "steer ..." stays a prompt (punctuation is stripped before
matching, so only explicit lead-ins match).

**Undo-window modes.** Follow-up messages merge in the car-mode undo window only
when they share the steer flag. A queue after a steer (or the reverse) replaces
the waiting text and the driver hears the `replaced` notice, so neither message
changes mode. A steer that is no longer possible at delivery goes out as a normal
message with `degraded: true`, and the Web Speech and Realtime paths say so.

**Known limit.** There is no cross-chat message-body search API (`chat_search` is
a per-chat MCP tool over the history store, with no HTTP route), and a new index
was out of scope: `search` therefore covers titles and workspace names.

**Schema-token budget (`--tokens`, chars/4).** `chat_ops` costs about 170 schema
tokens plus one instruction sentence. The `choose_option` and `switch_agent`
descriptions were shortened to offset part of it (behaviour unchanged); tools
went 4039 -> 4170 (OpenAI) with 44 tools, total 5309. The 43-tool state before
this leaf was already above the §10.1 limits (car mode v1-v3), so those rows are
a historic measurement, not a current guarantee. Corpus: u73-u80 (80 utterances,
`--validate` passes).

## 9c. Git status and commit, stopping tasks, quick commands by voice

One family tool `ops` (group `workspace`, `risk: 'confirm'`, required `action` in
`git_status | git_commit | task_stop | quick_list | quick_run`, flat params
`message`, `name`, `id`, `confirm`). Handlers live in
`app_front/features/voice/voiceOpsTools.js` (dependency-injected,
`tests/voice-ops.test.js`); the real dependencies are in `voiceOpsDeps.js` and
are reached through `commandHandlers.ops(args, { driverConfirm })`.

| Action | Risk | Behaviour |
|---|---|---|
| `git_status` | safe | Branch, changed / untracked counts, ahead / behind from the Git panel API (`GET /api/git/info`, panel scope). Counts only, never paths. |
| `git_commit` | confirm | `GET /api/git/commit-plan` lists the exact paths and fingerprints `(path, git hash-object of the current content or a deletion marker, mode)` per path; counts are per file (untracked directories expanded). Step one needs `message` (dictated or proposed, read back) and returns the counts and an `id`; step two (`confirm=true`, same `id`, unchanged context within 60 s) calls `POST /api/git/commit` with the fingerprint. The route re-plans and refuses `tree_changed` on any difference, then builds the commit in a **temporary index** (`GIT_INDEX_FILE` under `git rev-parse --git-path`, deleted in a `finally`) and never touches the user's real index while doing so: `read-tree HEAD` (or `--empty` on an unborn branch), stage ONLY the planned paths (`git add -- <paths>` / `git rm --cached`, never `-A`), verify blob and mode per path against the plan and that nothing else differs from HEAD, re-run the secret check and the size check on the staged set (one `git cat-file --batch-check` for all blobs; a missing object or unparsable answer is `add_failed`), then `write-tree`, `commit-tree -p <HEAD>` and a compare-and-swap `update-ref HEAD <new> <old>` (`head_moved` when HEAD moved). Only after the ref moved are the committed paths refreshed in the real index (`reset -q -- <paths>`, index only); files the user staged meanwhile stay staged and are not committed. This path does **not** run pre-commit / commit-msg hooks and uses the configured author (missing `user.name` / `user.email` is `identity_missing`); use the Git panel when hooks matter. Also refused: `operation_in_progress` (a merge, cherry-pick, revert or rebase in progress, or unmerged paths: checked in the plan and again before staging; the merge state and the real index are left alone), `sensitive_files`, `large_files` (> 5 MB), `unsupported_files` (symlinks, nested repos), `signing_required` (`commit.gpgsign=true` in that repo: `commit-tree` does not sign, so the voice path refuses instead of silently committing unsigned; it never tries to sign), `partially_staged` (a path staged AND modified again in the working tree, porcelain X staged + Y modified: the commit takes the working copy and the reset would drop the staged version; the plan exposes `partiallyStaged`, and before the final `reset` a path whose real index entry is neither HEAD's nor the committed blob is left alone and reported as `staleIndexPaths` / `indexRefreshed:false`), `workspace_busy` (running chats / delegations / Watcher, or a Cretli task worktree). |
| `task_stop` | confirm | Stops a running workspace task found by name (`GET /api/task-runs`, `DELETE /api/task-runs/:id`). Several matches return `candidates`; same two-step binding on the run id. |
| `quick_list` | safe | The quick-command bar (capped, untrusted). |
| `quick_run` | confirm for keys | Terminal / Tasks panel receive the text with Enter: two-step. The chat panel only gets the text in the send field (`drafted`, never over an unsent draft: `field_not_empty`): no confirm. **Fail-closed allowlist** (`isQuickCommandBlockedByVoice`, both paths, `not_by_voice`): a command runs by voice only when every word uses plain characters (no quotes, backslash, `$`, globbing, parentheses, `!`, `~`, `=`; so no substitution, chaining, grouping, environment assignment at any position) and the first word is literally one of: `git` (only `--no-pager`, then a read-only subcommand with exactly listed options: status, log, diff, show, blame, describe, rev-parse, ls-files, branch / tag / remote listing, `stash list`; no option prefixes or glued short options, so `--op=` / `-lO<cmd>` never reach git; `fetch` only of one named remote, no refspec, no `-u`), `gh` (the first two words are `pr|issue|run list|view` or `pr status`), `npm` / `pnpm` / `yarn` (`test` or `run <script>`), `make` (target names) or `node` (one script file inside the project). Paths (`/usr/lib/git-core/git-push`), launchers (`env`, `sudo`, `flock`, ...) and every other program are refused and stay available by touch. The user's own scripts are their responsibility (voice cannot inspect them); shell aliases and repo-level git config (`core.pager`, `diff.external`) are outside the filter. |

**No push, no merge.** Decision 10 of `docs/operator-internal-decision.md`: no
action, enum value or description of the registry or of either Realtime
declaration mentions them (`tests/voice-ops.test.js`); the corpus lists push /
merge requests as no-call.

**Confirm safety.** One use per binding; any other voice tool or other `ops`
action in between drops it. Realtime (OpenAI and Gemini) additionally requires
driver speech after the question through `voiceConfirmGuard` (its 30 s window is
the stricter one). Web Speech has no confirm action: only `git status` and
`quick commands` phrases (PL / EN, exact utterances) are local.

**Schema-token budget.** `ops` costs about 169 schema tokens (OpenAI tools 4170
-> 4338, total 5564, 45 tools; Gemini tools 3810). The over-limit state of the
earlier leaves is unchanged and is left to leaf 3. Corpus: u81-u90 (90
utterances, `--validate` passes).

## 9d. Notifications, Scout proposals and reading settings by voice; schema budget

Leaf 3 of the "Głos" tree. It adds one family tool and three actions on an existing
one, and brings the Realtime tool schema back under the §10.1 limits.

### Actions and risk classes

| Tool / action | Risk | Behaviour |
|---|---|---|
| `inbox` `list_notifications` | safe | Unread first, at most 8 rows `{id, title, unread}` (titles cut to 100 chars), `untrusted: true`. Uses the notification store the bell already uses; no new route. |
| `inbox` `mark_read` | safe | One listed id, or `id: "all"`. `NotificationStore.markRead` / `markAllRead` (`POST /api/notifications/read`). Unknown id: `not_found`. |
| `inbox` `dismiss` | safe | One listed id (`POST /api/notifications/dismiss`). "Dismiss all" is not offered. |
| `inbox` `list_scout` | safe | Pending proposals (`GET /api/workspace-watcher/scout?status=pending`, workspace scoped), at most 8 rows `{id, title, category, why}`, `untrusted: true`. Listing records each proposal's revision (`updatedAt` plus a content hash of title / category / rationale / plan) as "read in this session". |
| `inbox` `scout_accept` / `scout_reject` | confirm | Two-step like `work` / `ops`. Step one takes the proposal `id` and refuses with `not_listed` unless `list_scout` returned it in this session, re-reads the pending list and refuses with `not_pending` / `changed` when the proposal is gone or its revision differs from what was read, then returns `needsConfirm` and a binding id (`s1`...) tied to proposal id + revision + decision + workspace + chat, valid 60 s. Step two needs `confirm=true`, that binding id, an unchanged context and driver speech after the question (Realtime, `voiceConfirmGuard`); it re-checks the proposal once more and calls `POST /api/workspace-watcher/scout` `{action: accept|reject, ids: [id]}`. One use per binding; any other `inbox` action or voice tool in between drops it. Accepting only decides the proposal (the server may create an `idea` todo with an unapproved draft plan); plan approval stays UI-only and no registry text mentions it as an action. |
| `app_settings` `tts_engine` | safe | `browser`, `openai`, `azure` (spoken aliases such as "przeglądarka"); anything else is refused. |
| `app_settings` `tts_voice` | safe | Matched (exact, then unique substring, accent-insensitive) against the voices of the CURRENT engine: installed browser voices, `OPENAI_TTS_VOICES` or `AZURE_TTS_VOICES`. Ambiguous: `candidates`, nothing stored. No match: nothing stored. |
| `app_settings` `read_rate` | safe | A number 0.5-2 (comma allowed) or `slower` / `faster` (steps of 0.15) / `normal`. Out of range is refused, not clamped. |

API keys, LAN exposure and authentication are not reachable: the `app_settings`
enum lists only `theme, language, mic, tts_engine, tts_voice, read_rate`, any other
action is refused with an explicit message, and `tests/voice-inbox.test.js` asserts
that no schema property names a secret, network or auth setting. Corpus lines
u93-u110 cover the new actions in PL and EN and u111-u116 are no-call (API key,
LAN, auth, plan approval, bulk accept without reading).

Web Speech (no model) gets local PL / EN phrases for the safe actions only:
"show notifications", "mark notifications as read", "show scout proposals" and
their Polish forms. Accept / reject, dismiss and the reading settings need the
model (they take a spoken name or id).

### Review fixes (round 2)

- **`workspace` `task_run` is a confirm action.** The registry entry now carries
  `actionRisk` (per-action risk; `risk` of the family is the highest of them):
  `list`, `switch`, `folders`, `folder`, `tasks` safe, `task_run` confirm. Step one
  resolves the label (unknown / ambiguous handled as before) and returns
  `needsConfirm` plus an id bound to the resolved label, workspace and active chat
  (60 s, single use, `voiceConfirmBinding.js`); step two needs `confirm=true`, that id
  and driver speech after the question (`voiceConfirmGuard`), and runs the label from
  the binding, never the one named in the confirming call. Any other `workspace`
  action or voice tool between the steps drops the binding. Web Speech has no local
  phrase for it.
- **`delete_chat` uses the same two-step** (new `id` property): step one returns the
  title and an id bound to the chat, workspace and active chat; step two needs
  `confirm=true`, the id and driver speech, and deletes the chat step one described.
- **Session boundaries clear the Scout memory.** `resetRealtimeToolGuards` (session
  end, and now also the start of a Realtime / Gemini session) and the Web Speech
  start / stop call `commandHandlers.resetSession`, which clears the proposals read
  so far and every pending `inbox` / `ops` binding.
- **Only rows present in the answer count as read.** `list_scout` caps the result
  first and marks as read only the proposals left in it.

### Schema-token budget (leaves 1-3)

Measure: `node scripts/voice-control-benchmark.mjs --tokens` (chars/4 of the tool
schemas), limits from §10.1 (+25% over the §6.1 baseline). Enforced by
`tests/voice-schema-budget.test.js` for OpenAI and Gemini.

| State | Tools | OpenAI tool tokens | Gemini tool tokens |
|---|---|---|---|
| §10.1 final (leaf 6, 2026-10) | 36 | 2790 | 2414 |
| After leaf 1 (`chat_ops`), car mode v1-v3 included | 44 | 4170 | n/a |
| After leaf 2 (`ops`) | 45 | 4338 | 3810 |
| Leaf 3 (round 1) | 33 | 3060 (limit 3244) | 2672 (limit 2848) |
| **Leaf 3 after the review fixes** (`id` / `confirm` on `workspace`, `id` on `delete_chat`) | **33** | **3097** (limit 3244) | **2709** (limit 2848) |

How the schema was brought under the limit, with every safety contract kept:

- Descriptions and property descriptions were rewritten shorter; behaviour that
  tests pin ("Repeat the prompt back briefly before sending", "Never claim the
  model changed until this returns ok:true", the two-step wording of
  `delete_chat` / `switch_harness` / `work` / `ops` / `inbox`, "untrusted",
  `once` / `reject` only, plan approval is UI-only) stays in the text.
- Single-purpose tools are merged into families, each action keeping its old
  handler: `workspace` (`list`, `switch`, `folders`, `folder`, `tasks`,
  `task_run`: replaces `list_workspaces`, `switch_workspace`, `list_folders`,
  `switch_folder`, `list_tasks`, `run_task`), `sidebar` (`enable` true / false:
  replaces `open_chat_sidebar`, `close_chat_sidebar`), `chat_ops` gained
  `list`, `create`, `close` (archive), `rename`, `fork` (replacing `list_chats`,
  `create_chat`, `close_chat`, `rename_chat`, `fork_chat`; `delete_chat` stays a
  separate confirm tool) and `app_status` gained `chat` and `cost` (replacing
  `get_chat_status`, `get_cost`). The old handlers live in `subHandlers` in
  `realtimeTools.js`, reachable only through these families, so a stale tool name
  is "Unknown tool".
- The new actions of this leaf are one new family (`inbox`, about 150 tokens) and
  three values of the existing `app_settings` enum, instead of several top-level
  tools.

Instruction text (not part of the tool limit) went from 1226 to 1384 tokens (EN; total OpenAI prompt 4444)
because of the new `inbox` and reading-settings sentences.

## 10. Leaf 6: final measurement vs baseline

Protocol: leaf-1 harness, same 72-utterance corpus (`--validate` passes), same
20-turn prefix model. Commands: `node scripts/voice-control-benchmark.mjs
--tokens` and `--validate`. Offline numbers are chars/4 estimates of the schema +
instruction prefix, comparable only with the §6.1 baseline (same method).

### 10.1 Offline results (measured now)
| Backend | Metric | Baseline | Final | Change | Threshold | Result |
|---|---|---|---|---|---|---|
| OpenAI mini / flagship | Tool schema tokens | 2595 | 2790 | +7.5% | <= +25% (3244) | met |
| OpenAI mini / flagship | Instruction tokens (EN / PL) | 831 / 830 | 987 / 987 | +18.8% / +18.9% | (part of total) | - |
| OpenAI mini / flagship | Schema + instructions | 3426 | 3777 | +10.2% | <= +25% (4282) | met |
| Gemini | Tool schema tokens | 2278 | 2414 | +6.0% | <= +25% (2848) | met |
| Gemini | Schema + instructions | 3109 | 3401 | +9.4% | <= +25% (3886) | met |
| OpenAI mini | 20-turn prefix cost | ≈ $0.0060 | $0.00657 | +9.5% (tokens +10.2%) | <= +15% | met |
| OpenAI flagship | 20-turn prefix cost | ≈ $0.0397 | $0.04381 | +10.3% | <= +15% | met |
| Gemini | 20-turn prefix cost | n/a | n/a | n/a | <= +15% | not computable offline |

The prefix cost scales linearly with prefix tokens (1 uncached + 19 cached
turns), so the cost change equals the token change (+10.2%) for any rate.
Caveats: (1) the baseline cost figures in §6.1 are rounded; the percentage uses
the token ratio, which is exact for this model. (2) **N1 (leaf-1 review):**
`usage-rates.js` has no Gemini text-token rate, and the Gemini replay requests
AUDIO responses while the cost model uses text rates; a Gemini scenario cost
must come from the live ledger, not from this table. (3) This is a prefix-only
estimate: result sizes (capped by `capVoiceResult`, ≤ 8 items / ~1.2 KB) and the
single state item (`voiceStateSync.js`, re-sent only on change) are not in it;
the live scenario run measures them.

### 10.2 Live results — PENDING human-run (todo de394295)
Nothing below was measured by an agent; no number is invented. Baseline for the
comparison is the pre-change commit (leaf-1 start), run with the same command.
| Backend | Accuracy (>= baseline − 2 pp) | p95 latency (<= +10%) | 20-turn scenario cost (<= +15%) |
|---|---|---|---|
| OpenAI mini | PENDING human-run (todo de394295), est. ≈ $0.5-1 | PENDING | PENDING |
| OpenAI flagship | PENDING human-run (todo de394295), est. ≈ $3-4 | PENDING | PENDING |
| Gemini | PENDING human-run (todo de394295), est. ≈ $1 | PENDING | PENDING |

Commands (run once on the baseline commit and once on this branch, same
`VOICE_BENCH_REPEATS`, >= 5 for a comparable p95; cap $5 per run):
```
VOICE_BENCH_APPROVE_PAID=1 OPENAI_API_KEY=... VOICE_BENCH_REPEATS=5 VOICE_BENCH_OUTPUT=mini.json \
  node scripts/voice-control-benchmark.mjs --live openai-mini
VOICE_BENCH_APPROVE_PAID=1 OPENAI_API_KEY=... VOICE_BENCH_REPEATS=5 VOICE_BENCH_OUTPUT=flagship.json \
  node scripts/voice-control-benchmark.mjs --live openai-flagship
VOICE_BENCH_APPROVE_PAID=1 GEMINI_API_KEY=... VOICE_BENCH_REPEATS=5 VOICE_BENCH_OUTPUT=gemini.json \
  node scripts/voice-control-benchmark.mjs --live gemini
```
Risk to watch in accuracy: the corpus grew from 58 to 72 utterances (new
families); compare the original 58 ids against the baseline, and report the new
ids separately. Short-description tools (leaf 5) are the likeliest regression.

### 10.3 Coverage (report only)
Definition: voice-reachable actions / voice-suitable actions from the §1 audit.
The audit estimate ("~45 suitable, 24 covered") is replaced by an explicit
count of the audit rows. "Reachable" means a registry action with a handler
(39 registry tools incl. the families `panel`, `app_settings`, `app_status`,
`approval`, `work`); "partial" (panel can only be opened) is not counted.
| Area | Before | Now |
|---|---|---|
| Chat / workspace / task / voice core (§1 covered rows) | 24 | 24 |
| Todo list / show / start | 0 | 3 (`work` todo_ready, todo_status, todo_start) |
| Panels: files, browser, logs, tests | 0 | 4 (`panel open`) |
| Watcher status, Scout findings | 0 | 2 (`work` watcher_status, `app_status scout`) |
| Delegations list, cancel | 0 | 2 (`work` delegation_status, delegation_cancel) |
| Notifications list, connection/harness health | 0 | 2 (`app_status`) |
| Theme setting | 0 | 1 (`app_settings`) |
| Approval once / reject | 0 | 1 (`approval`) |
| **Total reachable** | **24** | **39** |
| Partial (panel open only): git, github, instances | 0 | 3 |
| Still gaps: chat search, steer/queue, restore from archive, todo status change, tasks stop, Scout accept/reject, notification dismiss, quick commands, widgets panel, voice prefs | 10 | 10 |
Denominator: 24 + 29 enumerated gap rows = 53 (the earlier "~45" was a rough
estimate). Coverage: **24/53 = 45% before, 39/53 = 74% now** (43/53 = 81% with
partials). Beyond the audit: watcher pause/resume, language and mic settings,
`app_status context`, `panel status` (not in the denominator).

### 10.4 Status, known limitations, follow-ups
- Threshold status: schema tokens and scenario-cost (offline) **met**. Accuracy
  and p95: **PENDING human-run, not evaluated**; no deviation is recorded
  because nothing exceeded a threshold in the measured data. If the live run
  exceeds one, record it here as "deviation for human decision".
- Local fast path (stop / yes / no) was **not added**: the offline data shows no
  token or cost pressure, and approval safety (§8) must stay model-mediated
  with `request_id` binding.
- Known limitations: plan approval is UI only; `todo_start` and
  `delegation_cancel` need a second confirmation with the same id (60 s window,
  same workspace and chat); always/harness grants are not available by voice;
  Gemini scenario cost is not computable offline (N1).
- Follow-ups: run §10.2; add the gaps in §10.3; add a Gemini text/audio rate to
  `usage-rates.js` so the offline Gemini estimate becomes possible.

### 10.5 Polish items closed in leaf 6
- `answerApproval` consumes the described `request_id` before any await (two
  concurrent answers deliver one reply) and restores it when the send fails or
  throws, so the user can retry.
- `startTodo` uses the workspace folder bound at confirm step one (the
  `WorkContext` passed to the dependency), not the header trigger.
- Voice todo start logic lives in `features/todo/todoVoiceStart.js` with
  injected dependencies and is tested behaviorally (prompt handed over after
  start; dirty worktree, not-ready, SDK and network failures start nothing);
  `todoPanel.js` keeps its UI behavior.

## 11. Operator as a voice back end (accepted, not implemented)

Not implemented. [operator-internal-decision.md](operator-internal-decision.md)
decision 10 (**accepted 2026-11-11 with an owner amendment**: an opt-in full voice authority
mode lets the owner decide plan, integration and policy cards by voice with a passphrase;
push/merge, real data and secrets stay touch-only) describes tree `e3060e01`
leaf 6: the voice model stays the speech and quick-UI layer while management
questions go to the internal operator as a priority-0 event and its short answer is
read back (spoken form without paths and identifiers, agent-derived text marked
`untrusted: true`). Proposed card confirmation by voice reuses the contracts above:
the card must have been read in the same session, the owner repeats its name inside
a 60 s window bound to card id, workspace and chat, and the confirmation goes through
the existing resolution route from the owner's UI session. Human-only kinds
(`plan_approval`, `integration`, `policy_upgrade`), push, real data and secrets stay
out of voice, as does plan approval today (§9). Nothing in this document's registry,
tool counts or thresholds changes until that ADR is accepted and leaf 6 is
implemented.

## 12. Browser voice mode and car mode

Without a provider key the header voice button starts hands-free dictation through the
browser's `SpeechRecognition` (`browserVoiceMode.js`). The phrases below are matched locally
against the whole utterance (`localCommands.js`) and run through the same
`commandHandlers.js` functions as the Realtime tools; there is no model in this path.

| Phrase (pl / en) | Registry action | Handler |
|---|---|---|
| stop, zatrzymaj, przerwij | `stop_agent` | `commandHandlers.stopAgent` |
| następny / poprzedni agent (czat), next / previous agent (chat) | `cycle_agent` | `commandHandlers.cycleChat` |
| następna / poprzednia karta, next / previous card | `cycle_card` | `commandHandlers.cycleCard` (car view decision cards, wraps around) |
| przełącz na <nazwa>, switch to <name> | `switch_chat` | `commandHandlers.switchTo` (chat title first, then workspace; ambiguous names are refused) |

| tryb samochodowy / car mode, zamknij tryb samochodowy / exit car mode | `car_mode` | `commandHandlers.setCarMode` |
| opcja 2, wybieram drugą, option two | `choose_option` | `commandHandlers.chooseOption` (remembers the pick, reads it back; plan approval, integration and policy cards are refused by voice and decided by touch in the car view) |
| tak, potwierdzam, yes / nie, anuluj, no (only while a pick waits) | `confirm_choice` | `commandHandlers.confirmChoice` |

| orkiestrator, wszyscy agenci, all agents / zamknij orkiestrator, close orchestrator | `orchestrator` | `commandHandlers.setOrchestrator` (agents screen of the car view) |
| co robią agenci, what are the agents doing | `list_agents` | `commandHandlers.listAgents` (all workspaces, needs-decision first, one-line summary) |
| który agent czeka, who is waiting, switch to the waiting agent | `switch_agent` (`waiting: true`) | `commandHandlers.switchAgent` |
| co nowego, powtórz, what's new, repeat | `whats_new` | `commandHandlers.whatsNew` (speaks the newest car-mode announcement again, or "Nothing new") |
| przełącz, switch (alone, right after an announcement) | `switch_agent` (`announced: true`) | `commandHandlers.switchAgent` goes to the chat of the newest announcement |
| (model only) switch to an agent by name, optionally with its workspace | `switch_agent` (`name`, `workspace`, `chat_id`) | `commandHandlers.switchAgent`; several matches are reported, never guessed; selecting a chat of another workspace switches the workspace |

The agents screen reads the same HTTP presence map as car mode (`GET /api/chats/agent-states`
already covers the chats of every workspace, so no new endpoint was needed) and switches by a big
button, a long horizontal drag on the row, or the voice commands above.

Decision cards by voice: only `humanOnly` kinds (`plan_approval`, `integration`,
`policy_upgrade`) are refused (decide those in the app); every other card needs the two steps
above, options 1-4, answered through the existing card API with the card id and revision.
`confirm_choice` is `risk: confirm`: the model must read the label back and wait for a spoken yes.

`tests/voice-local-commands.test.js` keeps every local command mapped to a registry action, and
`tests/voice-command-parity.test.js` checks that Web Speech, the OpenAI tool path and the Gemini
tool path run the same `commandHandlers` function exactly once (both Realtime sessions only call
`executeRealtimeTool`; the transports themselves are not instantiated in unit tests).

## Car mode: headset buttons and screen lock

Car mode (`app_front/features/car/carMediaSession.js`) maps Media Session keys while the view is
open: play/pause/stop toggle the microphone, next/previous track cycle the open agents and speak
the agent name as an announcement (it never cancels the answer being read). The screen wake lock
(`app_front/features/pwa/wakeLock.js`, independent reasons `agent` and `car`) is held for as long
as the view is open and re-requested after `visibilitychange`; closing the view does not release
a lock a running agent still needs.

Limits:

- Web Speech recognition on Android Chrome only works while the tab is visible and the screen is
  on; the wake lock keeps the screen on, but a switched-off screen or another app in front stops it.
- iOS Safari is limited: Web Speech is unreliable or stops in the background, and wake lock needs
  a recent Safari. Prefer the Realtime voice mode there.
- Media Session routes keys only to a page with active audio, so car mode plays a silent looped
  track. It needs a user gesture (the first tap after opening) and takes the "now playing" slot
  from a music player while car mode is open; it is released on close. TTS uses separate output
  and neither stops the other.
