---
name: cretli-mcp-tool-red-error-debug
description: Diagnose and fix why a Cretli MCP builtin tool (e.g. chat_set_title) shows as a red error or "didn't work" in the chat UI — separate the two distinct symptoms, verify actual on-disk state instead of trusting the tool's own success text, and find the exact throw path from history.
source: auto-skill
extracted_at: '2026-10-03T19:31:55.732Z'
---

# Debugging a Cretli MCP tool that "didn't work" / shows red

Use when the user says a Cretli MCP builtin tool (chat_set_title, chat_rename, todo_*,
delegation_*) "didn't work", "didn't set the title", or shows as a **red error** in the chat,
often with a pasted screenshot and a `cretli-ref chat=<uuid> seq=<a>-<b>` line.

## Step 0 — the model cannot see the screenshot
This chat's model rejects image input (`read_file` on a .jpg errors). Do NOT claim you read it.
Work from code + on-disk state, and if you need the verbatim symptom, ask for the **exact text** of
the red card (a plain-text request, not `ask_user_question` — that control request can time out here).

## Step 1 — two DIFFERENT symptoms, do not conflate them
A tool card is red **iff** its recorded `status === 'error'`
(`resolveToolBlockVariant` in `app_front/lib/sdk-rich-view.js`: completed→ok, error→err,
cancelled→warn). Critically:
- **"Didn't apply / skipped" is NOT red.** `chat_set_title` returning
  `Title not changed (manual|delegation|disabled|throttled)` is still `status: completed` (green),
  just not applied. So a green card with a "not changed" reason is a *policy gate*, not a bug.
- **Red = a thrown error** (MCP `is_error:true`, or a failed-text heuristic in the harness
  normalizer). Different root cause than "skipped".

Establish which one the user actually has before touching code.

## Step 2 — verify REAL state on disk; never trust the tool's own "Title set" text
The success string is only what the handler decided to print. Confirm against the data files
(`resolveDataPath` → repo `data/`; NOT a committed glob, so `glob **/chats.json` from the tool
finds nothing — read them directly):

```bash
node -e 'const fs=require("fs");const c=(JSON.parse(fs.readFileSync("data/chats.json","utf8")).chats||[]);
const x=c.find(k=>k.id==="<chatId>");console.log(x&&JSON.stringify({title:x.title,titleSource:x.titleSource,titleRev:x.titleRev,agentTransport:x.agentTransport}));'
```

- The `cretli-ref chat=<uuid>` in the user's message is **not necessarily this workspace's chat** —
  it may not exist in `data/chats.json` at all (observed: a pasted ref pointed at a foreign chat).
  Resolve the CURRENT chat id from `data/chat-history/<id>.json` or `chat_show`; verify the ref id
  before reasoning about it.
- Also note the harness: the same tool behaves per transport (here the working chat was `qwen`, the
  failing one `claude`).

## Step 3 — find the actual failing instance empirically (this is how the cause was pinned)
Don't guess which of the handler's branches threw. Scan **all** histories for the tool's
`tool_call` events and dump the `result` of the errored ones:

```bash
node -e 'const fs=require("fs"),p=require("path");const d="data/chat-history";
for(const f of fs.readdirSync(d).filter(x=>x.endsWith(".json"))){let doc;try{doc=JSON.parse(fs.readFileSync(p.join(d,f),"utf8"))}catch(e){continue}
for(const e of (doc.events||[])){const ev=e.rec&&e.rec.event;
 if(ev&&ev.type==="tool_call"&&typeof ev.name==="string"&&ev.name.includes("chat_set_title")&&ev.status==="error")
   console.log(f.slice(0,8),e.seq,"|",ev.result);}}'
```

History shape: top-level `{events:[{seq, rec}]}`, `rec.event` is the room event
(`type:"tool_call"`, `name`, `status`, `result`, `args`). The `name` is the full bridge name
(`mcp__cretli_bridge__…__chat_set_title`). Real observed result string that cracked it:
`VALIDATION_ERROR: client.setAgentTitle is not a function`.

