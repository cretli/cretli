# Voice control coverage, registry design and measurement protocol

Status: leaf 1 of the voice-control coverage effort (audit + design + measurement
baseline). No voice runtime behavior changes here; the only code changes are
measurement instrumentation (`lib/voice/voice-session-diagnose.js`,
`app_front/features/voice/voiceSessionLog.js`) and the benchmark harness
(`scripts/voice-control-benchmark.mjs`, corpus in
`tests/fixtures/voice-control-corpus.json`).

## 1. Coverage matrix

Baseline: the 27 tools in `REALTIME_TOOLS` (`lib/voice/realtime-session-config.js`):
`send_prompt, stop_agent, read_last_answer, get_chat_status, list_chats,
switch_chat, delete_chat, create_chat, open_chat_sidebar, close_chat_sidebar,
set_chat_mode, run_task, list_tasks, list_workspaces, switch_workspace,
list_folders, switch_folder, close_chat, rename_chat, send_nav, list_models,
set_model, switch_harness, fork_chat, set_read_mode, get_cost, end_voice_mode`.

Status: **covered** (reachable by voice today), **gap** (suitable for voice, no
tool), **not-for-voice** (with justification). The audit is based on the modules
under `app_front/` and `app_front/features/`; "voice-suitable" actions are the
denominator of the coverage metric (§5).

| Area (module) | UI actions | Status | Tools / notes |
|---|---|---|---|
| Chat (`chat.js`, `features/chat`) | send prompt, stop run, read answer, status | covered | `send_prompt`, `stop_agent`, `read_last_answer`, `get_chat_status` |
| Chat | mode plan/agent, model, harness, fork, rename, close, delete, create, switch | covered | `set_chat_mode`, `set_model`, `list_models`, `switch_harness`, `fork_chat`, `rename_chat`, `close_chat`, `delete_chat`, `create_chat`, `switch_chat`, `list_chats` |
| Chat | search chats by content/topic | gap | needs `chat.search` (capped results); title match exists only in `switch_chat` |
| Chat | attach images/files, paste, per-message actions | not-for-voice | needs pointer/file picker; spoken equivalent is unreliable |
| Send bar (`sendBar.js`, `features/sendBar`) | send, queue/steer a message, special keys | partial | `send_prompt` covers send; steer/queue while running = gap (`chat.steer`); special keys covered by `send_nav` only for prompts |
| Sidebar / archive (`features/sidebar`) | open/close sidebar, archive chat, switch workspace | covered | `open/close_chat_sidebar`, `close_chat`, `switch_workspace` |
| Sidebar | restore from archive, drag & drop, reorder | gap / not-for-voice | restore = gap (`chat.restore`, safe); drag & drop not-for-voice (pointer-only) |
| Todo (`todoPanel.js`, `features/todo`) | list, show, start, change status | gap | `todo.list/show` safe; `todo.start`, `todo.set_status` confirm |
| Files (`filesPanel.js`) | open panel, open a file | gap (panel open) | open panel = `panel.open`; file editing/browsing trees not-for-voice (paths must not be read aloud) |
| Git (`gitPanel.js`, `features/git`, `gitContextBadge.js`) | status, branch, diff summary | gap | read-only `git.status` (capped summary); commit/push/checkout = confirm, later leaf |
| GitHub (`githubPanel.js`) | PR/issue list, CI state | gap | read-only summary (`github.summary`); mutating actions not in scope |
| Browser (`features/browser`) | open panel, navigate | gap (open) / not-for-voice (driving pages) | only `panel.open browser`; page interaction is pointer-driven |
| Tasks (`tasks.js`) | list, run, stop a run | covered / gap | `list_tasks`, `run_task` covered; `tasks.stop` gap (confirm) |
| Terminal (`terminal.js`, `terminalSettings.js`) | typing, special keys | not-for-voice | free-form shell input by voice is a safety/accuracy risk; `send_nav` handles prompt keys only |
| Logs / debug (`logger.js`) | open log panel | gap (open only) | `panel.open logs`; content is not-for-voice (long, sensitive) |
| Tests (`statusTests.js`) | run/status of test suites | gap | `tasks`-like read of last result; low priority |
| Instances (`features/instances`) | list/switch client instances | gap (low) | `instances.list` safe; commands to other devices = confirm |
| Agents (`agents.js`, `agentsPanel.js`) | list/run agent definitions | gap | `agents.list` safe, `agents.run` confirm |
| Watcher + Scout inbox (`features/watcher`, `scoutFindingsInboxView.js`) | status, list findings, accept/reject, start cycle | gap | `watcher.status`, `watcher.list_findings` safe; `accept/reject` confirm; mode changes (autopilot) confirm |
| Delegations (`features/delegations`) | list, status, cancel | gap | `delegations.list` safe; `cancel` confirm |
| Approval / grants (`features/approval`) | approve once, reject, always-allow grants | covered (once/reject) | once/reject via `approval` (bound to requestId + chat); always-allow / grants = not-for-voice (persistent privilege) |
| Notifications (`features/notifications/notificationCenter.js`) | list, open, dismiss, mark read | gap | `notifications.list` (capped), `dismiss` safe |
| Connection status / harness health (`connectionStatus.js`, `features/harness-health`) | connection state, harness errors/limits | gap | one read-only `status.summary`; diagnostics/benchmarks panels not-for-voice |
| Quick commands (`quickCommands.js`) | run a saved command | gap | `quick.list`, `quick.run` (confirm when it sends keys) |
| Widgets (`widgetPanel.js`) | open widget panel | gap (open) | `panel.open widgets`; widget content not-for-voice |
| Settings (`features/settings`) | theme, read mode, voice prefs, harness keys | partial | `set_read_mode` covered; theme/voice prefs gap (safe); API keys, auth, LAN not-for-voice (secrets, network exposure) |
| Voice meta | cost, end session | covered | `get_cost`, `end_voice_mode` |
| Workspace/folder | list/switch | covered | `list_workspaces`, `switch_workspace`, `list_folders`, `switch_folder` |

