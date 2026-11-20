# Claude context trim: baseline, changes, rollback

Scope: what Cretli itself adds to a Claude Agent SDK turn (rules, skills
catalog, delivery policy). Sizes below are **bytes of Cretli's own
contribution**, not provider tokens, cache counters or cost.

## Baseline (reproducible)

Measured on one developer machine with the `harness` adapter, Claude transport,
prompt `test`, via `buildContextSnapshot(...)`. Reproduce: call
`collectAvailableSkills` / `buildSkillsCatalogText` and read
`snapshot.blocks[].bytes`, `snapshot.payloadBytes`. The numbers depend on the
skills installed on the machine.

The snapshot reported **36 delivered entries = 31 local catalog skills + 5
always-applied rules**. The 36 in the observed chat (user-supplied panel
figure, not re-measured here) matches that composition; it does not mean 36
skill files were sent. Source-file sizes shown next to entries describe files
on disk, not text sent.

| Block | Before | After |
| --- | --- | --- |
| `skills_catalog` (31 entries) | 9191 B | 9001 B |
| `cretli-system.mdc` (alwaysApply rule) | 5850 B | 3513 B |
| `workspace_rules` (5 rules) | 9245 B | 6908 B |
| Assembled static payload | 18444 B | 15917 B |

"Before" is HEAD: old intro/footer, same full descriptions, old rule. The
catalog saving (190 B) comes only from the shorter intro and footer; no
description is shortened. The rule trim saves 2337 B, so the total is 2527 B
(~14%) of Cretli's own text. The 18.4 KB panel figure of the observed chat
matches the "before" payload.

Not known from existing telemetry: provider input/cache-read/cache-write token
counts for that chat and the cause of the ~0.15 USD balance drop. The chat
history shows one user message, one reply and one `chat_set_title` tool call
(title source `agent`). That is one extra tool round inside the same turn, not
a separate server title job (server-side title generation is a different path
in `lib/chat-title-dispatcher.js`). No paid extra rounds are claimed.

Turn-by-turn effect (estimates, confirm with provider usage):

- **First turn of a session:** saves the byte difference above (~2.5 KB).
- **Later turns, dedupe off:** same saving on every turn that re-sends the
  static block.
- **Later turns, dedupe on (this repo):** the static block (catalog + rules,
  ~15.9 KB assembled) is skipped while the native Claude session holds it. Cold
  vs warm prompt cache is a provider matter; dedupe is not caching and cache
  hits must be confirmed from provider usage counters.

## Changes

1. `lib/skills/skill-context.js`: intro and footer of the catalog are shorter.
   Entries are unchanged: name, **full** description (all "Use when" / "Never"
   triggers and constraints), path. `@skill-name` / ID selection, the "read the
   path" instruction and the "do not use the native Skill tool" guidance stay.
   No skill is hidden and no description is clipped; filtering by harness was
   deliberately **not** added (a Claude chat may need Cursor-oriented skills).
   Precedence and shadowing are unchanged.
2. `.cursor/rules/cretli-system.mdc`: server start, frontend build, restart and
   PTY procedures moved to [docs/agent-operations.md](../agent-operations.md);
   the rule keeps the imperatives (start outside the sandbox, with the compact
   Cursor hint `required_permissions: ["all"]`; never ask the user to build, no
   HMR), the MCP/app/port rules, sub-chat delegation rules and the
   server-written `review` field, with pointers to the docs. Host policy takes
   precedence on other hosts.
3. `.cretli/context.json` sets `instructions.dedupe = proven_adapters` for this
   project only (project layer; global default stays `off`). It applies only to
   `claude` with an observed native session id. Redelivery is unchanged:
   `lib/sdk/prompt-decoration.ts` re-sends the static block when its content
   hash changes, and epoch bumps (new session, failed resume, compaction,
   model/mode change) drop the decoration state. Mode hints are still repeated
   every turn.
4. Manifest: `blocks[].bytes` and `payloadBytes` are UTF-8 bytes of the
   **assembled** text (the assembler ignores static dedupe, so with dedupe on
   they can exceed what was sent). `delivery.sentPayloadBytes` is the UTF-8
   size of the `sentPayload` actually passed to `recordContextSend`. The
   existing UTF-16 `length` fields are unchanged.

Tests: `tests/context-token-trim.test.js` (full long descriptions and real
project trigger clauses stay in the catalog, explicit `@name` still loads the
full body, project opt-in only for proven adapters, redelivery after edit/epoch
bump, assembled bytes vs `sentPayloadBytes` with multibyte text, rule size guard
and doc pointers).

## Audit notes and follow-ups (not done here)

- `chat_set_title` is already a deferred MCP tool (`lib/mcp/mcp-deferred-tools.js`);
  skipping the agent title round would need a server-side title for `agent`
  source chats. Separate proposal; keep the manual title lock.
- MCP tool schemas and the `claude_code` preset system prompt are outside
  Cretli's text and were not changed; the preset and required MCP stay intact.
- Other always-applied rules (`status-tests-workflow`, `opencode-harness`) are
  candidates for the same move-to-docs treatment.
- Capture provider usage (input / cache read / cache write) for a before/after
  pair of real sessions before claiming a cost saving.

## Rollback

- Dedupe: delete `.cretli/context.json` or set the value to `off`; takes effect
  next turn (a new session retracts it fully).
- Catalog: restore the previous `CATALOG_INTRO` / `CATALOG_FOOTER` strings in
  `lib/skills/skill-context.js` (`git checkout` the file). Nothing else changed
  there; descriptions were never clipped.
- Rule: restore the removed sections from `docs/agent-operations.md` into the
  rule (or `git checkout` the file).
- Manifest bytes are additive fields; nothing reads them yet.
