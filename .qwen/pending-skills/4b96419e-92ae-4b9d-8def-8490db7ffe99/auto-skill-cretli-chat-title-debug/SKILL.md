---
name: cretli-chat-title-debug
description: Diagnose a Cretli chat title (MCP chat_set_title) or other Cretli MCP builtin tool that "didn't work" / shows as a red error in the chat UI — verify ground truth in the persisted data files, trace the full title pipeline, and pin the red card to the exact status='error' source before changing code.
source: auto-skill
extracted_at: '2026-10-03T19:22:17.759Z'
---

# Debugging Cretli chat titles & "red error" MCP builtin tools

Use when the user reports that `chat_set_title` (or another Cretli MCP builtin tool)
"didn't work" or "shows as a red error in the UI". The reported symptom is almost always
a *rendering/status* question, not a persistence question — so establish ground truth first.

## Constraints learned the hard way
- **The model cannot read pasted screenshots** (`read_file` returns
  "This model does not support image input"). Do NOT burn turns trying. Ask the user to
  paste the **verbatim text** of the red card — it uniquely identifies the code path.
- **`cretli-ref chat=<uuid>` in a message may point at a different workspace.** The referenced
  chat id is NOT guaranteed to exist in this workspace's `data/chats.json`. Always verify the id
  is present before assuming you can reproduce the case. (In this session the ref id was
  `NOT FOUND` while the actual live chat had a different id.)
- **The active chat's own id** = the file under `data/chat-history/<chatId>.json`, not the ref.
- **User writes Polish** (see user memory `language-preference`): reply in Polish.

## Step 1 — Verify ground truth in the data (do this BEFORE reading a lot of code)
The persistence files are the source of truth and cheap to inspect:
```bash
# Where is the data? resolveDataPath() -> runtime-paths.js. Usually data/chats.json + data/chat-history/*.json
node -e 'const fs=require("fs");const chats=JSON.parse(fs.readFileSync("data/chats.json","utf8")).chats;
for(const id of ["<chatId>"]){const c=chats.find(x=>x.id===id);
console.log(c?JSON.stringify({title:c.title,titleSource:c.titleSource,titleRev:c.titleRev,agentTransport:c.agentTransport,delegationId:c.delegationId||null,archivedAt:c.archivedAt||null}):"NOT FOUND");}'

# The persisted tool_call event carries the authoritative status. History doc shape: {v,chatId,cursorSessionId,headSeq,updatedAt,events:[{seq,rec}]}, rec={kind,event:{type,name,status,result,...}}
node -e 'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("data/chat-history/<chatId>.json","utf8"));
const by={};for(const e of doc.events){const ev=e.rec&&e.rec.event;if(ev&&ev.type==="tool_call"&&String(ev.name).includes("chat_set_title"))by[ev.status]=(by[ev.status]||0)+1;}
console.log(JSON.stringify(by));'
```
If the tool shows `status: "completed"` and the DB title is set, **the tool works** — the issue is
UI display or a different chat/context. Don't invent a bug.

## The chat title pipeline (each hop is where a "no-op" can hide)
1. Handler `lib/mcp/builtin/chat-tools.js` → `name:'chat_set_title'`: uses **`session.chatId` only**
   (ignores any `chat` arg). It has exactly **two throws**: empty title, and
   `'chat_set_title needs a calling chat session.'` when `session.chatId` is blank (widget /
   agent-definition / standalone stdio). Everything else returns `mcpTextResult(...)`.
2. `client.setAgentTitle(chatId,title)` — `lib/mcp/mcp-inprocess-client.js` (in-proc) or
   `lib/remote-api-client.js` (posts `/api/chats/:id/agent-title`).
3. `applyAgentTitle` — `lib/chat-title-agent.js`: gates on `getAutoTitleSettings()` (`mode:'off'`
   or `source:'server'` → skipped `disabled`), `ineligibleReason` (temporary / delegation-nonterminal /
   archived / `titleSource==='manual'`), `throttleReason` (10 min interval, 12/day), then
   `sanitizeGeneratedTitle` (secrets/quotes → `rejected_output`).
4. `applyAutoTitle` — `lib/persist/chats-persist.js`: manual-lock + `expectedVersion` CAS;
   sets `title`, `titleSource:'auto'`, bumps `titleRev`, `saveChats`, then
   `broadcastChatListChanged({reason:'title',chatId})`.
5. Frontend — `app_front/features/chat/chatListLiveSync.js` `onChatsChanged` → `onTitleChanged`
   (only refreshes an open settings modal) + debounced `refresh`→`loadChatsFromServer`
   (`chatController.js` sets `existing.title` unconditionally then `renderChatList()` →
   `notifySidebar()` → `headerContextTitle.refresh()`).
6. Server generator does NOT clobber the agent title: `chat-title-dispatcher.js` skips when
   `source==='agent'` or the chat is already `!default`; with `source==='both'` the agent's
   mid-run `applyAutoTitle` bump makes the deferred job skip (`not_default`).

## Step 2 — Pin the RED card to its true cause (this is the crux)
A tool card is red **only** when `status==='error'`: `app_front/lib/sdk-rich-view.js`
`resolveToolBlockVariant(status)` → `completed:'ok'`, `error:'err'`, `cancelled:'warn'`. The
result *text* never drives color. For the Qwen harness `status` becomes `'error'` via
`lib/agent-harness/qwen-event-normalizer.js`:
`failed = rec.is_error===true || isFailedQwenToolResult(result) || isFailedToolSearchResult(result)`.
`isFailedQwenToolResult` (`lib/qwen/qwen-question.js`) only matches `[Operation Cancelled]`,
`Reason: Denied`, `permission was declined`, `Cannot ask user questions`, `User declined to
answer`, `Tool blocked by plan mode`, `has not been read in this session`,
`edit_requires_prior_read`. **"Title set…" / "Title not changed…" do NOT match.** So a red
`chat_set_title` means the handler **threw** (MCP `is_error:true`) — ask which of the two throw
strings the user sees.

## Step 3 — Do NOT blind-edit a tested invariant
`tests/chat-title-agent.test.js` explicitly asserts the missing-chatId throw:
```js
await assert.rejects(() => tool.handler({ title: 'x' }, { client, session: {} }), /calling chat/);
```
If a fix should soften that throw into a graceful non-error result, update this test in the same
change and note the behavior change. Confirm the exact failing path with the user first.

## Known non-bugs to mention (avoids chasing ghosts)
- **Live title can lag** if the browser's `ws.bufferedAmount` exceeds `WS_BACKPRESSURE_THRESHOLD_BYTES`
  when `broadcastChatListChanged` fires (right after the first reply, while the run is still streaming) —
  `sendChatListClientMessage` then drops the `chatsChanged` frame. The periodic `syncChatTitlesFromServer`
  (`app_front/chat.js`) reconciles it within the interval, so it's a transient delay, not permanent.
- A blank `session.chatId` is a genuine context limit (no chat bound), not a title bug.