Summary: of ~45 voice-suitable actions identified, 24 are reachable today (the
chat/workspace/task/voice core above), ~21 are gaps; roughly 10 further actions
are not-for-voice. Re-count when the registry lands: coverage = registry actions
with a voice handler / audit rows marked voice-suitable.

## 2. Action registry spec

One source of truth, `lib/voice/action-registry.js` (plain ESM data + pure
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

### 5.2 Instrumentation (added, partly unwired)
Existing: `tool.start`, `tool.call` (`durationMs`), `transcript`. New helper
`appendVoiceResponseTiming(kind, detail)` in `voiceSessionLog.js` writes the new
events `response.first_audio` and `response.end`; `diagnoseVoiceSessionLog`
returns `latency` with `{count, p50, p95}` for user→`tool.start`,
user→`tool.call`, user→`response.first_audio` and user→`response.end`, where the
end of an utterance is the user `transcript` event.

**Not emitted yet.** Leaf scope forbids touching `realtimeSession.js` and the
Gemini session code, so nothing calls `appendVoiceResponseTiming`:
`response.first_audio` and `response.end` do not appear in real session logs, and
the `userToFirstAudio` / `userToResponseEnd` p95 values (the
`first_audio` / `response_end` p95 rows in a diagnosis) stay empty for every real
session until a follow-up leaf wires exactly one call per provider (first audio
chunk, and `response.done` / `turnComplete`). Until then the harness measures
latency itself.

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
params) were added to `lib/voice/action-registry.js`; handlers live in
`app_front/features/voice/voiceAppTools.js` (dependency-injected, unit-tested in
`tests/voice-app-tools.test.js`) and are bound in `realtimeTools.js`.

| Tool | Actions | Notes |
|---|---|---|
| `panel` | `open` (chat, todo, files, git, github, browser, tasks, terminal, logs, tests, instances, agents), `status` | `open` clicks the real `.tab[data-panel]` button, so the normal router path runs; hidden/unavailable tabs return an error. `status` returns the active panel (read from `.panel.active`) plus connection state for chat/terminal. |
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
`action`, flat params) was added to `lib/voice/action-registry.js`. Handlers live
in `app_front/features/approval/voiceApprovalTools.js` (dependency-injected,
unit-tested in `tests/voice-approval-tools.test.js`) and are bound in
`realtimeTools.js`.

| Tool | Actions | Notes |
|---|---|---|
| `approval` | `describe_pending` (tool, chat, short summary, requestId), `answer` (`once` / `reject`) | `describe_pending` lists up to 8 waiting permission cards with `requestId` + `chatId`. `answer` resolves exactly one request and requires that request to still be pending and its chat to still be active. |

**Why `risk: 'confirm'`.** Approving a permission is a security decision, so the
two-step contract is `describe_pending` → `answer`, never a single bare yes. The
answer itself is final for `once`/`reject`: there is no `confirm` argument.

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
- the bare word `agent` is no longer an alias of the agents panel; the singular
  form resolves only with panel context (`panel agent`, `agent panel`), while
  `agents` / `agenci` / `agentów` / `agenty` still match on their own.

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