## Step 4 — trace the "is not a function" class (MCP builtin client wiring)
Handler `chat_set_title`/`chat_rename` call `client.setAgentTitle`/`client.renameChat` directly.
The client is whatever is threaded through:
- `lib/mcp/builtin/catalog.js` `createCretliMcpToolHandlers(client, session)` passes `client`
  straight to `tool.handler(args, { client, session })`.
- `lib/mcp/mcp-runtime.js` `callTool` uses `createCretliMcpToolHandlers(context?.builtinClient || {}, …)`
  — if `builtinClient` is absent it becomes `{}` → `client.X is not a function` → `TypeError` → wrapped
  as `VALIDATION_ERROR` by `toCretliMcpToolError` (`lib/mcp/builtin/errors.js`) → red card.
- Healthy paths DO populate it: `mcp-service.js` wraps with `withBuiltinClient()`
  (`createInProcessMcpClient`), and `mcp-openrouter-tools.js` sets `builtinClient`.
  `CretliApiClient` (`lib/remote-api-client.js`) also implements `setAgentTitle`.
- The `is_error` that the frontend turns red for the **Qwen** harness is computed in
  `lib/agent-harness/qwen-event-normalizer.js`: `rec.is_error === true || isFailedQwenToolResult(result)`
  (the text heuristic in `lib/qwen/qwen-question.js` only matches cancelled/denied/plan-mode/prior-read
  strings — a "Title set"/"not changed" sentence does NOT match it).

A red that later turns green in the SAME chat (observed: 17:06 error → 17:12+ completed, title
finally set) means a **transient stale-build / stale room session** (client captured before the
method existed) that self-heals after a server restart — do not edit code to "fix" a ghost.

## Step 5 — the fix (guard, don't change tested invariants)
`chat_set_title` had NO `typeof` guard (unlike `mcp_list`, which throws a clear message when the
method is absent). Minimal, contract-consistent fix — degrade to a non-error note instead of a
cryptic red `TypeError`, mirroring the tool's own best-effort wording:

```js
if (typeof client?.setAgentTitle !== 'function') {
  return mcpTextResult('Title not set (this session cannot set chat titles). This is fine; continue your task.');
}
```

Leave intentional throws alone: `tests/chat-title-agent.test.js` deliberately
`assert.rejects(..., /calling chat/)` for the missing-`chatId` case, so that hard error is by design.
Add the graceful branch only for the environmental (client-missing-method) case.

## Step 6 — verify in the repo's own test style
Cretli unit tests are plain assertion scripts printing `"<file>.test.js OK"`; run directly:
`node tests/chat-title-agent.test.js` and `node tests/mcp-builtin-tools.test.js`.
Then `npx eslint <changed files>`. Extend the existing test with a no-method case
(`{ client: {}, session: { chatId:'caller-chat', workspaceFolder: process.cwd() } }` →
`isError===false` and text matches `/cannot set chat titles/`).

## If the symptom is really "applied but UI never updated" (green, not red)
Separate path: `applyAutoTitle` (`lib/persist/chats-persist.js`) →
`broadcastChatListChanged({reason:'title'})` (`lib/chat-list-updates.js`) → frontend
`chatListLiveSync.onChatsChanged` → `loadChatsFromServer` (sets `existing.title` unconditionally) →
`renderChatList()` → `notifySidebar()` → `headerContextTitle.refresh()`.
Known edge: `sendChatListClientMessage` DROPS the frame when `ws.bufferedAmount` exceeds
`WS_BACKPRESSURE_THRESHOLD_BYTES` (likely right after a heavy streaming run) — so the live update
can be missed; the periodic `syncChatTitlesFromServer` reconciles it within its interval, and a full
reload always shows the persisted title. That is a delay, not a permanent failure.
