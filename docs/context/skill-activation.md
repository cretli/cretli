# Explicit skill activation (context unification, stage 4)

A skill's full `SKILL.md` reaches the model only when it is **explicitly
selected**. The catalog (name, purpose, path) is always sent as before; the
selection decides which bodies are added to the turn.

Code: `lib/skills/skill-selection.js` (rules), `lib/skills/skill-context.js` and
`lib/context/context-assembler.ts` (both use the same selection function).

## What activates a skill

1. **Structured IDs** — registry IDs (`/api/cursor-context` items carry `id`).
   The context picker inserts `@name` and records the ID; the client sends them
   as `selectedSkillIds` on `send` / `steer`. An ID is resolved in the scope of
   the send, so a delegated child sees only IDs its own registry has.
2. **Unquoted `@name` in the current user message.** Only when the caller says
   the text is user-authored (`parseMentions`): WebSocket `send`/`steer` messages
   (unless the client sends `skillMentions: false` — the web client does so when
   the payload also carries page, seed or inherited/handoff text).

Everything else never activates a skill: bare names ("use the review skill"),
text in quotes (`"..."`), inline or fenced code, indented blocks, `>` quotes,
log lines, plans, delegation reports, handoff/seed text and delegation task
text. Queue, watcher, delegation, keep-alive and operator starts are
server-started: they carry **IDs only** (`startChatRun({ selectedSkillIds })`);
`@name` inside their prompt is inert.

Name resolution for `@name`: one winner per call name (project → shared → user →
bundled). A name that collides inside the winning source is ambiguous and
activates nothing (diagnostic `ambiguous_name`; select by ID). An explicit ID
bypasses the table and wins over a same-name mention.

Commands and agents stay in the picker and the catalog API, but selecting one
does not activate anything: the diagnostic `kind_not_activatable` is recorded
because Cretli cannot promise command execution a harness may not have. The
picker still inserts `@command` / "run agent …" text for them as before.

## Transports

| Path | How the selection travels |
| --- | --- |
| WS `send` (all harnesses) | `selectedSkillIds` + `skillMentions` → runner argument → `room._activeSelection` → `decorateHarnessPrompt` / `applySdkHarnessOutboundPrompt` |
| Busy room queue (SDK, Claude, Codex, qwen, deepseek, codebuddy, opencode, mistral, mimo, zai, **OpenRouter**) | stored on the queue item (`item.selection`), restored on drain, unshift and retry |
| `startChatRun` (watcher, queue drain, delegation, operator) | `selectedSkillIds` → adapter `start` → `acceptRoomPrompt` / harness runner (`parseMentions: false`) |
| `delegation_start` (MCP, REST) | `selected_skill_ids` (max 32) stored on the delegation row, passed to every start/retry of the child; no role profile needed |

OpenRouter used to emit `sdkQueued` while dropping the message when busy. It now
keeps a real queue (text, mode, display text, selection) drained after the run;
`queueRemove` / `queueForceSend` work for it. A server-started run on a busy
OpenRouter room is rejected with `recipient_busy` (nothing is claimed queued).

## Steer

* **Steer with a selection** (IDs, or an active `@name`) is never injected raw
  into the live run: the server acks `revert_to_followup`, queues the text as an
  ordinary follow-up with its selection, and the full prompt builder produces the
  send manifest. The client keeps the text.
* **Plain steer** may be delivered natively. It is recorded as a separate
  manifest `kind: 'steer'` (hash, length, delivery status `delivered` /
  `reverted_to_followup` / `rejected`, `redelivery: 'not_claimed'`) — it never
  claims rules or skills were delivered again. The chat-context panel shows the
  last real send; steers appear only in the history list.

## Differences from legacy (visible and documented)

* The keyword heuristic is gone: "run X", "use X", "X skill" no longer activate
  skill X. The picker now inserts `@name` (and sends the ID) instead of
  "Use skill X.".
* Pasted tasks, logs, quotes and delegation task text that mention `@name` no
  longer activate skills.
* The catalog intro text changed accordingly (the catalog hash changes once).
* Every send manifest has `selection` with `mode`, `requestedIds`,
  `selectedIds`, `selectedNames`, `diagnostics` and `differencesFromLegacy`
  (names the old rule would have activated and the new one did not, or the
  reverse). Comparison mode (`CRETLI_CONTEXT_BUILDER=compare`) uses the same
  selection on both sides, so selection itself never shows up as a payload diff.
* IDs resolve against the registry of the send's cwd. A skill found only by the
  legacy parent-directory walk-up has no registry ID: it stays in the catalog
  and can be activated by `@name`, not by ID.
* `bindRoomRecoveryLifecycle` now forwards all `startPrompt` arguments (it used
  to drop everything after the 4th).

## Rollback

`CRETLI_SKILL_SELECTION=legacy` (environment, restart required) restores the
keyword heuristic for the selection of skill bodies; IDs and diagnostics are
ignored in that mode, the difference list is still produced. Unset it (or set
`explicit`) to return. The protocol fields stay accepted in both modes.

## Limits

* Mention parsing is textual: a message authored by the user that quotes a log
  without code fences may still activate a skill — use quotes/code or the
  picker. The web client disables mention parsing when the payload carries
  extra blocks; other clients choose with `skillMentions`.
* Skill activation is "delivered to the prompt", not "read" or "applied" by the
  harness; the manifest still reports `read: false`.
